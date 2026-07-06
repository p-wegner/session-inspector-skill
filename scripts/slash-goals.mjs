#!/usr/bin/env node
/**
 * What was the agent ASKED to do, and through which entry points?
 *
 * Two questions in one pass, because they answer each other:
 *   - GOALS: per session, the human's intent — custom title, else ai-title,
 *     else slug, else the first real typed prompt. Sorted by turns so the
 *     marathon sessions (the expensive ones) surface first.
 *   - SLASH COMMANDS: every `/command` the human invoked (parsed from
 *     <command-name> tags and leading-slash prompts). This includes the
 *     session-hygiene commands — `/clear`, `/compact`, `/model` — whose
 *     ABSENCE explains runaway context (no /clear = one marathon session).
 *   - SKILL INVOCATIONS: every Skill tool the agent fired (superpowers/*,
 *     custom skills). A workflow built on brainstorming -> writing-plans ->
 *     subagent-driven-development front-loads big design/plan docs and spawns
 *     Agents that dump large results — which is often WHY context balloons.
 *
 * So: goals tell you the intent, slash tells you the hygiene, skills tell you
 * the mechanism. Read alongside context-growth.mjs (the effect).
 *
 * Claude transcripts only. Usage:
 *   node scripts/slash-goals.mjs --project papershift
 *   node scripts/slash-goals.mjs --days 30 --top 20
 *   node scripts/slash-goals.mjs --json
 */

import { readFileSync } from "fs";
import { basename, dirname } from "path";
import { discover, extractMeta, projectIdentity } from "./lib/sessions.mjs";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const projectQ = (opt("--project", "") || "").toLowerCase();
const days = parseInt(opt("--days", "0"), 10);
const top = parseInt(opt("--top", "15"), 10);
const asJson = flag("--json");
const windowStartMs = days > 0 ? Date.now() - days * 86400000 - 86400000 : 0;

const HYGIENE = new Set(["clear", "compact", "model", "effort", "login", "exit"]);
const textOf = (c) => typeof c === "string" ? c : Array.isArray(c) ? c.map(b => b.text || "").join("") : "";

const slash = new Map(), skill = new Map(), goals = [];
const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);

const sessions = discover("claude");
for (const s of sessions) {
  if (windowStartMs && s.mtime.getTime() < windowStartMs) continue;
  let content; try { content = readFileSync(s.path, "utf-8"); } catch { continue; }
  const meta = extractMeta("claude", content);
  const id = projectIdentity(meta.cwd || "");
  const folder = basename(dirname(s.path));
  if (projectQ && ![folder, meta.cwd, id.project, id.projectKey].join(" ").toLowerCase().includes(projectQ)) continue;

  let title = "", slug = "", first = "", turns = 0;
  for (const ln of content.split("\n")) {
    if (!ln.trim()) continue;
    let o; try { o = JSON.parse(ln); } catch { continue; }
    if (o.customTitle) title = o.customTitle;
    if (o.aiTitle && !title) title = o.aiTitle;
    if (o.slug) slug = o.slug;
    if (o.type === "assistant") {
      turns++;
      for (const b of (Array.isArray(o.message?.content) ? o.message.content : []))
        if (b.type === "tool_use" && b.name === "Skill") bump(skill, b.input?.skill || "?");
    }
    if (o.type === "user" && o.message) {
      const c = o.message.content, txt = textOf(c);
      const m = txt.match(/<command-name>\s*\/?([^<\s]+)/) || txt.match(/^\/([a-zA-Z][\w:-]*)/);
      if (m) bump(slash, m[1]);
      if (!first && typeof c === "string" && !c.startsWith("<") && c.trim()) first = c.trim().replace(/\s+/g, " ").slice(0, 80);
    }
  }
  if (!turns) continue;
  goals.push({ id: s.sessionId.slice(0, 8), project: id.project || folder, turns, goal: title || slug || first || "(untitled)" });
}

const sortMap = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]);

if (asJson) {
  console.log(JSON.stringify({
    scope: { project: projectQ || null, days: days || null },
    slashCommands: sortMap(slash).map(([cmd, n]) => ({ cmd, n, hygiene: HYGIENE.has(cmd) })),
    skillInvocations: sortMap(skill).map(([skill, n]) => ({ skill, n })),
    goals: goals.sort((a, b) => b.turns - a.turns),
  }, null, 2));
} else {
  console.log("=== SLASH COMMANDS (human-invoked) ===");
  console.log("  (hygiene = clear/compact/model/… — their absence explains runaway context)");
  for (const [cmd, n] of sortMap(slash))
    console.log("  /" + cmd.padEnd(30) + String(n).padStart(4) + (HYGIENE.has(cmd) ? "  [hygiene]" : ""));
  if (!slash.size) console.log("  (none)");

  console.log("\n=== SKILL INVOCATIONS (agent-fired) ===");
  for (const [sk, n] of sortMap(skill)) console.log("  " + sk.padEnd(40) + String(n).padStart(4));
  if (!skill.size) console.log("  (none)");

  console.log(`\n=== SESSION GOALS (top ${top} by turns) ===`);
  for (const g of goals.sort((a, b) => b.turns - a.turns).slice(0, top))
    console.log("  " + (g.turns + "t").padStart(6) + "  " + g.id + "  " + g.project.slice(0, 24).padEnd(25) + g.goal.slice(0, 58));
}
