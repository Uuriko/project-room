// #3924 (B3 / L3 repro, inverted): the public-work write bucket used to
// be per-egress-IP and charged on entry, so one identity's refused
// attempts (404s, and its own 429s re-charging) starved every other
// identity behind the same egress IP. The write door now runs the
// per-identity ceiling (#3271) as the primary budget — charged on
// attempts — and charges the per-IP bucket only on ADMISSION, with
// both refusals peeked (a 429 charges neither bucket). These tests
// drive the L3 shape over real HTTP from ONE fixed egress address,
// plus the admissions backstop: 60 admitted writes from one IP still
// shed the 61st, whoever's identity presents it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';

const EGRESS = '203.0.113.7';

async function fixture(t, taskCount = 1) {
  const store = new RoomStore(':memory:'); store.initialize(initialRoom());
  for (let i = 0; i < taskCount; i++) {
    const offerId = `rate3924:task-${i}`;
    store.projectOffers.create('commons', 'owner', { requestId: `c-${i}`, offerId, reviewerMemberIds: ['owner'], terms: { kind: 'task', title: 'JavaScript volunteer task', summary: 'Synthetic public work', acceptanceCriteria: ['Return exact bytes'], repositoryUrl: 'https://github.com/example/project', reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'human' } } });
    store.projectOffers.transition('commons', 'owner', offerId, 'publish', { requestId: `p-${i}`, expectedRevision: 1 });
    store.publicWorkClaims.enable('commons', 'owner', offerId, { requestId: `e-${i}`, expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: [`result-${i}.js`] });
  }
  const identities = ['one', 'two', 'three', 'four'].map(name => store.identities.create(`Synthetic 3924 ${name}`));
  // One fixed egress address for every request unless a test overrides
  // it — the production shape for a fleet behind NAT/cloud egress.
  const server = createRoomServer({ store, resolveClientAddress: req => req.headers['x-test-address'] || EGRESS });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const claim = async (taskId, secret, requestId, address) => {
    const response = await fetch(`${origin}/api/public-work/tasks/${encodeURIComponent(taskId)}/claim`, {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...(address ? { 'X-Test-Address': address } : {}), Authorization: 'Bearer ' + secret },
      body: JSON.stringify({ requestId, expectedTermsVersion: 1 }),
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  return { store, identities, claim };
}

test("a peer's refused attempts never starve a well-behaved identity behind the same egress IP (L3 inverted)", async t => {
  const f = await fixture(t);
  const [storm, peer] = f.identities;
  // The storm: 130 refused attempts (missing task) from the shared IP —
  // more than two full write buckets' worth. The first 60 are domain
  // refusals (404, charged to the storm identity only); the rest are
  // the identity ceiling's own 429s, which must charge nothing further.
  for (let i = 0; i < 130; i++) {
    const reply = await f.claim('missing-task', storm.secret, `storm-${i}`);
    if (i < 60) {
      assert.equal(reply.status, 404, `attempt ${i + 1}: ${JSON.stringify(reply.body)}`);
      assert.equal(reply.body.error.code, 'public_work_not_found');
    } else {
      assert.equal(reply.status, 429, `attempt ${i + 1}`);
      assert.equal(reply.headers.get('x-ratelimit-bucket'), 'public-work-identity');
    }
  }
  // The peer, same egress IP, first-ever requests: a domain refusal is
  // a 404 (not a rate refusal), and real work is admitted.
  const peerRefused = await f.claim('missing-task', peer.secret, 'peer-refused');
  assert.equal(peerRefused.status, 404);
  const peerClaim = await f.claim('rate3924:task-0', peer.secret, 'peer-claim');
  assert.equal(peerClaim.status, 200, JSON.stringify(peerClaim.body));
  assert.equal(peerClaim.body.action, 'claimed');
});

test('the per-IP admissions backstop still sheds: 60 admitted writes from one IP refuse the 61st, identity untouched', async t => {
  const f = await fixture(t, 61);
  const [a, b, c, d] = f.identities;
  // 60 admitted writes from the shared egress, spread across three
  // identities so no per-identity ceiling is what binds. Each claim is
  // released in-process immediately (a door-less act, uncounted per
  // #3271) so the 3-live-claims ceiling (#3707) stays out of the way.
  const rotation = [a, b, c];
  for (let i = 0; i < 60; i++) {
    const who = rotation[i % 3];
    const reply = await f.claim(`rate3924:task-${i}`, who.secret, `admit-${i}`);
    assert.equal(reply.status, 200, `admission ${i + 1}: ${JSON.stringify(reply.body)}`);
    f.store.publicWorkClaims.act(`rate3924:task-${i}`, who.secret, 'release',
      { requestId: `admit-release-${i}`, expectedTermsVersion: 1, generation: reply.body.task.claim.generation });
  }
  // A fourth identity with a full budget of its own is refused by the
  // IP admissions bucket — the shed still protects the server.
  const shed = await f.claim('rate3924:task-60', d.secret, 'admit-over');
  assert.equal(shed.status, 429);
  assert.equal(shed.body.error.code, 'rate_limited');
  assert.equal(shed.headers.get('x-ratelimit-bucket'), 'public-work-write');
  // The refusal charged neither bucket: the same identity from another
  // egress is admitted immediately (its identity budget was untouched,
  // and the limit is the egress, not the identity).
  const elsewhere = await f.claim('rate3924:task-60', d.secret, 'admit-elsewhere', '198.51.100.9');
  assert.equal(elsewhere.status, 200, JSON.stringify(elsewhere.body));
  assert.equal(elsewhere.body.action, 'claimed');
});
