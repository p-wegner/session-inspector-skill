#!/usr/bin/env node
/**
 * BRIEF — write a harness-neutral handoff brief for ONE session, to be read by a
 * DIFFERENT agent than the one that produced it (claude → codex, codex → claude).
 *
 * A session id cannot cross harnesses; a brief can. The judgement lives in
 * lib/brief.mjs (and is tested there) — this file resolves the session and does
 * the IO.
 *
 * Usage:
 *   node scripts/brief.mjs <path|session-id-prefix>      # provider auto-detected
 *   node scripts/brief.mjs --latest [--provider claude]  # newest session on this box
 *   node scripts/brief.mjs <locator> --for codex         # translate the vocabulary
 *   node scripts/brief.mjs <locator> --out brief.md --seed-out seed.txt
 *   node scripts/brief.mjs <locator> --json              # the same content, structured
 *   node scripts/brief.mjs <locator> --budget 3000       # trim harder (default 4500, grows with tool calls)
 *   node scripts/brief.mjs <locator> --no-repo           # skip git + tracking files
 *   node scripts/brief.mjs <locator> --gaps              # what CONTINUE/BACKLOG do not record
 *
 * `--for` is the TARGET harness. It changes the vocabulary of the prose and the
 * "how to continue" block, nothing else; `--for any` (the default) stays neutral.
 * `--out` prints only the path, so a launcher can capture it; `--seed-out` writes
 * the one-line pointer prompt that seeds the receiving session.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { basename, dirname, resolve as resolvePath } from "path";
import { summarize } from "./lib/parse.mjs";
import { handoffExtract, scratchpadInfo } from "./lib/handoff.mjs";
import { gitState, readRepoDocs } from "./lib/repo.mjs";
import { discover } from "./lib/sessions.mjs";
import { sessionFacts } from "./lib/session-facts.mjs";
import { rankRepos, docsDirFor, history as gitHistory, remoteOf, editLanding, toplevel, touchesCode, landedArchivePath, struckIn, laterTouches, tagsSince } from "./lib/work-repo.mjs";
import { findSuccessors } from "./lib/successor.mjs";
import { docGaps, renderGaps, staleCounts } from "./lib/doc-gaps.mjs";
import {
  HARNESSES, buildModel, renderBrief, estimateTokens, codexHumanPrompts,
  sectionBullets, seedPrompt, TRIED_REJECTED_RE, repoRelativeFiles, matchOpenToLater, matchLanded, ticketLedger,
} from "./lib/brief.mjs";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const FLAGS_WITH_VALUE = ["--for", "--out", "--seed-out", "--budget", "--provider"];

const TARGET = (val("--for", "any") || "any").toLowerCase();
// A 15-hour, 800-call operator session carries more state than a 40-call one; at a
// flat 4500 its machine state and closing checklist were the sections cut. The default
// grows with the session, to 6500 at most. `--budget` still wins.
const BUDGET_ARG = parseInt(val("--budget", "0"), 10) || 0;
if (!HARNESSES.includes(TARGET)) {
  console.error(`--for must be one of ${HARNESSES.join(", ")} (got "${TARGET}")`);
  process.exit(2);
}

// ── resolve the session ──────────────────────────────────────────────────────
// A path if it is one, else the newest session, else a session-id prefix. The
// provider comes from whatever the discovery found it under: guessing it from the
// file shape would be a second source of truth for something already known.
function resolveTarget() {
  const positional = argv.find((a, i) => !a.startsWith("--") && !FLAGS_WITH_VALUE.includes(argv[i - 1]));
  const provider = val("--provider", "all");

  if (positional && existsSync(positional)) {
    const abs = resolvePath(positional);
    const found = discover(provider).find((x) => resolvePath(x.path) === abs);
    if (found) return found;
    // A path outside the known trees: infer the harness from the layout.
    const guessed = abs.includes(".codex") ? "codex" : abs.includes(".copilot") ? "copilot" : "claude";
    return { provider: guessed, path: abs, sessionId: basename(abs).replace(/\.jsonl$/, ""), profile: "" };
  }

  const all = discover(provider);
  if (!all.length) { console.error("no sessions found on this machine"); process.exit(1); }
  if (has("--latest") || !positional) return all[0];

  const needle = positional.replace(/\.jsonl$/i, "").toLowerCase();
  const hit = all.find((x) => String(x.sessionId).toLowerCase().startsWith(needle))
    || all.find((x) => String(x.sessionId).toLowerCase().includes(needle))
    || all.find((x) => x.path.toLowerCase().includes(needle));
  if (!hit) { console.error(`no session matches "${positional}" (tried id prefix, id substring, path substring)`); process.exit(1); }
  return hit;
}

const target = resolveTarget();
const content = readFileSync(target.path, "utf-8");
const summary = summarize(target.provider, content);
if (!summary) { console.error(`cannot summarize a "${target.provider}" transcript`); process.exit(1); }

const sessionCwd = summary.cwd || "";
const lines = content.split("\n");
const facts = target.provider === "claude" ? sessionFacts(lines) : null;
const skipRepo = has("--no-repo") || !sessionCwd;

// The work repo is where the session WROTE, which is not always where it started.
const ranked = skipRepo ? [] : rankRepos(facts ? facts.dirs : [], sessionCwd);
const workRoot = ranked.length ? ranked[0].root : "";
const cwd = workRoot || sessionCwd;
const topWriteDir = facts && facts.dirs.find((d) => d.writes && workRoot && d.dir.toLowerCase().startsWith(workRoot.toLowerCase()));
const docsDir = skipRepo ? "" : docsDirFor(topWriteDir ? topWriteDir.dir : sessionCwd, cwd);
const git = skipRepo ? null : gitState(cwd);
const docs = skipRepo ? null : readRepoDocs(docsDir || cwd);
const work = skipRepo ? null : {
  root: cwd, sessionCwd,
  differsFromCwd: Boolean(workRoot && !ranked[0].isCwd),
  remote: remoteOf(cwd),
  others: ranked.slice(1).filter((r) => r.writes > 0),
};
const hist = skipRepo ? null : gitHistory(cwd, summary.startTime, summary.endTime, content, facts ? facts.commitCommands : 0, facts ? facts.commits.map((c) => c.sha) : []);
const tags = skipRepo ? [] : tagsSince(cwd, summary.endTime);
const written = repoRelativeFiles([...(summary.filesEdited || []), ...(summary.filesWritten || [])], cwd);
const landing = skipRepo ? null : editLanding(cwd, written, summary.startTime, summary.endTime);
// Has another session already picked this one up? Same evidence ladder the
// resume tools use: ledger and brief are proof, a mention is a hint.
const successors = target.provider === "claude"
  ? (findSuccessors([{ sessionId: summary.sessionId || target.sessionId, path: target.path, endTime: summary.endTime }], discover("claude"), { order: "nearest" })
    .get(summary.sessionId || target.sessionId) || [])
  : [];
// Files written where git sees nothing: profile config, a skill junction's target
// outside the tree, a settings file. Scratch space is excluded — it has its own line.
const outside = skipRepo ? [] : [...new Set([...(summary.filesEdited || []), ...(summary.filesWritten || [])])]
  .filter((f) => !/(?:[\\/]|^)(?:Temp|tmp|scratchpad)(?:[\\/]|$)/i.test(f))
  .filter((f) => !toplevel(dirname(f)));
const continuePath = docs?.continueDoc?.exists ? docs.continueDoc.path : null;
const docPaths = [docs?.continueDoc, docs?.backlogDoc, docs?.local?.continueDoc, docs?.local?.backlogDoc]
  .filter((d) => d && d.exists).map((d) => d.path);
const docText = docPaths.map((p) => readFileSync(p, "utf-8")).join("\n\n");
// A count quoted in the tracking file or a commit body that the last run no longer
// matches: the successor measured on this trusted the prose over the tally.
const countWarnings = facts ? [
  ...staleCounts(docText, facts.tests).map((w) => ({ ...w, where: "the tracking file" })),
  ...(hist ? hist.during : []).flatMap((c) => staleCounts(`${c.subject} ${c.body || ""}`, facts.tests).map((w) => ({ ...w, where: `commit \`${c.sha}\`` }))),
] : [];

// What exists because of it, and the later commit that absorbed it if it did not
// commit itself.
const createdRel = facts ? repoRelativeFiles(facts.created || [], cwd) : [];
const bodyOf = new Map([...(hist ? [...hist.during, ...hist.after] : [])].map((c) => [c.sha, c]));
const built = {
  created: createdRel.slice(0, 14), createdMore: Math.max(0, createdRel.length - 14),
  absorbedBy: (landing ? landing.after : []).map((c) => ({ sha: c.sha, subject: c.subject, body: (bodyOf.get(c.sha) || {}).body || "" })),
};
// What it left open: its unchecked closing items and the BACKLOG entries it added.
const openItems = facts ? [
  ...(facts.closingChecklist?.open || []),
  ...(facts.trackingWrites || []).filter((w) => /BACKLOG/i.test(w.file))
    .flatMap((w) => [...w.text.matchAll(/^#{2,3}\s+(.+)$/gm)].map((x) => x[1])),
] : [];
const openUnique = [...new Set(openItems)];
// Which later commits are on the checked-out branch. `history()` reads --all, and in a
// repo where agents push feature branches most of them are not: measured, 194 "later
// commits" of which 61 were on master, and a reader who spot-checked the list
// concluded master had not moved at all.
if (hist && (hist.after.length || hist.during.length) && summary.endTime) {
  let onHead = null;   // null = unknown (git failed): nothing is marked off-branch
  try {
    onHead = new Set(execFileSync("git", ["-C", cwd, "rev-list", "--abbrev-commit", "--abbrev=10", `--since=${summary.startTime || summary.endTime}`, "HEAD"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000 })
      .split("\n").map((s) => s.trim()).filter(Boolean));
  } catch { /* unknown */ }
  if (onHead) {
    const has = (sha) => [...onHead].some((h) => h.startsWith(sha) || sha.startsWith(h));
    for (const c of hist.after) c.onHead = has(c.sha);
    for (const c of hist.during) c.onHead = has(c.sha);
    hist.onHeadCount = hist.after.filter((c) => c.onHead).length;
  }
}
const tickets = facts && (facts.tickets.length || facts.createdRecords.length)
  ? ticketLedger(facts.tickets, facts.createdRecords, hist ? hist.during : [], hist ? hist.after : [], { max: 200 }) : [];
