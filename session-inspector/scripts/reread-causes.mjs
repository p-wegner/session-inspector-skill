#!/usr/bin/env node
/**
 * Are file RE-READS actually avoidable — or are they the price of editing and of
 * long sessions? waste.mjs charges every 2nd+ read of a file as waste; this tool
 * classifies each re-read by what happened BETWEEN the two reads:
 *
 *   after-own-edit    an Edit/Write to the same file landed in between — the agent
 *                     is refreshing its own change (or the harness demanded a fresh
 *                     Read before the next Edit). Legitimate.
 *   post-compaction   a compact boundary in between — the earlier copy was
 *                     summarized away; re-reading is how state comes back. Legitimate.
 *   pre-edit-refresh  no edit in between, but an Edit to that file follows within
 *                     --edit-window turns — the re-read enables the edit (stale-read
 *                     guard). Legitimate.
 *   different-view    the file was seen before but through a DIFFERENT view — another
 *                     Read range, another sed/head range, grep vs cat. Pagination of a
 *                     big file is the recommended pattern, not a duplicate.
 *   distant           same view again, but the last copy is > --distant turns ago —
 *                     plausibly an attention refresh in a long session. Gray zone.
 *   pure-dup          same view again, recent copy still in context. Avoidable.
 *
 * Also answers "is Claude Code re-reading after every edit?" directly: for each
 * Edit/Write, does a read of the same file follow within --edit-window turns?
 * And counts the harness's forced re-reads (Edit rejected with "has been modified" /
 * "must use Read first").
 *
 * Reads = Read tool + shell read-verbs (cat/sed/head/tail/Get-Content …) whose
 * command names a file path (via chunk-kind's fileKey).
 *
 *   node scripts/reread-causes.mjs --days 3 [--project x] [--session id]
 *        [--distant 60] [--edit-window 3] [--json]
 */
import { readFileSync } from "fs";
import { reach } from "./lib/reach.mjs";
import { basename, dirname } from "path";
import { discover, extractMeta, projectIdentity } from "./lib/sessions.mjs";
import { fileKey } from "./lib/chunk-kind.mjs";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const projectQ = (opt("--project", "") || "").toLowerCase();
const sessionQ = (opt("--session", "") || "").toLowerCase();
const days = parseInt(opt("--days", "3"), 10);
const DISTANT = parseInt(opt("--distant", "60"), 10);
const EDITWIN = parseInt(opt("--edit-window", "3"), 10);
const asJson = flag("--json");
const windowStartMs = days > 0 ? Date.now() - days * 86400000 : 0;

