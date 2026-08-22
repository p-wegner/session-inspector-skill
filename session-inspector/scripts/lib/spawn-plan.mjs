/**
 * The spawn-plan contract, and where the launcher lives.
 *
 * This file only exists because the two halves are now ONE repo. While they were
 * separate, `continuations.mjs` (which writes plans) and `spawn-session/batch.mjs`
 * (which launches them) each had their own copy of the schema check, and the
 * launcher path was a hardcoded `C:\projects\andrena\spawn-session\spawn.cmd` in
 * four places. Both were the cost of the split, not decisions worth keeping.
 *
 * The plan file stays a plain, versioned JSON document: it is written by one tool,
 * edited by a HUMAN in between, and read by another, so it has to be legible and
 * hand-editable rather than clever.
 *
 * Node builtins only.
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

export const SCHEMA = "spawn-plan/1";

const HERE = dirname(fileURLToPath(import.meta.url));      // session-inspector/scripts/lib
// Up three: lib -> scripts -> session-inspector -> repo root. The two skills are
// SIBLINGS under that root, so the launcher is a peer directory, not a child of
// this one — which is why this counts three levels and not two.
const REPO_ROOT = resolve(HERE, "..", "..", "..");

/**
 * Absolute path to spawn.cmd. Resolved relative to this file, so a clone anywhere
 * works — and so does a junctioned copy, which is how these skills are installed.
 * Falls back to the historical location for an older checkout that still has the
 * two repos side by side.
 */
export function spawnCmdPath() {
  const inRepo = join(REPO_ROOT, "spawn-session", "spawn.cmd");
  if (existsSync(inRepo)) return inRepo;
  // Older layouts: the launcher nested inside the inspector skill (2026-08-22),
  // and before that a separate repo beside it.
  for (const legacy of [
    join(REPO_ROOT, "session-inspector", "spawn-session", "spawn.cmd"),
    join(REPO_ROOT, "..", "spawn-session", "spawn.cmd"),
  ]) {
    if (existsSync(legacy)) return resolve(legacy);
  }
  const old = "C:\\projects\\andrena\\spawn-session\\spawn.cmd";
  return existsSync(old) ? old : inRepo;         // report the expected path when absent
}

/** Is the launcher actually installed? Callers must degrade, not pretend. */
export function haveSpawnCmd() {
  return existsSync(spawnCmdPath());
}

/**
 * Read and validate a plan. Returns {ok, plan, error} rather than throwing, so a
 * CLI can print one clean line and pick its own exit code.
 */
export function readPlan(path) {
  if (!existsSync(path)) return { ok: false, error: `no such plan file: ${path}` };
  let plan;
  try { plan = JSON.parse(readFileSync(path, "utf-8")); }
  catch (e) { return { ok: false, error: `plan is not valid JSON: ${e.message}` }; }
  if (plan.schema !== SCHEMA) {
    return { ok: false, error: `unexpected plan schema "${plan.schema}" (expected "${SCHEMA}")` };
  }
  if (!Array.isArray(plan.candidates)) {
    return { ok: false, error: "plan has no candidates array" };
  }
  return { ok: true, plan };
}

export function writePlan(path, plan) {
  writeFileSync(path, `${JSON.stringify(plan, null, 2)}\n`, "utf-8");
}

/**
 * The gate, in one place: only entries a human marked `approved: true` may launch.
 * Kept here rather than in the launcher so that both sides agree on what approval
 * means, and so it is obvious in review that nothing else can pass.
 */
export function approvedEntries(plan) {
  return (plan.candidates || []).filter((c) => c.approved === true);
}

/** The instructions to print when a plan has nothing approved. Not an error. */
export function gateHelp(planPath, scriptHint = "node scripts/continuations.mjs") {
  return [
    "This is the human gate, not an error. Someone has to pick:",
    `  interactive : ${scriptHint} --review "${planPath}"`,
    `  explicit    : ${scriptHint} --approve "${planPath}" --pick 1,3`,
  ];
}
