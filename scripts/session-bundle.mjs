#!/usr/bin/env node
/**
 * Export agent transcripts to a portable bundle, and import bundles from other
 * devices or other people.
 *
 * Session-sync moves transcripts between YOUR machines over a live tailnet.
 * A bundle is the offline, hand-it-over form: one zip carrying the selected
 * transcripts plus a manifest describing where they came from. Two uses:
 *
 *   1. archive/share a slice  — "all sessions from my andrena_team_5x* profiles"
 *   2. POOL CORPORA           — several developers each export a bundle, one
 *                               person imports them all, and the combined set is
 *                               queried as one. Every record keeps its `user`,
 *                               so cross-person analysis stays attributable and
 *                               two people's sessionIds can never collide.
 *
 * Usage:
 *   node scripts/session-bundle.mjs export --profile andrena --out team.zip
 *   node scripts/session-bundle.mjs export --from server --days 30 --out last30.zip
 *   node scripts/session-bundle.mjs export --profile andrena --dry-run
 *   node scripts/session-bundle.mjs inspect team.zip
 *   node scripts/session-bundle.mjs import team.zip
 *   node scripts/session-bundle.mjs import alice.zip --as-user alice
 *
 * export options
 *   --from local|server   local = this box's profiles (default); server = a sync server
 *   --out <path>          .zip (default) or directory with --format dir
 *   --format zip|dir      dir skips the archiver entirely (always works)
 *   --profile <substr>    auth-profile filter, e.g. "andrena" hits andrena_team_5x*
 *   --kind <k>            main | subagent | workflow (default: all three)
 *   --provider <name>     claude | codex | copilot
 *   --project <substr>    match against project / projectKey
 *   --device <name>       (--from server) one device
 *   --user <name>         (--from server) one user; also stamps the bundle's owner
 *   --days N              only sessions touched in the last N days
 *   --since / --until     ISO timestamps (alternative to --days)
 *   --limit N             cap the number of sessions
 *   --deny <regex>        extra sensitive-project pattern (repeatable)
 *   --include-denied      export sensitive projects too (OFF by default)
 *   --dry-run             list what would be bundled, write nothing
 *
 * import options
 *   --server <url>        target sync server (default http://127.0.0.1:8765)
 *   --as-user <name>      attribute the bundle to this person (overrides manifest)
 *   --keep-device         don't prefix foreign devices with the user name
 *   --dry-run             show what would be imported, upload nothing
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync, readdirSync } from "fs";
import { join, resolve, basename } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
import { discover, extractMeta, projectIdentity, readFile, resolveSessionId } from "./lib/sessions.mjs";
import { serverUrl, deviceName, userName, flag } from "./lib/config.mjs";
import { zipDir, unzipTo } from "./lib/archive.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0];
const SCHEMA_VERSION = 1;

/**
 * Projects whose transcripts must never leave this machine in a shareable
 * artifact. Client work under NDA lives here: raw transcripts carry real module
 * names, customer and employee references verbatim, with no redaction anywhere
 * in the pipeline. Matched against project, projectKey and cwd — excluded by
 * default, and only `--include-denied` (a deliberate act) overrides it.
 * Extend per-invocation with --deny, or persistently via SESSION_BUNDLE_DENY.
 */
const BUILTIN_DENY = [/some-client/i];

const safe = (s) => String(s || "").replace(/[^A-Za-z0-9._-]/g, "_");
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

function collectFlags(name) {
  const out = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === name && argv[i + 1]) out.push(argv[i + 1]);
  return out;
}

function denyPatterns() {
  const extra = [...collectFlags("--deny")];
  if (process.env.SESSION_BUNDLE_DENY) extra.push(...process.env.SESSION_BUNDLE_DENY.split(",").map((s) => s.trim()).filter(Boolean));
  const compiled = [];
  for (const p of extra) {
    try { compiled.push(new RegExp(p, "i")); }
    catch { console.error(`✗ --deny ${p}: not a valid regex`); process.exit(1); }
  }
  return [...BUILTIN_DENY, ...compiled];
}

