#!/usr/bin/env node
/**
 * Session-sync server — a small REST + web-UI service that collects agent
 * session transcripts from all your machines into one searchable store.
 *
 * Node builtins only. Host-agnostic: bind address + port are configurable so
 * you can develop on localhost and later run the same file on another box.
 *
 * Usage:
 *   node scripts/sync-server.mjs                 # bind 0.0.0.0:8765 (tailnet-reachable)
 *   node scripts/sync-server.mjs --port 9000
 *   node scripts/sync-server.mjs --host 127.0.0.1   # localhost only
 *
 * Data:   SESSION_SYNC_DATA  (default ~/.session-sync)
 *   store/<device>/<provider>/<sessionId>.jsonl   raw transcripts
 *   index.json                                    metadata index
 *
 * API:
 *   GET  /api/health
 *   GET  /api/manifest?device=&provider=          -> [{key,hash,bytes,mtime}]   (for incremental push)
 *   POST /api/sessions                            upload one session (JSON envelope, see sync-push.mjs)
 *   GET  /api/sessions?device=&provider=&project=&q=&deep=1&since=&until=&limit=   -> [record]
 *   GET  /api/sessions/get?key=<device/provider/sessionId>   -> {record, content}
 *   GET  /api/sessions/raw?key=...                -> text/plain transcript
 *   GET  /api/meta                                -> {devices, providers, projects, count}
 *   GET  /                                        web UI
 */

import { createServer } from "http";
import { createHash } from "crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { dataDir, DEFAULT_PORT, flag } from "./lib/config.mjs";

const argv = process.argv.slice(2);
const PORT = Number(flag(argv, "--port") || process.env.SESSION_SYNC_PORT || DEFAULT_PORT);
const HOST = flag(argv, "--host") || "0.0.0.0";
const DATA = dataDir();
const STORE = join(DATA, "store");
const INDEX_PATH = join(DATA, "index.json");

// ── Index (in-memory, persisted to index.json) ───────────────────────────────

/** key "device/provider/sessionId" -> record */
let index = {};
function loadIndex() {
  if (existsSync(INDEX_PATH)) {
    try { index = JSON.parse(readFileSync(INDEX_PATH, "utf-8")); } catch { index = {}; }
  }
}
function saveIndex() {
  mkdirSync(DATA, { recursive: true });
  writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2));
}

