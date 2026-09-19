/**
 * lenses/speckit.mjs — the Spec Kit lens.
 *
 * A dashboard lens answers the questions a GENERIC session report cannot, because
 * they are about one workflow. For GitHub Spec Kit (`specify`) the questions are:
 *
 *   • Did the prescribed loop actually run — constitution → specify → clarify →
 *     plan → tasks → analyze → implement — or did phases get skipped?
 *   • What did each phase COST, in wall time and tokens, per feature?
 *   • What did the ceremony PRODUCE: how much spec prose per line of code, and did
 *     anything downstream ever read it?
 *   • Where is the workflow thin — which step has no artifact, no gate, and no
 *     evidence it changed the outcome?
 *
 * Two evidence sources, and the difference matters:
 *   TRANSCRIPT — skill invocations, the `.specify/scripts/*` calls, file writes,
 *     timings, tokens. Authoritative for "when" and "how much".
 *   REPO — the artifacts themselves (spec.md, plan.md, tasks.md, checklists).
 *     Authoritative for "what came out". Optional: pass --repo, else the session's
 *     cwd is used if it is still on disk.
 *
 * PHASE BOUNDARIES ARE INFERRED. Claude Code loads a skill once per session and
 * emits a "(Re-invocation of /speckit-specify)" notice on later uses, so counting
 * `Skill:` tool calls UNDER-reports every phase after the first feature — measured:
 * 14 skill invocations for a run that produced all 7 artifacts for all 5 features.
 * So a phase is detected from any of: the skill call, its `.specify` script, or the
 * artifact it owns. Each phase row says which evidence it rests on.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { estTokens } from "../turns.mjs";

export const id = "speckit";
export const title = "Spec Kit workflow";

const PHASES = ["constitution", "specify", "clarify", "plan", "tasks", "analyze", "implement"];

const norm = (p) => String(p || "").split("\\").join("/");
const featureOf = (s) => {
  const m = norm(s).match(/(?:specs\/)?(\d{3}-[a-z0-9-]+)/i);
  return m ? m[1] : "";
};

/** Does this session look like a Spec Kit run at all? */
export function detect({ calls }) {
  return calls.some((c) => /speckit|\.specify[\/\\]/i.test(`${c.tool} ${c.command} ${c.filePath}`));
}

// ── phase markers ────────────────────────────────────────────────────────────

