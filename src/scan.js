'use strict';
/*
 * Walk a directory (optionally glob-filtered), count tokens per file, aggregate.
 * No external deps — uses fs walking + simple glob matching so the skill stays
 * portable. Returns { files:[{path, tokens, bytes}], total, counter }.
 */

const fs = require('fs');
const path = require('path');

// directories never worth counting
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.cache',
  'coverage', '.venv', 'venv', '__pycache__', '.idea', '.vscode',
]);

// treat as text by extension (avoid tokenizing binaries)
const TEXT_EXT = new Set([
  '.md', '.mdx', '.txt', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.json', '.yaml', '.yml', '.toml', '.py', '.rs', '.go', '.java', '.kt',
  '.c', '.h', '.cpp', '.cs', '.rb', '.php', '.sh', '.ps1', '.html', '.css',
  '.xml', '.sql', '.csv', '.ini', '.env', '.gradle', '.svelte', '.vue',
]);

function globToRegExp(glob) {
  // tokenize so inserted regex (with its own * / ?) isn't re-substituted
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } // **/ -> optional dirs
        else re += '.*';                                     // ** -> anything
      } else re += '[^/]*';                                  // * -> within a segment
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

function* walk(root) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      yield* walk(full);
    } else if (e.isFile()) {
      yield full;
    }
  }
}

function scan(target, { counter, glob, includeAll = false } = {}) {
  const stat = fs.statSync(target);
  const root = stat.isDirectory() ? target : path.dirname(target);
  const re = glob ? globToRegExp(glob) : null;

  const candidates = stat.isFile() ? [target] : [...walk(target)];
  const files = [];
  let total = 0;

  for (const file of candidates) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    if (re && !re.test(rel)) continue;
    if (!includeAll && !TEXT_EXT.has(path.extname(file).toLowerCase())) continue;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const tokens = counter.count(text);
    total += tokens;
    files.push({ path: rel || path.basename(file), tokens, bytes: Buffer.byteLength(text) });
  }

  files.sort((a, b) => b.tokens - a.tokens);
  return { files, total, counter: counter.name };
}

module.exports = { scan, globToRegExp, SKIP_DIRS, TEXT_EXT };
