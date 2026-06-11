'use strict';
/* Tiny smoke test — no framework. `npm test`. */

const assert = require('assert');
const { resolveCounter, familyOf } = require('../src/counters');
const { scan } = require('../src/scan');
const { audit } = require('../src/audit');

let pass = 0;
function ok(name, fn) { try { fn(); console.log('  ✓', name); pass++; } catch (e) { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; } }

console.log('token-budget smoke test');

ok('family resolution', () => {
  assert.strictEqual(familyOf('opus-4.8'), 'claude');
  assert.strictEqual(familyOf('gpt-5.5'), 'openai');
  assert.strictEqual(familyOf('gemini'), 'gemini');
  assert.strictEqual(familyOf('nonsense'), 'heuristic');
});

ok('counter always resolves + counts', () => {
  for (const m of ['opus-4.8', 'gpt-5.5', 'gemini', 'heuristic', undefined]) {
    const c = resolveCounter(m);
    assert.ok(typeof c.count === 'function', `${m} has count`);
    const n = c.count('The quick brown fox jumps over the lazy dog.');
    assert.ok(n > 0 && n < 50, `${m} -> ${n} tokens plausible`);
  }
});

ok('empty string is zero', () => {
  assert.strictEqual(resolveCounter('heuristic').count(''), 0);
});

ok('scan this repo finds files + nonzero total', () => {
  const res = scan(__dirname + '/..', { counter: resolveCounter('heuristic'), glob: '**/*.js' });
  assert.ok(res.files.length > 0, 'found js files');
  assert.ok(res.total > 0, 'nonzero total');
  assert.ok(res.files[0].tokens >= res.files[res.files.length - 1].tokens, 'sorted desc');
});

ok('audit flags duplicate lines', () => {
  const dup = 'this is a sufficiently long repeated line of text\n'.repeat(3);
  const res = audit(dup, resolveCounter('heuristic'));
  assert.ok(res.findings.some(f => f.kind === 'duplicate-lines'), 'found dupes');
});

console.log(`\n${pass} checks passed`);
