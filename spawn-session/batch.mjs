#!/usr/bin/env node
/**
 * Launch a whole APPROVED plan of sessions in one call, and refuse everything
 * else. Two jobs:
 *
 *   1. Collapse the repetition. Spawning four continuations by hand is four
 *      near-identical invocations, each with a long `-m` that cannot safely
 *      cross bash → cmd (measured: a prompt containing parentheses died with
 *      `"plus" kann syntaktisch an dieser Stelle nicht verarbeitet werden`).
 *      Here every message travels as a FILE, which closes that class.
 *   2. Be the hard half of the human gate. A plan is written unapproved by
 *      session-inspector's `continuations.mjs`; this launches ONLY entries a
 *      person marked `approved: true`. If an agent skips the conversation, the
 *      plan is all `false` and nothing spawns — the gate cannot be forgotten,
 *      only deliberately answered.
 *
 * Plan format is `spawn-plan/1` (see continuations.mjs). Deliberately read with
 * plain JSON.parse and no shared code: the generator lives in another repo, and
 * a versioned flat file is the whole contract.
 *
 * Usage:
 *   node batch.mjs <plan.json> [--dry-run] [--force] [--no-wait] [--sequential]
 *     --dry-run     print what would launch, spawn nothing
 *     --force       ignore the capacity refusal (never the approval gate)
 *     --no-wait     do not wait for each session to register on the ACP bus
 */
import { writeFileSync, existsSync } from "fs";
import { join, dirname, resolve } from "path";
import { tmpdir } from "os";
import { execFileSync, spawnSync } from "child_process";
import { fileURLToPath } from "url";
// One repo now, so the schema, the validation and the gate are shared with the
// tool that WRITES these plans instead of being a second copy of both.
import { readPlan, approvedEntries, gateHelp } from "../session-inspector/scripts/lib/spawn-plan.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const INSPECTOR = resolve(HERE, "..", "session-inspector", "scripts");

const argv = process.argv.slice(2);
const has = (n) => argv.includes(n);
const planPath = argv.find((a) => !a.startsWith("-"));
const dryRun = has("--dry-run") || has("-n");
const force = has("--force");
const noWait = has("--no-wait");

if (!planPath) {
  console.error("usage: batch.mjs <plan.json> [--dry-run] [--force] [--no-wait]");
  console.error("");
  console.error("Write a plan first:");
  console.error(`  node "${join(INSPECTOR, "continuations.mjs")}" --plan plan.json`);
  process.exit(1);
}
const read = readPlan(planPath);
if (!read.ok) { console.error(`[batch] ${read.error}`); process.exit(1); }
const plan = read.plan;

const all = plan.candidates;
const approved = approvedEntries(plan);

// ── the gate ────────────────────────────────────────────────────────────────
if (!approved.length) {
  console.error(`[batch] NOTHING APPROVED — refusing to launch (${all.length} candidate(s) in the plan).`);
  console.error("");
  for (const line of gateHelp(planPath, `node "${join(INSPECTOR, "continuations.mjs")}"`)) console.error(line);
  process.exit(3);
}

// ── capacity, once for the whole batch ──────────────────────────────────────
// Asking per spawn would be both slower and wrong: N sessions need room for N,
// and the answer must be computed before the first one is started.
let room = null;
let roomNote = "";
try {
  const out = execFileSync("node", [join(HERE, "preflight.mjs"), "--pick-profile", "--json"], {
    encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 90000,
  });
  JSON.parse(out); // warms the snapshot cache preflight shares
} catch { /* capacity stays unknown */ }
try {
  const out = execFileSync("node", [join(HERE, "preflight.mjs"), "--target", approved[0].target, "--json"], {
    encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 90000,
  });
  const r = JSON.parse(out);
  const cap = [...(r.findings || []), ...(r.refusals || [])].find((f) => f.check === "capacity");
  const m = cap && /~?(-?\d+) more/.exec(cap.detail || "");
  if (m) room = parseInt(m[1], 10);
  roomNote = cap?.detail || "";
} catch (e) {
  // exit code 3 means a refusal was printed as JSON on stdout; parse it anyway
  try {
    const r = JSON.parse(e.stdout || "{}");
    const cap = [...(r.findings || []), ...(r.refusals || [])].find((f) => f.check === "capacity");
    roomNote = cap?.detail || "";
    if (/no RAM headroom/.test(roomNote)) room = 0;
  } catch { /* unknown */ }
}
if (room !== null && approved.length > room && !force && !dryRun) {
  console.error(`[batch] REFUSE: ${approved.length} session(s) approved but ${roomNote}.`);
  console.error("[batch]   Free memory, approve fewer (--pick), or pass --force to override.");
  process.exit(3);
}

