/**
 * Reach: what a fleet tool actually looked at, published next to what it computed.
 *
 * Every fleet number here is a sum over "all transcripts", and each way that
 * set can quietly shrink has shipped at least once: a profile never discovered
 * (quota-multi skips ~/.claude by design, with nothing said), a disk-wide count
 * printed as the window's sample (tool-friction), a ranked table read as the
 * whole population (token-sinks shows 20 rows), unparseable lines dropped by a
 * bare `catch { continue; }`, and usage rows over-counted until they were folded.
 * A reader cannot tell any of those from a correct run. So each tool records
 * them here, and prints one line under its header and a `reach` block in --json.
 *
 * One process runs one tool, so this is a module singleton: lib/parse.mjs and
 * lib/usage.mjs count into it without every caller threading a counter through.
 *
 *   import { reach } from "./lib/reach.mjs";
 *   reach.begin("token-sinks", { days, project });
 *   reach.found("claude", profile, id);        // a transcript exists on disk
 *   reach.exclude("outside window");           // ...and the last one found was dropped, with the reason
 *   reach.shown(rows.length, top);             // a ranked table printed a slice
 *   console.log(reach.line());                 // text header
 *   { ..., reach: reach.toJSON() }             // --json
 *
 * "read" is never reported by a tool: it is found minus excluded, so a tool that
 * adds a filter and forgets to say so shows up as a count that does not add up
 * rather than as a silently smaller population.
 *
 * The counts are plain integers: nothing here estimates, and a category with a
 * zero count is left out of the line (kept in JSON) so the line stays readable.
 */

import { basename } from "path";

function fresh() {
  return {
    tool: null,
    scope: {},
    entries: [],      // { agent, profile, id, excluded } per transcript found
    excluded: {},     // reason -> n
    badLines: new Map(), // file -> unparseable lines on its latest read
    dupUsageRows: new Map(), // file -> repeated usage rows folded on its latest read
    ownSession: null, // { id, included }
    rows: null,       // { shown, total }
    notes: [],
  };
}

let r = fresh();
let currentFile = null;

// agent -> { profile -> n } over the entries passing `keep`
function tally(keep) {
  const out = {};
  for (const e of r.entries) {
    if (!keep(e)) continue;
    const a = (out[e.agent] ||= {});
    a[e.profile || "-"] = (a[e.profile || "-"] || 0) + 1;
  }
  return out;
}
const mapTotal = (m) => [...m.values()].reduce((x, y) => x + y, 0);
const badTotal = () => mapTotal(r.badLines);
const fmt = (n) => Number(n).toLocaleString("en-US");

export const reach = {
  /** Start a run. `scope` is echoed back verbatim (days, project, provider, …). */
  begin(tool, scope = {}) {
    r = fresh();
    currentFile = null;
    r.tool = tool;
    r.scope = Object.fromEntries(Object.entries(scope).filter(([, v]) => v !== undefined && v !== null && v !== ""));
    const own = process.env.CLAUDE_CODE_SESSION_ID;
    if (own) r.ownSession = { id: own, included: false };
    return reach;
  },
  found(agent, profile, id) { r.entries.push({ agent, profile: profile || "", id: id || "", excluded: false }); },
  /** Drop the last `n` transcripts found that are still in, for `reason`. */
  exclude(reason, n = 1) {
    let left = n;
    for (let i = r.entries.length - 1; i >= 0 && left > 0; i--) {
      if (r.entries[i].excluded) continue;
      r.entries[i].excluded = true;
      left--;
    }
    if (n) r.excluded[reason] = (r.excluded[reason] || 0) + n;
  },
  /**
   * Call before parsing a file. Resets that file's bad-line and folded-row counts,
   * so a tool that reads the same file twice (fleet-stats does) reports them once.
   */
  file(path) { currentFile = path || "-"; r.badLines.delete(currentFile); r.dupUsageRows.delete(currentFile); },
  badLine() { const f = currentFile || "-"; r.badLines.set(f, (r.badLines.get(f) || 0) + 1); },
  dupUsageRow() { const f = currentFile || "-"; r.dupUsageRows.set(f, (r.dupUsageRows.get(f) || 0) + 1); },
  shown(shown, total) { r.rows = { shown: Math.min(shown, total), total }; },
  note(s) { if (s && !r.notes.includes(s)) r.notes.push(s); },

  toJSON() {
    const read = r.entries.filter((e) => !e.excluded);
    if (r.ownSession) r.ownSession.included = read.some((e) => e.id && String(e.id).startsWith(r.ownSession.id));
    return {
      tool: r.tool,
      scope: r.scope,
      transcriptsFound: r.entries.length,
      transcriptsRead: read.length,
      found: tally(() => true),
      read: tally((e) => !e.excluded),
      excluded: r.excluded,
      unparseableLines: badTotal(),
      unparseableFiles: [...r.badLines.keys()].filter((p) => p !== "-").map((p) => basename(p)),
      duplicateUsageRowsFolded: mapTotal(r.dupUsageRows),
      ownSession: r.ownSession,
      rows: r.rows,
      notes: r.notes,
    };
  },

  /** One human-readable line. Agents and profiles are named, so a missing one is visible. */
  line() {
    const j = reach.toJSON();
    const parts = [];
    const agents = Object.keys(j.found);
    if (agents.length) {
      const per = agents.map((a) => {
        const profs = Object.keys(j.found[a]).filter((p) => p !== "-");
        const n = Object.values(j.found[a]).reduce((x, y) => x + y, 0);
        return `${a} ${fmt(n)}${profs.length ? ` in ${profs.length} profile${profs.length > 1 ? "s" : ""} (${profs.join(", ")})` : ""}`;
      });
      parts.push(`${fmt(j.transcriptsFound)} transcripts found: ${per.join("; ")}`);
      parts.push(`${fmt(j.transcriptsRead)} read`);
    } else {
      parts.push("no transcripts found");
    }
    for (const [why, n] of Object.entries(r.excluded)) if (n) parts.push(`${fmt(n)} ${why}`);
    const bad = badTotal();
    if (bad) parts.push(`${fmt(bad)} unparseable line${bad > 1 ? "s" : ""} skipped in ${r.badLines.size} file${r.badLines.size === 1 ? "" : "s"}`);
    const dup = mapTotal(r.dupUsageRows);
    if (dup) parts.push(`${fmt(dup)} repeated usage rows folded`);
    if (r.rows && r.rows.shown < r.rows.total) parts.push(`showing ${fmt(r.rows.shown)} of ${fmt(r.rows.total)} rows (--top)`);
    if (r.ownSession) parts.push(r.ownSession.included ? "includes this session" : "this session not included");
    let s = `reach: ${parts.join(" · ")}`;
    for (const n of r.notes) s += `\n       note: ${n}`;
    return s;
  },
};