const safe = (s) => String(s || "").replace(/[^A-Za-z0-9._-]/g, "_");
function keyOf(device, provider, sessionId) { return `${device}/${provider}/${sessionId}`; }
function storePath(device, provider, sessionId) {
  return join(STORE, safe(device), safe(provider), `${safe(sessionId)}.jsonl`);
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(body);
}
function sendText(res, code, text, type = "text/plain; charset=utf-8") {
  res.writeHead(code, { "Content-Type": type, "Access-Control-Allow-Origin": "*" });
  res.end(text);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => { size += c.length; if (size > 64 * 1024 * 1024) reject(new Error("payload too large")); chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

// ── Handlers ─────────────────────────────────────────────────────────────────

function handleUpload(body, res) {
  let env;
  try { env = JSON.parse(body); } catch { return sendJson(res, 400, { error: "invalid json" }); }
  const { device, provider, sessionId, content } = env;
  if (!device || !provider || !sessionId || typeof content !== "string") {
    return sendJson(res, 400, { error: "device, provider, sessionId, content required" });
  }
  const key = keyOf(device, provider, sessionId);
  const hash = createHash("sha256").update(content).digest("hex");
  const prev = index[key];
  if (prev && prev.hash === hash) return sendJson(res, 200, { ok: true, key, status: "unchanged" });

  const p = storePath(device, provider, sessionId);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);

  const record = {
    key, device, provider, sessionId,
    project: env.project || "", projectKey: env.projectKey || "", gitRemote: env.gitRemote || "",
    cwd: env.cwd || "", model: env.model || "",
    startTime: env.startTime || "", mtime: env.mtime || "",
    firstPrompt: (env.firstPrompt || "").slice(0, 500),
    lastPrompt: (env.lastPrompt || "").slice(0, 500),
    bytes: Buffer.byteLength(content), lines: content.split("\n").filter((l) => l.trim()).length,
    hash, uploadedAt: new Date().toISOString(),
  };
  index[key] = record;
  saveIndex();
  sendJson(res, 200, { ok: true, key, status: prev ? "updated" : "created" });
}

function handleManifest(url, res) {
  const device = url.searchParams.get("device");
  const provider = url.searchParams.get("provider");
  const out = [];
  for (const r of Object.values(index)) {
    if (device && r.device !== device) continue;
    if (provider && r.provider !== provider) continue;
    out.push({ key: r.key, hash: r.hash, bytes: r.bytes, mtime: r.mtime });
  }
  sendJson(res, 200, out);
}

function matchRecord(r, params) {
  if (params.device && r.device !== params.device) return false;
  if (params.provider && r.provider !== params.provider) return false;
  if (params.project && !(`${r.project} ${r.projectKey}`.toLowerCase().includes(params.project.toLowerCase()))) return false;
  if (params.since && (r.mtime || "") < params.since) return false;
  if (params.until && (r.mtime || "") > params.until) return false;
  if (params.q) {
    const hay = `${r.project} ${r.cwd} ${r.model} ${r.firstPrompt} ${r.lastPrompt}`.toLowerCase();
    let hit = hay.includes(params.q.toLowerCase());
    if (!hit && params.deep) {
      try { hit = readFileSync(storePath(r.device, r.provider, r.sessionId), "utf-8").toLowerCase().includes(params.q.toLowerCase()); } catch { /* gone */ }
    }
    if (!hit) return false;
  }
  return true;
}

function handleSearch(url, res) {
  const params = {
    device: url.searchParams.get("device"),
    provider: url.searchParams.get("provider"),
    project: url.searchParams.get("project"),
    q: url.searchParams.get("q"),
    deep: url.searchParams.get("deep") === "1",
    since: url.searchParams.get("since"),
    until: url.searchParams.get("until"),
  };
  const limit = Number(url.searchParams.get("limit") || 200);
  const out = Object.values(index)
    .filter((r) => matchRecord(r, params))
    .sort((a, b) => (b.mtime || "").localeCompare(a.mtime || ""))
    .slice(0, limit);
  sendJson(res, 200, out);
}

function handleGet(url, res, raw) {
  const key = url.searchParams.get("key");
  const r = index[key];
  if (!r) return sendJson(res, 404, { error: "not found" });
  let content = "";
  try { content = readFileSync(storePath(r.device, r.provider, r.sessionId), "utf-8"); }
  catch { return sendJson(res, 410, { error: "transcript missing on disk" }); }
  if (raw) return sendText(res, 200, content);
  sendJson(res, 200, { record: r, content });
}

function handleMeta(res) {
  const devices = new Set(), providers = new Set(), projects = new Set();
  for (const r of Object.values(index)) {
    if (r.device) devices.add(r.device);
    if (r.provider) providers.add(r.provider);
    if (r.project) projects.add(r.project);
  }
  sendJson(res, 200, {
    devices: [...devices].sort(), providers: [...providers].sort(),
    projects: [...projects].sort(), count: Object.keys(index).length,
  });
}

// ── Server ───────────────────────────────────────────────────────────────────

loadIndex();
const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST", "Access-Control-Allow-Headers": "Content-Type" });
    return res.end();
  }
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const path = url.pathname;
  try {
    if (path === "/api/health") return sendJson(res, 200, { ok: true, count: Object.keys(index).length });
    if (path === "/api/meta") return handleMeta(res);
    if (path === "/api/manifest") return handleManifest(url, res);
    if (path === "/api/sessions" && req.method === "POST") return handleUpload(await readBody(req), res);
    if (path === "/api/sessions") return handleSearch(url, res);
    if (path === "/api/sessions/get") return handleGet(url, res, false);
    if (path === "/api/sessions/raw") return handleGet(url, res, true);
    if (path === "/" || path === "/index.html") return sendText(res, 200, HTML, "text/html; charset=utf-8");
    sendJson(res, 404, { error: "not found" });
  } catch (e) {
    sendJson(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`session-sync server on http://${HOST}:${PORT}  (data: ${DATA})`);
  console.log(`  web UI:   http://localhost:${PORT}/`);
  console.log(`  sessions: ${Object.keys(index).length} indexed`);
});

// ── Embedded web UI ──────────────────────────────────────────────────────────

