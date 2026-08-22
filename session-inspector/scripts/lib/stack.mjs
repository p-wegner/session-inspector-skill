/**
 * Detect the tech STACK a session worked in, from the commands it ran and the
 * files it touched. Reusable across fleet tools.
 *
 * Why this exists: git-remote grouping (projectIdentity) breaks the moment a
 * worktree is cleaned up — gitRemote() returns "" for a missing cwd and every
 * ticket falls back to its own unique path, so sessions no longer group. But a
 * builder's *stack* is stamped all over its commands (`gradlew`, `uv run
 * pytest`, `pnpm vitest`) and file extensions, which survive cleanup. Stack is
 * therefore the robust axis for comparing parallel build-outs (taskflow=TS vs
 * bookvault=Python vs shopcart=Kotlin) and for attaching per-stack suggestions.
 *
 * Node builtins only. Pure — pass in commands[] and files[] (both optional).
 */

// Each stack: id, human label, and signature regexes tested against every
// command string and file path. Score = number of distinct signals that hit.
const STACKS = [
  { id: "jvm-gradle", label: "JVM / Gradle (Kotlin/Java)",
    cmd: [/\bgradlew(\.bat)?\b/i, /\bgradle\b/i], file: [/\.gradle(\.kts)?$/i, /\.kt$/i, /\/gradlew/i] },
  { id: "jvm-maven", label: "JVM / Maven",
    cmd: [/\bmvn\b/i, /maven/i], file: [/pom\.xml$/i] },
  { id: "python", label: "Python",
    cmd: [/\buv\b/i, /\bpytest\b/i, /\bpip\b/i, /\bpoetry\b/i, /python[3]?\b/i, /\bruff\b/i], file: [/\.py$/i, /pyproject\.toml$/i, /requirements\.txt$/i] },
  { id: "node-ts", label: "Node / TypeScript",
    cmd: [/\bpnpm\b/i, /\bnpm\b/i, /\byarn\b/i, /\bvitest\b/i, /\bjest\b/i, /\btsc\b/i, /ts-node/i, /\bnode\b/i], file: [/\.tsx?$/i, /package\.json$/i, /tsconfig/i] },
  { id: "rust", label: "Rust / Cargo",
    cmd: [/\bcargo\b/i], file: [/\.rs$/i, /Cargo\.toml$/i] },
  { id: "go", label: "Go",
    cmd: [/\bgo (test|build|run|mod|vet)\b/i], file: [/\.go$/i, /go\.mod$/i] },
  { id: "ruby", label: "Ruby / Rails",
    cmd: [/\bbundle exec\b/i, /\brspec\b/i, /\brails\b/i, /\brake\b/i], file: [/\.rb$/i, /Gemfile$/i] },
  { id: "dotnet", label: ".NET",
    cmd: [/\bdotnet\b/i], file: [/\.csproj$/i, /\.cs$/i] },
];

/**
 * Return { id, label, score, scores } for the best-matching stack.
 * `scores` is the full per-stack tally (useful for polyglot repos / debugging).
 * Falls back to { id: "unknown", label: "unknown" } when nothing scores.
 */
export function detectStack(commands = [], files = []) {
  const cmds = commands.map(String);
  const fs = files.map(String);
  const scores = {};
  for (const s of STACKS) {
    let score = 0;
    for (const re of s.cmd) if (cmds.some((c) => re.test(c))) score++;
    for (const re of s.file) if (fs.some((f) => re.test(f))) score++;
    if (score) scores[s.id] = score;
  }
  let best = { id: "unknown", label: "unknown", score: 0 };
  for (const s of STACKS) {
    const sc = scores[s.id] || 0;
    if (sc > best.score) best = { id: s.id, label: s.label, score: sc };
  }
  return { ...best, scores };
}

export const STACK_IDS = STACKS.map((s) => s.id);
export const stackLabel = (id) => (STACKS.find((s) => s.id === id) || {}).label || id;
