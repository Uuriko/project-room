// Agent-inbox v1: needs-me myClaims + actionsNeeded standing sections.
// Before this, needs-me told a polling agent about other people's asks
// (mentions, review asks, open work) and two urgent cases on its own claims
// (myWork: lease expiring / idle), but never the full list of its own open
// claims or which of them were broken — an agent had to re-read the whole
// board to answer "what is mine and what needs fixing". These sections are
// standing state: they ride beside items and never move the cursor.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { AgentRooms } from '../server/agent-rooms.mjs';
import { collectNeedsMe } from '../server/needs-me.mjs';
import { createWork, claimWork, updateWork, recordReview, recordCi } from '../server/work-claims.mjs';
import { linkWithProof } from "./helpers/link-with-proof.mjs";

const WRITER = ['steer', 'accept_work', 'complete_work', 'verify'];

function setup(t) {
  // Pin the store clock to the scenario date: the fixtures kernel-claim
  // at t0 with default 24h leases and intend LIVE claims. Since #3898
  // the sections derive lease liveness from store.now(), so an unpinned
  // (wall-clock) store would read every fixture claim as long expired.
  const store = new RoomStore(':memory:', { now: () => Date.parse('2026-10-05T00:00:00Z') });
  t.after(() => store.close());
  const rooms = new AgentRooms(store);
  const owner = store.identities.create('Owen');
  const ada = store.identities.create('Ada');
  const bob = store.identities.create('Bob');
  rooms.create(owner.secret, { roomId: 'board', title: 'board', purpose: 'Inbox v1', kind: 'personal' });
  for (const identity of [ada, bob]) {
    linkWithProof(store, owner.secret, 'board', identity, { displayName: identity === ada ? 'Ada' : 'Bob', permissions: WRITER });
  }
  const memberOf = identity => store.db.prepare('SELECT member_id AS m FROM identity_links WHERE identity_id=? AND room_id=?')
    .get(identity.identityId, 'board').m;
  const t0 = Date.parse('2026-10-05T00:00:00Z');
  const put = (id, minutes = 0) => {
    const item = { ...createWork({ id, title: `Task ${id}` }, { now: t0 + minutes * 60000, agentId: owner.identityId }) };
    store.workClaims.set('board', item);
    return item;
  };
  const own = (id, memberId, state, minutes = 0) => {
    let item = claimWork(put(id, minutes), memberId, { now: t0 + minutes * 60000 });
    if (state !== 'claimed') item = updateWork(item, memberId, { state, now: t0 + minutes * 60000 });
    store.workClaims.set('board', item);
    return item;
  };
  return { store, owner, ada, bob, memberOf, put, own, t0 };
}

test('myClaims lists every open claim the member owns, with state and next step', t => {
  const { store, ada, memberOf, own } = setup(t);
  const adaId = memberOf(ada);
  assert.equal(collectNeedsMe(store, ada.secret, {}).myClaims, undefined, 'no claims, no section');
  own('fresh', adaId, 'claimed');
  own('doing', adaId, 'in_progress');
  own('stuck', adaId, 'blocked');
  const delivered = own('shipped', adaId, 'in_progress');
  store.workClaims.set('board', { ...delivered, state: 'delivered' });
  const finished = own('finished', adaId, 'in_progress');
  store.workClaims.set('board', { ...finished, state: 'done' });

  const page = collectNeedsMe(store, ada.secret, {});
  assert.equal(page.myClaims?.length, 1);
  const mine = page.myClaims[0];
  assert.equal(mine.roomId, 'board');
  assert.equal(mine.count, 4, 'terminal and unclaimed work is not mine to act on');
  assert.deepEqual(mine.byState, { claimed: 1, in_progress: 1, blocked: 1, delivered: 1 });
  assert.deepEqual(mine.top.map(row => row.id), ['stuck', 'doing', 'fresh', 'shipped'],
    'actionable states first: blocked, in progress, claimed, then delivered');
  const next = Object.fromEntries(mine.top.map(row => [row.id, row.next]));
  assert.deepEqual(next, { stuck: 'start', doing: 'finish', fresh: 'start', shipped: 'await_review' },
    'next step is the lifecycle verb for the state; delivered waits on reviewers');
  assert.match(mine.next, /^GET \/api\/rooms\/board\/work-claims$/);
});

