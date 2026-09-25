/**
 * node --test scripts/test/cowork.test.mjs
 *
 * Claude Desktop sessions. Cowork keeps one Claude Code home per task inside the app's
 * data dir; the Desktop Code tab writes into ~/.claude like the CLI. Discovery has to
 * find the first, and the `entrypoint` a transcript carries has to tell all of them
 * apart, because the folder cannot. Layout and entrypoint values measured on
 * Claude Desktop 2.9939.2, 2026-09-25.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { coworkAppDirs, coworkProjectDirs, isCoworkPath, profileOfProjectsDir, authProfiles } from "../lib/config.mjs";
import { surfaceOf, sessionSurface, coworkTask, extractMeta } from "../lib/sessions.mjs";

const TASK = "0a1b2c3d";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "si-cowork-"));
  const app = join(root, "Claude-3p");
  const org = join(app, "local-agent-mode-sessions", "9f8e7d6c", "00000000");
  const projects = join(org, TASK, ".claude", "projects");
  mkdirSync(join(projects, "session"), { recursive: true });
  const transcript = join(projects, "session", "11111111-2222-4333-8444-555555555555.jsonl");
  writeFileSync(transcript, JSON.stringify({ type: "user", entrypoint: "local-agent", sessionId: "11111111", message: { content: "hi" } }) + "\n");
  writeFileSync(join(org, `local_${TASK}-aaaa-4bbb-8ccc-dddddddddddd.json`), JSON.stringify({ sessionId: `local_${TASK}-aaaa`, title: "Fruit notes", model: "Claude Sonnet 5", initialMessage: "hi" }));
  // a directory that is not a task home must not be picked up
  mkdirSync(join(org, "memory"), { recursive: true });
  return { root, app, projects, transcript };
}

test("entrypoint -> surface, for every value seen on a real box", () => {
  assert.equal(surfaceOf("cli"), "cli");
  assert.equal(surfaceOf("sdk-cli"), "sdk");
  assert.equal(surfaceOf("sdk-ts"), "sdk");
  assert.equal(surfaceOf("claude-desktop"), "desktop");
  assert.equal(surfaceOf("claude-desktop-3p"), "desktop-3p");
  assert.equal(surfaceOf("local-agent"), "cowork");
  assert.equal(surfaceOf(""), "");
  assert.equal(surfaceOf("something-new"), "something-new", "an unknown value passes through, never guessed");
});

test("a Cowork task under Claude-3p is cowork-3p, under the subscription app plain cowork", () => {
  const sub = "C:/Users/x/AppData/Roaming/Claude/local-agent-mode-sessions/a/b/c/.claude/projects";
  const gw = "C:\\Users\\x\\AppData\\Local\\Claude-3p\\local-agent-mode-sessions\\a\\b\\c\\.claude\\projects";
  assert.ok(isCoworkPath(sub) && isCoworkPath(gw));
  assert.ok(!isCoworkPath("C:/Users/x/.claude/projects"));
  assert.equal(profileOfProjectsDir(sub), "cowork");
  assert.equal(profileOfProjectsDir(gw), "cowork-3p");
  assert.equal(profileOfProjectsDir("C:/Users/x/.claude/projects"), "default", "unchanged for a normal home");
  assert.equal(sessionSurface(gw + "/session/x.jsonl", { surface: "cowork" }), "cowork-3p");
  assert.equal(sessionSurface(sub + "/session/x.jsonl", { surface: "cowork" }), "cowork");
  assert.equal(sessionSurface("C:/Users/x/.claude/projects/p/x.jsonl", { surface: "desktop-3p" }), "desktop-3p");
});

test("discovery finds each task's home, and only task homes", (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const before = process.env.COWORK_APP_DIRS;
  process.env.COWORK_APP_DIRS = f.app;
  try {
    assert.deepEqual(coworkAppDirs(), [f.app]);
    assert.deepEqual(coworkProjectDirs(), [f.projects]);
    process.env.COWORK_APP_DIRS = "none";
    assert.deepEqual(coworkProjectDirs(), []);
  } finally {
    if (before === undefined) delete process.env.COWORK_APP_DIRS; else process.env.COWORK_APP_DIRS = before;
  }
});

test("the task's own record gives the title; anything else gives null", (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const task = coworkTask(f.transcript);
  assert.equal(task.title, "Fruit notes");
  assert.equal(task.model, "Claude Sonnet 5");
  assert.equal(coworkTask("C:/Users/x/.claude/projects/p/x.jsonl"), null);
  const meta = extractMeta("claude", '{"type":"user","entrypoint":"local-agent","message":{"content":"hi"}}\n');
  assert.equal(meta.entrypoint, "local-agent");
  assert.equal(meta.surface, "cowork");
});

test("Cowork homes are never listed as an auth profile", (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const before = process.env.CLAUDE_PROJECT_DIRS;
  process.env.CLAUDE_PROJECT_DIRS = f.projects;
  try {
    assert.deepEqual(authProfiles({ includeDefault: true }), []);
  } finally {
    if (before === undefined) delete process.env.CLAUDE_PROJECT_DIRS; else process.env.CLAUDE_PROJECT_DIRS = before;
  }
});
