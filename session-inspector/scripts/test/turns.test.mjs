import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyCommand, commandCategories, stripHeredocs, stripQuoted, stats, histogram } from "../lib/turns.mjs";

// The two corrections below are the whole reason classification is not a regex over
// the raw command: each one moved "when did it first verify" by minutes.

test("a heredoc that WRITES a package.json is not a test run", () => {
  const cmd = `cat > package.json <<'EOF'
{ "name": "tt", "scripts": { "test": "vitest run" } }
EOF`;
  assert.equal(classifyCommand(cmd), "write");
});

test("a capacity probe that greps the process table for vitest is not a test run", () => {
  const cmd = `Get-CimInstance Win32_Process | Where-Object CommandLine -match 'vitest'`;
  assert.notEqual(classifyCommand(cmd), "test");
});

test("a commit message naming tests is a git command", () => {
  assert.equal(classifyCommand(`git commit -m "feat: add tests for the timer"`), "git");
});

test("a real runner invocation is a test run", () => {
  assert.equal(classifyCommand("timeout 300 npx vitest run --maxWorkers=2"), "test");
  assert.equal(classifyCommand("npm test"), "test");
  assert.equal(classifyCommand("pytest -n 4"), "test");
});

test("a compound command gets every category, most load-bearing first", () => {
  const cats = commandCategories("sed -i 's/a/b/' src/x.ts && npx tsc --noEmit | head -20 && npx vitest run");
  assert.equal(cats[0], "test", "a call that edits then tests counts as a test run");
  assert.ok(cats.includes("typecheck"));
  assert.ok(cats.includes("inspect"));
});

test("leading noise does not hide the verb", () => {
  assert.equal(classifyCommand("cd C:/repo; timeout 120 npx tsc --noEmit"), "typecheck");
  assert.equal(classifyCommand("CI=1 npm run build"), "build");
});

test("stripHeredocs survives an unterminated body (a truncated command)", () => {
  const out = stripHeredocs("python - <<'PY'\nprint('vitest')");
  assert.ok(!out.includes("vitest"));
});

test("stripQuoted keeps the command but blanks its literals", () => {
  assert.equal(stripQuoted(`grep -E "×|FAIL" file`), 'grep -E "" file');
});

test("an empty or unknown command is `other`, never forced into a bucket", () => {
  assert.equal(classifyCommand(""), "other");
  assert.equal(classifyCommand("whoami"), "other");
});

test("stats reports percentiles, not just a mean", () => {
  const s = stats([1, 2, 3, 4, 100]);
  assert.equal(s.n, 5);
  assert.equal(s.median, 3);
  assert.equal(s.max, 100);
  assert.ok(s.mean > s.median, "the outlier moves the mean and not the median — which is why both are printed");
});

test("histogram bins are half-open and total to the input count", () => {
  const bins = histogram([0, 49, 50, 99, 100, 1e6]);
  assert.equal(bins.reduce((a, b) => a + b.count, 0), 6);
  assert.equal(bins.find((b) => b.lo === 0 && b.hi === 50).count, 2);
});
