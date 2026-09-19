/**
 * session-compact: a fork whose tool traffic is cut while the conversation is kept.
 * Each test pins a rule the 2026-09-19 measurement depended on:
 *   1. the line set, uuid chain and every prompt / assistant text are byte-identical after;
 *   2. pairs mode keeps the SHAPE of a tool_use input and the tool_result id + is_error;
 *   3. the last prompt's calls are verbatim (`recent`), and fewer prompts than `recent`
 *      means nothing changes (the bug that made the first measurement compare two
 *      compacted copies and call them equal);
 *   4. narrate mode is one line each way and still a valid tool_use / tool_result pair;
 *   5. the sidecar fields shrink type-preservingly; sessionId is rewritten everywhere;
 *   6. an error result keeps more; a compaction summary is not a prompt.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { compactTranscript, cutString, shrinkStrings, headTail, describeCall, describeResult } from "../lib/compact.mjs";

const J = (o) => JSON.stringify(o);
let n = 0;
const uuid = () => `u${++n}`;
const big = (label, lines = 200) => Array.from({ length: lines }, (_, i) => `${label} line ${i + 1}: ${"x".repeat(40)}`).join("\n");

function transcript() {
  n = 0;
  const L = [];
  let parent = null;
  const push = (o) => { const u = uuid(); L.push({ ...o, uuid: u, parentUuid: parent, sessionId: "old-id" }); parent = u; };
  const prompt = (text) => push({ type: "user", message: { role: "user", content: text } });
  const call = (id, name, input) => push({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] }, wireToolInputs: { [id]: input } });
  const result = (id, content, extra = {}, is_error = false) =>
    push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error }] }, toolUseResult: extra });
  const text = (t) => push({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: t }] } });

  prompt("build the thing");
  call("t1", "Read", { file_path: "C:\\repo\\src\\a.ts" });
  result("t1", big("a.ts"), { type: "text", file: { filePath: "C:\\repo\\src\\a.ts", content: big("a.ts"), numLines: 200 } });
  call("t2", "Bash", { command: "cd /c/repo && node --test test/*.mjs 2>&1 | tail -20", description: "Run the tests" });
  result("t2", "Error: Cannot find module\n" + big("stack", 30), { stdout: "", stderr: big("stack", 30), interrupted: false }, true);
  call("t3", "Write", { file_path: "C:\\repo\\src\\b.ts", content: big("b.ts", 80) });
  result("t3", "File created successfully at: C:\\repo\\src\\b.ts", { type: "create", filePath: "C:\\repo\\src\\b.ts", content: big("b.ts", 80) });
  text("Done with the first part.");
  prompt("now the second thing");
  call("t4", "Edit", { file_path: "C:\\repo\\src\\a.ts", old_string: big("old", 20), new_string: big("new", 20) });
  result("t4", "The file C:\\repo\\src\\a.ts has been updated. Here's the result of running `cat -n`:\n" + big("cat", 50), { filePath: "C:\\repo\\src\\a.ts", originalFile: big("orig", 200), structuredPatch: [] });
  text("Second part done.\n- [x] a\n- [ ] b");
  return L.map(J);
}

const parse = (lines) => lines.map((l) => JSON.parse(l));
const blocks = (objs, type) => objs.flatMap((o) => (Array.isArray(o.message?.content) ? o.message.content.filter((b) => b.type === type) : []));

test("the line set, uuid chain, prompts and assistant text survive untouched", () => {
  const src = transcript();
  const { lines } = compactTranscript(src, { recent: 0 });
  assert.equal(lines.length, src.length);
  const a = parse(src), b = parse(lines);
  assert.deepEqual(b.map((o) => [o.uuid, o.parentUuid]), a.map((o) => [o.uuid, o.parentUuid]));
  const texts = (objs) => objs.map((o) => (typeof o.message?.content === "string" ? o.message.content : blocks([o], "text").map((t) => t.text).join("|")));
  assert.deepEqual(texts(b), texts(a));
});

test("pairs mode keeps the input's shape, the ids and is_error, and cuts the bulk", () => {
  const src = transcript();
  const { lines, stats } = compactTranscript(src, { recent: 0 });
  const uses = blocks(parse(lines), "tool_use");
  assert.deepEqual(uses.map((u) => u.id), ["t1", "t2", "t3", "t4"]);
  assert.deepEqual(Object.keys(uses[3].input), ["file_path", "old_string", "new_string"], "an Edit keeps its keys");
  assert.match(uses[3].input.old_string, /session-compact: \d+ chars, \d+ lines cut/);
  assert.equal(uses[0].input.file_path, "C:\\repo\\src\\a.ts", "a short string passes through");
  assert.match(uses[2].input.content, /^\[session-compact: 80 lines, \d+ chars\] b\.ts line 1/, "Write content becomes a one-line note");
  const results = blocks(parse(lines), "tool_result");
  assert.deepEqual(results.map((r) => [r.tool_use_id, r.is_error]), [["t1", false], ["t2", true], ["t3", false], ["t4", false]]);
  assert.match(results[0].content, /^a\.ts line 1:.*\n… \[session-compact: \d+ chars, \d+ lines omitted\] …\n.*a\.ts line 200/s, "head, marker, tail");
  assert.equal(results[2].content, "File created successfully at: C:\\repo\\src\\b.ts", "a short result is untouched");
  assert.equal(stats.compacted, 4);
  assert.ok(stats.after.toolResult < stats.before.toolResult / 4, `results shrank ${stats.before.toolResult} → ${stats.after.toolResult}`);
  assert.ok(stats.saved > 0.5);
});

test("an error result keeps twice the head and tail of a normal one", () => {
  const src = transcript();
  const { lines } = compactTranscript(src, { recent: 0, head: 100, tail: 50 });
  const [ok, err] = blocks(parse(lines), "tool_result");
  const kept = (s) => s.replace(/\n… \[session-compact:[^\]]*\] …\n/, "").length;
  assert.equal(kept(ok.content), 150);
  assert.equal(kept(err.content), 300);
  assert.match(err.content, /^Error: Cannot find module/);
});

test("the calls after the last prompt stay verbatim, and fewer prompts than `recent` changes nothing", () => {
  const src = transcript();
  const r1 = compactTranscript(src, { recent: 1 });
  const uses = blocks(parse(r1.lines), "tool_use");
  assert.equal(uses[3].input.old_string, big("old", 20), "the Edit after the last prompt is untouched");
  assert.match(uses[0].input.file_path, /a\.ts/);
  assert.equal(r1.stats.compacted, 3);
  assert.equal(r1.stats.kept, 1);
  const r9 = compactTranscript(src, { recent: 9 });
  assert.deepEqual(r9.lines, src, "two prompts, recent 9: every line is the original");
  assert.equal(r9.stats.compacted, 0);
});

test("a compaction summary does not count as a prompt", () => {
  const src = transcript();
  const objs = parse(src);
  objs.push({ type: "user", isCompactSummary: true, uuid: "s", parentUuid: objs[objs.length - 1].uuid, sessionId: "old-id", message: { role: "user", content: "This session is being continued from a previous conversation…" } });
  const { stats } = compactTranscript(objs.map(J), { recent: 1 });
  assert.equal(stats.prompts, 2);
  assert.equal(stats.kept, 1, "the summary did not move the cut-off");
});

test("narrate mode is one line each way and still a tool_use / tool_result pair", () => {
  const src = transcript();
  const { lines, stats } = compactTranscript(src, { recent: 0, mode: "narrate" });
  const uses = blocks(parse(lines), "tool_use");
  const results = blocks(parse(lines), "tool_result");
  assert.deepEqual(uses.map((u) => u.id), ["t1", "t2", "t3", "t4"]);
  assert.deepEqual(uses.map((u) => Object.keys(u.input)), [["session-compact"], ["session-compact"], ["session-compact"], ["session-compact"]]);
  assert.equal(uses[0].input["session-compact"], "Read repo/src/a.ts");
  assert.match(uses[1].input["session-compact"], /^Bash: cd \/c\/repo && node --test .* — Run the tests$/);
  assert.match(uses[2].input["session-compact"], /^Write repo\/src\/b\.ts \(80 lines, \d+ chars\)$/);
  assert.match(uses[3].input["session-compact"], /^Edit repo\/src\/a\.ts: "old line 1: x+" → "new line 1: x+"$/);
  assert.equal(results[0].content, "[session-compact] 200 lines");
  assert.match(results[1].content, /^\[session-compact\] ERROR: Error: Cannot find module \(\+30 lines\)$/);
  assert.equal(results[1].is_error, true);
  assert.equal(results[2].content, "[session-compact] File created successfully at: C:\\repo\\src\\b.ts");
  for (const r of results) assert.equal(r.content.split("\n").length, 1);
  assert.ok(stats.after.toolResult < 400, `narrated results total ${stats.after.toolResult} chars`);
});

test("sidecar fields shrink type-preservingly and the session id is rewritten on every line", () => {
  const src = transcript();
  const { lines } = compactTranscript(src, { recent: 0, sessionId: "new-id" });
  const objs = parse(lines);
  assert.ok(objs.every((o) => o.sessionId === "new-id"));
  const read = objs.find((o) => o.toolUseResult?.file);
  assert.equal(typeof read.toolUseResult.file.content, "string");
  assert.equal(read.toolUseResult.file.numLines, 200, "a number stays a number");
  assert.ok(read.toolUseResult.file.content.length < 400);
  const edit = objs.find((o) => o.toolUseResult?.originalFile);
  assert.ok(Array.isArray(edit.toolUseResult.structuredPatch), "an array stays an array");
  const wire = objs.find((o) => o.wireToolInputs?.t4);
  assert.ok(wire.wireToolInputs.t4.old_string.length < 400);
  assert.ok(lines.every((l) => !l.includes("old-id")));
});

test("the helpers", () => {
  assert.equal(cutString("short", 10), "short");
  assert.match(cutString("y".repeat(300), 100), /^y{100}… \[session-compact: 200 chars, 1 lines cut\]$/);
  assert.deepEqual(shrinkStrings({ a: [1, "z".repeat(300), { b: null }] }, 50).a[2], { b: null });
  assert.equal(headTail("abc", 1, 1), "abc");
  assert.equal(describeCall("Grep", { pattern: "foo", path: "C:\\r\\src", glob: "*.ts" }), "Grep /foo/ in C:/r/src (*.ts)");
  assert.equal(describeCall("Agent", { subagent_type: "Explore", description: "find the callers" }), "Agent Explore: find the callers");
  assert.equal(describeResult("Bash", "a\nb\nc\nd", false), "4 lines; first: a; last: d");
  assert.equal(describeResult("Bash", "   ", false), "(no output)");
});
