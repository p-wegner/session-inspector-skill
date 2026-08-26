import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyHumanText, fileKey, bashVerb, shortPath, padTail } from "../lib/chunk-kind.mjs";

test("fileKey pulls the first file path out of a shell command, else bash:<verb>", () => {
  const cases = [
    ["Bash", "cd /c/x && cat packages/server/src/services/git-http.service.ts | head", "packages/server/src/services/git-http.service.ts"],
    ["Bash", "sed -n '1,110p' drive-review-effectiveness.ts", "drive-review-effectiveness.ts"],
    ["Bash", "python - <<'PY'\nimport sys; print(sys.stdin.read())\nPY", "bash:python"],
    ["Bash", "S=/tmp/x node scripts/foo.mjs --json", "scripts/foo.mjs"],
    ["Bash", "git status", "bash:git"],
    ["Bash", "sleep 295; echo waited", "bash:sleep"],
    ["Bash", "X=1 && for f in a b; do echo $f; done", "bash:echo"],
    ["Bash", "for f in *.md; do wc -l $f; done", "bash:wc"],
    ["PowerShell", "Get-Content C:\\projects\\andrena\\x\\monitor-setup.ts -Tail 40", "C:\\projects\\andrena\\x\\monitor-setup.ts"],
    ["Read", "C:\\a\\b.ts", "C:\\a\\b.ts"],
    ["Bash", "", ""],
  ];
  for (const [t, w, exp] of cases) assert.equal(fileKey(t, w), exp, JSON.stringify(w));
});

test("bashVerb skips assignments, operators, cd-prefixes and shell keywords", () => {
  assert.equal(bashVerb("cd a && cd b; npm test"), "npm");
  assert.equal(bashVerb("FOO=1 BAR=2 node x.mjs"), "node");
  assert.equal(bashVerb("while true; do curl x; done"), "curl");
  assert.equal(bashVerb("/usr/bin/env python3 -c 1"), "python3");
});

test("classifyHumanText separates harness content from human text", () => {
  const skill = classifyHumanText("Base directory for this skill: C:\\Users\\p\\.claude\\skills\\session-inspector\n# T");
  assert.equal(skill.kind, "skill_inject");
  assert.equal(skill.where, "skill:session-inspector");
  assert.equal(classifyHumanText("This session is being continued from a previous conversation that ran out of context.").kind, "compaction");
  assert.equal(classifyHumanText("<summary>\nstuff").kind, "compaction");
  assert.equal(classifyHumanText("You are taking over work from a session that hit its usage limit.").kind, "handoff_brief");
  assert.equal(classifyHumanText("<system-reminder>x</system-reminder>").kind, "harness_inject");
  assert.equal(classifyHumanText("fix the bug").kind, "user_prompt");
  assert.equal(classifyHumanText("x".repeat(6000)).kind, "user_paste");
  assert.equal(classifyHumanText("hello", { pasteMinTok: 0 }).kind, "user_paste");
});

test("shortPath keeps root + tail (basename and nearest ancestors), drops the middle", () => {
  const p = "C:/projects/andrena/agentic-kanban/.claude/worktrees/agentic-kanban/ak-903/packages/server/src/services/pre-merge-gate.service.ts";
  const s = shortPath(p, 60);
  assert.ok(s.length <= 60, s);
  assert.ok(s.startsWith("C:/…/"), s);
  assert.ok(s.endsWith("pre-merge-gate.service.ts"), s);
  assert.ok(s.includes("services/"), s);
  assert.equal(shortPath("short.ts", 60), "short.ts");
  assert.equal(shortPath("", 10), "");
  const w = shortPath("C:\\a\\.worktrees\\ak-903\\x.ts", 20);
  assert.ok(w.endsWith("x.ts") && w.length <= 20, w);
});

test("padTail keeps the identifying tail of long labels", () => {
  const a = padTail("C--projects-andrena--worktrees-agentic-kanban-ak-903", 30);
  const b = padTail("C--projects-andrena--worktrees-agentic-kanban-ak-904", 30);
  assert.notEqual(a, b);
  assert.ok(a.endsWith("ak-903") && a.length === 30, a);
  assert.equal(padTail("short", 8), "short   ");
});
