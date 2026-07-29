#!/usr/bin/env node
/**
 * QUOTA MONTH — a CALENDAR-RANGE quota dashboard: everything the andrena_team_5x*
 * profiles did inside an explicit wall-clock window (default: the current calendar
 * month), across all profiles combined plus per-profile.
 *
 * Companion to the two existing views:
 *   quota-report.mjs  → ONE profile, since its last weekly reset
 *   quota-multi.mjs   → ALL profiles, sliced by each one's weekly reset windows
 *   quota-month.mjs   → ALL profiles, one fixed calendar range ("the whole July")
 *
 * Same accounting as both (lib/quota.mjs): per-TURN timestamp filtering, subagents
 * included, cost = pay-go-equivalent "subscription value". A session that spans the
 * range boundary contributes only its in-range turns.
 *
 * Only `~/.claude-andrena_team_5x*` profiles are discovered — the personal `~/.claude`
 * profile is deliberately never read. Pass --profiles to narrow further.
 *
 * Usage:
 *   node scripts/quota-month.mjs --from 2026-07-01 --to 2026-08-01 --html july.html
 *   node scripts/quota-month.mjs --month 2026-07 --html july.html      # same thing
 *   node scripts/quota-month.mjs                                        # current month → terminal
 *   node scripts/quota-month.mjs --month 2026-07 --json
 *   node scripts/quota-month.mjs --profiles andrena_team_5x,andrena_team_5x_2 --month 2026-07
 *
 * Dates are Berlin wall-clock (see --tz); --to is EXCLUSIVE.
 */