// Later commits that changed its files, beyond the ones that committed its own edits.
const touchedLater = hist && hist.after.length
  ? laterTouches(cwd, summary.endTime, written).filter((c) => !(landing ? landing.after : []).some((a) => a.sha === c.sha))
  : [];
const landedPath = skipRepo ? "" : landedArchivePath(cwd);
// Struck in the repo's own archive, with the commit that wrote the strike. A strike
// written before the session ended is the session's own closure, not later work.
const endMs = summary.endTime ? Date.parse(summary.endTime) : Infinity;
const landedMatches = (landedPath && hist && hist.after.length ? matchLanded(openUnique, readFileSync(landedPath, "utf-8")) : [])
  .map((x) => ({ ...x, by: struckIn(cwd, (x.landed.match(/~~.+?~~/) || [x.landed])[0]) }))
  .filter((x) => !x.by || Date.parse(x.by.when) > endMs);
const landedSet = new Set(landedMatches.map((x) => x.item));
const openMatches = hist && hist.after.length
  ? matchOpenToLater(openUnique.filter((i) => !landedSet.has(i)), hist.after, { touchesCode: (sha) => touchesCode(cwd, sha) }) : [];

const model = buildModel({
  provider: target.provider, target: TARGET,
  sessionId: target.sessionId, transcript: target.path, profile: target.profile || "",
  summary, cwd, git, docs,
  // A codex session has no background tools, no delegated helper runs and no
  // scratchpad; passing null makes the brief say that rather than imply nothing was
  // left running.
  machine: target.provider === "claude" ? handoffExtract(content.split("\n")) : null,
  scratch: target.provider === "claude" ? scratchpadInfo(target.path, summary.sessionId) : null,
  humanPrompts: target.provider === "codex" ? codexHumanPrompts(content) : [],
  triedRejected: sectionBullets(continuePath, TRIED_REJECTED_RE),
  facts, work, history: hist, landing, successors, outside, countWarnings, built, openMatches, landedMatches, touchedLater, tickets, tags,
});

