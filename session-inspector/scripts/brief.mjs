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
 *   node scripts/brief.mjs <locator> --budget 3000       # trim harder (default 4500)
 *   node scripts/brief.mjs <locator> --no-repo           # skip git + tracking files
 *
 * `--for` is the TARGET harness. It changes the vocabulary of the prose and the
 * "how to continue" block, nothing else; `--for any` (the default) stays neutral.
 * `--out` prints only the path, so a launcher can capture it; `--seed-out` writes
 * the one-line pointer prompt that seeds the receiving session.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { basename, resolve as resolvePath } from "path";
import { summarize } from "./lib/parse.mjs";
import { handoffExtract, scratchpadInfo } from "./lib/handoff.mjs";
import { gitState, readRepoDocs } from "./lib/repo.mjs";
import { discover } from "./lib/sessions.mjs";
import {
  HARNESSES, buildModel, renderBrief, estimateTokens, codexHumanPrompts,
  sectionBullets, seedPrompt, TRIED_REJECTED_RE,
} from "./lib/brief.mjs";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const FLAGS_WITH_VALUE = ["--for", "--out", "--seed-out", "--budget", "--provider"];

const TARGET = (val("--for", "any") || "any").toLowerCase();
const BUDGET = parseInt(val("--budget", "4500"), 10) || 4500;
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

const cwd = summary.cwd || "";
const skipRepo = has("--no-repo") || !cwd;
const git = skipRepo ? null : gitState(cwd);
const docs = skipRepo ? null : readRepoDocs(cwd);
const continuePath = docs?.continueDoc?.exists ? docs.continueDoc.path : null;

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
});

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
