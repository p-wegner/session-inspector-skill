/**
 * SESSION FACTS — what a successor needs from a transcript that the summary drops.
 *
 * `summarize()` answers "what happened, at a glance": first and last prompt, tool
 * counts, the last assistant text. A handoff needs a different cut. Measured on two
 * real sessions (2026-09-19) the brief built from the summary lost, among others:
 * the human's answers to the session's own questions, every mid-session prompt of a
 * 196-turn run, the commits and the push, which tests ran and what they said, the
 * defects hit on the way, the docs the work was built from, and — for a session cut
 * off by a limit — its last real message, because the last text was the banner.
 *
 * One pass, no IO: the CLI resolves directories to repos. Claude transcripts only;
 * a codex session gets its human prompts from lib/brief.mjs `codexHumanPrompts`.
 */

import { classify } from "./prompts.mjs";
import { limitKind } from "./parse.mjs";

const clip = (t, n) => {
  const x = String(t || "").replace(/\s+/g, " ").trim();
  return x.length > n ? `${x.slice(0, n)}…` : x;
};
const textOf = (content) => (typeof content === "string" ? content
  : Array.isArray(content) ? content.map((c) => (c && typeof c.text === "string" ? c.text : "")).join("\n") : "");

// Test runners worth reporting. The command is kept verbatim so a successor can
// re-run it; the result line is whatever the runner printed as its tally.
// A project's own runner script counts too (`node tests/all.mjs`): measured on a
// session whose only test runs were that form, the brief reported no checks at all.
const TEST_RE = /\b(?:node\s+--test|node\s+(?:\S*[\\/])?tests?[\\/]\S+\.m?[jt]s|node\s+\S+\.test\.m?[jt]s|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+test|npx\s+vitest|vitest\s+run|jest\b|pytest\b|uv\s+run\s+pytest|gradlew?\s+[^\n]*\btest\b|mvn\s+[^\n]*\btest\b|cargo\s+test|go\s+test|dotnet\s+test|rspec\b|bundle\s+exec\s+rspec)/i;
// The runner invocation alone, without the heredoc or the `cd` around it.
const RUN_RE = new RegExp(String.raw`(?:timeout\s+\d+\s+)?(?:[A-Z_]+=\S+\s+)*` + TEST_RE.source + String.raw`[^\n&|;]*`, "i");
const TALLY_RE = /^.*(?:\b(?:pass|passed|passing|fail|failed|failing|tests?)\b[ \t]*[:=]?[ \t]*\d+|\d+[ \t]+(?:\w+[ \t]+){0,2}(?:passed|failed|passing|failing|tests?)\b|✔|✖|Tests:[ \t]).*$/gim;
// The summary shapes runners themselves print (node:test, pytest/jest-style counts,
// a project runner's "N checks passed"). The CLI under test prints "failed: 1" too.
const RUNNER_TALLY = /^\s*(?:ℹ[ \t]+(?:tests|suites|pass|fail|skipped|todo|cancelled)[ \t]+\d+|\d+[ \t]+(?:\w+[ \t]+){0,2}(?:passed|failed|passing|failing)\b.*|Tests?:[ \t].*\d.*|=+[ \t].*\b(?:passed|failed)\b.*=+)\s*$/i;
const TALLY_KEY = /\b(tests?|pass(?:ed|ing)?|fail(?:ed|ing)?)\b/i;

/**
 * Tally lines grouped into runs. One command can hold several runs — a suite and
 * then a mutation check that reverts the fix and expects a failure — and printed as
 * one line they read as a contradiction (`pass 6 · fail 0 · fail 1`), which a
 * successor measured on resolved by trusting a stale count instead. A run ends
 * where a key it already has repeats.
 */
export function tallyRuns(lines) {
  const runs = [];
  let cur = [], keys = new Set();
  for (const l of lines) {
    const k = (l.match(TALLY_KEY) || [])[1];
    const key = k ? k.toLowerCase().replace(/(?:ed|ing|s)$/, "") : "";
    if (key && keys.has(key)) { runs.push(cur); cur = []; keys = new Set(); }
    cur.push(l); if (key) keys.add(key);
  }
  if (cur.length) runs.push(cur);
  return runs;
}