// ── --gaps: what the tracking files do not record ────────────────────────────
// The same facts, turned around: not "what does a successor need" but "what did
// this session learn that its CONTINUE.md / BACKLOG.md never got". Run it before
// writing the closing pass, or on someone else's session to see what exists only
// in the transcript.
if (has("--gaps")) {
  if (!facts) { console.error("--gaps reads a Claude transcript; this session is " + target.provider); process.exit(2); }
  const paths = docPaths;
  const g = docGaps(facts, docText, {
    commits: hist ? hist.during : [], remote: work ? work.remote : null,
    isOutside: (f) => outside.includes(f),
    scratchSecrets: model.machine?.scratchpad?.secrets || [],
  });
  const text = renderGaps(g, { docPaths: paths, sessionId: summary.sessionId || target.sessionId });
  if (val("--out")) writeFileSync(val("--out"), text, "utf-8");
  console.log(has("--json") ? JSON.stringify({ docs: paths, ...g }, null, 2) : (val("--out") || text));
  process.exit(0);
}

const BUDGET = BUDGET_ARG || Math.min(6500, 4500 + Math.floor(Math.max(0, (summary.toolCalls || 0) - 200) * 3.5));
const out = renderBrief(model, { budget: BUDGET });
const est = estimateTokens(out);
const outPath = val("--out");
if (outPath) writeFileSync(outPath, out, "utf-8");

if (has("--json")) {
  console.log(JSON.stringify({ ...model, markdown: out, estimatedTokens: est, writtenTo: outPath || null }, null, 2));
} else if (outPath) {
  console.log(outPath);                                   // stdout is the path alone, for a launcher
  console.error(`brief: ~${est} tokens (budget ${BUDGET})`);
} else {
  console.log(out);
  console.log(`\n_Brief size: ~${est} tokens (budget ${BUDGET})._`);
}

const seedOut = val("--seed-out");
if (seedOut) {
  if (!outPath) {
    console.error("--seed-out needs --out: the seed is a pointer to the brief file, so the brief has to exist somewhere");
    process.exit(2);
  }
  writeFileSync(seedOut, seedPrompt(target.provider, outPath), "utf-8");
  if (!has("--json")) console.error(`seed: ${seedOut}`);
}
