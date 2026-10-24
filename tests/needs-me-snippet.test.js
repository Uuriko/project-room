// A claim's needs-me snippet must describe the work, not lease, assignment or
// retention bookkeeping (prod showed "retention-ack seen=1 first=1 sla_due=..."
// as the only line an assigned agent saw about its task).
import test from 'node:test';
import assert from 'node:assert/strict';
import { claimSnippet } from '../server/needs-me.mjs';

const at = '2026-10-20T15:26:07.470Z';

test('bookkeeping history notes never become the snippet', () => {
  const claim = { history: [
    { at, action: 'created', note: null },
    { at, action: 'claimed', note: 'assigned by ai_owner' },
    { at, action: 'retention_ack', note: 'retention-ack seen=1 first=1 sla_due=2026-10-21T15:26:07.470Z' },
    { at, action: 'renewed', note: 'lease: 2h' },
  ] };
  assert.equal(claimSnippet(claim), null);
});

test('a real note still wins over newer bookkeeping', () => {
  const claim = { history: [
    { at, action: 'created', note: 'Write the hello note in notes/hello.md' },
    { at, action: 'claimed', note: 'lease: 2h' },
    { at, action: 'retention_ack', note: 'retention-ack seen=1 first=0' },
  ] };
  assert.equal(claimSnippet(claim), 'Write the hello note in notes/hello.md');
});

test('acceptance criteria still take precedence', () => {
  assert.equal(claimSnippet({ acceptanceCriteria: ['Note exists'], history: [{ at, action: 'created', note: 'x' }] }), 'Note exists');
});
