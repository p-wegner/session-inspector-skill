#!/usr/bin/env node
/**
 * Edit the user/assistant messages of a Claude Code session transcript.
 *
 * Two phases, so the actual editing happens in YOUR editor, not in a flag:
 *
 *   1. extract  — flatten the .jsonl into a readable, delimited text file
 *   2. (edit)   — open that file, change the text under any [edit] header
 *   3. apply    — write the changes back into the .jsonl, in place
 *
 * The extracted file carries the source path + a sha256 of the source, so
 * `apply` refuses to run against a transcript that changed underneath you.
 *
 * Usage:
 *   node scripts/session-edit.mjs extract --latest [-o edits.md]
 *   node scripts/session-edit.mjs extract <path.jsonl> [--include-thinking] [--include-tool-results]
 *   node scripts/session-edit.mjs extract --session 874e3950 --profile andrena_team_5x
 *   node scripts/session-edit.mjs apply edits.md [--dry-run] [--no-backup] [--force]
 *
 * Editable by default: human prompts (`user` string content) and assistant
 * `text` blocks. Thinking / tool_use / tool_result blocks are emitted as
 * truncated [read-only] context and are never written back — opt them in with
 * --include-thinking / --include-tool-results.
 *
 * Never deletes lines: the uuid/parentUuid chain is left exactly as-is, so
 * `claude --resume <id>` still walks the transcript. Text is rewritten in place.
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, renameSync, copyFileSync } from "fs";
import { join, resolve, basename } from "path";
import { homedir } from "os";
import { createHash } from "crypto";

const FORMAT_VERSION = 2;
// v1 had no per-block hashes, so it can't tell an appended line from a rewritten
// block; it falls back to refusing any sha mismatch without --force.
const SUPPORTED_VERSIONS = new Set([1, 2]);
const DELIM = "@@@";
// A transcript this fresh is probably still being written by a live agent.
const LIVE_WINDOW_MS = 120_000;
const RO_MAX_LINES = 10;
const RO_MAX_CHARS = 600;

// ── session resolution (mirrors analyze-claude-session.mjs) ─────────────────

function resolveConfigDir(argv) {
  const cd = argv[argv.indexOf("--config-dir") + 1];
  if (argv.includes("--config-dir") && cd) return cd;
  const pf = argv[argv.indexOf("--profile") + 1];
  if (argv.includes("--profile") && pf) return join(homedir(), `.claude-${pf}`);
  if (process.env.CLAUDE_CONFIG_DIR) return process.env.CLAUDE_CONFIG_DIR;
  return join(homedir(), ".claude");
}

function listSessions(argv) {
  const base = join(resolveConfigDir(argv), "projects");
  const out = [];
  if (!existsSync(base)) return out;
  for (const dir of readdirSync(base)) {
    const dirPath = join(base, dir);
    let files;
    try { files = readdirSync(dirPath).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
    for (const f of files) {
      const p = join(dirPath, f);
      out.push({ path: p, id: f.replace(/\.jsonl$/, ""), dir, modified: statSync(p).mtime });
    }
  }
  return out.sort((a, b) => b.modified - a.modified);
}

function resolveTarget(argv, positional) {
  if (argv.includes("--latest")) {
    const s = listSessions(argv);
    if (!s.length) die("No sessions found under " + resolveConfigDir(argv));
    return s[0].path;
  }
  const idx = argv.indexOf("--session");
  if (idx >= 0 && argv[idx + 1]) {
    const want = argv[idx + 1];
    const hits = listSessions(argv).filter((s) => s.id.startsWith(want));
    if (!hits.length) die(`No session matching id prefix "${want}"`);
    if (hits.length > 1) die(`Ambiguous id prefix "${want}" — ${hits.length} matches:\n` + hits.map((h) => "  " + h.id).join("\n"));
    return hits[0].path;
  }
  if (positional) return resolve(positional);
  die("Need a session: <path.jsonl> | --latest | --session <id-prefix>");
}

// ── helpers ────────────────────────────────────────────────────────────────

function die(msg) { console.error("error: " + msg); process.exit(1); }
function sha256(buf) { return createHash("sha256").update(buf).digest("hex"); }

/** Short fingerprint of a block's ORIGINAL text, so apply can tell whether that
 *  specific block changed underneath the edit — as opposed to the transcript
 *  merely growing by an appended turn. */
