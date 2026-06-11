#!/usr/bin/env node
'use strict';
/*
 * tokt — token-budget CLI.
 *
 *   tokt count "text"                 count a string
 *   tokt count --file path            count a file
 *   tokt scan <dir|file> [opts]       per-file token table + total
 *   tokt audit <file>                 flag likely token bloat
 *
 * Options:
 *   --model <id>    opus-4.8 | sonnet-4.6 | gpt-5.5 | gemini | heuristic (default: openai estimate)
 *   --glob <pat>    filter scan, e.g. star-star-slash-star.md
 *   --top <n>       show only the N biggest files
 *   --all           include all extensions (not just known text types)
 *   --exact         use exact (API) counter where available (Claude)
 *   --json          machine-readable output
 */

const fs = require('fs');
const { resolveCounter } = require('../src/counters');
const { scan } = require('../src/scan');
const { audit } = require('../src/audit');
const { scanTable, fmt } = require('../src/report');

function parse(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') o.file = argv[++i];
    else if (a === '--model' || a === '-m') o.model = argv[++i];
    else if (a === '--glob' || a === '-g') o.glob = argv[++i];
    else if (a === '--top' || a === '-t') o.top = parseInt(argv[++i], 10);
    else if (a === '--all') o.all = true;
    else if (a === '--exact') o.exact = true;
    else if (a === '--json') o.json = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else o._.push(a);
  }
  return o;
}

function usage() {
  console.log(`tokt — token-budget CLI

  tokt count "text"            tokt count --file <path>
  tokt scan <dir|file>         [--glob "**/*.md"] [--top 20] [--all]
  tokt audit <file>

  --model  opus-4.8|sonnet-4.6|haiku-4.5|gpt-5.5|gpt-5.4|gemini|heuristic
  --exact  use API counter where available (Claude; needs ANTHROPIC_API_KEY)
  --json   machine-readable output`);
}

function main() {
  const o = parse(process.argv.slice(2));
  const cmd = o._[0];
  if (o.help || !cmd) return usage();

  const counter = resolveCounter(o.model, { exact: o.exact });

  if (cmd === 'count') {
    let text = o.file ? fs.readFileSync(o.file, 'utf8') : o._.slice(1).join(' ');
    if (!text) { console.error('nothing to count (pass text or --file)'); process.exit(1); }
    const n = counter.count(text);
    if (o.json) return console.log(JSON.stringify({ tokens: n, counter: counter.name }));
    return console.log(`${fmt(n)} tokens  (${counter.name})`);
  }

  if (cmd === 'scan') {
    const target = o._[1];
    if (!target) { console.error('scan needs a path'); process.exit(1); }
    const res = scan(target, { counter, glob: o.glob, includeAll: o.all });
    if (o.json) return console.log(JSON.stringify(res, null, 2));
    return console.log(scanTable(res, { top: o.top || 0 }));
  }

  if (cmd === 'audit') {
    const target = o._[1];
    if (!target) { console.error('audit needs a file'); process.exit(1); }
    const text = fs.readFileSync(target, 'utf8');
    const res = audit(text, counter);
    if (o.json) return console.log(JSON.stringify(res, null, 2));
    console.log(`${target}: ${fmt(res.total)} tokens  (${counter.name})\n`);
    if (!res.findings.length) return console.log('no obvious bloat patterns found.');
    for (const f of res.findings) {
      const metric = f.tokens != null ? `~${fmt(f.tokens)} tok` : `${f.count}×`;
      console.log(`  • ${f.kind.padEnd(18)} ${String(metric).padStart(10)}  ${f.hint}`);
    }
    console.log(`\nSee references/optimization-guide.md before cutting; preserve all load-bearing instructions.`);
    return;
  }

  console.error(`unknown command: ${cmd}`);
  usage();
  process.exit(1);
}

main();