import { readdirSync, statSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { walkJsonl, parseFileEvents, scanLimits, collapseLimits, detectWeeklyReset, weeklyWindows, aggregate } from "./lib/quota.mjs";

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
const tzOffset = parseInt(flag("tz", "2"), 10);
const jsonOut = argv.includes("--json");
const htmlPath = flag("html", "");
const nowMs = Date.now();

// ── range ─────────────────────────────────────────────────────────────────────
// Berlin wall-clock midnight → UTC ms. --to is exclusive.
const dayMs = (y, mo, d) => Date.UTC(y, mo, d, -tzOffset, 0, 0);
function parseDay(s) {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(s || "");
  if (!m) return null;
  return { y: +m[1], mo: +m[2] - 1, d: m[3] ? +m[3] : 1 };
}
let fromMs, toMs, rangeLabel;
const monthArg = flag("month", "");
const fromArg = flag("from", ""), toArg = flag("to", "");
if (monthArg) {
  const p = parseDay(monthArg);
  if (!p) { console.error(`--month wants YYYY-MM (got "${monthArg}")`); process.exit(1); }
  fromMs = dayMs(p.y, p.mo, 1); toMs = dayMs(p.y, p.mo + 1, 1);
} else if (fromArg) {
  const a = parseDay(fromArg);
  if (!a) { console.error(`--from wants YYYY-MM-DD (got "${fromArg}")`); process.exit(1); }
  fromMs = dayMs(a.y, a.mo, a.d);
  if (toArg) {
    const b = parseDay(toArg);
    if (!b) { console.error(`--to wants YYYY-MM-DD (got "${toArg}")`); process.exit(1); }
    toMs = dayMs(b.y, b.mo, b.d);
  } else toMs = dayMs(a.y, a.mo + 1, 1);
} else {
  const n = new Date(nowMs + tzOffset * 3600e3);
  fromMs = dayMs(n.getUTCFullYear(), n.getUTCMonth(), 1);
  toMs = dayMs(n.getUTCFullYear(), n.getUTCMonth() + 1, 1);
}
if (!(toMs > fromMs)) { console.error("Empty range: --to must be after --from."); process.exit(1); }
const endMs = Math.min(toMs, nowMs);           // don't chart the future
const openEnded = toMs > nowMs;                // range not finished yet
{
  const d = new Date(fromMs + tzOffset * 3600e3);
  const isFullMonth = d.getUTCDate() === 1 && toMs === dayMs(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  rangeLabel = isFullMonth
    ? d.toLocaleDateString("en-GB", { timeZone: "UTC", month: "long", year: "numeric" })
    : `${new Date(fromMs + tzOffset * 3600e3).toISOString().slice(0, 10)} → ${new Date(toMs + tzOffset * 3600e3 - 1).toISOString().slice(0, 10)}`;
}

// ── profiles: andrena_team_5x* only, never the personal ~/.claude ──────────────
function discoverProfiles() {
  const home = homedir(); const out = [];
  for (const e of readdirSync(home)) {
    const m = e.match(/^\.claude-(andrena_team_5x.*)$/);
    if (m && existsSync(join(home, e, "projects"))) out.push(m[1]);
  }
  return out.sort((a, b) => a.length - b.length || a.localeCompare(b));
}
const profiles = flag("profiles", "") ? flag("profiles", "").split(",").map(s => s.trim()).filter(Boolean) : discoverProfiles();
if (!profiles.length) { console.error("No andrena_team_5x* profiles found (use --profiles a,b)."); process.exit(1); }

// ── parse (once) ──────────────────────────────────────────────────────────────
// A transcript last written before the range starts cannot hold in-range turns,
// so mtime is a safe lower-bound prefilter — and it skips most of the archive.
const allRecords = [];
const profOut = [];
let skipped = 0, parsed = 0;
for (const name of profiles) {
  const base = join(homedir(), `.claude-${name}`, "projects");
  const records = []; const limitEvents = [];
  for (const f of walkJsonl(base)) {
    let st; try { st = statSync(f); } catch { continue; }
    if (st.mtimeMs < fromMs) { skipped++; continue; }
    const rel = f.slice(base.length + 1);
    const events = parseFileEvents(f);
    parsed++;
    if (!events || !events.length) continue;
    if (!events.some(ev => ev.ms >= fromMs && ev.ms < toMs)) continue;   // wholly out of range
    const rec = {
      id: f.split(/[\\/]/).pop().replace(/\.jsonl$/, ""),
      profile: name,
      project: rel.split(/[\\/]/)[0],
      isSubagent: /[\\/]subagents[\\/]/.test(f),
      events,
    };
    records.push(rec); allRecords.push(rec);
    if (!rec.isSubagent) for (const l of scanLimits(f)) limitEvents.push(l);
  }
  if (!records.length) { profOut.push({ name, empty: true }); continue; }

  const reset = detectWeeklyReset(limitEvents, tzOffset, nowMs);
  // Weekly windows aligned to this profile's own reset anchor, but clipped to the range.
  let windows = reset ? weeklyWindows(reset.anchorMs, fromMs, endMs, 12) : [];
  // `partial` must be judged against the RAW 7-day billing week (weeklyWindows
  // already clamps `end` to now, which would make the in-progress week look complete).
  windows = windows
    .map(w => ({
      start: Math.max(w.start, fromMs), end: Math.min(w.end, endMs), current: w.current,
      partial: w.start < fromMs || w.start + 7 * 24 * 3600e3 > endMs,
    }))
    .filter(w => w.end > w.start);

  const winOut = windows.map((w, i) => ({
    id: `${name}-w${i}`,
    start: new Date(w.start).toISOString(),
    end: new Date(w.end).toISOString(),
    current: w.current, partial: w.partial,
    stats: aggregate(records, w.start, w.end, tzOffset, { topSessions: 15 }),
    limitEvents: collapseLimits(limitEvents, w.start, w.end),
  })).filter(w => w.stats.totals.turns > 0 || w.stats.totals.toolCalls > 0);

  profOut.push({
    name,
    anchor: reset ? reset.anchor : null,
    anchorMode: reset ? "auto" : "unknown",
    anchorEvidence: reset ? reset.evidence : null,
    windows: winOut,
    total: { stats: aggregate(records, fromMs, toMs, tzOffset, { topSessions: 15 }), limitEvents: collapseLimits(limitEvents, fromMs, toMs) },
  });
}

// ── combined + calendar-week rollup ───────────────────────────────────────────
const combinedStats = aggregate(allRecords, fromMs, toMs, tzOffset, { topSessions: 25 });

// Calendar weeks (Mon-anchored, Berlin) clipped to the range — a month is 4-5 of them.
const weeks = [];
{
  const wkMs = 7 * 24 * 3600e3;
  const firstWall = new Date(fromMs + tzOffset * 3600e3);
  const backToMon = (firstWall.getUTCDay() + 6) % 7;
  for (let s = fromMs - backToMon * 24 * 3600e3; s < endMs; s += wkMs) {
    const ws = Math.max(s, fromMs), we = Math.min(s + wkMs, endMs);
    if (we <= ws) continue;
    const st = aggregate(allRecords, ws, we, tzOffset, { topSessions: 0 });
    if (!st.totals.turns && !st.totals.toolCalls) continue;
    weeks.push({
      start: new Date(ws).toISOString(), end: new Date(we).toISOString(),
      days: (we - ws) / 864e5, partial: s < fromMs || s + wkMs > endMs,
      totals: st.totals, byProfile: st.byProfile.map(p => ({ profile: p.profile, cost: p.cost })),
    });
  }
}

// Zero-fill the calendar days so a quiet day reads as a gap, not as absent data.
function padDays(st) {
  const have = new Map(st.byDay.map(d => [d.day, d]));
  const out = [];
  for (let ms = fromMs; ms < endMs; ms += 864e5) {
    const day = new Date(ms + tzOffset * 3600e3).toISOString().slice(0, 10);
    out.push(have.get(day) || { day, turns: 0, toolCalls: 0, cost: 0, rawTokens: 0 });
  }
  return out;
}
combinedStats.byDay = padDays(combinedStats);
for (const p of profOut) if (!p.empty) p.total.stats.byDay = padDays(p.total.stats);

const report = {
  meta: {
    generatedAt: new Date(nowMs).toISOString(), tzOffset, profiles, rangeLabel,
    from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(),
    end: new Date(endMs).toISOString(), openEnded,
    days: (endMs - fromMs) / 864e5,
    filesParsed: parsed, filesSkippedByMtime: skipped,
  },
  combined: combinedStats,
  weeks,
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
tfoot td{font-weight:700;border-bottom:none}
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
const dayNum=s=>String(+s.slice(8,10));
const shortProf=n=>n.replace('andrena_team_','');
const shortProj=p=>(p||'').replace('C--projects-acme-','').replace(/^C--/,'');

let state={scope:'combined',win:'total'};

function barRows(items,label,valOf,fmt,colorIdx){
  const max=Math.max(...items.map(valOf),1);
  return items.map((it,i)=>{const v=valOf(it),w=(v/max*100).toFixed(1),col=cvar(CC[colorIdx!=null?colorIdx:i%CC.length]);
    return '<div class="bar-row"><div class="name" title="'+esc(label(it))+'">'+esc(label(it))+'</div><div class="bar-track"><div class="bar-fill" style="width:'+w+'%;background:'+col+'"></div></div><div class="val">'+fmt(v,it)+'</div></div>';}).join('');
}
// Month-scale daily chart: up to 31 bars, so per-bar value labels and weekday names
// are dropped once they would collide — the tooltip keeps the detail.
function dailyChart(st){const d=st.byDay;if(!d.length)return'<div class="sub">No activity.</div>';
  const W=980,H=230,pad=34,gap=(W-pad*2)/d.length,bw=Math.max(3,Math.min(46,gap-4));
  const max=Math.max(...d.map(x=>x.cost),1),dense=d.length>14;let b='',l='';
  d.forEach((x,i)=>{const h=(x.cost/max)*(H-pad*2),cx=pad+gap*i+gap/2;
    const wd=new Date(x.day+'T12:00:00Z').getUTCDay(),we=(wd===0||wd===6);
    b+='<rect x="'+(cx-bw/2)+'" y="'+(H-pad-h)+'" width="'+bw+'" height="'+Math.max(h,x.cost>0?1:0)+'" rx="3" fill="'+cvar(we?'--c2':'--c1')+'"><title>'+dayName(x.day)+' — '+usd(x.cost)+' · '+x.turns+' turns · '+x.toolCalls+' tools</title></rect>';
    if(!dense)b+='<text class="axis" x="'+cx+'" y="'+(H-pad-h-5)+'" text-anchor="middle">'+usd(x.cost)+'</text>';
    else if(x.cost>=max*0.55)b+='<text class="axis" x="'+cx+'" y="'+(H-pad-h-5)+'" text-anchor="middle">'+usd(x.cost)+'</text>';
    if(!dense||i%2===0)l+='<text class="axis" x="'+cx+'" y="'+(H-pad+14)+'" text-anchor="middle">'+(dense?dayNum(x.day):dayName(x.day).replace(/,.*/,''))+'</text>';});
  return '<svg viewBox="0 0 '+W+' '+H+'">'+b+l+'</svg>'+
    (dense?'<div class="legend"><span><i class="dot" style="background:'+cvar('--c1')+'"></i>weekday</span><span><i class="dot" style="background:'+cvar('--c2')+'"></i>weekend</span></div>':'');}
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
  const active=st.byDay?st.byDay.filter(d=>d.turns>0).length:0;
  return '<div class="kpis">'+K(usd(t.cost),'Est. subscription value','pay-go equivalent')+K(tok(t.rawTokens),'Raw tokens',tok(t.tokens?t.tokens.output:st.tokens.output)+' generated')+
    K(num(t.sessions),'Sessions',num(t.subagents)+' subagents')+K(num(t.turns),'Assistant turns','API calls billed')+
    K(num(t.toolCalls),'Tool calls',t.toolErrors+' err · '+er.toFixed(1)+'%')+
    (days?K(usd(t.cost/days),'per calendar day',(t.turns/days|0)+' turns/day'):'')+
    (active?K(usd(t.cost/active),'per ACTIVE day',active+' of '+st.byDay.length+' days used'):'')+'</div>';}

function weekTable(){if(!R.weeks.length)return'';
  const rows=R.weeks.map(w=>'<tr><td>'+dmon(w.start)+' – '+dmon(new Date(new Date(w.end)-1).toISOString())+(w.partial?' <span class="pill">partial</span>':'')+'</td>'+
    '<td class="n">'+usd(w.totals.cost)+'</td><td class="n">'+tok(w.totals.rawTokens)+'</td><td class="n">'+num(w.totals.sessions)+'</td>'+
    '<td class="n">'+num(w.totals.subagents)+'</td><td class="n">'+num(w.totals.turns)+'</td><td class="n">'+num(w.totals.toolCalls)+'</td>'+
    '<td class="n">'+usd(w.totals.cost/w.days)+'</td></tr>').join('');
  const t=R.combined.totals;
  return '<div class="panel"><h2>Week by week (Mon–Sun, Berlin)</h2><div class="overflow"><table>'+
    '<thead><tr><th>Week</th><th class="n">Value</th><th class="n">Tokens</th><th class="n">Sessions</th><th class="n">Subagents</th><th class="n">Turns</th><th class="n">Tools</th><th class="n">$/day</th></tr></thead>'+
    '<tbody>'+rows+'</tbody>'+
    '<tfoot><tr><td>'+esc(R.meta.rangeLabel)+'</td><td class="n">'+usd(t.cost)+'</td><td class="n">'+tok(t.rawTokens)+'</td><td class="n">'+num(t.sessions)+'</td>'+
    '<td class="n">'+num(t.subagents)+'</td><td class="n">'+num(t.turns)+'</td><td class="n">'+num(t.toolCalls)+'</td><td class="n">'+usd(t.cost/R.meta.days)+'</td></tr></tfoot>'+
    '</table></div><div class="sub" style="margin-top:9px">Calendar weeks clipped to the range — not the per-account billing weeks (each profile resets on its own weekday; use a profile tab for those).</div></div>';}

function statsPanels(st,{showProfile}={}){
  const t=st.totals;
  const modelBars=barRows(st.byModel.filter(x=>x.cost>0),x=>x.model,x=>x.cost,(v)=>usd(v)+' · '+(v/t.cost*100).toFixed(0)+'%');
  const projBars=barRows(st.byProject.slice(0,10),x=>shortProj(x.project),x=>x.cost,(v)=>usd(v));
  const profBars=showProfile&&st.byProfile.length?barRows(st.byProfile,x=>shortProf(x.profile),x=>x.cost,(v,it)=>usd(v)+' · '+(v/t.cost*100).toFixed(0)+'%'):'';
  const toolRows=st.byTool.slice(0,16).map(x=>{const r=x.calls?(x.errors/x.calls*100):0;
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
    (st.sessions.length?'<div class="panel"><h2>Top sessions by est. value</h2><div class="overflow"><table><thead><tr><th>Goal (first prompt)</th>'+(showProfile?'<th>Profile</th>':'')+'<th>Project</th><th>Model</th><th class="n">Value</th><th class="n">Turns</th><th class="n">Tools</th><th class="n">Dur</th></tr></thead><tbody>'+sessRows+'</tbody></table></div></div>':'');
}

// "Current week" already reads as in-progress, so the * marker is reserved for
// weeks that are partial because the REPORT RANGE cut them short.
function winLabel(w){return (w.current?'Current week':'Week')+' · '+dmon(w.start)+' – '+dmon(new Date(new Date(w.end)-1).toISOString())+(w.partial&&!w.current?' *':'');}

function renderNav(){
  const tabs=[['combined','All profiles',R.combined.totals.cost]].concat(R.profiles.filter(p=>!p.empty).map(p=>[p.name,shortProf(p.name),p.total.stats.totals.cost]));
  let html='<div class="tabs">'+tabs.map(([k,lbl,c])=>'<button class="tab'+(state.scope===k?' on':'')+'" onclick="sel(\''+k+'\')">'+esc(lbl)+'<span class="c">'+usd(c)+'</span></button>').join('')+'</div>';
  if(state.scope!=='combined'){const p=R.profiles.find(x=>x.name===state.scope);
    const chips=[['total',esc(R.meta.rangeLabel)+' total']].concat(p.windows.map(w=>[w.id,winLabel(w)]));
    html+='<div class="wins">'+chips.map(([k,lbl])=>'<button class="win'+(state.win===k?' on':'')+'" onclick="selWin(\''+k+'\')">'+lbl+'</button>').join('')+'</div>';}
  return '<div class="nav">'+html+'</div>';
}

function renderBody(){
  const nProf=R.profiles.filter(p=>!p.empty).length;
  if(state.scope==='combined'){
    const st=R.combined,days=R.meta.days;
    return '<div class="callout"><b>'+esc(R.meta.rangeLabel)+' — all '+nProf+' team profiles combined.</b> '+
      dmon(R.meta.from)+' → '+(R.meta.openEnded?'now':dmon(new Date(new Date(R.meta.to)-1).toISOString()))+' ('+days.toFixed(1)+' days'+(R.meta.openEnded?', month still running':'')+'). '+
      'Grand total of subscription value extracted across all team seats in this range. The personal <span class="mono">~/.claude</span> profile is excluded by design.</div>'+
      kpis(st,days)+weekTable()+statsPanels(st,{showProfile:true});
  }
  const p=R.profiles.find(x=>x.name===state.scope);
  let src,limitEvents,days,head;
  if(state.win==='total'){src=p.total.stats;limitEvents=p.total.limitEvents;days=R.meta.days;
    head='<div class="callout'+(p.anchorMode==='unknown'?' warn':'')+'"><b>'+esc(shortProf(p.name))+' — '+esc(R.meta.rangeLabel)+'.</b> '+
      dmon(R.meta.from)+' → '+(R.meta.openEnded?'now':dmon(new Date(new Date(R.meta.to)-1).toISOString()))+' ('+days.toFixed(1)+'d). '+
      (p.anchor?'Weekly reset <b>'+esc(p.anchor.weekday+' '+p.anchor.clock+' ('+p.anchor.tz+')')+'</b> — the week chips below follow this account\'s own billing weeks, clipped to the range (* = partial).':'Weekly reset anchor <b>unknown</b> — no weekly-limit banner seen for this profile, so no billing-week chips.')+'</div>';
  } else {const w=p.windows.find(x=>x.id===state.win);src=w.stats;limitEvents=w.limitEvents;days=Math.max(0.1,(new Date(w.end)-new Date(w.start))/864e5);
    head='<div class="callout"><b>'+esc(shortProf(p.name))+' — '+esc(winLabel(w))+'.</b> '+dt(w.start)+' → '+(w.current?'now':dt(w.end))+' ('+days.toFixed(1)+'d), billing week of '+esc(p.anchor?p.anchor.weekday+' '+p.anchor.clock:'unknown')+
      (w.partial?'. <b>Partial</b> — clipped to the report range, so it is not a full billing week.':'.')+'</div>';}
  const tl=(limitEvents||[]).slice(0,20).map(e=>'<div class="ev"><time>'+dt(e.ts)+'</time>'+esc(e.text)+(e.count>1?' <span class="pill">×'+e.count+'</span>':'')+'</div>').join('')||'<div class="sub">No usage-limit banners in this window.</div>';
  return head+kpis(src,days)+
    '<div class="panel"><h2>Usage-limit timeline</h2><div class="tl">'+tl+'</div></div>'+
    statsPanels(src,{showProfile:false});
}

function render(){document.getElementById('app').innerHTML=
  '<h1>Subscription Quota — '+esc(R.meta.rangeLabel)+'</h1>'+
  '<div class="sub">'+R.profiles.filter(p=>!p.empty).length+' team profiles · generated '+dt(R.meta.generatedAt)+' · per-turn accounting, subagents included</div>'+
  renderNav()+renderBody()+
  '<div class="sub" style="margin-top:18px">Est. value = pay-go API cost of the same tokens (opus 5/25, sonnet 3/15, haiku 1/5 $/1M; cache-read 0.1×, cache-write 1.25×) — the leverage from a flat subscription, not a bill. Fable priced as opus (not in the table) — slight over-estimate.</div>';}
window.sel=k=>{state.scope=k;state.win='total';render();window.scrollTo(0,0);};
window.selWin=k=>{state.win=k;render();};
render();
</script>`;

function renderHtml(r) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Quota — ${r.meta.rangeLabel}</title>
${CSS}
</head><body><div id="app"></div>
<script>const DATA=${JSON.stringify(r)};</script>
${JS}
</body></html>`;
}

if (jsonOut) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }
if (htmlPath) { writeFileSync(htmlPath, renderHtml(report)); console.error(`Wrote ${report.meta.rangeLabel} dashboard → ${htmlPath}`); }

// ── terminal summary ──────────────────────────────────────────────────────────
const usd = (n) => `$${n.toFixed(2)}`;
const tk = (n) => n >= 1e9 ? (n / 1e9).toFixed(2) + "B" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : (n / 1e3).toFixed(1) + "K";
const c = report.combined.totals;
console.log("═".repeat(78));
console.log(`QUOTA ${report.meta.rangeLabel.toUpperCase()} — ${profiles.length} team profiles · ${report.meta.days.toFixed(1)} days`);
console.log("═".repeat(78));
console.log(`COMBINED: ${usd(c.cost)} · ${tk(c.rawTokens)} tok · ${c.sessions} sessions · ${c.subagents} subagents · ${c.turns} turns · ${c.toolCalls} tools`);
console.log(`          ${usd(c.cost / report.meta.days)}/calendar day`);
console.log("─".repeat(78));
for (const p of profOut) {
  if (p.empty) { console.log(`  ${p.name}: (no activity in range)`); continue; }
  const t = p.total.stats.totals;
  console.log(`  ${p.name.padEnd(22)} ${usd(t.cost).padStart(11)} · ${tk(t.rawTokens).padStart(7)} · ${String(t.sessions).padStart(4)}s/${String(t.subagents).padStart(4)}a · ${String(t.turns).padStart(6)} turns`);
}
console.log("─".repeat(78));
// Berlin-local day label — the raw ISO would render a Berlin midnight as the
// previous day 22:00Z and make every week look off-by-one.
const localDay = (iso) => new Date(new Date(iso).getTime() + tzOffset * 3600e3).toISOString().slice(5, 10);
for (const w of report.weeks) {
  console.log(`  ${localDay(w.start)}→${localDay(new Date(new Date(w.end) - 1).toISOString())} ${usd(w.totals.cost).padStart(11)} · ${String(w.totals.sessions).padStart(4)}s · ${String(w.totals.turns).padStart(6)} turns${w.partial ? "  (partial)" : ""}`);
}
console.log("═".repeat(78));
console.log(`parsed ${report.meta.filesParsed} transcripts · skipped ${report.meta.filesSkippedByMtime} older than range (mtime prefilter)`);
