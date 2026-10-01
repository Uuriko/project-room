// Room-first coordination verbs over real HTTP: the verbs only count when the
// room's own work-claim record confirms them, so these tests drive the real
// server and read the record back instead of trusting a client-side echo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomAgentClient } from '../client/room-agent.mjs';
import { RoomLandClient } from '../client/room-land.mjs';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
import { CoordError, claimAndVerify, closeClaim, coordStatus, digest, handoff, isLiveClaim, land, pathCovers, renewWithProgress, verifyClaim } from '../client/room-coord.mjs';
import { parseArgs, run } from '../scripts/room-coord.mjs';

const PR_SHA = 'd'.repeat(40);

async function fixture(t) {
  const store = new RoomStore(':memory:');
  store.initialize(initialRoom('commons'));
  const ownerKey = store.issueAccessKey('commons', 'owner');
  store.command(ownerKey, 'commons', { id: 'add-reviewer', type: 'member.added',
    data: { memberId: 'reviewer', displayName: 'Reviewer', kind: 'human', permissions: [] } });
  const peerKey = store.issueAccessKey('commons', 'reviewer');
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { store,
    lander: new RoomLandClient({ origin, roomId: 'commons', token: ownerKey }),
    owner: new RoomAgentClient({ origin, roomId: 'commons', token: ownerKey }),
    peer: new RoomAgentClient({ origin, roomId: 'commons', token: peerKey }) };
}

const coded = code => error => error instanceof CoordError && error.code === code;
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
const postedBodies = async (client, messageId) => (await client.changes(0, 100)).events
  .filter(row => row.event.type === 'message.posted' && row.event.data.messageId === messageId)
  .map(row => row.event.data.body);

test('a directory claim covers the files beneath it and nothing beside it', () => {
  for (const [held, file, covered] of [
    ['server', 'server/http.mjs', true],
    ['./server/', 'server/http.mjs', true],
    ['server/http.mjs', 'server/http.mjs', true],
    ['server/h', 'server/http.mjs', false],
    ['server/http.mjs', 'server', false],
    ['server/./http.mjs', 'server/http.mjs', true],
    ['server/http.mjs', 'server/./http.mjs', true],
    ['docs', 'docs-site/index.md', false]
  ]) assert.equal(pathCovers(held, file), covered, `${held} vs ${file}`);
  assert.throws(() => pathCovers('../outside', 'server/a.mjs'), coded('invalid_path'));
});

test('claims are confirmed by reading the room record back, and held files refuse a second member', async t => {
  const { owner, peer } = await fixture(t);
  const held = await claimAndVerify(owner, 'lane-a', { memberId: 'owner', files: ['server/coord'], leaseHours: 2, title: 'Lane A' });
  assert.equal(held.owner, 'owner');
  assert.equal(held.state, 'claimed');
  assert.ok(Date.parse(held.leaseExpiresAt) > Date.now());
  assert.deepEqual(held.files, ['server/coord']);

  await assert.rejects(claimAndVerify(peer, 'lane-b', { memberId: 'reviewer', files: ['server/coord/a.mjs', 'docs/b.md'] }),
    error => coded('claim_conflict')(error) && error.details.conflicts.length === 1
      && error.details.conflicts[0].claimId === 'lane-a' && error.details.conflicts[0].file === 'server/coord/a.mjs');
  await assert.rejects(peer.workClaimGet('lane-b'), error => error.status === 404, 'a refused claim writes nothing');

  const overlapping = await claimAndVerify(peer, 'lane-b', { memberId: 'reviewer', files: ['server/coord/a.mjs'], allowOverlap: true });
  assert.equal(overlapping.owner, 'reviewer');
});

test('a claim that loses the race is released, and omitted files still refuse an overlap', async t => {
  const { owner, peer } = await fixture(t);
  let reads = 0;
  const racing = {
    workClaims: async options => {
      reads += 1;
      if (reads === 1) {
        const stale = await owner.workClaims(options);
        await peer.workClaim('intruder', { files: ['docs'], leaseHours: 2 });
        return stale;
      }
      return owner.workClaims(options);
    },
    workClaim: (id, body) => owner.workClaim(id, body),
    workClaimGet: (id, options) => owner.workClaimGet(id, options),
    releaseWorkItem: (id, body) => owner.releaseWorkItem(id, body)
  };
  await assert.rejects(claimAndVerify(racing, 'racer', { memberId: 'owner', files: ['docs/shared.md'], leaseHours: 2 }),
    error => coded('claim_conflict')(error) && error.details.released === true
      && error.details.conflicts[0].heldPath === 'docs' && error.details.conflicts[0].file === 'docs/shared.md');
  assert.equal((await owner.workClaimGet('racer')).state, 'unclaimed');
  assert.equal((await peer.workClaimGet('intruder')).owner, 'reviewer');

  await owner.workClaimCreate({ id: 'kept', files: ['server/kept.mjs'] });
  await peer.workClaim('keepsake', { files: ['server/kept.mjs'], leaseHours: 1 });
  await assert.rejects(claimAndVerify(owner, 'kept', { memberId: 'owner', leaseHours: 1 }), coded('claim_conflict'));
  const kept = await owner.workClaimGet('kept');
  assert.equal(kept.state, 'unclaimed');
  assert.equal(kept.history.some(entry => entry.action === 'claimed'), false);
});

