#!/usr/bin/env node
/**
 * QUOTA MULTI — the "complete picture": every Claude auth profile, every weekly
 * reset window, plus a combined grand total, in ONE self-contained dashboard you
 * can switch through. Per-profile it auto-detects the weekly reset anchor (each
 * account resets on a different weekday/time) and slices the data into weekly
 * windows; the Combined scope sums every profile+window and breaks down by profile.
 *
 * Parses every transcript ONCE (lib/quota.mjs), then aggregates each window slice
 * in memory. Subagents included. Cost = pay-go-equivalent "subscription value".
 *
 * Usage:
 *   node scripts/quota-multi.mjs --html combined.html                 # all andrena_team_5x* profiles
 *   node scripts/quota-multi.mjs --profiles andrena_team_5x,andrena_team_5x_2 --html out.html
 *   node scripts/quota-multi.mjs --json                               # full nested blob
 *   node scripts/quota-multi.mjs --tz 2 --max-windows 8
 */
import { readdirSync, statSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { walkJsonl, parseFileEvents, scanLimits, collapseLimits, detectWeeklyReset, weeklyWindows, aggregate } from "./lib/quota.mjs";

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
const tzOffset = parseInt(flag("tz", "2"), 10);
const maxWindows = parseInt(flag("max-windows", "8"), 10);
const jsonOut = argv.includes("--json");
const htmlPath = flag("html", "");
const nowMs = Date.now();

// discover profiles
function discoverProfiles() {
  const home = homedir(); const out = [];
  for (const e of readdirSync(home)) {
    const m = e.match(/^\.claude-(andrena_team_5x.*)$/);
    if (m && existsSync(join(home, e, "projects"))) out.push(m[1]);
  }
  return out.sort((a, b) => a.length - b.length || a.localeCompare(b));
}
const profiles = (flag("profiles", "") ? flag("profiles", "").split(",").map(s => s.trim()).filter(Boolean) : discoverProfiles());
if (!profiles.length) { console.error("No andrena_team_5x* profiles found (use --profiles a,b)."); process.exit(1); }

// ── build per-profile records + windows ───────────────────────────────────────
const allRecords = []; // for combined
const profOut = [];
for (const name of profiles) {
  const base = join(homedir(), `.claude-${name}`, "projects");
  const files = walkJsonl(base);
  const records = []; const limitEvents = [];
  let dataMin = Infinity;
  for (const f of files) {
    let st; try { st = statSync(f); } catch { continue; }
    const rel = f.slice(base.length + 1);
    const project = rel.split(/[\\/]/)[0];
    const isSubagent = /[\\/]subagents[\\/]/.test(f);
    const events = parseFileEvents(f);
    if (!events || !events.length) continue;
    const id = f.split(/[\\/]/).pop().replace(/\.jsonl$/, "");
    const rec = { id, profile: name, project, isSubagent, events };
    records.push(rec); allRecords.push(rec);
    for (const ev of events) if (ev.ms < dataMin) dataMin = ev.ms;
    if (!isSubagent) for (const l of scanLimits(f)) limitEvents.push(l);
  }
  if (!records.length) { profOut.push({ name, empty: true }); continue; }

  const reset = detectWeeklyReset(limitEvents, tzOffset, nowMs);
  let windows;
  if (reset) windows = weeklyWindows(reset.anchorMs, dataMin, nowMs, maxWindows);
  else windows = [{ start: dataMin, end: nowMs, current: true }]; // no weekly evidence → single span

  const winOut = windows.map((w, i) => {
    const stats = aggregate(records, w.start, w.end, tzOffset, { topSessions: 15 });
    return {
      id: `${name}-w${i}`,
      start: new Date(w.start).toISOString(),
      end: new Date(w.end).toISOString(),
      current: w.current,
      stats,
      limitEvents: collapseLimits(limitEvents, w.start, w.end),
    };
  }).filter(w => w.stats.totals.turns > 0 || w.stats.totals.toolCalls > 0);

  const total = aggregate(records, dataMin, nowMs, tzOffset, { topSessions: 15 });
  profOut.push({
    name,
    anchor: reset ? reset.anchor : null,
    anchorMode: reset ? "auto" : "unknown",
    anchorEvidence: reset ? reset.evidence : null,
    dataStart: new Date(dataMin).toISOString(),
    windows: winOut,
    total: { stats: total, limitEvents: collapseLimits(limitEvents, -Infinity, Infinity) },
  });
}

// ── combined ──────────────────────────────────────────────────────────────────
let combinedMin = Infinity;
for (const r of allRecords) for (const ev of r.events) if (ev.ms < combinedMin) combinedMin = ev.ms;
const combinedStats = aggregate(allRecords, combinedMin, nowMs, tzOffset, { topSessions: 25 });

const report = {
  meta: { generatedAt: new Date(nowMs).toISOString(), tzOffset, profiles, combinedStart: new Date(combinedMin).toISOString() },
  combined: combinedStats,
  profiles: profOut,
};

const CSS = `<style>
:root{--bg:#f6f7f9;--panel:#fff;--ink:#1a1d21;--muted:#5b6470;--line:#e3e7ec;--track:#eef1f5;
  --accent:#4f7cff;--good:#2f9e6f;--bad:#d8493f;
  --c1:#4f7cff;--c2:#8b5cf6;--c3:#e8833a;--c4:#2f9e6f;--c5:#d8493f;--c6:#39b3c6;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--sans:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
@media(prefers-color-scheme:dark){:root{--bg:#0f1216;--panel:#171b21;--ink:#e8ecf1;--muted:#9aa4b2;--line:#262c35;--track:#232a33;
  --c1:#6b93ff;--c2:#a78bfa;--c3:#f0975a;--c4:#4cc78d;--c5:#f0665c;--c6:#4fc9db}}
:root[data-theme=dark]{--bg:#0f1216;--panel:#171b21;--ink:#e8ecf1;--muted:#9aa4b2;--line:#262c35;--track:#232a33;
  --c1:#6b93ff;--c2:#a78bfa;--c3:#f0975a;--c4:#4cc78d;--c5:#f0665c;--c6:#4fc9db}
:root[data-theme=light]{--bg:#f6f7f9;--panel:#fff;--ink:#1a1d21;--muted:#5b6470;--line:#e3e7ec;--track:#eef1f5;
  --c1:#4f7cff;--c2:#8b5cf6;--c3:#e8833a;--c4:#2f9e6f;--c5:#d8493f;--c6:#39b3c6}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:14px;line-height:1.45;-webkit-font-smoothing:antialiased}
#app{max-width:1180px;margin:0 auto;padding:24px 22px 60px}
h1{font-size:21px;margin:0 0 3px}h2{font-size:15px;margin:0 0 14px;font-weight:600}
.sub{color:var(--muted);font-size:13px}
.nav{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(8px);
  padding:12px 0;margin:6px 0 4px;border-bottom:1px solid var(--line)}
.tabs{display:flex;gap:8px;flex-wrap:wrap}
.tab{padding:7px 14px;border:1px solid var(--line);border-radius:9px;background:var(--panel);color:var(--ink);
  cursor:pointer;font-size:13px;font-weight:500}
.tab.on{background:var(--accent);border-color:var(--accent);color:#fff}
.tab .c{font-size:11px;color:var(--muted);margin-left:6px}.tab.on .c{color:#e6ecff}
.wins{display:flex;gap:7px;flex-wrap:wrap;margin-top:9px}
.win{padding:5px 11px;border:1px solid var(--line);border-radius:20px;background:var(--panel);color:var(--muted);cursor:pointer;font-size:12px}
.win.on{background:color-mix(in srgb,var(--accent) 16%,var(--panel));border-color:var(--accent);color:var(--ink);font-weight:600}
.callout{background:color-mix(in srgb,var(--good) 12%,var(--panel));border:1px solid color-mix(in srgb,var(--good) 40%,var(--line));border-radius:12px;padding:13px 16px;margin:16px 0}
.callout.warn{background:color-mix(in srgb,var(--c3) 12%,var(--panel));border-color:color-mix(in srgb,var(--c3) 40%,var(--line))}
.callout b{color:var(--good)}.callout.warn b{color:var(--c3)}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:12px;margin:16px 0}
.kpi{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:13px 15px}
.kpi .v{font-size:23px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.kpi .l{color:var(--muted);font-size:12px;margin-top:2px}.kpi .h{font-size:11px;color:var(--muted);margin-top:5px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:17px 19px;margin:15px 0}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:15px}@media(max-width:820px){.grid2{grid-template-columns:1fr}}
.bar-row{display:grid;grid-template-columns:150px 1fr 94px;align-items:center;gap:10px;margin:7px 0;font-size:13px}
.bar-row .name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bar-track{background:var(--track);border-radius:6px;height:18px;overflow:hidden}.bar-fill{height:100%;border-radius:6px}
.bar-row .val{text-align:right;font-variant-numeric:tabular-nums;color:var(--muted)}
.legend{display:flex;flex-wrap:wrap;gap:13px;margin-top:9px;font-size:12px;color:var(--muted)}
.legend span{display:inline-flex;align-items:center;gap:6px}.dot{width:10px;height:10px;border-radius:3px;display:inline-block}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line)}
th{color:var(--muted);font-weight:600;font-size:12px}td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
.pill{font-size:11px;padding:1px 7px;border-radius:20px;background:var(--track);color:var(--muted)}
.err{color:var(--bad)}.goal{color:var(--muted);max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.stack{display:flex;height:26px;border-radius:7px;overflow:hidden;border:1px solid var(--line)}.stack>div{height:100%}
svg{display:block;width:100%;height:auto;overflow:visible}.axis{fill:var(--muted);font-size:10px;font-family:var(--mono)}
.themebtn{position:fixed;top:12px;right:14px;background:var(--panel);border:1px solid var(--line);color:var(--muted);border-radius:8px;padding:5px 10px;cursor:pointer;font-size:12px;z-index:9}
.overflow{overflow-x:auto}.mono{font-family:var(--mono);font-size:12px}
.tl{border-left:2px solid var(--line);margin-left:6px;padding-left:14px}.tl .ev{margin:8px 0;font-size:12.5px}
.tl .ev time{color:var(--muted);font-family:var(--mono);font-size:11px;margin-right:8px}
</style>`;

const JS = String.raw`<button class="themebtn" onclick="(function(){var r=document.documentElement,d=(r.getAttribute('data-theme')||(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'))==='dark';r.setAttribute('data-theme',d?'light':'dark');})()">◐ theme</button>
<script>
const R=DATA,CC=['--c1','--c2','--c3','--c4','--c5','--c6'];
const cvar=n=>getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const usd=n=>'$'+(n||0).toLocaleString('en-US',{maximumFractionDigits:(n||0)<100?2:0});
const tok=n=>n>=1e9?(n/1e9).toFixed(2)+'B':n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(1)+'K':String(Math.round(n||0));
const num=n=>(n||0).toLocaleString('en-US');
const esc=s=>(s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const dt=s=>{try{return new Date(s).toLocaleString('en-GB',{timeZone:'Europe/Berlin',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}catch(e){return s}};
const dmon=s=>{try{return new Date(s).toLocaleDateString('en-GB',{timeZone:'Europe/Berlin',day:'2-digit',month:'short'})}catch(e){return s}};
const dayName=s=>new Date(s+'T12:00:00Z').toLocaleDateString('en-GB',{weekday:'short',day:'2-digit',month:'short'});
const shortProf=n=>n.replace('andrena_team_','');
const shortProj=p=>(p||'').replace('C--projects-papershift-','').replace(/^C--/,'');

let state={scope:'combined',win:'total'};

function barRows(items,label,valOf,fmt,colorIdx){
  const max=Math.max(...items.map(valOf),1);
  return items.map((it,i)=>{const v=valOf(it),w=(v/max*100).toFixed(1),col=cvar(CC[colorIdx!=null?colorIdx:i%CC.length]);
    return '<div class="bar-row"><div class="name" title="'+esc(label(it))+'">'+esc(label(it))+'</div><div class="bar-track"><div class="bar-fill" style="width:'+w+'%;background:'+col+'"></div></div><div class="val">'+fmt(v,it)+'</div></div>';}).join('');
}
function dailyChart(st){const d=st.byDay;if(!d.length)return'<div class="sub">No activity.</div>';
  const W=680,H=200,pad=34,bw=Math.min(70,(W-pad*2)/d.length-10),max=Math.max(...d.map(x=>x.cost),1),gap=(W-pad*2)/d.length;let b='',l='';
  d.forEach((x,i)=>{const h=(x.cost/max)*(H-pad*2),cx=pad+gap*i+gap/2;
    b+='<rect x="'+(cx-bw/2)+'" y="'+(H-pad-h)+'" width="'+bw+'" height="'+h+'" rx="4" fill="'+cvar('--c1')+'"><title>'+dayName(x.day)+' — '+usd(x.cost)+' · '+x.turns+' turns · '+x.toolCalls+' tools</title></rect>';
    b+='<text class="axis" x="'+cx+'" y="'+(H-pad-h-5)+'" text-anchor="middle">'+usd(x.cost)+'</text>';
    l+='<text class="axis" x="'+cx+'" y="'+(H-pad+14)+'" text-anchor="middle">'+dayName(x.day).replace(/,.*/,'')+'</text>';});
  return '<svg viewBox="0 0 '+W+' '+H+'">'+b+l+'</svg>';}
function hourChart(st){const h=st.byHour,W=680,H=150,pad=26,max=Math.max(...h.map(x=>x.turns),1),gap=(W-pad*2)/24;let b='',l='';
  h.forEach((x,i)=>{const bh=(x.turns/max)*(H-pad*2),cx=pad+gap*i+gap/2;
    b+='<rect x="'+(cx-gap*0.38)+'" y="'+(H-pad-bh)+'" width="'+(gap*0.76)+'" height="'+bh+'" rx="2" fill="'+cvar('--c2')+'"><title>'+String(i).padStart(2,'0')+':00 — '+x.turns+' turns · '+usd(x.cost)+'</title></rect>';
    if(i%3===0)l+='<text class="axis" x="'+cx+'" y="'+(H-pad+13)+'" text-anchor="middle">'+String(i).padStart(2,'0')+'</text>';});
  return '<svg viewBox="0 0 '+W+' '+H+'">'+b+l+'</svg>';}
function tokenStack(st){const t=st.tokens,total=st.totals.rawTokens||1;
  const parts=[['cache-read',t.cacheRead,'--c1'],['cache-write',t.cacheCreation,'--c2'],['output',t.output,'--c3'],['input',t.input,'--c4']];
  return '<div class="stack">'+parts.map(p=>'<div style="width:'+(p[1]/total*100)+'%;background:'+cvar(p[2])+'" title="'+p[0]+': '+tok(p[1])+'"></div>').join('')+
    '</div><div class="legend">'+parts.map(p=>'<span><i class="dot" style="background:'+cvar(p[2])+'"></i>'+p[0]+' '+tok(p[1])+'</span>').join('')+'</div>';}

function kpis(st,days){const t=st.totals,er=t.toolCalls?(t.toolErrors/t.toolCalls*100):0;const K=(v,l,h)=>'<div class="kpi"><div class="v">'+v+'</div><div class="l">'+l+'</div>'+(h?'<div class="h">'+h+'</div>':'')+'</div>';
  return '<div class="kpis">'+K(usd(t.cost),'Est. subscription value','pay-go equivalent')+K(tok(t.rawTokens),'Raw tokens',tok(t.tokens?t.tokens.output:st.tokens.output)+' generated')+
    K(num(t.sessions),'Sessions',num(t.subagents)+' subagents')+K(num(t.turns),'Assistant turns','API calls billed')+
    K(num(t.toolCalls),'Tool calls',t.toolErrors+' err · '+er.toFixed(1)+'%')+(days?K(usd(t.cost/days),'per day avg',(t.turns/days|0)+' turns/day'):'')+'</div>';}

function statsPanels(st,{showProfile}={}){
  const t=st.totals;
  const modelBars=barRows(st.byModel.filter(x=>x.cost>0),x=>x.model,x=>x.cost,(v)=>usd(v)+' · '+(v/t.cost*100).toFixed(0)+'%');
  const projBars=barRows(st.byProject.slice(0,8),x=>shortProj(x.project),x=>x.cost,(v)=>usd(v));
  const profBars=showProfile&&st.byProfile.length?barRows(st.byProfile,x=>shortProf(x.profile),x=>x.cost,(v,it)=>usd(v)+' · '+(v/t.cost*100).toFixed(0)+'%'):'';
  const toolRows=st.byTool.slice(0,14).map(x=>{const r=x.calls?(x.errors/x.calls*100):0;
    return '<tr><td>'+esc(x.tool)+'</td><td class="n">'+num(x.calls)+'</td><td class="n '+(x.errors?'err':'')+'">'+(x.errors||'')+'</td><td class="n">'+(x.errors?r.toFixed(1)+'%':'')+'</td></tr>';}).join('');
  const sessRows=st.sessions.map(s=>'<tr><td class="goal" title="'+esc(s.firstPrompt||s.id)+'">'+esc(s.firstPrompt||'(no prompt)')+'</td>'+
    (showProfile?'<td><span class="pill">'+esc(shortProf(s.profile))+'</span></td>':'')+
    '<td><span class="pill">'+esc(shortProj(s.project))+'</span></td><td>'+esc(s.model)+'</td>'+
    '<td class="n">'+usd(s.cost)+'</td><td class="n">'+num(s.turns)+'</td><td class="n">'+num(s.toolCalls)+'</td>'+
    '<td class="n">'+(s.durationMin>60?(s.durationMin/60).toFixed(1)+'h':Math.round(s.durationMin)+'m')+'</td></tr>').join('');
  return (profBars?'<div class="panel"><h2>By profile</h2>'+profBars+'</div>':'')+
    '<div class="panel"><h2>Token composition</h2>'+tokenStack(st)+'<div class="sub" style="margin-top:9px">Cache-read dominates volume but is billed ~0.1× — cost is weighted accordingly.</div></div>'+
    '<div class="panel"><h2>Estimated value by day</h2>'+dailyChart(st)+'</div>'+
    '<div class="panel"><h2>Activity by hour (Berlin)</h2>'+hourChart(st)+'</div>'+
    '<div class="grid2"><div class="panel"><h2>By model</h2>'+modelBars+'</div><div class="panel"><h2>By project</h2>'+projBars+'</div></div>'+
    '<div class="panel"><h2>Tool calls</h2><div class="overflow"><table><thead><tr><th>Tool</th><th class="n">Calls</th><th class="n">Errors</th><th class="n">Rate</th></tr></thead><tbody>'+toolRows+'</tbody></table></div></div>'+
    '<div class="panel"><h2>Top sessions by est. value</h2><div class="overflow"><table><thead><tr><th>Goal (first prompt)</th>'+(showProfile?'<th>Profile</th>':'')+'<th>Project</th><th>Model</th><th class="n">Value</th><th class="n">Turns</th><th class="n">Tools</th><th class="n">Dur</th></tr></thead><tbody>'+sessRows+'</tbody></table></div></div>';
}

function winLabel(w){const s=dmon(w.start);return (w.current?'This week':'Week')+' · '+s+(w.current?' → now':' – '+dmon(w.end));}

function renderNav(){
  const tabs=[['combined','Combined',R.combined.totals.cost]].concat(R.profiles.filter(p=>!p.empty).map(p=>[p.name,shortProf(p.name),p.total.stats.totals.cost]));
  let html='<div class="tabs">'+tabs.map(([k,lbl,c])=>'<button class="tab'+(state.scope===k?' on':'')+'" onclick="sel(\''+k+'\')">'+esc(lbl)+'<span class="c">'+usd(c)+'</span></button>').join('')+'</div>';
  if(state.scope!=='combined'){const p=R.profiles.find(x=>x.name===state.scope);
    const chips=[['total','Profile total']].concat(p.windows.map(w=>[w.id,winLabel(w)]));
    html+='<div class="wins">'+chips.map(([k,lbl])=>'<button class="win'+(state.win===k?' on':'')+'" onclick="selWin(\''+k+'\')">'+esc(lbl)+'</button>').join('')+'</div>';}
  return '<div class="nav">'+html+'</div>';
}

function renderBody(){
  if(state.scope==='combined'){
    const st=R.combined,days=Math.max(1,(new Date(R.meta.generatedAt)-new Date(R.meta.combinedStart))/864e5);
    return '<div class="callout"><b>Combined — all '+R.profiles.filter(p=>!p.empty).length+' profiles.</b> Every profile, all data ('+dmon(R.meta.combinedStart)+' → now, '+days.toFixed(1)+'d). '+
      'This is the grand total of subscription value extracted across all seats. Windows are per-profile (each account resets on a different day) — pick a profile tab to slice by its weekly reset.</div>'+
      kpis(st,days)+statsPanels(st,{showProfile:true});
  }
  const p=R.profiles.find(x=>x.name===state.scope);
  let src,limitEvents,days,head;
  if(state.win==='total'){src=p.total.stats;limitEvents=p.total.limitEvents;days=Math.max(1,(new Date(R.meta.generatedAt)-new Date(p.dataStart))/864e5);
    head='<div class="callout'+(p.anchorMode==='unknown'?' warn':'')+'"><b>'+esc(shortProf(p.name))+' — profile total (all windows).</b> All data '+dmon(p.dataStart)+' → now ('+days.toFixed(1)+'d). '+
      (p.anchor?'Weekly reset <b>'+esc(p.anchor.weekday+' '+p.anchor.clock+' ('+p.anchor.tz+')')+'</b>'+(p.anchorEvidence?', auto-detected from: <span class="mono">“'+esc(p.anchorEvidence.text)+'”</span>.':'.'):'Weekly reset anchor <b>unknown</b> — no weekly-limit banner in this profile yet (only 5-hour session limits), so it is shown as one span.')+'</div>';
  } else {const w=p.windows.find(x=>x.id===state.win);src=w.stats;limitEvents=w.limitEvents;days=Math.max(0.1,(new Date(w.end)-new Date(w.start))/864e5);
    head='<div class="callout"><b>'+esc(shortProf(p.name))+' — '+esc(winLabel(w))+'.</b> '+dt(w.start)+' → '+(w.current?'now':dt(w.end))+' ('+days.toFixed(1)+'d), weekly reset '+esc(p.anchor?p.anchor.weekday+' '+p.anchor.clock:'unknown')+'.</div>';}
  const tl=(limitEvents||[]).slice(0,14).map(e=>'<div class="ev"><time>'+dt(e.ts)+'</time>'+esc(e.text)+(e.count>1?' <span class="pill">×'+e.count+'</span>':'')+'</div>').join('')||'<div class="sub">No usage-limit banners in this window.</div>';
  return head+kpis(src,days)+
    '<div class="panel"><h2>Usage-limit timeline</h2><div class="tl">'+tl+'</div></div>'+
    statsPanels(src,{showProfile:false});
}

function render(){document.getElementById('app').innerHTML=
  '<h1>Subscription Quota — complete picture</h1>'+
  '<div class="sub">'+R.profiles.filter(p=>!p.empty).length+' profiles · generated '+dt(R.meta.generatedAt)+' · per-turn accounting, subagents included</div>'+
  renderNav()+renderBody()+
  '<div class="sub" style="margin-top:18px">Est. value = pay-go API cost of the same tokens (opus 5/25, sonnet 3/15, haiku 1/5 $/1M; cache-read 0.1×, cache-write 1.25×) — the leverage from a flat subscription, not a bill. Fable priced as opus (not in table) — slight over-estimate.</div>';}
window.sel=k=>{state.scope=k;state.win='total';render();window.scrollTo(0,0);};
window.selWin=k=>{state.win=k;render();};
render();
</script>`;

if (jsonOut) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }
if (htmlPath) { writeFileSync(htmlPath, renderHtml(report)); console.error(`Wrote combined dashboard → ${htmlPath}`); process.exit(0); }

