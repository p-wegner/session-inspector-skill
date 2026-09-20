#!/usr/bin/env node
/**
 * Render the agent feature matrix from lib/harness.mjs.
 *
 * The matrix used to be maintained by hand off the script headers and said so ("re-check
 * a cell against the script before relying on it"). It is generated now, and
 * test/harness.test.mjs fails if the checked-in file differs — so a cell cannot drift
 * from the code that decides it.
 *
 *   node scripts/harness-matrix.mjs            # print the markdown
 *   node scripts/harness-matrix.mjs --write     # write ../docs/agent-feature-matrix.md
 *   node scripts/harness-matrix.mjs --check     # exit 1 if the checked-in file differs
 *   node scripts/harness-matrix.mjs --json      # the registry, for another tool
 */
import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { FACTS, HARNESS, PROVIDERS, TOOLS, SECTIONS, EXTRA_STORES, cell } from "./lib/harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const DOC_PATH = join(here, "..", "..", "docs", "agent-feature-matrix.md");

const MARK = { y: "y", cand: "cand", "n/a": "n/a" };

function render() {
  const L = [];
  L.push("# Agent feature matrix — session-inspector");
  L.push("");
  L.push("**Generated** by `session-inspector/scripts/harness-matrix.mjs --write` from");
  L.push("`scripts/lib/harness.mjs`, and pinned by `scripts/test/harness.test.mjs`. Edit the registry,");
  L.push("not this file. A cell is derived from what the agent's transcript carries crossed with what");
  L.push("the tool needs, so it cannot disagree with the code.");
  L.push("");
  L.push("**Policy.** Build a Codex or Copilot variant when that agent has sessions **and** someone asks");
  L.push("a question the tool answers. Symmetry is not a reason. Claude Code is the reference");
  L.push("implementation and stays the most advanced on purpose: a second agent is cheapest to add by");
  L.push("naming what it lacks. Claude-only concepts (subagent transcripts, the skill-listing and");
  L.push("nested-memory attachments, compaction rows, cache pricing, hooks) are deliberately not");
  L.push("abstracted — an interface written for one implementation guesses wrong at the second.");
  L.push("");
  L.push("Legend: **y** wired today · **cand** the data is there, nobody has asked for it ·");
  L.push("**n/a** the agent records no such thing (the reason is in the notes).");
  L.push("");

  L.push("## What each agent's transcript carries");
  L.push("");
  L.push(`| Fact | ${PROVIDERS.map((p) => HARNESS[p].label).join(" | ")} |`);
  L.push(`|---|${PROVIDERS.map(() => "---").join("|")}|`);
  for (const [fact, desc] of Object.entries(FACTS)) {
    const cells = PROVIDERS.map((p) => (HARNESS[p].facts[fact] === true ? "y" : "—"));
    L.push(`| \`${fact}\` — ${desc} | ${cells.join(" | ")} |`);
  }
  L.push("");
  L.push("Layouts: " + PROVIDERS.map((p) => `**${HARNESS[p].label}** \`${HARNESS[p].layout}\``).join(" · ") + ".");
  L.push("");
  L.push("Read outside this matrix: " + Object.entries(EXTRA_STORES).map(([k, v]) => `**${k}** — ${v}`).join(" · ") + ".");
  L.push("");

  for (const [key, title] of Object.entries(SECTIONS)) {
    const rows = TOOLS.filter((t) => t.section === key);
    if (!rows.length) continue;
    L.push(`## ${title}`);
    L.push("");
    L.push(`| Tool | ${PROVIDERS.map((p) => HARNESS[p].label).join(" | ")} | Notes |`);
    L.push(`|---|${PROVIDERS.map(() => "---").join("|")}|---|`);
    for (const t of rows) {
      const cells = PROVIDERS.map((p) => MARK[cell(t.tool, p).state]);
      // one entry per REASON, naming the agents that share it — the same sentence twice
      // reads as two findings
      const byReason = new Map();
      for (const p of PROVIDERS) {
        const c = cell(t.tool, p);
        if (c.state !== "n/a") continue;
        byReason.set(c.why, [...(byReason.get(c.why) || []), p]);
      }
      const reasons = [...byReason].map(([why, ps]) => `${ps.join("/")}: ${why}`);
      const note = [t.note, ...reasons].filter(Boolean).join("; ").replace(/\|/g, "\|");
      L.push(`| \`${t.tool}\` | ${cells.join(" | ")} | ${note} |`);
    }
    L.push("");
  }

  L.push("## Adding an agent");
  L.push("");
  L.push("1. A `HARNESS` entry in `scripts/lib/harness.mjs`: the layout, and a reason string for every");
  L.push("   fact the agent does not record. The reason is what a refusal prints, so write it for");
  L.push("   someone who just got told no.");
  L.push("2. Discovery and parsing: `lib/sessions.mjs` and `lib/parse.mjs` branch per agent today. Split");
  L.push("   them into one module per agent only when a second agent needs a verb — the seam is three");
  L.push("   verbs (discover, meta, events+usage), not thirty.");
  L.push("3. Nothing else. Every tool's cell in the tables above appears on its own, as `cand` or `n/a`,");
  L.push("   and a tool that cannot answer refuses with `refuse(tool, agent)` rather than printing a zero.");
  L.push("");
  return L.join("\n");
}

const argv = process.argv.slice(2);
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  if (argv.includes("--json")) {
    const out = { facts: FACTS, harness: HARNESS, tools: TOOLS.map((t) => ({ ...t, cells: Object.fromEntries(PROVIDERS.map((p) => [p, cell(t.tool, p)])) })) };
    console.log(JSON.stringify(out, null, 2));
  } else if (argv.includes("--write")) {
    writeFileSync(DOC_PATH, render(), "utf8");
    console.log(`wrote ${DOC_PATH}`);
  } else if (argv.includes("--check")) {
    const have = readFileSync(DOC_PATH, "utf8");
    if (have !== render()) { console.error("docs/agent-feature-matrix.md is stale — run: node scripts/harness-matrix.mjs --write"); process.exit(1); }
    console.log("matrix is current");
  } else {
    console.log(render());
  }
}

export { render };
