/**
 * WORK REPO — where a session's work actually landed, and what git says happened
 * there during the session and after it.
 *
 * A session's `cwd` is where it was STARTED, which is often not where it worked:
 * measured 2026-09-19, a session started in session-inspector built and pushed a
 * whole new skill repo next door, and the brief described session-inspector's dirty
 * tree (someone else's work) and reported "no CONTINUE.md" — while the repo it had
 * built carried both tracking files. The writes and the `cd`s say where the work is.
 *
 * And a brief is read LATER than the session ended. On the second target 16 commits
 * had landed since the cut-off, including the one its last instruction asked for, so
 * "0 uncommitted paths" and the tracking file's newest pass described the present,
 * not the session. `history()` splits git log at the session's end so the brief can
 * say which is which.
 */

import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { dirname, join } from "path";

const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], {
  encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000,
}).trim();

/** Nearest existing ancestor (a deleted scratch dir must not break resolution). */
function existing(dir) {
  let d = dir;
  for (let i = 0; i < 30 && d && !existsSync(d); i++) {
    const up = dirname(d);
    if (up === d) return "";
    d = up;
  }
  return d && existsSync(d) ? d : "";
}

export function toplevel(dir) {
  const d = existing(dir);
  if (!d) return "";
  try { return git(d, "rev-parse", "--show-toplevel").replace(/\//g, "\\"); } catch { return ""; }
}

/**
 * Rank the git roots a session touched. A write counts 3, a command run there 1,
 * and the cwd gets 1 so a read-only session still resolves to where it started.
 * Returns [{ root, writes, commands, score, isCwd }], best first.
 */
export function rankRepos(dirs, cwd) {
  const byRoot = new Map();
  const add = (dir, writes, commands) => {
    const root = toplevel(dir);
    if (!root) return;
    const key = root.toLowerCase();
    const e = byRoot.get(key) || { root, writes: 0, commands: 0, score: 0, isCwd: false };
    e.writes += writes; e.commands += commands; e.score += writes * 3 + commands;
    byRoot.set(key, e);
  };
  for (const d of dirs || []) add(d.dir, d.writes || 0, d.commands || 0);
  const cwdRoot = cwd ? toplevel(cwd) : "";
  if (cwdRoot) {
    const key = cwdRoot.toLowerCase();
    const e = byRoot.get(key) || { root: cwdRoot, writes: 0, commands: 0, score: 0, isCwd: true };
    e.isCwd = true; e.score += 1;
    byRoot.set(key, e);
  }
  return [...byRoot.values()].sort((a, b) => (b.score - a.score) || (a.isCwd ? -1 : 1));
}

/**
 * The directory whose CONTINUE.md speaks for this work: the nearest one walking up
 * from where the session wrote, stopping at the repo root. A monorepo can carry one
 * per sub-project; the root's is the fallback.
 */
export function docsDirFor(startDir, root) {
  let d = existing(startDir) || root;
  const stop = String(root || "").toLowerCase();
  for (let i = 0; i < 30 && d; i++) {
    if (existsSync(join(d, "CONTINUE.md")) || existsSync(join(d, "BACKLOG.md"))) return d;
    if (d.toLowerCase() === stop) break;
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return root;
}

/**
 * Commits since the session started, split at its end. `transcript` is the raw
 * JSONL text: a commit whose short sha the session printed is marked `mine`. In a
 * shared checkout other sessions commit in the same window, so an unmarked commit
 * inside the window is reported as "in the window", never as this session's.
 */
export function history(root, startedAt, endedAt, transcript = "", commitCommands = 0, ownShas = []) {
  if (!root || !startedAt) return { during: [], after: [] };
  let raw = "";
  // The body travels too: a fix commit's body is usually the only place the defect
  // and its mechanism are written down ("argv[1] is the junction path, so the
  // import.meta.url guard never matched"), and a subject alone reads as a title.
  try { raw = git(root, "log", "--all", `--since=${startedAt}`, "--format=%h%x09%cI%x09%an%x09%D%x09%s%x09%b%x1e"); } catch { return { during: [], after: [] }; }
  const end = endedAt ? Date.parse(endedAt) + 120000 : Infinity; // 2 min: a commit printed in the last tool call
  const during = [], after = [];
  for (const rec of raw.split("\x1e").map((r) => r.trim()).filter(Boolean).reverse()) {
    const [sha, when, author, refs, subject, ...rest] = rec.split("\t");
    const body = rest.join("\t").replace(/\n*Co-Authored-By:[^\n]*/gi, "").replace(/\s+/g, " ").trim();
    const c = { sha, when, author, refs: refs || "", subject: subject || "", body: body.length > 360 ? `${body.slice(0, 360)}…` : body, mine: Boolean(transcript && transcript.includes(sha)) };
    (Date.parse(when) <= end ? during : after).push(c);
  }
  // The session printed no sha for a commit it made with `-q`, or in the same call
  // as the push. If it ran at least as many `git commit`s as the window holds, the
  // window is its own.
  // The count fallback is for a session that never printed a sha. Once any commit is
  // confirmed by its sha, the rest are someone else's: measured on a board repo where
  // agents commit concurrently, five of theirs were listed as the session's own.
  // Strongest: the shas its own `git commit` printed. A session that reads `git log`
  // prints other agents' shas too, so "the sha appears in the transcript" over-claims.
  if (ownShas.length) {
    const own = (sha) => ownShas.some((o) => o.startsWith(sha) || sha.startsWith(o));
    for (const c of during) c.mine = own(c.sha);
  } else if (!during.some((c) => c.mine) && commitCommands >= during.length) for (const c of during) c.mine = true;
  return { during, after };
}

/**
 * Where did each file the session wrote end up? One of: committed inside the
 * session's window, committed LATER (by whoever came next — the commit is named),
 * uncommitted right now, or unchanged (written back identical, or since reverted).
 *
 * The case this exists for: a session cut off before its last ask ("commit and push
 * what we have") left every edit uncommitted, another session committed them four
 * minutes later, and nothing a successor reads says so. `git status` is clean, so
 * "is my work lost?" and "was it already done?" look the same until someone digs.
 */
export function editLanding(root, files, startedAt, endedAt) {
  const out = { during: new Map(), after: new Map(), dirty: [], none: [] };
  if (!root || !files || !files.length || !startedAt) return out;
  let raw = "";
  try { raw = git(root, "log", "--all", `--since=${startedAt}`, "--reverse", "--format=@%h\t%cI\t%s", "--name-only"); } catch { return out; }
  const end = endedAt ? Date.parse(endedAt) + 120000 : Infinity;
  const first = new Map(); // path -> {sha, when, subject, after}
  let cur = null;
  for (const line of raw.split("\n")) {
    if (line.startsWith("@")) { const [sha, when, subject] = line.slice(1).split("\t"); cur = { sha, when, subject, after: Date.parse(when) > end }; continue; }
    const p = line.trim().replace(/\\/g, "/").toLowerCase();
    if (p && cur && !first.has(p)) first.set(p, cur);
  }
  let dirtySet = new Set();
  try {
    dirtySet = new Set(git(root, "status", "--porcelain").split("\n").filter(Boolean)
      .map((l) => l.slice(3).replace(/^"|"$/g, "").replace(/\\/g, "/").toLowerCase()));
  } catch { /* ignore */ }
  for (const f of files) {
    const key = String(f).replace(/\\/g, "/").toLowerCase();
    const c = first.get(key);
    if (dirtySet.has(key)) out.dirty.push(f);
    else if (!c) out.none.push(f);
    else {
      const bucket = c.after ? out.after : out.during;
      const e = bucket.get(c.sha) || { ...c, files: [] };
      e.files.push(f); bucket.set(c.sha, e);
    }
  }
  // Is each landing commit on a remote branch? "Committed" and "pushed" are two
  // different answers to "is my work safe", and the last ask is often both.
  // "On SOME remote branch" is the wrong test in a repo where agents push feature
  // branches cut from a local master: measured, a session's two commits sat on eight
  // pushed `feature/ak-…` branches while `origin/master` was six days behind, and the
  // brief said "pushed". Pushed means: on the upstream of the default branch.
  let upstream = "";
  for (const ref of ["@{upstream}", "origin/HEAD", "origin/main", "origin/master"]) {
    try { upstream = git(root, "rev-parse", "--abbrev-ref", ref); if (upstream && upstream !== "origin/HEAD") break; } catch { /* next */ }
  }
  const pushed = (sha) => {
    try { if (upstream) { git(root, "merge-base", "--is-ancestor", sha, upstream); return true; } } catch { /* not on it */ }
    return false;
  };
  const elsewhere = (sha) => { try { return git(root, "branch", "-r", "--contains", sha).split("\n").map((s) => s.trim()).filter(Boolean); } catch { return []; } };
  // Reported only when it differs from the GLOBAL identity: a repo-local .git/config
  // (a test fixture's `E2ETest`) is exactly the case worth saying out loud.
  let globalEmail = "";
  try { globalEmail = execFileSync("git", ["config", "--global", "user.email"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim().toLowerCase(); } catch { /* none */ }
  const author = (sha) => {
    try {
      const a = git(root, "log", "-1", "--format=%an <%ae>", sha);
      return globalEmail && a.toLowerCase().includes(`<${globalEmail}>`) ? "" : a;
    } catch { return ""; }
  };
  // And on the LOCAL branch: "not on origin/master" read alone as "not in master" to a
  // reader, when both commits were ancestors of the local master.
  let head = "";
  try { head = git(root, "rev-parse", "--abbrev-ref", "HEAD"); } catch { /* detached */ }
  const onHead = (sha) => { try { git(root, "merge-base", "--is-ancestor", sha, "HEAD"); return true; } catch { return false; } };
  const withPush = (list) => list.map((c) => {
    const on = pushed(c.sha);
    const refs = on ? [] : elsewhere(c.sha);
    return { ...c, pushed: on, upstream, otherRemoteRefs: refs.length, otherRemoteRef: refs[0] || "", author: author(c.sha), onLocal: onHead(c.sha) ? head : "" };
  });
  return {
    during: withPush([...out.during.values()]), after: withPush([...out.after.values()]),
    dirty: out.dirty, none: out.none,
  };
}

/** `origin` without credentials, the branch's upstream and ahead/behind right now. */
export function remoteOf(root) {
  if (!root) return null;
  let url = "";
  try { url = git(root, "remote", "get-url", "origin").replace(/\/\/[^/@]+@/, "//"); } catch { return { url: "", upstream: "" }; }
  let upstream = "";
  try { upstream = git(root, "rev-parse", "--abbrev-ref", "@{upstream}"); } catch { /* none */ }
  return { url, upstream };
}

/**
 * Did a commit change anything but prose? Measured: an open item matched a
 * docs-only commit (b0491fd, a BACKLOG edit) ahead of the one that built the fix
 * (a368100). A commit that only touches `*.md` / `docs/` records work, it rarely is it.
 */
export function touchesCode(root, sha) {
  try {
    const files = git(root, "show", "--name-only", "--format=", sha).split("\n").filter(Boolean);
    return files.some((f) => !/\.md$/i.test(f) && !/^docs\//i.test(f));
  } catch { return true; } // unknown: do not demote it
}

/** The convention's archive of landed BACKLOG items, if the repo keeps one. */
export function landedArchivePath(root) {
  for (const rel of ["docs/archive/BACKLOG-landed.md", "BACKLOG-landed.md", "docs/BACKLOG-landed.md"]) {
    const p = join(root, rel);
    if (existsSync(p)) return p;
  }
  return "";
}

/**
 * The commit that FIRST wrote a strike (`~~title~~`) into any file — the repo's own
 * record of when an item was closed, and by which commit. Exact, unlike a
 * shared-words match: `git log -S` finds the commit whose diff added the string.
 */
export function struckIn(root, struck) {
  try {
    const out = git(root, "log", "--all", "--reverse", "-S", struck, "--format=%h%x09%cI%x09%s");
    const first = out.split("\n").filter(Boolean)[0];
    if (!first) return null;
    const [sha, when, subject] = first.split("\t");
    return { sha, when, subject };
  } catch { return null; }
}

/**
 * Later commits that changed files the session wrote — exact, where a shared-words
 * match is a guess. Measured on a held-out session: the word matcher offered two
 * docs-only commits as "may have closed" an item (both wrong), while the two commits
 * that rewrote its own docs went unmentioned and the successor called every later
 * commit unrelated.
 */
export function laterTouches(root, endedAt, files) {
  if (!root || !endedAt || !files || !files.length) return [];
  let raw = "";
  try { raw = git(root, "log", "--all", `--since=${endedAt}`, "--format=%x1e%h%x09%cI%x09%s", "--name-only", "--", ...files.slice(0, 60)); } catch { return []; }
  const end = Date.parse(endedAt);
  return raw.split("\x1e").map((b) => b.trim()).filter(Boolean).map((b) => {
    const [head, ...rest] = b.split("\n");
    const [sha, when, subject] = head.split("\t");
    return { sha, when, subject, files: rest.map((f) => f.trim()).filter(Boolean) };
  }).filter((c) => Date.parse(c.when) > end).reverse();
}

/**
 * Tags created after the session ended — a deploy, a promotion, a release. An open
 * item that waits on one ("#1141 needs a promotion") is stale once a later tag exists:
 * measured, three `stable-*` promotions landed after a session that listed a promotion
 * as its blocker, and the brief still passed the blocker on.
 */
export function tagsSince(root, endedAt) {
  if (!root || !endedAt) return [];
  let raw = "";
  try { raw = git(root, "for-each-ref", "refs/tags", "--sort=creatordate", "--format=%(refname:short)%09%(creatordate:iso-strict)%09%(objectname:short)"); } catch { return []; }
  const end = Date.parse(endedAt);
  return raw.split("\n").filter(Boolean).map((l) => { const [name, when, sha] = l.split("\t"); return { name, when, sha }; })
    .filter((t) => Date.parse(t.when) > end);
}