test('myClaims never moves the cursor and retires as claims close', t => {
  const { store, ada, memberOf, own } = setup(t);
  const adaId = memberOf(ada);
  const before = collectNeedsMe(store, ada.secret, {});
  own('transient', adaId, 'claimed');
  const during = collectNeedsMe(store, ada.secret, { since: before.cursor });
  assert.equal(during.myClaims?.[0].count, 1);
  assert.deepEqual(during.cursor, before.cursor, 'standing sections leave the cursor untouched');
  const item = store.workClaims.list('board').find(row => row.id === 'transient');
  store.workClaims.set('board', { ...item, state: 'done' });
  assert.equal(collectNeedsMe(store, ada.secret, {}).myClaims, undefined, 'a closed claim leaves the list');
});

test("one identity's sections never surface another member's claims", t => {
  const { store, ada, bob, memberOf, own } = setup(t);
  const adaId = memberOf(ada);
  const bobId = memberOf(bob);
  own('ada-task', adaId, 'in_progress');
  const bobItem = own('bob-task', bobId, 'in_progress');
  store.workClaims.set('board', recordCi(bobItem, { state: 'failure', headSha: 'a'.repeat(40), url: 'https://ci.example/bob' }, Date.now()).item);

  const adaPage = collectNeedsMe(store, ada.secret, {});
  assert.deepEqual(adaPage.myClaims?.[0].top.map(row => row.id), ['ada-task'], "Ada sees only Ada's claims");
  assert.equal(adaPage.actionsNeeded, undefined, "Bob's failed CI is not Ada's action");

  const bobPage = collectNeedsMe(store, bob.secret, {});
  assert.deepEqual(bobPage.myClaims?.[0].top.map(row => row.id), ['bob-task'], "Bob sees only Bob's claims");
  assert.deepEqual(bobPage.actionsNeeded?.[0].top.map(row => row.id), ['bob-task']);
  assert.equal(bobPage.actionsNeeded[0].top[0].why, 'ci_failed');
});

test('actionsNeeded surfaces a failed CI rollup on my own claim with its pointers', t => {
  const { store, ada, memberOf, own } = setup(t);
  const adaId = memberOf(ada);
  let item = own('red-build', adaId, 'in_progress');
  item = recordCi(item, { state: 'failure', headSha: 'b'.repeat(40), url: 'https://ci.example/run/1' }, Date.now()).item;
  store.workClaims.set('board', item);
  own('green-build', adaId, 'in_progress');
  const green = store.workClaims.list('board').find(row => row.id === 'green-build');
  store.workClaims.set('board', recordCi(green, { state: 'success', headSha: 'c'.repeat(40) }, Date.now()).item);

  const page = collectNeedsMe(store, ada.secret, {});
  assert.equal(page.actionsNeeded?.length, 1);
  const needed = page.actionsNeeded[0];
  assert.equal(needed.count, 1, 'passing CI needs no action');
  const row = needed.top[0];
  assert.equal(row.id, 'red-build');
  assert.equal(row.why, 'ci_failed');
  assert.equal(row.ciUrl, 'https://ci.example/run/1');
  assert.equal(row.headSha, 'b'.repeat(40));
  const mine = page.myClaims[0].top.find(entry => entry.id === 'red-build');
  assert.equal(mine.ci, 'failure', 'myClaims carries the rollup state too');
});

test('actionsNeeded surfaces a changes-requested review on the current round only', t => {
  const { store, ada, bob, memberOf, own } = setup(t);
  const adaId = memberOf(ada);
  const bobId = memberOf(bob);
  const now = Date.now();
  let item = own('revise-me', adaId, 'in_progress');
  item = recordReview(item, bobId, { verdict: 'changes_requested', summary: 'Please add the missing test', now });
  store.workClaims.set('board', item);

  const page = collectNeedsMe(store, ada.secret, {});
  const row = page.actionsNeeded?.[0].top.find(entry => entry.id === 'revise-me');
  assert.ok(row, 'the owner sees the ask');
  assert.equal(row.why, 'changes_requested');
  assert.equal(row.by, bobId);
  assert.match(row.summary, /missing test/);
  assert.equal(page.myClaims[0].top.find(entry => entry.id === 'revise-me').changesRequested, true);

  // The same verdict left over from a previous ownership round (an older
  // claimedAt in its basis) is history, not an action.
  let stale = own('old-round', adaId, 'in_progress');
  const staleReview = {
    memberId: bobId, verdict: 'changes_requested', summary: 'From the round before the release',
    url: null, at: new Date(now).toISOString(),
    basis: { version: 1, owner: adaId, claimedAt: '2020-01-01T00:00:00.000Z', revision: null, headSha: null, deliveryDigest: null, deliveryGeneration: 0 }
  };
  store.workClaims.set('board', { ...stale, reviews: [staleReview] });
  stale = store.workClaims.list('board').find(entry => entry.id === 'old-round');
  assert.notEqual(stale.reviews[0].basis.claimedAt, stale.claimedAt, 'fixture: the stale basis names an earlier round');
  const after = collectNeedsMe(store, ada.secret, {});
  assert.equal(after.actionsNeeded?.[0].top.some(entry => entry.id === 'old-round'), false,
    'a verdict from a previous round does not resurface');
  assert.equal(after.myClaims[0].top.find(entry => entry.id === 'old-round').changesRequested, undefined);
});

