#!/usr/bin/env node
// build-digest.test.mjs — invariants for the coordinator digest builder.
// Run: node --test scripts/build-digest.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeStatus,
  normalizeReceipt,
  parseTests,
  scoreCompletion,
  buildDigest,
  buildRollup,
} from './build-digest.mjs';

describe('normalizeStatus', () => {
  it('maps common aliases', () => {
    assert.equal(normalizeStatus('done'), 'completed');
    assert.equal(normalizeStatus('Failed'), 'errored');
    assert.equal(normalizeStatus('STUCK'), 'blocked');
    assert.equal(normalizeStatus('whatever'), 'unknown');
    assert.equal(normalizeStatus(null), 'unknown');
  });
});

describe('normalizeReceipt', () => {
  it('accepts the minimal fallback schema', () => {
    const n = normalizeReceipt(
      { workerId: 'w-1', status: 'completed', summary: 'did the thing', filesChanged: ['a.mjs'], tests: { passed: 3, failed: 0 } },
      'w-1.json'
    );
    assert.equal(n.workerId, 'w-1');
    assert.equal(n.status, 'completed');
    assert.equal(n.fileCount, 1);
    assert.deepEqual(n.tests, { passed: 3, failed: 0 });
  });
  it('falls back to file name for workerId', () => {
    const n = normalizeReceipt({ status: 'blocked' }, 'lane-9.json');
    assert.equal(n.workerId, 'lane-9');
  });
  it('tolerates envelope wrappers and flat test counts', () => {
    const n = normalizeReceipt(
      { receipt: { worker_id: 'w-2', state: 'ok', testsPassed: 5, testsFailed: 1, open_questions: ['why?'] } },
      'x.json'
    );
    assert.equal(n.workerId, 'w-2');
    assert.equal(n.status, 'completed');
    assert.deepEqual(n.tests, { passed: 5, failed: 1 });
    assert.deepEqual(n.openQuestions, ['why?']);
  });
  it('rejects non-objects', () => {
    assert.equal(normalizeReceipt(null, 'a.json'), null);
    assert.equal(normalizeReceipt('str', 'a.json'), null);
  });
});

describe('scoreCompletion', () => {
  const base = (over) => normalizeReceipt({ workerId: 'w', status: 'completed', summary: '', filesChanged: [], tests: { passed: 0, failed: 0 }, ...over }, 'w.json');
  it('is deterministic and ranks failing tests higher (needs attention)', () => {
    const green = base({ summary: 'docs update' });
    const red = base({ summary: 'docs update', tests: { passed: 8, failed: 2 } });
    assert.ok(scoreCompletion(red) > scoreCompletion(green));
    assert.equal(scoreCompletion(green), scoreCompletion(base({ summary: 'docs update' })));
  });
  it('weights security/breaking keywords', () => {
    const a = base({ summary: 'fix a security hole in auth' });
    const b = base({ summary: 'fix a typo in docs' });
    assert.ok(scoreCompletion(a) > scoreCompletion(b));
  });
});

describe('buildDigest', () => {
  const mk = (workerId, status, summary = 's', extra = {}) =>
    normalizeReceipt({ workerId, status, summary, filesChanged: ['f.mjs'], tests: { passed: 1, failed: 0 }, ...extra }, `${workerId}.json`);
  const receipts = [
    mk('w-b', 'completed', 'security fix for the deploy gate'),
    mk('w-a', 'completed', 'docs typo'),
    mk('w-c', 'errored', 'fell over', { error: 'boom', openQuestions: ['retry or revert?'] }),
    mk('w-d', 'blocked', 'waiting', { blockers: ['needs token'], openQuestions: ['who has the token?', 'is there a fallback?'] }),
  ];
  const { digest, rollup, stats } = buildDigest(receipts, [], '/tmp');
  it('counts headlines and ranks completions by significance', () => {
    assert.match(digest, /4 receipts: 2 completed, 1 errored, 1 blocked/);
    const idxB = digest.indexOf('[w-b]');
    const idxA = digest.indexOf('[w-a]');
    assert.ok(idxB > 0 && idxA > 0 && idxB < idxA, 'security completion ranks above docs typo');
  });
  it('quotes open questions verbatim in the attention section', () => {
    assert.ok(digest.includes('open question: retry or revert?'));
    assert.ok(digest.includes('open question: who has the token?'));
  });
  it('caps the roll-up at 500 chars', () => {
    assert.ok(rollup.length <= 500, `rollup is ${rollup.length} chars`);
  });
  it('reports aggregate metrics', () => {
    assert.equal(stats.total, 4);
    assert.equal(stats.testsPassed, 4);
  });
  it('is byte-identical across runs (deterministic)', () => {
    const again = buildDigest(receipts, [], '/tmp');
    assert.equal(again.digest, digest);
  });
});

describe('buildRollup', () => {
  it('never exceeds the limit even with long summaries', () => {
    const mk = (id) => normalizeReceipt({ workerId: id, status: 'completed', summary: 'x'.repeat(2000) }, `${id}.json`);
    const completions = [mk('w1'), mk('w2'), mk('w3'), mk('w4'), mk('w5')];
    const r = buildRollup({ total: 25, completed: 25, errored: 0, blocked: 0, completions, attention: [], testsPassed: 1, testsFailed: 0 }, 500);
    assert.ok(r.length <= 500);
  });
});