test('renewal of a missing claim fails before a progress line is posted', async t => {
  const { owner } = await fixture(t);
  await assert.rejects(renewWithProgress(owner, 'missing-claim', 'nothing to report', { memberId: 'owner' }),
    error => error instanceof CoordError && error.code === 'work_claim_not_found');
  const bodies = (await owner.changes(0, 100)).events
    .filter(row => row.event.type === 'message.posted')
    .map(row => row.event.data.body);
  assert.equal(bodies.some(body => String(body).includes('[missing-claim]')), false);
});

test('done closes a claimed or blocked item by moving it through in progress', async t => {
  const { owner } = await fixture(t);
  await claimAndVerify(owner, 'finish-claimed', { memberId: 'owner', leaseHours: 1 });
  const claimed = await run(['done', 'finish-claimed', '--note', 'shipped'], { client: owner, memberId: 'owner' });
  assert.equal(claimed.state, 'done');
  assert.equal(claimed.history.at(-1).note, 'shipped');
  assert.equal(claimed.history.at(-2).note, 'started to close');
  assert.deepEqual(claimed.history.map(entry => entry.action).slice(-3), ['claimed', 'state:in_progress', 'state:done']);

  await claimAndVerify(owner, 'finish-blocked', { memberId: 'owner', leaseHours: 1 });
  await owner.updateWorkItem('finish-blocked', { state: 'blocked' });
  const blocked = await closeClaim(owner, 'finish-blocked', { memberId: 'owner', note: 'unblocked and shipped' });
  assert.equal(blocked.state, 'done');
  assert.equal(blocked.history.at(-1).action, 'state:done');
  assert.equal(blocked.history.at(-2).action, 'state:in_progress');

  await claimAndVerify(owner, 'finish-started', { memberId: 'owner', leaseHours: 1 });
  await owner.updateWorkItem('finish-started', { state: 'in_progress' });
  const started = await closeClaim(owner, 'finish-started', { memberId: 'owner', note: 'shipped' });
  assert.equal(started.state, 'done');
  assert.equal(started.history.some(entry => entry.note === 'started to close'), false);

  await owner.workClaimCreate({ id: 'needs-review', reviewPolicy: 'distinct_member' });
  await claimAndVerify(owner, 'needs-review', { memberId: 'owner', leaseHours: 1 });
  await assert.rejects(closeClaim(owner, 'needs-review', { memberId: 'owner', note: 'shipped' }),
    error => error instanceof CoordError && error.code === 'work_review_rejected');
  assert.equal((await owner.workClaimGet('needs-review')).state, 'in_progress');
});

test('a record that is not a live lease held by the caller is never treated as a claim', () => {
  const now = Date.parse('2026-10-01T12:00:00Z');
  const live = { id: 'w', state: 'claimed', owner: 'me', leaseExpiresAt: '2026-10-01T13:00:00Z' };
  assert.equal(verifyClaim(live, { memberId: 'me', now }).id, 'w');
  assert.equal(verifyClaim({ ...live, leaseExpiresAt: null }, { memberId: 'me', now }).id, 'w');
  // Four minutes past the stamp is still live: a client clock that far ahead
  // of the room must not drop the lease. Six minutes past is not.
  assert.equal(verifyClaim({ ...live, leaseExpiresAt: '2026-10-01T11:56:00Z' }, { memberId: 'me', now }).id, 'w');
  assert.equal(isLiveClaim({ ...live, leaseExpiresAt: '2026-10-01T11:56:00Z' }, now), true);
  assert.equal(isLiveClaim({ ...live, leaseExpiresAt: '2026-10-01T11:54:00Z' }, now), false);
  for (const record of [
    null,
    { ...live, state: 'unclaimed', owner: null },
    { ...live, owner: 'someone-else' },
    { ...live, leaseExpiresAt: '2026-10-01T11:54:00Z' },
    { ...live, state: 'done' }
  ]) assert.throws(() => verifyClaim(record, { memberId: 'me', now }), coded('claim_not_verified'));
});

test('renewal posts a public progress line and extends the lease against that message', async t => {
  const { owner } = await fixture(t);
  const first = await claimAndVerify(owner, 'renew-me', { memberId: 'owner', leaseHours: 1 });
  await tick();
  const { messageId, claim } = await renewWithProgress(owner, 'renew-me', 'guard wired into CI', { memberId: 'owner', leaseHours: 3 });
  assert.ok(Date.parse(claim.leaseExpiresAt) > Date.parse(first.leaseExpiresAt));
  assert.equal(claim.history.at(-1).action, 'renewed');
  assert.deepEqual(await postedBodies(owner, messageId), ['[renew-me] guard wired into CI']);
});

