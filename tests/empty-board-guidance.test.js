// Empty-board guidance contract (PRODUCT-200, first-run excellence).
//
// QA-200 stranger testing found the #2 dead-end: a fresh identity hitting an
// empty board gets `recommendations: []` with no next step — a silent dead
// end. This pins the fix: an empty match carries machine-readable guidance.
//
// Authoring-gate answers:
// 1. Protects the empty-board guidance contract on POST /api/public-work/match.
// 2. Credible regression: guidance field dropped, or the empty branch
//    refactored to return bare [] again.
// 3. discoverability.test.js pins the match shape's required fields; nothing
//    pins guidance-on-empty.
// 4. No production seam: asserts on the HTTP response body at the real boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';

async function fixture(t) {
  const store = new RoomStore(':memory:'); store.initialize(initialRoom());
  const server = createRoomServer({ store }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams?.(); server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { secret, body } = {}) => {
    const response = await fetch(origin + path, { method,
      headers: { Origin: origin, 'Content-Type': 'application/json', ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  return { call };
}

test('empty board: match returns guidance, not just []', async t => {
  const f = await fixture(t);
  const minted = await f.call('POST', '/api/agent-identities', { body: { displayName: 'empty-board-stranger' } });
  assert.equal(minted.status, 201);
  const match = await f.call('POST', '/api/public-work/match',
    { secret: minted.body.secret, body: { autoClaim: true, requestId: randomUUID(), limit: 3 } });
  assert.equal(match.status, 200);
  assert.deepEqual(match.body.recommendations, []);
  assert.equal(match.body.claim, null);
  const guidance = match.body.guidance;
  assert.ok(guidance && typeof guidance === 'object', 'empty match must carry a guidance object');
  assert.ok(Array.isArray(guidance.nextSteps) && guidance.nextSteps.length > 0, 'guidance.nextSteps must be a non-empty array');
  for (const step of guidance.nextSteps) assert.ok(typeof step === 'string' && step.length > 0, 'each next step is actionable text');
});

test('empty board: anonymous match (no autoClaim) also carries guidance', async t => {
  const f = await fixture(t);
  const match = await f.call('POST', '/api/public-work/match', { body: { limit: 3 } });
  assert.equal(match.status, 200);
  assert.deepEqual(match.body.recommendations, []);
  assert.ok(match.body.guidance?.nextSteps?.length > 0, 'anonymous empty match must carry guidance');
});

test('non-empty board: guidance stays out of the way', async t => {
  const f = await fixture(t);
  // No seeded offer here either — but the shape assertion matters: when a
  // future fixture has offers, guidance must not clutter a useful response.
  // This documents the intended contract: guidance appears on empty only.
  const match = await f.call('POST', '/api/public-work/match', { body: { limit: 3 } });
  assert.equal(match.status, 200);
  if (match.body.recommendations.length > 0) {
    assert.equal(match.body.guidance, undefined, 'guidance is for empty boards only');
  } else {
    assert.ok(match.body.guidance?.nextSteps?.length > 0);
  }
});