test('a fresh delivery generation retires the changes-requested ask', t => {
  const { store, ada, bob, memberOf, own } = setup(t);
  const adaId = memberOf(ada);
  const bobId = memberOf(bob);
  const now = Date.now();
  let item = own('redo', adaId, 'in_progress');
  item = recordReview(item, bobId, { verdict: 'changes_requested', summary: 'Not yet', now });
  store.workClaims.set('board', item);
  assert.ok(collectNeedsMe(store, ada.secret, {}).actionsNeeded, 'ask is live on this generation');
  const redelivered = { ...item, state: 'delivered', deliveryGeneration: (item.deliveryGeneration ?? 0) + 1 };
  store.workClaims.set('board', redelivered);
  const page = collectNeedsMe(store, ada.secret, {});
  assert.equal(page.actionsNeeded, undefined, 'a new delivery generation answers the ask until a reviewer speaks again');
  assert.equal(page.myClaims[0].top[0].next, 'await_review');
});

// #3898: the standing sections read raw stored rows, so a claim whose
// lease lapsed on a quiet board (no sweep traffic) was still served as
// held — with a forward "next" verb and a ci_failed action — long after
// the domain's own derivation (releaseExpired) says the member no
// longer holds it. The sections must derive lease liveness from the
// store clock instead of trusting the stored row.
function pinnedSetup(t) {
  let clock = Date.parse('2026-10-05T00:00:00Z');
  const store = new RoomStore(':memory:', { now: () => clock });
  t.after(() => store.close());
  const rooms = new AgentRooms(store);
  const owner = store.identities.create('Owen');
  const ada = store.identities.create('Ada');
  const bob = store.identities.create('Bob');
  rooms.create(owner.secret, { roomId: 'board', title: 'board', purpose: 'Inbox v1', kind: 'personal' });
  for (const identity of [ada, bob]) {
    linkWithProof(store, owner.secret, 'board', identity, { displayName: identity === ada ? 'Ada' : 'Bob', permissions: WRITER });
  }
  const memberOf = identity => store.db.prepare('SELECT member_id AS m FROM identity_links WHERE identity_id=? AND room_id=?')
    .get(identity.identityId, 'board').m;
  return { store, ada, bob, memberOf, t0: clock, advance: ms => { clock += ms; } };
}

test('an expired lease is not reported as held: myClaims and actionsNeeded derive liveness (#3898)', t => {
  const { store, ada, bob, memberOf, t0, advance } = pinnedSetup(t);
  const adaId = memberOf(ada);
  let stale = { ...createWork({ id: 'stale-task', title: 'Stale task' }, { now: t0, agentId: adaId }) };
  stale = claimWork(stale, adaId, { now: t0, leaseHours: 1 });
  stale = recordCi(stale, { state: 'failure', headSha: 'a'.repeat(40), url: 'https://ci.example/stale' }, t0).item;
  store.workClaims.set('board', stale);
  let live = { ...createWork({ id: 'live-task', title: 'Live task' }, { now: t0, agentId: adaId }) };
  live = claimWork(live, adaId, { now: t0, leaseHours: 72 });
  store.workClaims.set('board', live);

  advance(2 * 3600 * 1000); // stale-task's 1h lease has lapsed; live-task's has not

  const page = collectNeedsMe(store, ada.secret, {});
  assert.deepEqual(page.myClaims?.[0]?.top.map(row => row.id), ['live-task'],
    'the lapsed claim is no longer served as held');
  assert.deepEqual(page.actionsNeeded ?? [], [],
    'no ci_failed action for a claim the member no longer holds');
  // The same derivation feeds openWork: the lapsed work is open again
  // for everyone else instead of hidden behind a dead claim.
  const bobPage = collectNeedsMe(store, bob.secret, {});
  assert.ok(bobPage.openWork?.[0]?.top.some(row => row.id === 'stale-task'),
    'lapsed claim returns to open work');
});