function blockHash(text) { return sha256(Buffer.from(normalizeText(text), "utf-8")).slice(0, 8); }

/** The single normalization both extract and apply must agree on. */
function normalizeText(text) { return trimTrailingBlank(text.split("\n")).join("\n"); }

/** Dot-stuff body lines that would otherwise look like a delimiter header. */
function escapeBody(text) {
  return text.split("\n").map((l) => (/^\.*@@@/.test(l) ? "." + l : l)).join("\n");
}
function unescapeBody(text) {
  return text.split("\n").map((l) => (/^\.+@@@/.test(l) ? l.slice(1) : l)).join("\n");
}

/** Drop trailing blank lines (the separator we emit, plus any the editor added). */
function trimTrailingBlank(lines) {
  const out = lines.slice();
  while (out.length && out[out.length - 1].trim() === "") out.pop();
  return out;
}

function truncateForContext(text) {
  let lines = text.split("\n");
  let dropped = 0;
  if (lines.length > RO_MAX_LINES) { dropped = lines.length - RO_MAX_LINES; lines = lines.slice(0, RO_MAX_LINES); }
  let s = lines.join("\n");
  if (s.length > RO_MAX_CHARS) { s = s.slice(0, RO_MAX_CHARS); dropped = Math.max(dropped, 1); }
  return dropped ? s + `\n… [truncated, ${dropped} more line(s)]` : s;
}

/** Pull displayable text out of a tool_result block's content. */
function toolResultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((b) => b?.type === "text").map((b) => b.text).join("\n");
  return "";
}

// ── the block model ────────────────────────────────────────────────────────
//
// One "block" = one addressable, textual span in the transcript, identified by
// (uuid, index-within-message.content). For a user line with string content the
// index is 0 and the "block" is the whole message.

function collectBlocks(lines, opts) {
  const blocks = [];
  let seq = 0;
  lines.forEach((raw, lineNo) => {
    const t = raw.trim();
    if (!t) return;
    let o;
    try { o = JSON.parse(t); } catch { return; }
    if (o.type !== "user" && o.type !== "assistant") return;
    const content = o.message?.content;
    const uuid = o.uuid || "";

    const push = (kind, index, text, editable) =>
      blocks.push({ seq: ++seq, kind, uuid, index, lineNo, text, editable, ts: o.timestamp || "" });

    if (o.type === "user" && typeof content === "string") {
      // isMeta / <command-*> / <system-reminder> lines are machinery, not prompts.
      const machinery = o.isMeta === true || /^\s*<(command-|local-command|system-reminder)/.test(content);
      push("user", 0, content, !machinery);
      return;
    }
    if (!Array.isArray(content)) return;

    content.forEach((b, i) => {
      if (o.type === "user" && b?.type === "tool_result") {
        push("user.tool_result", i, toolResultText(b.content), !!opts.includeToolResults);
      } else if (o.type === "assistant" && b?.type === "text") {
        push("assistant.text", i, b.text ?? "", true);
      } else if (o.type === "assistant" && b?.type === "thinking") {
        push("assistant.thinking", i, b.thinking ?? "", !!opts.includeThinking);
      } else if (o.type === "assistant" && b?.type === "tool_use") {
        push(`assistant.tool_use:${b.name || "?"}`, i, JSON.stringify(b.input ?? {}, null, 2), false);
      }
    });
  });
  return blocks;
}

/** Write `text` into the block addressed by (uuid, index) on a parsed line object. */
function setBlockText(o, index, text) {
  const content = o.message?.content;
  if (typeof content === "string") { o.message.content = text; return true; }
  if (!Array.isArray(content)) return false;
  const b = content[index];
  if (!b) return false;
  if (b.type === "text") { b.text = text; return true; }
  if (b.type === "thinking") { b.thinking = text; return true; }
  if (b.type === "tool_result") {
    if (typeof b.content === "string") b.content = text;
    else if (Array.isArray(b.content)) {
      const first = b.content.find((x) => x?.type === "text");
      if (first) first.text = text;
      else b.content.push({ type: "text", text });
    } else b.content = text;
    return true;
  }
  return false;
}

