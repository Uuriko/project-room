// FIX-69: event-light claim writes.
//
// The room event log has a lifetime budget of 10,000 events. Every committed
// claim write used to append one work_claim.updated event (~6.5 per claim
// lifecycle), so 200 agents x 1 lifecycle/hour gated the whole room in ~3h.
// Claim writes are now event-light:
// - POST .../work-claims/{id}/touch records a heartbeat with zero room events;
// - routine lifecycle transitions batch into one work_claim.digest event per
//   room per 5-minute window;
// - only decision-grade signals (attention, review verdicts) still emit a
//   per-transition work_claim.updated event.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomAgentClient } from '../client/room-agent.mjs';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';

const DIGEST_WINDOW_MS = 5 * 60 * 1000;

async function fixture(t) {
  const store = new RoomStore(':memory:');
  store.initialize(initialRoom('commons'));
  const ownerKey = store.issueAccessKey('commons', 'owner');
  const memberKeys = {};
  for (const memberId of ['peer', 'racer-a', 'racer-b', 'racer-c']) {
    store.command(ownerKey, 'commons', { id: `add-${memberId}`, type: 'member.added',
      data: { memberId, displayName: memberId, kind: 'human', permissions: ['accept_work'] } });
    memberKeys[memberId] = store.issueAccessKey('commons', memberId);
  }
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const raw = async (token, method, path, body) => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = await response.json().catch(() => null);
    return { status: response.status, value };
  };
  const api = (token, method, path, body) =>
    raw(token, method, `/api/rooms/commons${path}`, body);
  return { store, server, raw, api, ownerKey, memberKeys,
    owner: new RoomAgentClient({ origin, roomId: 'commons', token: ownerKey }),
    peer: new RoomAgentClient({ origin, roomId: 'commons', token: memberKeys.peer }) };
}

const eventsOfType = async (client, type) =>
  (await client.changes(0, 1000)).events
    .filter(row => row.event.type === type)
    .map(row => row.event);

const touch = (f, token, id, body = {}) =>
  f.api(token, 'POST', `/work-claims/${id}/touch`, body);

test('touch records a heartbeat with zero room events', async t => {
  const f = await fixture(t);
  const before = await eventsOfType(f.owner, 'work_claim.updated');
  await f.owner.workClaimCreate({ id: 'beat-1', title: 'Beat one' });
  await f.owner.claimWorkItem('beat-1', { leaseHours: 1 });
  const eventsAfterClaim = await eventsOfType(f.owner, 'work_claim.updated');
  const res = await touch(f, f.ownerKey, 'beat-1');
  assert.equal(res.status, 200, `touch should succeed, got ${res.status}: ${JSON.stringify(res.value)}`);
  assert.ok(typeof res.value.leaseHeartbeatAt === 'string' && Number.isFinite(Date.parse(res.value.leaseHeartbeatAt)),
    'touch stamps leaseHeartbeatAt on the claim');
  assert.equal(res.value.owner, 'owner');
  assert.deepEqual(await eventsOfType(f.owner, 'work_claim.updated'), eventsAfterClaim,
    'a heartbeat appends no room events');
  assert.deepEqual(await eventsOfType(f.owner, 'work_claim.digest'), [],
    'a heartbeat alone does not flush a digest either');
  void before;
});

test('touch is owner-only and 404s on unknown claims', async t => {
  const f = await fixture(t);
  await f.owner.workClaimCreate({ id: 'beat-2', title: 'Beat two' });
  await f.owner.claimWorkItem('beat-2', { leaseHours: 1 });
  const foreign = await touch(f, f.memberKeys.peer, 'beat-2');
  assert.equal(foreign.status, 403);
  assert.equal(foreign.value?.error?.code, 'work_not_owner');
  const missing = await touch(f, f.ownerKey, 'no-such-claim');
  assert.equal(missing.status, 404);
  assert.equal(missing.value?.error?.code, 'work_claim_not_found');
});