function isDenied(rec, patterns) {
  const hay = `${rec.project || ""} ${rec.projectKey || ""} ${rec.cwd || ""}`;
  for (const re of patterns) if (re.test(hay)) return re.source;
  return null;
}

function timeWindow() {
  let since = flag(argv, "--since") || null;
  const until = flag(argv, "--until") || null;
  const days = flag(argv, "--days");
  if (days && !since) since = new Date(Date.now() - Number(days) * 86400_000).toISOString();
  return { since, until };
}

function fmtBytes(n) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024).toFixed(0)} KB`;
}

// ── Collect: this machine's profiles ─────────────────────────────────────────

/**
 * Yields one {record, content} at a time rather than returning an array.
 *
 * A full corpus here is multiple GB of transcript text; holding every file's
 * content in memory at once aborts the process with a V8 OOM. The caller writes
 * each transcript to the staging dir as it arrives, so only one is ever live.
 */
function* iterLocal() {
  const device = deviceName(argv);
  const user = userName(argv);
  const provider = flag(argv, "--provider") || "all";
  const profileF = (flag(argv, "--profile") || "").toLowerCase();
  const projectF = (flag(argv, "--project") || "").toLowerCase();
  const kindF = flag(argv, "--kind") || null;
  const { since, until } = timeWindow();

  let files = discover(provider);
  if (profileF) files = files.filter((s) => (s.profile || "").toLowerCase().includes(profileF));
  if (kindF) files = files.filter((s) => (s.kind || "main") === kindF);
  if (since) files = files.filter((s) => s.mtime.toISOString() >= since);
  if (until) files = files.filter((s) => s.mtime.toISOString() <= until);

  for (const s of files) {
    let content;
    try { content = readFile(s.path); } catch { continue; }
    const meta = extractMeta(s.provider, content);
    const ident = projectIdentity(meta.cwd);
    if (projectF && !`${ident.project} ${ident.projectKey}`.toLowerCase().includes(projectF)) continue;
    const sessionId = resolveSessionId(s, meta);
    yield {
      record: {
        key: `${device}/${s.provider}/${sessionId}`,
        device, user, profile: s.profile || "", provider: s.provider, sessionId,
        kind: s.kind || "main", parentSessionId: s.parentSessionId || "",
        project: ident.project, projectKey: ident.projectKey, gitRemote: ident.gitRemote,
        cwd: meta.cwd, model: meta.model, startTime: meta.startTime,
        mtime: s.mtime.toISOString(),
        firstPrompt: (meta.firstPrompt || "").slice(0, 500),
        lastPrompt: (meta.lastPrompt || "").slice(0, 500),
        bytes: Buffer.byteLength(content),
        lines: content.split("\n").filter((l) => l.trim()).length,
        hash: createHash("sha256").update(content).digest("hex"),
      },
      content,
    };
  }
}

// ── Collect: a sync server (all devices at once) ─────────────────────────────

async function* iterServer() {
  const SERVER = serverUrl(argv);
  const p = new URLSearchParams();
  for (const k of ["device", "user", "profile", "kind", "provider", "project", "limit"]) {
    const v = flag(argv, `--${k}`); if (v) p.set(k, v);
  }
  const { since, until } = timeWindow();
  if (since) p.set("since", since);
  if (until) p.set("until", until);
  if (!p.get("limit")) p.set("limit", "100000");

  let records;
  try {
    const r = await fetch(`${SERVER}/api/sessions?${p}`);
    if (!r.ok) throw new Error(`status ${r.status}`);
    records = await r.json();
  } catch (e) {
    console.error(`✗ Cannot query sync server at ${SERVER} (${e.message}).`);
    console.error(`  Start it with:  node scripts/sync-server.mjs`);
    process.exit(1);
  }

  for (const rec of records) {
    let content;
    try {
      const r = await fetch(`${SERVER}/api/sessions/raw?key=${encodeURIComponent(rec.key)}`);
      if (!r.ok) { console.log(`  ! skip ${rec.key} (raw ${r.status})`); continue; }
      content = await r.text();
    } catch (e) { console.log(`  ! skip ${rec.key} (${e.message})`); continue; }
    yield { record: rec, content };
  }
}

function originOf(from) {
  const base = { user: userName(argv), device: deviceName(argv) };
  return { ...base, source: from === "local" ? "local" : `server ${serverUrl(argv)}` };
}

// ── export ───────────────────────────────────────────────────────────────────

async function doExport() {
  const from = flag(argv, "--from") || "local";
  if (!["local", "server"].includes(from)) { console.error(`✗ --from must be local or server`); process.exit(1); }
  const dryRun = argv.includes("--dry-run");
  const format = flag(argv, "--format") || "zip";
  const limit = flag(argv, "--limit") ? Number(flag(argv, "--limit")) : null;

  const origin = originOf(from);
  console.log(`source   ${origin.source}`);
  console.log(`owner    ${origin.user}@${origin.device}`);

  const stamp = new Date().toISOString().slice(0, 10);
  const outArg = flag(argv, "--out") || `session-bundle-${stamp}.${format === "dir" ? "d" : "zip"}`;
  const outPath = resolve(outArg);
  const stageDir = format === "dir" ? outPath : join(tmpdir(), `session-bundle-${process.pid}`, basename(outPath).replace(/\.zip$/i, ""));
  if (!dryRun) {
    if (existsSync(stageDir)) rmSync(stageDir, { recursive: true, force: true });
    mkdirSync(stageDir, { recursive: true });
  }

  // Sensitive-project guard — applied to LOCAL and SERVER alike, because a
  // bundle is the artifact that leaves the machine either way.
  const patterns = denyPatterns();
  const includeDenied = argv.includes("--include-denied");
  const deniedByProject = {};
  let deniedCount = 0;
  let totalBytes = 0;
  const manifestSessions = [];

  // Streamed: each transcript is written out and released before the next is
  // read, so peak memory stays flat no matter how large the corpus is.
  const src = from === "local" ? iterLocal() : iterServer();
  for await (const { record, content } of src) {
    if (!includeDenied) {
      const hit = isDenied(record, patterns);
      if (hit) {
        deniedCount++;
        const k = record.project || record.cwd || "?";
        deniedByProject[k] = (deniedByProject[k] || 0) + 1;
        continue;
      }
    }
    if (limit && manifestSessions.length >= limit) break;

    const rel = `sessions/${safe(record.device)}/${safe(record.provider)}/${safe(record.sessionId)}.jsonl`;
    if (!dryRun) {
      const abs = join(stageDir, rel);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, content);
    }
    totalBytes += record.bytes;
    manifestSessions.push({ ...record, file: rel });
    if (manifestSessions.length % 500 === 0) {
      console.log(`  ... ${manifestSessions.length} sessions, ${fmtBytes(totalBytes)}`);
    }
  }

  console.log(`sessions ${manifestSessions.length}  (${fmtBytes(totalBytes)})`);
  if (deniedCount) {
    // Names printed locally only — the manifest records the count, never the
    // project, so the bundle itself doesn't leak what was withheld.
    console.log(`\n⚠ excluded ${deniedCount} session(s) from sensitive projects:`);
    for (const [proj, n] of Object.entries(deniedByProject)) console.log(`    ${n} × ${proj}`);
    console.log(`  (--include-denied to override — check what you are handing over first)`);
  }
  if (!manifestSessions.length) {
    console.log(`\nNothing to bundle.`);
    if (!dryRun) rmSync(stageDir, { recursive: true, force: true });
    return;
  }
  if (dryRun) {
    console.log(`\n[dry-run] first 20 of ${manifestSessions.length}:`);
    for (const r of manifestSessions.slice(0, 20)) {
      console.log(`  ${(r.mtime || "").slice(0, 16).replace("T", " ")}  ${r.provider}/${r.profile || "-"}/${r.kind}  ${r.project || r.cwd}`);
    }
    return;
  }

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    kind: "session-bundle",
    createdAt: new Date().toISOString(),
    origin: { ...origin, tool: "session-inspector/session-bundle" },
    filters: {
      from, profile: flag(argv, "--profile") || null, provider: flag(argv, "--provider") || null,
      project: flag(argv, "--project") || null, device: flag(argv, "--device") || null,
      kind: flag(argv, "--kind") || null,
      user: flag(argv, "--user") || null, ...timeWindow(), limit,
    },
    counts: { sessions: manifestSessions.length, bytes: totalBytes, excludedSensitive: deniedCount },
    sessions: manifestSessions,
  };
  writeFileSync(join(stageDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(join(stageDir, "README.txt"),
    `Agent session bundle (schema ${SCHEMA_VERSION}) — ${manifestSessions.length} transcripts\n` +
    `from ${origin.user}@${origin.device} (${origin.source}) at ${manifest.createdAt}\n\n` +
    `Import into a session-sync server:\n` +
    `  node scripts/session-bundle.mjs import <this-bundle> --as-user ${origin.user}\n\n` +
    `Contains RAW, UNREDACTED transcripts. Treat as confidential.\n`);

  if (format === "dir") {
    console.log(`\n✓ bundle directory  ${stageDir}`);
    return;
  }
  const z = zipDir(stageDir, outPath);
  rmSync(join(stageDir, ".."), { recursive: true, force: true });
  if (!z.ok) { console.error(`\n✗ ${z.err}`); process.exit(1); }
  console.log(`\n✓ ${outPath}  (${fmtBytes(statSync(outPath).size)}, via ${z.tool})`);
}

// ── bundle reading (zip or directory) ────────────────────────────────────────

/** Resolve a bundle path to a directory holding manifest.json. Returns {dir, cleanup}. */
function openBundle(p) {
  const path = resolve(p);
  if (!existsSync(path)) { console.error(`✗ no such bundle: ${path}`); process.exit(1); }

  let dir = path;
  let cleanup = () => {};
  if (!isDir(path)) {
    const tmp = join(tmpdir(), `session-bundle-in-${process.pid}`);
    rmSync(tmp, { recursive: true, force: true });
    const x = unzipTo(path, tmp);
    if (!x.ok) { console.error(`✗ ${x.err}`); process.exit(1); }
    dir = tmp;
    cleanup = () => rmSync(tmp, { recursive: true, force: true });
  }
  // A zip made by `export` wraps everything in one folder; descend into it.
  if (!existsSync(join(dir, "manifest.json"))) {
    const subs = readdirSync(dir).map((d) => join(dir, d)).filter(isDir);
    const hit = subs.find((d) => existsSync(join(d, "manifest.json")));
    if (hit) dir = hit;
  }
  const mPath = join(dir, "manifest.json");
  if (!existsSync(mPath)) { cleanup(); console.error(`✗ ${path} has no manifest.json — not a session bundle`); process.exit(1); }

  let manifest;
  try { manifest = JSON.parse(readFileSync(mPath, "utf-8")); }
  catch (e) { cleanup(); console.error(`✗ manifest.json is not valid JSON (${e.message})`); process.exit(1); }
  if (manifest.kind !== "session-bundle") { cleanup(); console.error(`✗ not a session bundle (kind=${manifest.kind})`); process.exit(1); }
  if (manifest.schemaVersion > SCHEMA_VERSION) {
    console.error(`✗ bundle schema v${manifest.schemaVersion} is newer than this tool (v${SCHEMA_VERSION}) — update session-inspector.`);
    cleanup(); process.exit(1);
  }
  return { dir, manifest, cleanup };
}

function doInspect() {
  const p = argv[1];
  if (!p) { console.error(`usage: inspect <bundle.zip|dir>`); process.exit(1); }
  const { manifest, cleanup } = openBundle(p);
  const o = manifest.origin || {};
  console.log(`kind       ${manifest.kind} (schema ${manifest.schemaVersion})`);
  console.log(`created    ${manifest.createdAt}`);
  console.log(`origin     ${o.user}@${o.device}  via ${o.source}`);
  console.log(`sessions   ${manifest.counts?.sessions}  (${fmtBytes(manifest.counts?.bytes || 0)})`);
  if (manifest.counts?.excludedSensitive) console.log(`excluded   ${manifest.counts.excludedSensitive} sensitive session(s) withheld at export`);

  const tally = (f) => {
    const m = {};
    for (const s of manifest.sessions || []) { const k = s[f] || "(none)"; m[k] = (m[k] || 0) + 1; }
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  };
  for (const f of ["user", "device", "profile", "provider", "kind"]) {
    console.log(`\n${f}:`);
    for (const [k, n] of tally(f)) console.log(`  ${String(n).padStart(5)}  ${k}`);
  }
  console.log(`\ntop projects:`);
  for (const [k, n] of tally("project").slice(0, 15)) console.log(`  ${String(n).padStart(5)}  ${k}`);
  cleanup();
}

// ── import ───────────────────────────────────────────────────────────────────

async function doImport() {
  const p = argv[1];
  if (!p) { console.error(`usage: import <bundle.zip|dir> [--as-user name]`); process.exit(1); }
  const SERVER = serverUrl(argv);
  const dryRun = argv.includes("--dry-run");
  const { dir, manifest, cleanup } = openBundle(p);

  if (!dryRun) {
    try {
      const h = await fetch(`${SERVER}/api/health`);
      if (!h.ok) throw new Error(`status ${h.status}`);
    } catch (e) {
      cleanup();
      console.error(`✗ Cannot reach sync server at ${SERVER} (${e.message}).`);
      console.error(`  Start it with:  node scripts/sync-server.mjs`);
      process.exit(1);
    }
  }

  const bundleUser = flag(argv, "--as-user") || manifest.origin?.user || "imported";
  const localUser = userName([]);
  // Two people can hold the same hostname, and the store keys on device — so a
  // foreign corpus gets its device tagged with its owner. Without this, alice's
  // "DESKTOP-ABC" would silently overwrite bob's.
  const foreign = bundleUser !== localUser && !argv.includes("--keep-device");

  console.log(`bundle   ${manifest.counts?.sessions} sessions from ${manifest.origin?.user}@${manifest.origin?.device}`);
  console.log(`as user  ${bundleUser}${foreign ? "  (devices namespaced)" : ""}`);
  console.log(`target   ${SERVER}\n`);

  const counts = { created: 0, updated: 0, unchanged: 0, failed: 0, missing: 0 };
  for (const s of manifest.sessions || []) {
    const abs = join(dir, s.file || "");
    if (!s.file || !existsSync(abs)) { counts.missing++; console.log(`  ! missing file for ${s.sessionId}`); continue; }
    const content = readFileSync(abs, "utf-8");
    const device = foreign && !String(s.device).includes("@") ? `${bundleUser}@${s.device}` : s.device;

    if (dryRun) { counts.created++; continue; }
    const envelope = {
      device, user: bundleUser, profile: s.profile || "", provider: s.provider, sessionId: s.sessionId,
      kind: s.kind || "main", parentSessionId: s.parentSessionId || "",
      project: s.project, projectKey: s.projectKey, gitRemote: s.gitRemote,
      cwd: s.cwd, model: s.model, startTime: s.startTime, mtime: s.mtime,
      firstPrompt: s.firstPrompt, lastPrompt: s.lastPrompt, content,
    };
    try {
      const r = await fetch(`${SERVER}/api/sessions`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(envelope),
      });
      const out = await r.json();
      if (!r.ok) { counts.failed++; console.log(`  ✗ ${s.sessionId}: ${out.error || r.status}`); continue; }
      counts[out.status] = (counts[out.status] || 0) + 1;
      if (out.status !== "unchanged") console.log(`  ${out.status === "created" ? "+" : "~"} ${device}  ${s.project || s.sessionId}`);
    } catch (e) { counts.failed++; console.log(`  ✗ ${s.sessionId}: ${e.message}`); }
  }
  cleanup();
  console.log(`\n${dryRun ? "[dry-run] " : ""}created ${counts.created}, updated ${counts.updated}, unchanged ${counts.unchanged}, missing ${counts.missing}, failed ${counts.failed}`);
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log("commands: export | import <bundle> | inspect <bundle>   (see file header for flags)");
    return;
  }
  if (cmd === "export") return doExport();
  if (cmd === "import") return doImport();
  if (cmd === "inspect") return doInspect();
  console.error(`unknown command: ${cmd}`);
  process.exit(1);
}
main();