const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Session Sync</title>
<style>
:root{--bg:#0f1115;--panel:#171a21;--line:#262b36;--fg:#d8dee9;--mut:#8a93a6;--acc:#6cb6ff;--warn:#e5c07b}
*{box-sizing:border-box}body{margin:0;font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--bg);color:var(--fg);height:100vh;display:flex;flex-direction:column}
header{padding:8px 12px;border-bottom:1px solid var(--line);display:flex;gap:8px;align-items:center;flex-wrap:wrap}
header h1{font-size:14px;margin:0 12px 0 0;color:var(--acc)}
select,input{background:var(--panel);color:var(--fg);border:1px solid var(--line);border-radius:5px;padding:5px 7px;font:inherit}
input#q{min-width:240px}label{color:var(--mut);display:flex;gap:4px;align-items:center}
main{flex:1;display:flex;min-height:0}
#list{width:46%;overflow:auto;border-right:1px solid var(--line)}
#detail{flex:1;overflow:auto;padding:12px}
.row{padding:8px 12px;border-bottom:1px solid var(--line);cursor:pointer}
.row:hover{background:var(--panel)}.row.sel{background:#1d2330}
.row .t{color:var(--fg)}.row .m{color:var(--mut);font-size:11px;margin-top:2px}
.badge{display:inline-block;padding:1px 6px;border-radius:4px;background:var(--line);color:var(--mut);font-size:11px;margin-right:5px}
.badge.claude{color:#bd93f9}.badge.codex{color:#8fd16f}.badge.copilot{color:#6cb6ff}
#meta{margin-bottom:10px}#meta div{margin:2px 0}#meta b{color:var(--mut);display:inline-block;width:96px}
pre{white-space:pre-wrap;word-break:break-word;background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:10px;margin:0}
.muted{color:var(--mut)}.count{color:var(--mut);margin-left:auto}
button{background:var(--panel);color:var(--fg);border:1px solid var(--line);border-radius:5px;padding:5px 9px;cursor:pointer}
button:hover{border-color:var(--acc)}
</style></head><body>
<header>
  <h1>Session Sync</h1>
  <input id="q" placeholder="search prompts / cwd / model…">
  <label><input type="checkbox" id="deep"> deep (transcript text)</label>
  <select id="device"><option value="">all devices</option></select>
  <select id="provider"><option value="">all agents</option></select>
  <input id="project" placeholder="project filter" style="width:140px">
  <span class="count" id="count"></span>
</header>
<main>
  <div id="list"></div>
  <div id="detail"><p class="muted">Select a session.</p></div>
</main>
<script>
const $=s=>document.querySelector(s);
let sel=null;
async function j(u){const r=await fetch(u);return r.json();}
async function loadMeta(){
  const m=await j('/api/meta');
  for(const d of m.devices)$('#device').insertAdjacentHTML('beforeend',\`<option>\${d}</option>\`);
  for(const p of m.providers)$('#provider').insertAdjacentHTML('beforeend',\`<option>\${p}</option>\`);
}
function esc(s){return (s||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
async function search(){
  const p=new URLSearchParams();
  if($('#q').value)p.set('q',$('#q').value);
  if($('#deep').checked)p.set('deep','1');
  if($('#device').value)p.set('device',$('#device').value);
  if($('#provider').value)p.set('provider',$('#provider').value);
  if($('#project').value)p.set('project',$('#project').value);
  const rows=await j('/api/sessions?'+p.toString());
  $('#count').textContent=rows.length+' sessions';
  $('#list').innerHTML=rows.map(r=>\`<div class="row" data-key="\${encodeURIComponent(r.key)}">
    <div class="t"><span class="badge \${r.provider}">\${r.provider}</span>\${esc(r.project||r.cwd||'(no project)')}</div>
    <div class="m">\${esc((r.firstPrompt||'').slice(0,90))||'<span class=muted>(no prompt)</span>'}</div>
    <div class="m">\${(r.mtime||'').slice(0,16).replace('T',' ')} · \${r.device} · \${r.lines} lines · \${(r.bytes/1024).toFixed(0)}KB</div>
  </div>\`).join('')||'<p class="muted" style="padding:12px">No matches.</p>';
  document.querySelectorAll('.row').forEach(el=>el.onclick=()=>open(el));
}
async function open(el){
  document.querySelectorAll('.row').forEach(e=>e.classList.remove('sel'));el.classList.add('sel');
  const key=el.dataset.key;
  const {record:r,content}=await j('/api/sessions/get?key='+key);
  $('#detail').innerHTML=\`<div id="meta">
    <div><b>project</b>\${esc(r.project)} <span class=muted>\${esc(r.projectKey)}</span></div>
    <div><b>agent</b><span class="badge \${r.provider}">\${r.provider}</span> \${esc(r.model)}</div>
    <div><b>device</b>\${esc(r.device)}</div>
    <div><b>cwd</b>\${esc(r.cwd)}</div>
    <div><b>session</b>\${esc(r.sessionId)}</div>
    <div><b>modified</b>\${(r.mtime||'').replace('T',' ').slice(0,19)}</div>
    <div><b>size</b>\${r.lines} lines · \${(r.bytes/1024).toFixed(0)}KB</div>
    <div style="margin-top:6px"><button id="dl">download raw</button> <span class=muted>\${esc(key)}</span></div>
  </div>
  <div class="muted" style="margin:8px 0 4px">first prompt</div><pre>\${esc(r.firstPrompt)||'<span class=muted>—</span>'}</pre>
  <div class="muted" style="margin:8px 0 4px">last prompt</div><pre>\${esc(r.lastPrompt)||'<span class=muted>—</span>'}</pre>
  <div class="muted" style="margin:8px 0 4px">raw transcript (\${content.split('\\n').length} lines)</div>
  <pre style="max-height:50vh;overflow:auto">\${esc(content)}</pre>\`;
  $('#dl').onclick=()=>{const b=new Blob([content],{type:'text/plain'});const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=r.sessionId+'.jsonl';a.click();};
}
let t;['#q','#project'].forEach(s=>$(s).oninput=()=>{clearTimeout(t);t=setTimeout(search,250);});
['#device','#provider','#deep'].forEach(s=>$(s).onchange=search);
loadMeta();search();
</script></body></html>`;