// ── extract ────────────────────────────────────────────────────────────────

function cmdExtract(argv) {
  const positional = argv.slice(1).find((a, i) => !a.startsWith("--") && !VALUE_FLAGS.has(argv.slice(1)[i - 1]));
  const src = resolveTarget(argv, positional);
  if (!existsSync(src)) die("No such transcript: " + src);

  const opts = {
    includeThinking: argv.includes("--include-thinking"),
    includeToolResults: argv.includes("--include-tool-results"),
  };
  const buf = readFileSync(src);
  const lines = buf.toString("utf-8").split("\n");
  const blocks = collectBlocks(lines, opts);
  if (!blocks.length) die("No user/assistant messages found in " + src);

  const editable = blocks.filter((b) => b.editable);
  const scope = ["user", "assistant.text"]
    .concat(opts.includeThinking ? ["assistant.thinking"] : [])
    .concat(opts.includeToolResults ? ["user.tool_result"] : []);

  const sessionId = basename(src).replace(/\.jsonl$/, "");
  const outArg = argv[argv.indexOf("-o") + 1] ?? argv[argv.indexOf("--out") + 1];
  const out = (argv.includes("-o") || argv.includes("--out")) && outArg
    ? resolve(outArg)
    : resolve(`${sessionId.slice(0, 8)}.session-edit.md`);

  const H = [];
  H.push(`${DELIM} session-edit v${FORMAT_VERSION}`);
  H.push(`${DELIM} source: ${src}`);
  H.push(`${DELIM} sha256: ${sha256(buf)}`);
  H.push(`${DELIM} session: ${sessionId}`);
  H.push(`${DELIM} scope: ${scope.join(",")}`);
  H.push(`${DELIM} blocks: ${editable.length} editable / ${blocks.length} total`);
  H.push(`${DELIM} ${"-".repeat(66)}`);
  H.push(`${DELIM} Edit the text under any [edit] header. Leave ${DELIM} header lines alone.`);
  H.push(`${DELIM} [read-only] bodies are truncated context and are never written back.`);
  H.push(`${DELIM} Body lines starting with ${DELIM} are escaped with a leading dot — keep it.`);
  H.push(`${DELIM} Then: node scripts/session-edit.mjs apply ${basename(out)}`);
  H.push(`${DELIM} ${"=".repeat(66)}`);

  const body = blocks.map((b) => {
    const tag = b.editable ? "[edit]" : "[read-only]";
    // Read-only bodies are truncated, so hashing them would be meaningless.
    const h = b.editable ? ` h=${blockHash(b.text)}` : "";
    const head = `${DELIM} ${b.seq} ${b.kind} ${b.uuid}#${b.index} ${tag}${h}`;
    const text = b.editable ? escapeBody(b.text) : escapeBody(truncateForContext(b.text));
    return `${head}\n${text}\n`;
  });

  writeFileSync(out, H.join("\n") + "\n\n" + body.join("\n"), "utf-8");
  console.log(`Extracted ${blocks.length} blocks (${editable.length} editable) → ${out}`);
  console.log(`Source: ${src}`);
  console.log(`\nEdit it, then: node ${basename(process.argv[1])} apply "${out}"`);
}

// ── parse an edited file back into blocks ──────────────────────────────────

const HEADER_RE = new RegExp(`^${DELIM} (\\d+) (\\S+) ([^#\\s]*)#(\\d+) \\[(edit|read-only)\\](?: h=([0-9a-f]{8}))?\\s*$`);