test('handoff moves the lease to the receiver and leaves an actionable handoff post', async t => {
  const { owner, peer } = await fixture(t);
  await claimAndVerify(owner, 'baton', { memberId: 'owner', files: ['client/room-coord.mjs'], leaseHours: 4 });
  const { messageId, claim } = await handoff(owner, 'baton', { to: 'reviewer', toHandle: 'Reviewer',
    summary: 'client verbs merged', next: 'wire the guard into CI' });
  assert.equal(claim.owner, 'reviewer');
  const [body] = await postedBodies(owner, messageId);
  assert.match(body, /^Handoff baton to @Reviewer\n/);
  assert.match(body, /\nNext: wire the guard into CI(\n|$)/);
  assert.match(body, /\nFiles: client\/room-coord\.mjs(\n|$)/);
  assert.equal((await peer.updateWorkItem('baton', { state: 'in_progress' })).state, 'in_progress');
  await assert.rejects(owner.releaseWorkItem('baton'), error => error.status === 403);
});

test('status shows live, mine, expiring and overlapping claims plus the land queue, and the digest cites each', async t => {
  const { store, lander, owner, peer } = await fixture(t);
  store.landQueue.configure({ token: 'github_pat_test_room_coord', fetchImpl: async url => ({ status: 200, ok: true, json: async () => (
    url.includes('/check-runs') ? { check_runs: [] }
      : url.endsWith('/status') ? { state: 'pending' }
        : { title: 'Room coordination verbs', merged: false, merge_commit_sha: null, mergeable: true, mergeable_state: 'clean', head: { sha: PR_SHA } }) }) });
  await claimAndVerify(owner, 'short', { memberId: 'owner', files: ['server'], leaseHours: 1 });
  await claimAndVerify(peer, 'long', { memberId: 'reviewer', files: ['server/x.mjs'], leaseHours: 8, allowOverlap: true });
  await owner.workClaimCreate({ id: 'waiting' });
  const queued = await land(lander, { repo: 'acme/demo', prNumber: 7 });
  assert.deepEqual([queued.item.repo, queued.item.prNumber, queued.duplicate], ['acme/demo', 7, false]);

  const status = await coordStatus(owner, { lander, memberId: 'owner' });
  assert.deepEqual(status.live.map(claim => claim.id).sort(), ['long', 'short']);
  assert.deepEqual(status.mine.map(claim => claim.id), ['short']);
  assert.deepEqual(status.expiring.map(claim => claim.id), ['short']);
  assert.deepEqual(status.unclaimed.map(claim => claim.id), ['waiting']);
  assert.deepEqual(status.overlaps, [{ claims: ['long', 'short'], owners: ['owner', 'reviewer'], paths: ['server/x.mjs'] }]);
  assert.deepEqual(status.landQueue.map(item => [item.repo, item.prNumber]), [['acme/demo', 7]]);

  const page = await owner.changes(0, 100);
  const text = digest({ events: page.events, status });
  assert.match(text, /^- short · owner · claimed · lease /m);
  assert.match(text, /^- long \+ short · server\/x\.mjs$/m);
  assert.match(text, /^- acme\/demo#7 · checks /m);
  for (const line of text.split('\n').filter(entry => entry.startsWith('- seq '))) assert.match(line, /^- seq \d+ · /);
});

test('the room-coord CLI drives the same verbs and refuses malformed input before any write', async t => {
  const { owner, lander } = await fixture(t);
  const claimed = await run(['claim', 'cli-lane', '--files', 'docs/a.md,docs/b.md', '--lease-hours', '2', '--title', 'CLI lane'], { client: owner, memberId: 'owner' });
  assert.deepEqual([claimed.owner, claimed.files], ['owner', ['docs/a.md', 'docs/b.md']]);
  assert.match(await run(['status', '--md'], { client: owner, lander, memberId: 'owner' }), /^- cli-lane · owner · claimed/m);
  const released = await run(['release', 'cli-lane', '--note', 'paused'], { client: owner, memberId: 'owner' });
  assert.equal(released.state, 'unclaimed');
  await assert.rejects(run(['verify', 'cli-lane'], { client: owner, memberId: 'owner' }), coded('claim_not_verified'));
  await assert.rejects(run(['renew', 'cli-lane'], { client: owner, memberId: 'owner' }), coded('usage_error'));
  await assert.rejects(run(['land', '--repo', 'acme/demo', '--pr', 'seven'], { client: owner, lander, memberId: 'owner' }), coded('usage_error'));
  assert.deepEqual((await lander.landQueue()).items, [], 'refused input queued nothing');
  await assert.rejects(run(['teleport'], { client: owner, memberId: 'owner' }), coded('usage_error'));
  assert.throws(() => parseArgs(['claim', 'x', '--files']), coded('usage_error'));
  assert.deepEqual(parseArgs(['claim', 'x', '--note=a=b', '--allow-overlap']).options, { note: 'a=b', 'allow-overlap': true });
});
