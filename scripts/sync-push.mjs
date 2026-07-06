#!/usr/bin/env node
/**
 * Push this machine's agent session transcripts to the sync server.
 *
 * Incremental: a local state file records the (mtime,size) last pushed per file,
 * so re-running only uploads new/changed sessions. The server also dedups by
 * content hash, so a continued session updates in place (no duplicate entry).
 *
 * Usage:
 *   node scripts/sync-push.mjs                       # push all providers, incremental
 *   node scripts/sync-push.mjs --provider claude     # one provider
 *   node scripts/sync-push.mjs --days 7              # only sessions touched in last 7 days
 *   node scripts/sync-push.mjs --dry-run             # show what WOULD upload
 *   node scripts/sync-push.mjs --force               # ignore local state, re-evaluate all
 *   node scripts/sync-push.mjs --server http://100.80.175.96:8765
 *   (SESSION_SYNC_URL / SESSION_SYNC_DEVICE env vars also work)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { discover, extractMeta, projectIdentity, readFile } from "./lib/sessions.mjs";
import { serverUrl, deviceName, dataDir, flag } from "./lib/config.mjs";

const argv = process.argv.slice(2);
const SERVER = serverUrl(argv);
const DEVICE = deviceName(argv);
const provider = flag(argv, "--provider") || "all";
const days = flag(argv, "--days") ? Number(flag(argv, "--days")) : null;
const dryRun = argv.includes("--dry-run");
const force = argv.includes("--force");

const STATE_PATH = join(dataDir(), `push-state-${DEVICE.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
function loadState() {
  if (existsSync(STATE_PATH)) { try { return JSON.parse(readFileSync(STATE_PATH, "utf-8")); } catch { /* */ } }
  return {};
}
function saveState(s) { mkdirSync(dataDir(), { recursive: true }); writeFileSync(STATE_PATH, JSON.stringify(s, null, 2)); }

async function main() {
  // Verify server is reachable up front for a clear error.
  try {
    const h = await fetch(`${SERVER}/api/health`);
    if (!h.ok) throw new Error(`status ${h.status}`);
  } catch (e) {
    console.error(`✗ Cannot reach sync server at ${SERVER} (${e.message}).`);
    console.error(`  Start it with:  node scripts/sync-server.mjs`);
    console.error(`  Or point elsewhere:  --server <url>  or  SESSION_SYNC_URL=<url>`);
    process.exit(1);
  }

  const state = loadState();
  let sessions = discover(provider);
  if (days != null) {
    const cutoff = Date.now() - days * 86400_000;
    sessions = sessions.filter((s) => s.mtime.getTime() >= cutoff);
  }

  const counts = { created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 };
  console.log(`Device ${DEVICE} → ${SERVER}  (${sessions.length} candidate sessions)\n`);

  for (const s of sessions) {
    const sig = `${s.mtime.getTime()}:${s.size}`;
    if (!force && state[s.path] === sig) { counts.skipped++; continue; }

    let content;
    try { content = readFile(s.path); } catch { counts.failed++; continue; }
    const meta = extractMeta(s.provider, content);
    const sessionId = meta.sessionId || s.sessionId;
    const ident = projectIdentity(meta.cwd);

    if (dryRun) {
      console.log(`  would push  [${s.provider}] ${ident.project || meta.cwd || sessionId}  (${(s.size / 1024).toFixed(0)}KB)`);
      counts.created++;
      continue;
    }

    const envelope = {
      device: DEVICE, provider: s.provider, sessionId,
      project: ident.project, projectKey: ident.projectKey, gitRemote: ident.gitRemote,
      cwd: meta.cwd, model: meta.model, startTime: meta.startTime,
      mtime: s.mtime.toISOString(),
      firstPrompt: meta.firstPrompt, lastPrompt: meta.lastPrompt,
      content,
    };
    try {
      const r = await fetch(`${SERVER}/api/sessions`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(envelope),
      });
      const out = await r.json();
      if (!r.ok) { counts.failed++; console.log(`  ✗ ${sessionId}: ${out.error || r.status}`); continue; }
      counts[out.status] = (counts[out.status] || 0) + 1;
      state[s.path] = sig;
      if (out.status !== "unchanged") {
        console.log(`  ${out.status === "created" ? "+" : "~"} [${s.provider}] ${ident.project || sessionId}`);
      }
    } catch (e) { counts.failed++; console.log(`  ✗ ${sessionId}: ${e.message}`); }
  }

  if (!dryRun) saveState(state);
  console.log(`\n${dryRun ? "[dry-run] " : ""}created ${counts.created}, updated ${counts.updated}, unchanged ${counts.unchanged}, skipped ${counts.skipped}, failed ${counts.failed}`);
}

main();