const TOK = (s) => Math.ceil((s || "").length / 4);
const READ_VERB = /(^|[\s;&|("'])(cat|head|tail|sed|grep|rg|bat|Get-Content|gc|type)\b/;
const norm = (p) => (p || "").replace(/\\/g, "/").toLowerCase();

const CLASSES = ["after-own-edit", "post-compaction", "pre-edit-refresh", "different-view", "distant", "pure-dup"];
const tally = Object.fromEntries(CLASSES.map((c) => [c, { n: 0, tok: 0 }]));
let firstReads = 0, rereads = 0, editsTotal = 0, editsFollowedByRead = 0, forcedRereadErrors = 0;
let sessions = 0;
const perFileDupTok = new Map(); // naive waste.mjs-style count, for comparison

reach.begin("reread-causes", { days, project: projectQ });
for (const s of discover("claude")) {

  reach.found(s.provider, s.profile, s.sessionId);
  if (windowStartMs && s.mtime.getTime() < windowStartMs) { reach.exclude("outside the --days window"); continue; }
  const folder = basename(dirname(s.path));
  if (sessionQ && !s.sessionId.toLowerCase().includes(sessionQ) && !folder.toLowerCase().includes(sessionQ)) { reach.exclude("other --session"); continue; }
  let content; try { content = readFileSync(s.path, "utf-8"); } catch { reach.exclude("unreadable"); continue; }
  reach.file(s.path);
  const meta = extractMeta("claude", content);
  const id = projectIdentity(meta.cwd || "");
  if (projectQ && ![folder, meta.cwd, id.project, id.projectKey].join(" ").toLowerCase().includes(projectQ)) { reach.exclude("other --project"); continue; }

  // pass 1: chronological event list  {turn, kind:'read'|'edit'|'compact', file, uid}
  const events = [];
  const uidTok = new Map(); // tool_use_id -> result tokens
  let turn = 0, turns = 0;
  for (const ln of content.split("\n")) {
    if (!ln) continue;
    let o; try { o = JSON.parse(ln); } catch { reach.badLine(); continue; }
    const m = o.message;
    if (o.type === "assistant" && m) {
      if (m.usage) { turn++; turns++; }
      if (!Array.isArray(m.content)) continue;
      for (const b of m.content) {
        if (b.type !== "tool_use") continue;
        const inp = b.input || {};
        if (b.name === "Read" && inp.file_path)
          // the view signature: two Reads only duplicate each other when the RANGE matches
          events.push({ turn, kind: "read", file: norm(inp.file_path), uid: b.id,
            sig: `read:${inp.offset || 0}+${inp.limit || 0}` });
        else if ((b.name === "Edit" || b.name === "Write" || b.name === "MultiEdit" || b.name === "NotebookEdit") && inp.file_path)
          events.push({ turn, kind: "edit", file: norm(inp.file_path), uid: b.id });
        else if ((b.name === "Bash" || b.name === "PowerShell") && typeof inp.command === "string" && READ_VERB.test(inp.command)) {
          const k = fileKey(b.name, inp.command);
          // shell view signature = the whole normalized command: `sed -n '1,100p' f`
          // and `sed -n '100,200p' f` are pagination, not a duplicate; only the exact
          // same command repeated re-fetches content already in context
          if (k && !k.startsWith("bash:")) events.push({ turn, kind: "read", file: norm(k), uid: b.id,
            sig: "sh:" + inp.command.replace(/\s+/g, " ").trim() });
        }
      }
    } else if (o.type === "user" && m) {
      if (o.isCompactSummary) events.push({ turn, kind: "compact" });
      const c = m.content;
      if (Array.isArray(c)) for (const b of c) {
        if (b.type !== "tool_result") continue;
        const text = Array.isArray(b.content) ? b.content.map((x) => x.text || "").join(" ") : String(b.content || "");
        if (b.tool_use_id) uidTok.set(b.tool_use_id, TOK(text));
        if (b.is_error && /has been modified|must use (the )?Read|has not been read|Read the file first|read it first/i.test(text))
          forcedRereadErrors++;
      }
    }
  }
  if (turns < 3) continue;
  sessions++;

  // pass 2: classify every re-read; measure edit -> read-within-window
  const lastRead = new Map();   // file -> turn of last read (any view)
  const lastSig = new Map();    // file+sig -> turn this exact view was last fetched
  const lastEdit = new Map();   // file -> turn of last edit
  let lastCompact = -1;
  const nextEditAfter = (file, fromTurn) => {
    for (const e of events) if (e.kind === "edit" && e.file === file && e.turn > fromTurn && e.turn <= fromTurn + EDITWIN) return true;
    return false;
  };
  for (const e of events) {
    if (e.kind === "compact") { lastCompact = e.turn; continue; }
    if (e.kind === "edit") {
      lastEdit.set(e.file, e.turn);
      editsTotal++;
      if (events.some((r) => r.kind === "read" && r.file === e.file && r.turn > e.turn && r.turn <= e.turn + EDITWIN)) editsFollowedByRead++;
      continue;
    }
    // read
    const prev = lastRead.get(e.file);
    const tok = uidTok.get(e.uid) || 0;
    const sigKey = e.file + "|" + e.sig;
    if (prev === undefined) { firstReads++; lastRead.set(e.file, e.turn); lastSig.set(sigKey, e.turn); continue; }
    rereads++;
    perFileDupTok.set(e.file, (perFileDupTok.get(e.file) || 0) + tok);
    const le = lastEdit.get(e.file) ?? -1;
    const prevSig = lastSig.get(sigKey);
    let cls;
    if (le >= prev && le <= e.turn) cls = "after-own-edit";
    else if (lastCompact > prev && lastCompact <= e.turn) cls = "post-compaction";
    else if (nextEditAfter(e.file, e.turn)) cls = "pre-edit-refresh";
    else if (prevSig === undefined) cls = "different-view";
    else if (e.turn - prevSig > DISTANT) cls = "distant";
    else cls = "pure-dup";
    tally[cls].n++; tally[cls].tok += tok;
    lastRead.set(e.file, e.turn);
    lastSig.set(sigKey, e.turn);
  }
}

const fmt = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "K" : String(Math.round(n));
const pct = (x, tot) => tot ? (100 * x / tot).toFixed(0) + "%" : "0%";
const totalRe = CLASSES.reduce((a, c) => a + tally[c].n, 0);
const totalTok = CLASSES.reduce((a, c) => a + tally[c].tok, 0);

if (asJson) {
  console.log(JSON.stringify({ reach: reach.toJSON(),
    scope: { project: projectQ || "(all)", session: sessionQ || "(all)", days, distant: DISTANT, editWindow: EDITWIN },
    sessions, firstReads, rereads, byClass: tally,
    editsTotal, editsFollowedByRead, forcedRereadErrors,
  }, null, 2));
  process.exit(0);
}

console.log(`\nRe-read causes — project:${projectQ || "(all)"}  window:${days}d  (Claude; Read tool + shell read-verbs)`);
console.log(reach.line());
if (!sessions) { console.log("No matching Claude sessions in window.\n"); process.exit(0); }
console.log(`${sessions} sessions · ${firstReads} first reads · ${rereads} re-reads (${pct(rereads, firstReads + rereads)} of all reads)\n`);
const P = (s, w) => String(s).padStart(w);
console.log("WHY FILES GOT RE-READ (n = re-read events, tok = re-read result tokens)");
console.log("  " + "class".padEnd(18) + P("n", 6) + P("share", 7) + P("tok", 8) + P("tok%", 7) + "   verdict");
const verdict = { "after-own-edit": "legitimate — refresh after own change / harness stale-guard",
  "post-compaction": "legitimate — earlier copy summarized away",
  "pre-edit-refresh": `legitimate — read enables an edit within ${EDITWIN} turns`,
  "different-view": "legitimate-ish — new range/view of a known file (pagination)",
  distant: `gray — same view, last copy >${DISTANT} turns old (attention refresh)`,
  "pure-dup": "avoidable — same view, recent copy still in context" };
for (const c of CLASSES)
  console.log("  " + c.padEnd(18) + P(tally[c].n, 6) + P(pct(tally[c].n, totalRe), 7) + P(fmt(tally[c].tok), 8) + P(pct(tally[c].tok, totalTok), 7) + "   " + verdict[c]);

console.log(`\nDOES IT RE-READ AFTER EVERY EDIT?`);
console.log(`  ${editsTotal} Edit/Write calls · ${editsFollowedByRead} followed by a read of the same file within ${EDITWIN} turns (${pct(editsFollowedByRead, editsTotal)})`);
console.log(`  harness-forced re-reads (Edit rejected: stale/unread file): ${forcedRereadErrors}`);
console.log(`\nNote: waste.mjs's "dup-read waste" charges ALL ${rereads} re-reads; by this classification`);
console.log(`only the pure-dup share (${pct(tally["pure-dup"].tok, totalTok)} of re-read tokens) is clearly avoidable.\n`);
