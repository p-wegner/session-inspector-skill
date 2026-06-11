'use strict';
/* Tiny smoke test — no framework. `npm test`. */

const assert = require('assert');
const { resolveCounter, familyOf } = require('../src/counters');
const { scan } = require('../src/scan');
const { audit } = require('../src/audit');
const { analyzeSkill, parseFrontmatter } = require('../src/skill');

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

ok('claude/gemini counters: o200k normalized offline + exact API hook', () => {
  for (const m of ['opus-4.8', 'gemini']) {
    const c = resolveCounter(m);
    assert.ok(c.estimate === true, `${m} marked as estimate`);
    assert.ok(typeof c.note === 'string' && c.note.length, `${m} has caveat note`);
    assert.ok(typeof c.exact === 'function', `${m} exposes async exact()`);
    // offline number must match the shared o200k_base normalizer
    const txt = 'The quick brown fox jumps over the lazy dog.';
    assert.strictEqual(c.count(txt), resolveCounter('gpt-5.5').count(txt), `${m} == o200k normalized`);
  }
  // openai is exact, no caveat
  assert.strictEqual(resolveCounter('gpt-5.5').estimate, false);
});

ok('frontmatter parse: name + description + body split', () => {
  const { name, description, body } = parseFrontmatter('---\nname: foo\ndescription: a thing it does\n---\nBody here mentions refs/x.md');
  assert.strictEqual(name, 'foo');
  assert.strictEqual(description, 'a thing it does');
  assert.ok(body.startsWith('Body here'));
});

ok('analyzeSkill tiers this repo + flags reachability', () => {
  const a = analyzeSkill(__dirname + '/..', resolveCounter('gpt-5.5'));
  assert.strictEqual(a.name, 'token-budget');
  assert.ok(a.tiers.alwaysOn > 0 && a.tiers.onInvoke > a.tiers.alwaysOn, 'body > desc');
  // references/*.md are linked from SKILL.md → on-demand, not orphaned
  assert.ok(a.tiers.onDemandDocs.some(f => f.path.includes('optimization-guide')), 'guide reachable');
  // README is a human doc, never a scary orphan
  assert.ok(a.notContext.humanDocs.some(f => /readme/i.test(f.path)), 'README = human doc');
  assert.strictEqual(a.notContext.orphanDocs.length, 0, 'no true orphans');
  assert.strictEqual(a.fullyExpanded, a.tiers.alwaysOn + a.tiers.onInvoke + a.tiers.onDemand, 'expanded = sum of tiers');
});

console.log(`\n${pass} checks passed`);