const SCRIPT_PHASE = [
  [/create-new-feature/i, "specify"],
  [/setup-plan/i, "plan"],
  [/setup-tasks/i, "tasks"],
];
const ARTIFACT_PHASE = [
  [/\.specify\/memory\/constitution\.md$/i, "constitution"],
  [/specs\/[^/]+\/spec\.md$/i, "specify"],
  [/specs\/[^/]+\/(plan|research|data-model|quickstart)\.md$/i, "plan"],
  [/specs\/[^/]+\/contracts\//i, "plan"],
  [/specs\/[^/]+\/tasks\.md$/i, "tasks"],
  [/specs\/[^/]+\/checklists\//i, "analyze"],
];

function markersFrom(calls) {
  const out = [];
  for (const c of calls) {
    const tool = c.tool || "";
    if (tool.startsWith("Skill:speckit-")) {
      const ph = tool.slice("Skill:speckit-".length);
      if (PHASES.includes(ph)) { out.push({ seq: c.seq, ts: c.ts, phase: ph, via: "skill", feature: featureOf(c.branch) }); continue; }
    }
    const cmd = c.command || "";
    if (/\.specify[\/\\]scripts/i.test(cmd)) {
      for (const [re, ph] of SCRIPT_PHASE) if (re.test(cmd)) { out.push({ seq: c.seq, ts: c.ts, phase: ph, via: "script", feature: featureOf(c.branch) }); break; }
      continue;
    }
    const f = norm(c.filePath);
    if (f && /^(Write|Edit|MultiEdit)$/.test(tool)) {
      for (const [re, ph] of ARTIFACT_PHASE) if (re.test(f)) { out.push({ seq: c.seq, ts: c.ts, phase: ph, via: "artifact", feature: featureOf(f) || featureOf(c.branch) }); break; }
      const feat = featureOf(c.branch);
      if (feat && /^(src|tests|lib|app)\//i.test(f.replace(/.*speckit-timetracking\//, ""))) {
        out.push({ seq: c.seq, ts: c.ts, phase: "implement", via: "code", feature: feat });
      }
    }
  }
  // Collapse consecutive markers of the same (feature, phase) into one span start.
  const spans = [];
  for (const m of out) {
    const last = spans[spans.length - 1];
    if (last && last.phase === m.phase && last.feature === m.feature) { last.endSeq = m.seq; last.endTs = m.ts; last.vias.add(m.via); continue; }
    spans.push({ ...m, endSeq: m.seq, endTs: m.ts, vias: new Set([m.via]) });
  }
  return spans;
}

// ── repo-side artifact facts ─────────────────────────────────────────────────

function countMatches(text, re) { return (text.match(re) || []).length; }

function readRepo(repoDir) {
  if (!repoDir || !existsSync(join(repoDir, "specs"))) return null;
  const features = [];
  for (const d of readdirSync(join(repoDir, "specs"))) {
    const dir = join(repoDir, "specs", d);
    let st; try { st = statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    const f = { feature: d, files: {}, requirements: 0, userStories: 0, clarifications: 0, tasksTotal: 0, tasksDone: 0, specLines: 0 };
    const walk = (p, rel = "") => {
      for (const e of readdirSync(p)) {
        const full = join(p, e);
        let s; try { s = statSync(full); } catch { continue; }
        if (s.isDirectory()) { walk(full, `${rel}${e}/`); continue; }
        if (!e.endsWith(".md")) continue;
        const text = readFileSync(full, "utf8");
        const lines = text.split("\n").length;
        f.files[`${rel}${e}`] = { lines, chars: text.length };
        f.specLines += lines;
        if (e === "spec.md") {
          f.requirements = countMatches(text, /^\s*[-*]?\s*\*{0,2}(FR|NFR)-\d+/gim);
          f.userStories = countMatches(text, /^###?\s+(User Story|US-?\d)/gim);
          f.clarifications = countMatches(text, /^\s*[-*]\s*\*\*?Q\*?\*?:|^\s*[-*]\s+Q:/gim)
            || (/##\s*Clarifications/i.test(text) ? countMatches(text.split(/##\s*Clarifications/i)[1] || "", /^\s*[-*]\s/gm) : 0);
        }
        if (e === "tasks.md") {
          f.tasksTotal = countMatches(text, /^\s*[-*]\s*\[[ xX]\]/gm);
          f.tasksDone = countMatches(text, /^\s*[-*]\s*\[[xX]\]/gm);
        }
      }
    };
    walk(dir);
    features.push(f);
  }
  // Code size, for the prose-to-code ratio.
  let codeLines = 0, testLines = 0, codeFiles = 0;
  const walkCode = (p) => {
    let entries; try { entries = readdirSync(p); } catch { return; }
    for (const e of entries) {
      const full = join(p, e);
      let s; try { s = statSync(full); } catch { continue; }
      if (s.isDirectory()) { if (!/node_modules|\.git|dist|coverage/.test(e)) walkCode(full); continue; }
      if (!/\.(ts|js|tsx|jsx|py|kt|java|go|rb|cs)$/.test(e)) continue;
      const n = readFileSync(full, "utf8").split("\n").length;
      codeFiles++;
      if (/(^|[\/\\])tests?([\/\\]|$)|\.(test|spec)\./.test(full)) testLines += n; else codeLines += n;
    }
  };
  for (const d of ["src", "tests", "test", "lib", "app"]) if (existsSync(join(repoDir, d))) walkCode(join(repoDir, d));
  const constitutionPath = join(repoDir, ".specify", "memory", "constitution.md");
  const constitution = existsSync(constitutionPath)
    ? { lines: readFileSync(constitutionPath, "utf8").split("\n").length }
    : null;
  return { features, codeLines, testLines, codeFiles, constitution };
}

// ── analysis ─────────────────────────────────────────────────────────────────

export function analyze(ctx) {
  const { meta, events, calls, apiCalls, repoDir } = ctx;
  const t0 = meta.startTime ? new Date(meta.startTime).getTime() : 0;
  const off = (ts) => (t0 && ts ? Math.round((new Date(ts).getTime() - t0) / 1000) : 0);
  const spans = markersFrom(calls);
  const repo = readRepo(repoDir);

  const features = [...new Set(spans.map((s) => s.feature).filter(Boolean))].sort();
  // Every call/event carries the branch, so cost per feature needs no span join.
  const byFeature = {};
  for (const f of features) byFeature[f] = { feature: f, calls: 0, writes: 0, tests: 0, outputTokens: 0, inputCharsEst: 0, startSec: null, endSec: null, phases: {} };

  for (const c of calls) {
    const f = featureOf(c.branch) || featureOf(c.filePath);
    if (!f || !byFeature[f]) continue;
    const b = byFeature[f];
    b.calls++;
    if (/^(Write|Edit|MultiEdit)$/.test(c.tool)) b.writes++;
    b.inputCharsEst += c.inputChars;
    const s = off(c.ts);
    if (b.startSec === null || s < b.startSec) b.startSec = s;
    if (b.endSec === null || s > b.endSec) b.endSec = s;
  }
  for (const a of apiCalls) {
    const f = featureOf(a.branch);
    if (f && byFeature[f]) byFeature[f].outputTokens += a.output;
  }

  // Phase presence + cost per feature.
  const ordered = [...spans].sort((a, b) => a.seq - b.seq);
  for (let i = 0; i < ordered.length; i++) {
    const s = ordered[i];
    const next = ordered[i + 1];
    const startSec = off(s.ts);
    const endSec = next ? off(next.ts) : meta.durationSec;
    const bucket = byFeature[s.feature] || (byFeature[s.feature] = { feature: s.feature || "(pre-feature)", calls: 0, writes: 0, tests: 0, outputTokens: 0, inputCharsEst: 0, startSec, endSec, phases: {} });
    const p = (bucket.phases[s.phase] ||= { phase: s.phase, seconds: 0, vias: new Set(), firstSec: startSec });
    p.seconds += Math.max(0, endSec - startSec);
    for (const v of s.vias) p.vias.add(v);
  }

  // Per-phase totals across the whole session.
  const phaseTotals = {};
  for (const b of Object.values(byFeature)) {
    for (const [ph, p] of Object.entries(b.phases)) {
      const t = (phaseTotals[ph] ||= { phase: ph, seconds: 0, features: 0 });
      t.seconds += p.seconds; t.features++;
    }
  }

  // Repo-side rescue: a phase can leave its mark in the ARTIFACT rather than in
  // the session. A spec carrying a `## Clarifications` section is proof the clarify
  // phase ran for that feature, even when the skill was never re-invoked and the
  // edit is indistinguishable from any other spec edit in the transcript.
  if (repo) {
    for (const rf of repo.features) {
      const b = byFeature[rf.feature];
      if (b && rf.clarifications > 0 && !b.phases.clarify)
        b.phases.clarify = { phase: "clarify", seconds: 0, vias: new Set(["repo"]), firstSec: null };
    }
  }

  // Which phases are evidenced only by their artifact (skill never re-invoked)?
  const skillInvocations = calls.filter((c) => c.tool.startsWith("Skill:speckit-")).length;
  const artifactOnly = [];
  for (const b of Object.values(byFeature))
    for (const [ph, p] of Object.entries(b.phases))
      if (!p.vias.has("skill")) artifactOnly.push(`${b.feature}/${ph}`);

  const missing = [];
  for (const b of Object.values(byFeature)) {
    if (!b.feature || !/^\d{3}-/.test(b.feature)) continue;
    for (const ph of ["specify", "plan", "tasks", "implement"]) if (!b.phases[ph]) missing.push(`${b.feature}/${ph}`);
  }

  // Prose vs code.
  const specLines = repo ? repo.features.reduce((a, f) => a + f.specLines, 0) : 0;
  const codeLines = repo ? repo.codeLines + repo.testLines : 0;

  const headline = [
    { label: "features", value: String(features.length), note: features.join(", ") },
    { label: "phases detected", value: String(Object.keys(phaseTotals).length), note: Object.keys(phaseTotals).join(" → ") },
    { label: "skill invocations", value: String(skillInvocations), note: `${artifactOnly.length} phase(s) evidenced only by their artifact — the harness loads a skill once per session` },
  ];
  if (repo) {
    headline.push({ label: "spec prose", value: `${specLines} lines`, note: `${repo.features.length} feature folders, ${repo.features.reduce((a, f) => a + Object.keys(f.files).length, 0)} markdown files` });
    headline.push({ label: "prose : code", value: codeLines ? `1 : ${(codeLines / specLines).toFixed(1)}` : "—", note: `${repo.codeLines} src + ${repo.testLines} test lines` });
    const tasksTotal = repo.features.reduce((a, f) => a + f.tasksTotal, 0);
    const tasksDone = repo.features.reduce((a, f) => a + f.tasksDone, 0);
    headline.push({ label: "tasks", value: `${tasksDone}/${tasksTotal} ticked`, note: tasksTotal ? `${Math.round((tasksDone / tasksTotal) * 100)}% of generated tasks were marked done` : "" });
  }

  const sections = [];

  sections.push({
    title: "Phase × feature",
    note: "Which phases left evidence for each feature, and how long the session spent inside each. S = the Spec Kit skill was invoked; s = its .specify/ script ran; a = only the artifact it owns appeared; c = source/test writes; r = no in-session marker at all, the evidence is in the committed artifact. A phase with no skill mark still ran — the harness does not re-load a loaded skill.",
    table: {
      cols: ["feature", ...PHASES, "wall", "writes", "~out tok"],
      rows: Object.values(byFeature)
        .filter((b) => b.feature)
        .sort((a, b) => String(a.feature).localeCompare(String(b.feature)))
        .map((b) => [
          b.feature,
          ...PHASES.map((ph) => {
            const p = b.phases[ph];
            if (!p) return "";
            const via = p.vias.has("skill") ? "S" : p.vias.has("script") ? "s" : p.vias.has("artifact") ? "a" : p.vias.has("repo") ? "r" : "c";
            return p.vias.has("repo") && !p.seconds ? "r" : `${via} ${Math.round(p.seconds / 60)}m`;
          }),
          b.startSec != null ? `${Math.round((b.endSec - b.startSec) / 60)}m` : "",
          String(b.writes),
          String(Math.round(b.outputTokens / 1000)) + "k",
        ]),
    },
  });

  sections.push({
    title: "Cost per phase (whole session)",
    note: "Wall-clock inside each phase span, summed over features. Spans are bounded by the next phase marker, so a phase that interleaves with another is attributed to whichever marker came last.",
    table: {
      cols: ["phase", "features", "minutes", "share"],
      rows: (() => {
        const total = Object.values(phaseTotals).reduce((a, p) => a + p.seconds, 0) || 1;
        return PHASES.filter((p) => phaseTotals[p]).map((p) => {
          const t = phaseTotals[p];
          return [p, String(t.features), String(Math.round(t.seconds / 60)), `${Math.round((t.seconds / total) * 100)}%`];
        });
      })(),
    },
  });

  if (repo) {
    sections.push({
      title: "Artifacts produced",
      note: "Read from the repository, not the transcript. `clarifications` counts the bullets under a spec's `## Clarifications` heading — the record that the clarify phase changed anything.",
      table: {
        cols: ["feature", "spec lines", "reqs", "clarifications", "tasks", "done", "md files"],
        rows: repo.features.map((f) => [
          f.feature, String(f.specLines), String(f.requirements), String(f.clarifications),
          String(f.tasksTotal), String(f.tasksDone), String(Object.keys(f.files).length),
        ]),
      },
    });
  }

  const questions = [];
  questions.push({
    q: "Did the prescribed loop actually run?",
    a: missing.length ? `No — ${missing.length} phase(s) left no evidence` : "Yes, for every feature",
    detail: missing.length ? missing.join(", ")
      : `constitution → specify → clarify → plan → tasks → analyze → implement, with ${skillInvocations} skill invocations and ${artifactOnly.length} phases evidenced only by their artifacts.`,
  });
  questions.push({
    q: "Is the phase count honest?",
    a: artifactOnly.length ? `No — ${artifactOnly.length} phases ran without a skill invocation` : "Yes",
    detail: "Claude Code loads a skill once per session; later uses emit a re-invocation notice instead of a tool call. Counting `Skill:` calls alone under-reports every feature after the first, which is why this lens also reads the .specify scripts and the artifacts.",
  });
  if (repo) {
    const tasksTotal = repo.features.reduce((a, f) => a + f.tasksTotal, 0);
    const tasksDone = repo.features.reduce((a, f) => a + f.tasksDone, 0);
    questions.push({
      q: "Did the task list get used, or just generated?",
      a: tasksTotal ? `${tasksDone}/${tasksTotal} ticked (${Math.round((tasksDone / tasksTotal) * 100)}%)` : "no tasks.md found",
      detail: "A tasks.md that is generated and never ticked is a plan nobody tracked against. Ticking is cheap, so a low number is a signal about the loop, not about the work.",
    });
    const noClarify = repo.features.filter((f) => !f.clarifications).map((f) => f.feature);
    questions.push({
      q: "Did clarify change anything?",
      a: noClarify.length ? `${repo.features.length - noClarify.length}/${repo.features.length} specs carry recorded clarifications` : "every spec records clarifications",
      detail: noClarify.length ? `No clarification record in: ${noClarify.join(", ")}. The phase may still have run — but it left nothing behind, which is the same thing for anyone reading the spec later.` : "",
    });
    questions.push({
      q: "What did the ceremony cost in prose?",
      a: `${specLines} lines of spec for ${codeLines} lines of code`,
      detail: `Ratio 1 : ${(codeLines / (specLines || 1)).toFixed(1)}. Spec Kit's own templates account for much of it — the question for a real project is whether anyone reads the plan.md and research.md after the feature lands.`,
    });
  }

  const analyzeFeatures = Object.values(byFeature).filter((b) => b.phases.analyze).length;
  questions.push({
    q: "Which phase leaves nothing behind?",
    a: `analyze — detectable for ${analyzeFeatures}/${features.length} features`,
    detail: "specify, plan and tasks each own a file, so they are provable months later. clarify at least writes a section into the spec. analyze writes nothing: its findings land as edits to the other three artifacts, indistinguishable from any other edit. That makes it the phase you cannot audit, cannot resume, and cannot tell was skipped — the gap is in the workflow, not in this measurement.",
  });

  return { headline, sections, questions, features, byFeature, phaseTotals, repo };
}