// terminal summary
const usd = (n) => `$${n.toFixed(2)}`;
const tk = (n) => n >= 1e9 ? (n / 1e9).toFixed(2) + "B" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : (n / 1e3).toFixed(1) + "K";
console.log("═".repeat(74));
console.log(`QUOTA MULTI — ${profiles.length} profiles · combined`);
console.log("═".repeat(74));
const c = report.combined.totals;
console.log(`COMBINED: ${usd(c.cost)} · ${tk(c.rawTokens)} tok · ${c.sessions} sessions · ${c.subagents} subagents · ${c.turns} turns · ${c.toolCalls} tools`);
console.log("─".repeat(74));
for (const p of profOut) {
  if (p.empty) { console.log(`  ${p.name}: (no data)`); continue; }
  const t = p.total.stats.totals;
  const a = p.anchor ? `${p.anchor.weekday} ${p.anchor.clock}` : "weekly anchor unknown";
  console.log(`  ${p.name.padEnd(22)} ${usd(t.cost).padStart(10)} · ${String(t.sessions).padStart(3)}s/${String(t.subagents).padStart(3)}a · reset ${a} · ${p.windows.length} window(s)`);
}
console.log("═".repeat(74));

function renderHtml(r) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Quota — all profiles</title>
${CSS}
</head><body><div id="app"></div>
<script>const DATA=${JSON.stringify(r)};</script>
${JS}
</body></html>`;
}
