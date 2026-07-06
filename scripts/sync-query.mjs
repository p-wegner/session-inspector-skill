#!/usr/bin/env node
/**
 * Browse/search the sync server from the terminal (the CLI counterpart to the
 * web UI). Lets this skill and the agent query sessions synced from any machine.
 *
 * Usage:
 *   node scripts/sync-query.mjs meta                         # devices / providers / projects / count
 *   node scripts/sync-query.mjs list [--device d] [--provider p] [--project x] [--limit n]
 *   node scripts/sync-query.mjs search "<text>" [--deep] [--provider p] ...
 *   node scripts/sync-query.mjs get <key>                    # print raw transcript
 *   node scripts/sync-query.mjs get <key> --save out.jsonl   # save raw transcript
 *   node scripts/sync-query.mjs get <key> --analyze          # fetch + run the matching analyzer
 *   node scripts/sync-query.mjs --json list                  # machine-readable
 *
 *   key = "device/provider/sessionId" (shown by list/search)
 *   --server <url> / SESSION_SYNC_URL to target a remote server.
 */

import { writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { serverUrl, flag } from "./lib/config.mjs";

const argv = process.argv.slice(2);
const SERVER = serverUrl(argv);
const jsonOut = argv.includes("--json");
const positional = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--server" && argv[i - 1] !== "--device" && argv[i - 1] !== "--provider" && argv[i - 1] !== "--project" && argv[i - 1] !== "--limit" && argv[i - 1] !== "--save");
const cmd = positional[0];
const here = dirname(fileURLToPath(import.meta.url));

function qs() {
  const p = new URLSearchParams();
  for (const k of ["device", "provider", "project", "since", "until", "limit"]) {
    const v = flag(argv, `--${k}`); if (v) p.set(k, v);
  }
  if (argv.includes("--deep")) p.set("deep", "1");
  return p;
}
async function j(path) { const r = await fetch(`${SERVER}${path}`); if (!r.ok) { console.error(`✗ ${r.status} ${await r.text()}`); process.exit(1); } return r.json(); }

function pad(s, n) { s = String(s ?? ""); return s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n); }
function printRows(rows) {
  if (jsonOut) { console.log(JSON.stringify(rows, null, 2)); return; }
  console.log(`${rows.length} sessions\n`);
  for (const r of rows) {
    console.log(`${(r.mtime || "").slice(0, 16).replace("T", " ")}  ${pad(r.provider, 8)} ${pad(r.device, 14)} ${pad(r.project || r.cwd, 28)} ${pad((r.firstPrompt || "").replace(/\s+/g, " "), 40)}`);
    console.log(`    ${r.key}`);
  }
}

async function main() {
  if (!cmd || cmd === "help") {
    console.log("commands: meta | list | search <text> | get <key>   (see header for flags)");
    return;
  }
  if (cmd === "meta") { console.log(JSON.stringify(await j("/api/meta"), null, jsonOut ? 2 : 0)); return; }
  if (cmd === "list") { printRows(await j(`/api/sessions?${qs()}`)); return; }
  if (cmd === "search") {
    const text = positional[1];
    if (!text) { console.error("usage: search \"<text>\""); process.exit(1); }
    const p = qs(); p.set("q", text);
    printRows(await j(`/api/sessions?${p}`));
    return;
  }
  if (cmd === "get") {
    const key = positional[1];
    if (!key) { console.error("usage: get <key>"); process.exit(1); }
    const { record, content } = await j(`/api/sessions/get?key=${encodeURIComponent(key)}`);
    const save = flag(argv, "--save");
    if (save) { writeFileSync(save, content); console.log(`saved ${content.length} bytes → ${save}`); return; }
    if (argv.includes("--analyze")) {
      const tmp = join(tmpdir(), `sync-${record.provider}-${record.sessionId}.jsonl`);
      writeFileSync(tmp, content);
      const script = join(here, `analyze-${record.provider}-session.mjs`);
      const r = spawnSync(process.execPath, [script, tmp], { stdio: "inherit" });
      process.exit(r.status || 0);
    }
    process.stdout.write(content);
    return;
  }
  console.error(`unknown command: ${cmd}`);
  process.exit(1);
}
main();