test('a full claim lifecycle burns no per-transition room events', async t => {
  const f = await fixture(t);
  let now = Date.now();
  f.store.now = () => now;
  const countUpdated = async () => (await eventsOfType(f.owner, 'work_claim.updated')).length;

  await f.owner.workClaimCreate({ id: 'life-1', title: 'Lifecycle' });
  await f.owner.claimWorkItem('life-1', { leaseHours: 1 });
  await f.owner.updateWorkItem('life-1', { state: 'in_progress', note: 'starting' });
  await f.owner.renewWorkItem('life-1', { leaseHours: 2 });
  await f.owner.updateWorkItem('life-1', { note: 'still going' });
  await touch(f, f.ownerKey, 'life-1');
  await touch(f, f.ownerKey, 'life-1');
  await f.owner.updateWorkItem('life-1', { state: 'done', note: 'shipped' });
  assert.equal(await countUpdated(), 0,
    'create/claim/renew/notes/touch/done batch into the digest instead of per-transition events');
});

test('routine transitions batch into one digest event per window', async t => {
  const f = await fixture(t);
  let now = Date.now();
  f.store.now = () => now;
  const digests = () => eventsOfType(f.owner, 'work_claim.digest');

  await f.owner.workClaimCreate({ id: 'dig-1', title: 'Digest one' });
  await f.owner.claimWorkItem('dig-1', { leaseHours: 1 });
  await f.owner.updateWorkItem('dig-1', { state: 'in_progress' });
  await f.owner.workClaimCreate({ id: 'dig-2', title: 'Digest two' });
  await f.owner.releaseWorkItem('dig-1', { note: 'parked' });
  assert.deepEqual(await digests(), [], 'no digest flushes inside the window');

  now += DIGEST_WINDOW_MS + 1000;
  await f.owner.workClaimCreate({ id: 'dig-3', title: 'Digest three' });
  const flushed = await digests();
  assert.equal(flushed.length, 1, 'one digest event covers the whole window');
  const data = flushed[0].data;
  assert.ok(Date.parse(data.windowStart) < Date.parse(data.windowEnd));
  assert.deepEqual(data.digestCounts, { created: 2, claimed: 1, state_changed: 1, released: 1 });
  assert.equal(data.digestClaims.length, 2);
  const byId = Object.fromEntries(data.digestClaims.map(entry => [entry.workClaim, entry]));
  assert.equal(byId['dig-1'].action, 'released');
  assert.equal(byId['dig-1'].claimState, 'unclaimed');
  assert.equal(byId['dig-2'].action, 'created');
  // The window resets: a second window flushes separately.
  now += DIGEST_WINDOW_MS + 1000;
  await f.owner.claimWorkItem('dig-3', { leaseHours: 1 });
  assert.equal((await digests()).length, 2);
});

test('attention and review verdicts still emit immediate per-transition events', async t => {
  const f = await fixture(t);
  const countUpdated = async () => (await eventsOfType(f.owner, 'work_claim.updated')).length;
  const before = await countUpdated();
  // create-with-assignee carries attention=assigned: still immediate.
  await f.owner.workClaimCreate({ id: 'attn-1', title: 'Assigned', assignee: 'peer' });
  assert.equal(await countUpdated(), before + 1);
  const [assigned] = (await eventsOfType(f.owner, 'work_claim.updated')).slice(-1);
  assert.equal(assigned.data.action, 'claimed');
  assert.equal(assigned.data.attention, 'assigned');
  // A verdict review is decision-grade: still immediate.
  await f.owner.reviewWorkItem('attn-1', { verdict: 'changes_requested', summary: 'needs work' });
  const [verdict] = (await eventsOfType(f.owner, 'work_claim.updated')).slice(-1);
  assert.equal(verdict.data.action, 'reviewed');
  assert.equal(verdict.data.verdict, 'changes_requested');
});

test('staged same-tick claim races still yield exactly one winner', async t => {
  const f = await fixture(t);
  await f.owner.workClaimCreate({ id: 'race-1', title: 'Race' });
  const tokens = [f.ownerKey, f.memberKeys['racer-a'], f.memberKeys['racer-b'], f.memberKeys['racer-c']];
  const attempts = await Promise.all(tokens.map(token =>
    f.api(token, 'POST', '/work-claims/race-1/claim', {})));
  const winners = attempts.filter(a => a.status === 200);
  const losers = attempts.filter(a => a.status === 409);
  assert.equal(winners.length, 1, `exactly one winner, got ${winners.length}`);
  assert.equal(losers.length, tokens.length - 1);
  assert.ok(losers.every(a => a.value?.error?.code === 'work_claim_conflict'),
    'every loser gets 409 work_claim_conflict');
});