function parseEditFile(path) {
  const raw = readFileSync(path, "utf-8");
  const lines = raw.split("\n");
  const meta = {};
  const blocks = [];
  let cur = null;

  for (const line of lines) {
    const m = HEADER_RE.exec(line);
    if (m) {
      if (cur) blocks.push(cur);
      cur = { seq: +m[1], kind: m[2], uuid: m[3], index: +m[4], editable: m[5] === "edit", hash: m[6] || "", body: [] };
      continue;
    }
    if (cur) { cur.body.push(line); continue; }
    // still in the preamble
    const km = /^@@@ (source|sha256|session|scope|blocks):\s*(.*)$/.exec(line);
    if (km) meta[km[1]] = km[2].trim();
    const vm = /^@@@ session-edit v(\d+)\s*$/.exec(line);
    if (vm) meta.version = +vm[1];
  }
  if (cur) blocks.push(cur);

  for (const b of blocks) b.text = unescapeBody(trimTrailingBlank(b.body).join("\n"));
  return { meta, blocks, raw };
}

// ── apply ──────────────────────────────────────────────────────────────────

function cmdApply(argv) {
  const editPath = argv.slice(1).find((a) => !a.startsWith("--"));
  if (!editPath) die("Usage: session-edit.mjs apply <edits.md> [--dry-run] [--no-backup] [--force]");
  const p = resolve(editPath);
  if (!existsSync(p)) die("No such edit file: " + p);

  const dryRun = argv.includes("--dry-run");
  const force = argv.includes("--force");
  const { meta, blocks } = parseEditFile(p);

  if (!SUPPORTED_VERSIONS.has(meta.version)) die(`Unsupported edit-file version ${meta.version ?? "?"} (supported: ${[...SUPPORTED_VERSIONS].join(", ")})`);
  if (!meta.source) die("Edit file has no `@@@ source:` header — was it truncated?");
  const src = meta.source;
  if (!existsSync(src)) die("Source transcript is gone: " + src);
  if (!blocks.length) die("Edit file contains no block headers.");

  const buf = readFileSync(src);
  const nowSha = sha256(buf);

  // Guards protect the WRITE. --dry-run touches nothing, so it only warns.
  const guard = (msg) => {
    if (dryRun) return console.warn("warning: " + msg + "\n  (--dry-run: previewing anyway)");
    if (force) return console.warn("warning: " + msg);
    die(msg);
  };

  // Rebuild the block model from the CURRENT source so we compare like-for-like
  // (same normalization the extractor applied) and address lines by uuid#index.
  // Blocks are addressed by uuid, never by line offset, so lines APPENDED to the
  // transcript since extract are carried through untouched.
  const srcLines = buf.toString("utf-8").split("\n");
  const current = collectBlocks(srcLines, { includeThinking: true, includeToolResults: true });
  const byKey = new Map(current.map((b) => [`${b.uuid}#${b.index}`, b]));

  const changes = [];
  const conflicts = [];   // edited blocks whose ORIGINAL text moved underneath us
  let skippedReadonly = 0, unmatched = 0;

  for (const b of blocks) {
    if (!b.editable) { skippedReadonly++; continue; }
    const key = `${b.uuid}#${b.index}`;
    const cur = byKey.get(key);
    if (!cur) {
      console.warn(`warning: block ${b.seq} (${key}) not found in source — skipped`);
      unmatched++;
      conflicts.push(`#${b.seq} ${b.kind} — the block no longer exists in the transcript`);
      continue;
    }
    // v2 records a hash of each editable block's original text. If it still
    // matches, that block is untouched and is safe to rewrite regardless of
    // what else changed in the file.
    if (b.hash && b.hash !== blockHash(cur.text)) {
      conflicts.push(`#${b.seq} ${b.kind} — rewritten in the transcript after you extracted it`);
    }
    const before = normalizeText(cur.text);
    if (before === b.text) continue;
    changes.push({ seq: b.seq, kind: b.kind, key, lineNo: cur.lineNo, before, after: b.text });
  }

  const hashed = blocks.some((b) => b.editable && b.hash);
  if (meta.sha256 && nowSha !== meta.sha256) {
    if (!hashed) {
      // v1 edit file: no per-block hashes, so we cannot distinguish an appended
      // turn from a rewritten block. Refuse conservatively.
      guard(`Source transcript changed since extract, and this v1 edit file has no per-block hashes to tell what changed.\n` +
        `  expected ${meta.sha256}\n  actual   ${nowSha}\n  Re-extract, or pass --force.`);
    } else if (conflicts.length) {
      guard(`Source transcript changed since extract, and ${conflicts.length} block(s) you edited changed too:\n` +
        conflicts.map((c) => "    " + c).join("\n") +
        `\n  Re-extract to rebase your edits, or pass --force to overwrite them.`);
    } else {
      console.log("note:     transcript grew since extract (the session flushed or resumed), but every block\n" +
                  "          you edited is untouched — applying by uuid, appended lines are preserved.");
    }
  } else if (conflicts.length) {
    // Same file hash but a block moved: shouldn't happen; fail loudly.
    guard(`Block-level conflict despite an unchanged file hash:\n` + conflicts.map((c) => "    " + c).join("\n"));
  }

  const age = Date.now() - statSync(src).mtimeMs;
  if (age < LIVE_WINDOW_MS) {
    guard(`Source was modified ${Math.round(age / 1000)}s ago — the session may still be live and could append a turn\n` +
        "  between this read and the write. Exit that session first, or pass --force.");
  }

  console.log(`Source:   ${src}`);
  console.log(`Blocks:   ${blocks.length} in edit file (${skippedReadonly} read-only, ${unmatched} unmatched)`);
  console.log(`Changes:  ${changes.length}`);
  if (!changes.length) { console.log("\nNothing to apply."); return; }

  for (const c of changes) {
    const d = c.after.length - c.before.length;
    console.log(`\n  #${c.seq} ${c.kind}  (${d >= 0 ? "+" : ""}${d} chars)`);
    console.log(`    - ${firstLine(c.before)}`);
    console.log(`    + ${firstLine(c.after)}`);
  }

  if (dryRun) { console.log("\n--dry-run: nothing written."); return; }

  // Rewrite only the affected lines; every other byte of the transcript is
  // passed through untouched.
  const byLine = new Map();
  for (const c of changes) {
    if (!byLine.has(c.lineNo)) byLine.set(c.lineNo, []);
    byLine.get(c.lineNo).push(c);
  }
  for (const [lineNo, cs] of byLine) {
    const o = JSON.parse(srcLines[lineNo]);
    for (const c of cs) {
      const index = +c.key.split("#")[1];
      if (!setBlockText(o, index, c.after)) die(`Failed to write block ${c.key} — aborted, nothing changed.`);
    }
    srcLines[lineNo] = JSON.stringify(o);
  }

  if (!argv.includes("--no-backup")) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const bak = `${src}.bak-${stamp}`;
    copyFileSync(src, bak);
    console.log(`\nBackup:  ${bak}`);
  }

  const tmp = `${src}.tmp-${process.pid}`;
  writeFileSync(tmp, srcLines.join("\n"), "utf-8");
  renameSync(tmp, src);
  console.log(`Applied ${changes.length} change(s) → ${src}`);
}

function firstLine(s) {
  const l = (s.split("\n")[0] || "").trim();
  return l.length > 100 ? l.slice(0, 100) + "…" : l || "(empty)";
}

// ── main ───────────────────────────────────────────────────────────────────

const VALUE_FLAGS = new Set(["--config-dir", "--profile", "--session", "-o", "--out"]);
const argv = process.argv.slice(2);
const cmd = argv[0];

if (cmd === "extract") cmdExtract(argv);
else if (cmd === "apply") cmdApply(argv);
else {
  console.log(`Usage:
  node scripts/session-edit.mjs extract --latest [-o edits.md]
  node scripts/session-edit.mjs extract <path.jsonl> [--include-thinking] [--include-tool-results]
  node scripts/session-edit.mjs extract --session <id-prefix> [--profile <name> | --config-dir <path>]
  node scripts/session-edit.mjs apply <edits.md> [--dry-run] [--no-backup] [--force]`);
  process.exit(cmd ? 1 : 0);
}