console.log(`[batch] ${approved.length} approved of ${all.length}${room !== null ? `  ·  capacity: ${roomNote}` : ""}`);
console.log("");

// ── launch ──────────────────────────────────────────────────────────────────
const spawnCmd = join(HERE, "spawn.cmd");
const receipts = [];

for (const c of approved) {
  const label = `${c.key} → ${c.profile || "(inherit)"}`;
  if (!c.target || !existsSync(c.target)) {
    receipts.push({ key: c.key, status: "skipped", note: `target does not exist: ${c.target}` });
    console.log(`[batch] SKIP ${label} — target does not exist: ${c.target}`);
    continue;
  }

  // The message travels as a FILE, never on a command line. wt splits on ';'
  // after cmd quoting is satisfied, and cmd itself mangles parentheses — a path
  // contains nothing either of them reinterprets.
  const msgFile = join(tmpdir(), `spawn-plan-${c.key.replace(/[^\w.-]/g, "_")}-${process.pid}-${receipts.length}.txt`);
  try { writeFileSync(msgFile, c.message || "", "utf-8"); } catch (e) {
    receipts.push({ key: c.key, status: "failed", note: `could not stage message: ${e.message}` });
    continue;
  }

  const args = [c.target, "-mf", msgFile];
  if (c.profile) args.push("-p", c.profile);
  if (!noWait) args.push("-wait");
  if (force) args.push("-force");
  if (dryRun) args.push("-n");

  console.log(`[batch] launching ${label}`);
  const res = spawnSync(process.env.COMSPEC || "cmd.exe", ["/c", spawnCmd, ...args], {
    encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 240000,
  });
  const out = `${res.stdout || ""}${res.stderr || ""}`;
  process.stdout.write(out.split("\n").map((l) => (l.trim() ? `        ${l}` : l)).join("\n"));

  const agent = (out.match(/handed off to (\S+)/) || [])[1] || "";
  const refused = /\[preflight\] REFUSE/.test(out);
  receipts.push({
    key: c.key,
    status: dryRun ? "dry-run" : refused ? "refused" : res.status === 0 ? "launched" : "failed",
    agent,
    profile: c.profile,
    target: c.target,
    note: refused ? "preflight refused" : (res.status === 0 ? "" : `exit ${res.status}`),
  });
}

// ── receipt ─────────────────────────────────────────────────────────────────
console.log("");
console.log("─".repeat(74));
console.log("BATCH RECEIPT");
console.log("─".repeat(74));
for (const r of receipts) {
  const mark = { launched: "✓", "dry-run": "·", refused: "⛔", skipped: "–", failed: "✗" }[r.status] || "?";
  console.log(`  ${mark} ${String(r.key).padEnd(26)} ${String(r.profile || "").padEnd(8)} ${r.agent || r.note || r.status}`);
}
const launched = receipts.filter((r) => r.status === "launched");
console.log("");
console.log(`${launched.length} launched, ${receipts.length - launched.length} not.`);
if (launched.length) {
  console.log("Reach any of them:  node \"C:/projects/andrena/acp/acp.js\" send --to <agent> --msg \"...\"");
}
process.exit(receipts.some((r) => r.status === "failed") ? 1 : 0);