test('the 200-cap refusal still fires deterministically', async t => {
  const f = await fixture(t);
  // Narrow the room cap through the same registry the routes read, so the
  // HTTP refusal path is exercised without 200 creates (and their write
  // rate limit). The default-200 semantics are covered in
  // tests/work-claim-guards.test.js.
  f.store.workClaims.configure('commons', { maxOpenClaims: 2 });
  assert.equal((await f.api(f.ownerKey, 'POST', '/work-claims', { id: 'cap-a', title: 'A' })).status, 201);
  assert.equal((await f.api(f.ownerKey, 'POST', '/work-claims', { id: 'cap-b', title: 'B' })).status, 201);
  const over = await f.api(f.ownerKey, 'POST', '/work-claims', { id: 'cap-over', title: 'Over' });
  assert.equal(over.status, 409);
  assert.equal(over.value?.error?.code, 'work_board_full');
  assert.match(over.value?.error?.message ?? '', /close stale claims/i);
});

test('board list defaults to the summary view', async t => {
  const f = await fixture(t);
  await f.owner.workClaimCreate({ id: 'sum-1', title: 'Summary', note: 'a note' });
  await f.owner.claimWorkItem('sum-1', { leaseHours: 1 });
  const page = await f.api(f.ownerKey, 'GET', '/work-claims');
  assert.equal(page.status, 200);
  assert.ok(page.value.claims.length >= 1);
  for (const claim of page.value.claims) {
    assert.ok(!('history' in claim), 'summary view omits history');
    assert.ok(['id', 'title', 'state', 'owner', 'leaseExpiresAt'].every(key => key in claim));
  }
  const full = await f.api(f.ownerKey, 'GET', '/work-claims?view=full');
  assert.equal(full.status, 200);
  assert.ok(full.value.claims.every(claim => Array.isArray(claim.history)), 'view=full keeps the full items');
  const bad = await f.api(f.ownerKey, 'GET', '/work-claims?view=bogus');
  assert.equal(bad.status, 422);
});

test('state=expired is distinct from unclaimed', async t => {
  const f = await fixture(t);
  let now = Date.now();
  f.store.now = () => now;
  await f.owner.workClaimCreate({ id: 'exp-1', title: 'Will lapse' });
  await f.owner.workClaimCreate({ id: 'exp-2', title: 'Never claimed' });
  await f.owner.claimWorkItem('exp-1', { leaseHours: 0.25 });
  now += 16 * 60 * 1000; // past the 15-minute lease
  const swept = await f.api(f.ownerKey, 'GET', '/work-claims');
  assert.ok(swept.value.swept?.includes('exp-1'), 'the lapsed claim is swept');
  const expired = await f.api(f.ownerKey, 'GET', '/work-claims?state=expired');
  assert.equal(expired.status, 200);
  const expiredIds = expired.value.claims.map(claim => claim.id);
  assert.ok(expiredIds.includes('exp-1'), 'the lapsed claim reads as expired');
  assert.ok(!expiredIds.includes('exp-2'), 'a never-claimed item is not expired');
  const unclaimed = await f.api(f.ownerKey, 'GET', '/work-claims?state=unclaimed');
  assert.ok(unclaimed.value.claims.map(claim => claim.id).includes('exp-2'));
});

test('touch stays cheaper than a full claim write', async t => {
  const f = await fixture(t);
  await f.owner.workClaimCreate({ id: 'perf-1', title: 'Perf' });
  await f.owner.claimWorkItem('perf-1', { leaseHours: 1 });
  const time = async fn => {
    const start = process.hrtime.bigint();
    await fn();
    return Number(process.hrtime.bigint() - start) / 1e6;
  };
  const touchTimes = [];
  const createTimes = [];
  for (let i = 0; i < 10; i++) {
    touchTimes.push(await time(() => touch(f, f.ownerKey, 'perf-1')));
    createTimes.push(await time(() => f.api(f.ownerKey, 'POST', '/work-claims', { id: `perf-c-${i}`, title: 'x' })));
  }
  const p50 = samples => samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)];
  const touchP50 = p50(touchTimes);
  const createP50 = p50(createTimes);
  assert.ok(touchP50 <= createP50,
    `touch p50 (${touchP50.toFixed(1)}ms) should not exceed create p50 (${createP50.toFixed(1)}ms)`);
});