// Links a session creates outside any repo — skill junctions, profile wiring. They
// outlive the session, and nothing in git records them.
const LINK_RE = /New-Item\b[^\n]*-ItemType\s+(?:Junction|SymbolicLink|HardLink)|\bmklink\b|\bln\s+-s\b/i;
const TRACKING_FILE = /(?:^|[\\/])(CONTINUE|BACKLOG)(?:\.local)?\.md$/i;
const READ_ONLY_CMD = /^\s*(?:cat|grep|rg|ls|head|tail|type|find|Get-Content|Select-String|Get-ChildItem|Test-Path|wc|stat)\b[^|;&]*$/i;
// Per-user state directories a command names (`~/.nexos-tools`, `$HOME/.config`,
// `C:\Users\x\.foo`). A tool's own config store is where a session's side effects
// outlive it, and git records none of them. The agent's own homes are excluded.
const HOME_STATE_RE = /(?:~|\$HOME|\$env:USERPROFILE|%USERPROFILE%|[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"']+)[\\/]+(\.(?!claude|codex|copilot|cache\b|npm\b|local\b)[A-Za-z][\w.-]{2,})((?:[\\/][\w.-]+)*)/g;
// A "Verified" statement in the session's own words — prose or a CONTINUE entry.
// The live checks (a gateway answering "pong", a sibling repo's contract test)
// live only there: no test runner printed a tally for them.
const VERIFIED_RE = /^\s*(?:[-*]\s*)?\*\*(?:Verified|Not (?:yet )?verified)[^*]*\*\*|^\s*(?:[-*]\s*)?(?:Verified|Not (?:yet )?verified)(?: live)?:/i;
const KEYISH = /api[_-]?key|token|secret|bearer|password|credential/i;

// `cd <dir>` at the head of a shell command, or `git -C <dir>` — where a command
// actually ran. A session's cwd says where it STARTED; these say where it worked.
const CD_RE = /(?:^|&&|;|\n)\s*(?:cd|Set-Location|pushd)\s+(?:-LiteralPath\s+)?["']?([A-Za-z]:[\\/][^"'\s;&|]*|\/[a-z]\/[^"'\s;&|]*)["']?/gi;
const GITC_RE = /\bgit\s+-C\s+["']?([A-Za-z]:[\\/][^"'\s;&|]*|\/[a-z]\/[^"'\s;&|]*)/gi;

/** "/c/projects/x" → "C:\projects\x"; Windows paths pass through with / → \. */
export function normalizeDir(p) {
  let s = String(p || "").trim().replace(/[\\/]+$/, "");
  const posix = s.match(/^\/([a-z])\/(.*)$/i);
  if (posix) s = `${posix[1].toUpperCase()}:\\${posix[2]}`;
  s = s.replace(/\//g, "\\");
  if (/^[a-z]:/.test(s)) s = s[0].toUpperCase() + s.slice(1);
  return s;
}

/** Parse the AskUserQuestion result text: `"question"="answer", …`. */
export function parseAnswers(text) {
  const out = [];
  const body = String(text || "").replace(/^[\s\S]*?answered:\s*/i, "").replace(/\.\s*You can now continue[\s\S]*$/i, "");
  for (const m of body.matchAll(/"((?:[^"\\]|\\.)*)"\s*=\s*"((?:[^"\\]|\\.)*)"/g)) out.push({ question: m[1], answer: m[2] });
  return out;
}

/** `- [x] …` / `- [ ] …` lines of a message — the checklist a session closes on. */
export function checklistOf(text) {
  const done = [], open = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = line.match(/^\s*[-*]\s*\[([ xX])\]\s*(.+)$/);
    if (!m) continue;
    (m[1] === " " ? open : done).push(clip(m[2], 220));
  }
  const next = String(text || "").match(/\*\*Next:\*\*\s*(.+)/);
  return { done, open, next: next ? clip(next[1], 220) : "" };
}

export function sessionFacts(lines) {
  const f = {
    humanPrompts: [],   // {ts, text}
    answers: [],        // {ts, question, answer}
    sources: [],        // {kind: url|search, value}
    tests: [],          // {ts, command, ok, tally}
    commits: [],        // {ts, sha, subject, dir}
    pushes: [],         // {ts, remote, ref}
    failures: [],       // {ts, tool, what, error, resolved}
    dirs: new Map(),    // dir -> {writes, commands}
    lastReal: "",       // last assistant text that is not a limit banner
    lastRealAt: "",
    subagents: 0,
    commitCommands: 0,  // successful shell calls that ran `git commit`
    trackingWrites: [], // {ts, file, text} — what the session itself wrote into CONTINUE/BACKLOG
    lastGitStatus: null,// {ts, entries:[porcelain lines]} — the tree as the session last saw it
    links: [],          // {ts, command} — junctions/symlinks it created
    verified: [],       // {ts, text, negative, where} — its own "Verified:" statements
  };
  const pending = new Map(); // tool_use_id -> {name, input, ts}
  let awaitingDiagnosis = null; // the last failure (tool error or failing run) still waiting for the session's words
  const homeState = new Map();  // ~/.something -> {cmd, out, commands, files, keyish}
  const bumpHome = (raw, where, rest = "", ctx = "") => {
    const k = raw.toLowerCase().replace(/\.+$/, ""); // "~/.nexos-tools." at the end of a sentence
    const e = homeState.get(k) || { cmd: 0, out: 0, commands: [], files: [], keyish: [] };
    e[where]++;
    // A count ("22×") hides WHAT changed there. Keep the distinct commands and the
    // files named under the store, and flag a file whose line also names a key.
    if (where === "cmd" && ctx) { const c = clip(ctx, 140); if (!e.commands.includes(c)) e.commands.push(c); }
    const file = rest && /\.[a-z0-9]{2,5}$/i.test(rest) ? rest.replace(/^[\\/]+/, "").replace(/\\/g, "/") : "";
    if (file && !e.files.includes(file)) e.files.push(file);
    if (file && KEYISH.test(ctx) && !e.keyish.includes(file)) e.keyish.push(file);
    homeState.set(k, e);
  };
  const addVerified = (ts, text, where) => {
    for (const p of String(text || "").split(/\n\s*\n/)) {
      const ls = p.split("\n");
      const i = ls.findIndex((l) => VERIFIED_RE.test(l));
      if (i < 0) continue;
      const body = clip(ls.slice(i).map((l) => l.replace(/^\s*>\s?/, "")).join(" "), 420);
      if (f.verified.some((v) => v.text === body)) continue;
      f.verified.push({ ts, text: body, negative: /not (?:yet )?verified/i.test(body.slice(0, 40)), where });
    }
  };
  const created = [];           // files the session created with Write (vs edited)
  const bump = (dir, key) => {
    const d = normalizeDir(dir);
    if (!d) return;
    const e = f.dirs.get(d) || { writes: 0, commands: 0 };
    e[key]++;
    f.dirs.set(d, e);
  };
  const seenSource = new Set();
  const addSource = (kind, value) => {
    const k = `${kind}:${value}`;
    if (!value || seenSource.has(k)) return;
    seenSource.add(k);
    f.sources.push({ kind, value });
  };

  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let o; try { o = JSON.parse(t); } catch { continue; }
    if (o.isSidechain) continue; // a subagent's own turns are not the session's decisions
    const ts = o.timestamp || "";
    const msg = o.message;
    if (!msg) continue;

    if (o.type === "assistant") {
      for (const b of msg.content || []) {
        if (b.type === "text" && b.text && !limitKind(b.text) && b.text.trim().length > 20) {
          f.lastReal = b.text; f.lastRealAt = ts;
          addVerified(ts, b.text, "message");
          // The first thing the session SAID after a failure is its diagnosis —
          // "the total left out the skipped components; node --test needs a glob".
          // That sentence is the defect record; the error output is only the symptom.
          if (awaitingDiagnosis) { awaitingDiagnosis.diagnosis = clip(b.text, 320); awaitingDiagnosis = null; }
        } else if (b.type === "tool_use") {
          const input = b.input || {};
          pending.set(b.id, { name: b.name, input, ts });
          const fp = input.file_path || input.notebook_path;
          if (fp && /^(Write|Edit|MultiEdit|NotebookEdit)$/.test(b.name)) bump(fp.replace(/[\\/][^\\/]*$/, ""), "writes");
          if (fp && b.name === "Write" && !created.includes(fp)) created.push(fp);
          // The session's own record of the work, as it wrote it. Read later, the
          // file may carry passes other sessions added on top; this is this one's.
          if (fp && TRACKING_FILE.test(fp) && (b.name === "Write" || b.name === "Edit")) {
            const text = b.name === "Write" ? input.content : input.new_string;
            if (text && String(text).trim()) { f.trackingWrites.push({ ts, file: fp, text: String(text) }); addVerified(ts, text, "tracking file"); }
          }
          const cmd = typeof input.command === "string" ? input.command : "";
          if (cmd && LINK_RE.test(cmd)) {
            let tgt = (cmd.match(/-Target\s+["']?([^"'\s;)]+)/i) || cmd.match(/mklink\s+\/[JDH]\s+\S+\s+["']?([^"'\s]+)/i) || cmd.match(/\bln\s+-s\S*\s+["']?([^"'\s]+)/i) || [])[1] || "";
            // `-Target $target`: resolve the variable from its assignment in the same script.
            const v = tgt.match(/^\$(\w+)$/);
            if (v) tgt = (cmd.match(new RegExp(String.raw`\$${v[1]}\s*=\s*["']([^"']+)["']`, "i")) || [])[1] || tgt;
            f.links.push({ ts, id: b.id, target: tgt, perProfile: /\.claude\*|claude\*/.test(cmd), command: clip(cmd, 160), result: "" });
          }
          // A path in a pure read (`cat ~/.git-credentials`, `grep … ~/.cargo`) is
          // something the session LOOKED at, not state it changed.
          if (cmd && !READ_ONLY_CMD.test(cmd)) for (const m of cmd.matchAll(HOME_STATE_RE)) bumpHome(m[1], "cmd", m[2], cmd);
          if (cmd && /cat\s*>>?\s*\S*(?:CONTINUE|BACKLOG)\.md\s*<<\s*'?(\w+)'?/i.test(cmd)) {
            const hd = cmd.match(/cat\s*>>?\s*(\S*(?:CONTINUE|BACKLOG)\.md)\s*<<\s*'?(\w+)'?\s*\n([\s\S]*?)\n\2\b/i);
            if (hd) { f.trackingWrites.push({ ts, file: hd[1], text: hd[3] }); addVerified(ts, hd[3], "tracking file"); }
          }
          // A script that rewrites a tracking file (`python - <<PY … open('BACKLOG.md')`)
          // adds its sections as string literals: `'## Codex: silence … catalog\n\n'`.
          // Only a literal that ENDS in a newline escape is written text; one without
          // (`s.index('## A second harness')`) is a lookup. Struck headings are closures.
          if (cmd && /(?:python|node)\b/.test(cmd) && /(?:CONTINUE|BACKLOG)\.md/.test(cmd)) {
            const file = (cmd.match(/(\S*(?:CONTINUE|BACKLOG)\.md)/) || [])[1];
            const heads = [...cmd.matchAll(/['"](#{2,3} [^'"\n\\]+)\\n/g)].map((x) => x[1])
              // a literal the same script also writes struck is the old heading being closed
              .filter((x) => !/~~/.test(x) && !cmd.includes(`~~${x.replace(/^#+\s+/, "")}~~`));
            if (file && heads.length) f.trackingWrites.push({ ts, file: file.replace(/^.*['"(=]/, ""), text: heads.join("\n"), scripted: true });
          }
          if (cmd) {
            for (const m of cmd.matchAll(CD_RE)) bump(m[1], "commands");
            for (const m of cmd.matchAll(GITC_RE)) bump(m[1], "commands");
          }
          if (b.name === "WebFetch" && input.url) addSource("url", input.url);
          if (b.name === "WebSearch" && input.query) addSource("search", input.query);
          if (b.name === "Agent" || b.name === "Task") f.subagents++;
        }
      }
      continue;
    }

    if (o.type !== "user") continue;
    const content = msg.content;
    if (typeof content === "string") {
      if (/^<local-command-caveat>/.test(content)) continue;
      const c = classify(content);
      if (c && c.kind === "human") f.humanPrompts.push({ ts, text: c.text });
      continue;
    }
    for (const b of content || []) {
      if (b.type === "text" && b.text) {
        const c = classify(b.text);
        if (c && c.kind === "human") f.humanPrompts.push({ ts, text: c.text });
        continue;
      }
      if (b.type !== "tool_result") continue;
      const call = pending.get(b.tool_use_id);
      if (!call) continue;
      const out = textOf(b.content);
      const cmd = typeof call.input.command === "string" ? call.input.command : "";

      if (call.name === "AskUserQuestion") {
        for (const a of parseAnswers(out)) f.answers.push({ ts, ...a });
      }
      // A repo's own CLI writes its store without naming it on the command line;
      // the path shows up in what it prints.
      if (cmd && !b.is_error && !READ_ONLY_CMD.test(cmd)) {
        const o2 = out.slice(0, 20000);
        for (const m of o2.matchAll(HOME_STATE_RE)) {
          const ls = o2.lastIndexOf("\n", m.index) + 1, le = o2.indexOf("\n", m.index);
          bumpHome(m[1], "out", m[2], o2.slice(ls, le < 0 ? undefined : le));
        }
      }
      const link = f.links.find((k) => k.id === b.tool_use_id);
      if (link) link.result = clip(out, 220);
      if (call.name === "WebFetch") {
        // A fetch that failed is not a source; listing it sent a successor to 404s.
        const src = f.sources.find((s) => s.kind === "url" && s.value === call.input.url);
        // WebFetch reports most failures as a SUCCESSFUL result whose text says so.
        const bad = b.is_error || /HTTP [45]\d\d|status code [45]\d\d|REDIRECT DETECTED|^\s*(?:Request failed|Error)\b|cannot provide|not available|does not contain|no (?:relevant )?(?:information|content)/i.test(out.slice(0, 240));
        if (src) { if (bad) src.failedFetches = (src.failedFetches || 0) + 1; else src.ok = true; }
      }
      if (b.is_error) {
        const what = cmd ? clip(cmd, 140) : clip(call.input.file_path || call.input.url || call.input.description || "", 140);
        const x = { ts, tool: call.name, what, error: clip(out.replace(/^Exit code \d+\s*/, ""), 200), resolved: false, diagnosis: "" };
        f.failures.push(x);
        awaitingDiagnosis = x;
      } else if (f.failures.length) {
        // A later success of the same tool marks the most recent open failure of
        // that tool as resolved. Crude on purpose: it says "the session moved past
        // it", never "it was fixed", and the brief words it that way.
        for (let i = f.failures.length - 1; i >= 0; i--) {
          const x = f.failures[i];
          if (!x.resolved && x.tool === call.name) { x.resolved = true; break; }
        }
      }
      if (cmd && TEST_RE.test(cmd)) {
        const tally = [...out.matchAll(TALLY_RE)].map((m) => m[0].trim()).filter((l) => l.length < 160);
        const summary = tally.filter((l) => /\b(?:pass|fail|tests?)\b/i.test(l) && !/^✔|^✖/.test(l)).slice(-3);
        // A command that merely MENTIONS a runner (a heredoc writing docs) prints no
        // tally; only a run that printed one, or failed, is a test run.
        const run = cmd.match(RUN_RE);
        const counted = tally.filter((l) => RUNNER_TALLY.test(l));
        const runs = tallyRuns(counted.length ? counted : tally.slice(-2)).map((r) => r.slice(-3));
        if (tally.length || b.is_error) {
          const firstErr = (out.match(/^.*\b(?:Error|error:|AssertionError|FAIL|not ok)\b.*$/m) || [""])[0];
          const t = { ts, command: clip(run ? run[0] : cmd, 160), ok: !b.is_error, tally: summary.length ? summary : tally.slice(-2), runs, firstError: clip(firstErr, 200), diagnosis: "", stashed: /\bgit\s+stash\b/.test(cmd) };
          f.tests.push(t);
          // A run whose FIRST tally reports failures is a problem the session hit,
          // even when the shell call itself exited 0 (a pipe to `tail` hides it).
          const firstFail = runs.length && runs[0].some((l) => /(?:ℹ\s*fail\s+[1-9]|\b[1-9]\d*\s+(?:\w+\s+){0,2}fail(?:ed|ing))/i.test(l));
          if (firstFail) awaitingDiagnosis = t;
        }
      }
      if (cmd && /\bgit\b[^\n|]*\bstatus\b/.test(cmd) && !b.is_error) {
        const entries = out.split(/\r?\n/).filter((l) => /^(?:[ MADRCU?!]{2}) \S/.test(l));
        if (entries.length || /nothing to commit|working tree clean/i.test(out) || /--short|--porcelain|-s\b/.test(cmd)) f.lastGitStatus = { ts, entries };
      }
      if (cmd && !b.is_error) f.commitCommands += (cmd.match(/\bgit\s+(?:-[Cc]\s+\S+\s+)*commit\b/g) || []).length;
      if (cmd && /\bgit\b[^\n]*\bcommit\b/.test(cmd)) {
        for (const m of out.matchAll(/^\[([^\]\s]+)(?:\s+\(root-commit\))?\s+([0-9a-f]{7,40})\]\s+(.+)$/gm)) {
          f.commits.push({ ts, branch: m[1], sha: m[2], subject: clip(m[3], 140) });
        }
      }
      if (cmd && /\bgit\b[^\n]*\bpush\b/.test(cmd)) {
        const to = out.match(/^To\s+(\S+)/m);
        const refs = [...out.matchAll(/^\s*[+*!= -]?\s*(?:\[new branch\]|[0-9a-f]{7,}\.\.[0-9a-f]{7,}|\+?[0-9a-f]{7,}\.\.\.[0-9a-f]{7,})\s+(\S+\s*->\s*\S+)/gm)].map((m) => m[1]);
        const rejected = /\[rejected\]|failed to push|error:/i.test(out);
        if (to || refs.length || rejected) f.pushes.push({ ts, remote: to ? to[1] : "", refs, ok: !b.is_error && !rejected });
      }
    }
  }

  const lastRealList = checklistOf(f.lastReal);
  return {
    ...f,
    dirs: [...f.dirs.entries()].map(([dir, v]) => ({ dir, ...v })).sort((a, b) => (b.writes - a.writes) || (b.commands - a.commands)),
    closingChecklist: lastRealList,
    // Named by a command that is not a pure read, or printed by commands at least
    // three times: a tool's own store shows up in what it prints, a stray string once.
    homeState: [...homeState.entries()].filter(([, v]) => v.cmd > 0 || v.out >= 3)
      .map(([dir, v]) => ({ dir: `~/${dir}`, mentions: v.cmd + v.out, commands: v.commands.slice(-5), files: v.files.slice(0, 8), keyish: v.keyish.slice(0, 4) }))
      .sort((a, b) => b.mentions - a.mentions),
    created,
  };
}
