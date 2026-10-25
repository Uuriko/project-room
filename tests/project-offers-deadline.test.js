import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';

// DOOR-CURE-4 (stranger-door row 7): a published offer whose deadline has
// passed is not open work. The public shelf (list), the single-offer read
// and the brief must stop serving it as published, with the same boundary
// the claim path already enforces (#3707: deadline <= now has passed).
// The stored status is untouched — this is a read-path rule, and the
// owner's private view still shows the offer so it can be managed.
const input = (id, deadline) => ({ requestId: `create-${id}`, offerId: id, reviewerMemberIds: ['owner'],
  terms: { repositoryUrl: 'https://github.com/Uuriko/project-room', kind: 'task', title: 'Useful work',
    summary: 'Produce a reviewable result', acceptanceCriteria: ['One concrete accepted result'],
    reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'human' }, ...(deadline ? { deadline } : {}) } });

function fixture(t, now) {
  const dir = mkdtempSync(join(tmpdir(), 'project-offer-deadline-')); const file = join(dir, 'room.sqlite');
  const store = new RoomStore(file, { now });
  store.initialize(initialRoom());
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return store;
}
const publish = (store, id, deadline) => {
  store.projectOffers.create('commons', 'owner', input(id, deadline));
  store.projectOffers.transition('commons', 'owner', id, 'publish', { requestId: `publish-${id}`, expectedRevision: 1 });
};

test('past-deadline and at-deadline offers are not served publicly; in-date and deadline-free offers are', t => {
  const nowMs = Date.parse('2026-10-25T00:00:00.000Z');
  const store = fixture(t, () => nowMs);
  publish(store, 'expired-offer', '2026-10-23T09:20:38.156Z');
  publish(store, 'boundary-offer', '2026-10-25T00:00:00.000Z');
  publish(store, 'open-offer', '2026-11-01T00:00:00.000Z');
  publish(store, 'open-no-deadline', null);

  // The shelf serves only the two still-open offers, in offer_id order.
  assert.deepEqual(store.projectOffers.list().offers.map(offer => offer.id), ['open-no-deadline', 'open-offer']);
  // Expired rows sort before the open ones, so they would consume page
  // slots under a post-fetch filter; pagination must step over them.
  const first = store.projectOffers.list({ limit: 1 });
  assert.deepEqual(first.offers.map(offer => offer.id), ['open-no-deadline']);
  assert.equal(first.nextCursor, 'open-no-deadline');
  const second = store.projectOffers.list({ limit: 1, after: first.nextCursor });
  assert.deepEqual(second.offers.map(offer => offer.id), ['open-offer']);
  assert.equal(second.nextCursor, null);

  // Single read and brief follow the same rule.
  for (const id of ['expired-offer', 'boundary-offer']) {
    assert.throws(() => store.projectOffers.read(id), error => error.code === 'offer_not_found');
    assert.throws(() => store.projectOffers.brief(id), error => error.code === 'offer_not_found');
  }
  assert.equal(store.projectOffers.read('open-offer').id, 'open-offer');
  assert.ok(store.projectOffers.brief('open-no-deadline').includes('Useful work'));

  // Read-path rule only: stored rows stay published, and the owner's
  // private view still lists all four so expired offers can be managed.
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM project_offers WHERE status='published'").get().n, 4);
  assert.equal(store.projectOffers.ownerList('commons', 'owner').offers.length, 4);
});

test('an in-date offer leaves the public shelf when the clock passes its deadline', t => {
  let nowMs = Date.parse('2026-10-20T00:00:00.000Z');
  const store = fixture(t, () => nowMs);
  publish(store, 'soon-lapsed', '2026-10-23T00:00:00.000Z');
  assert.deepEqual(store.projectOffers.list().offers.map(offer => offer.id), ['soon-lapsed']);
  nowMs = Date.parse('2026-10-24T00:00:00.000Z');
  assert.deepEqual(store.projectOffers.list(), { offers: [], nextCursor: null });
  assert.throws(() => store.projectOffers.read('soon-lapsed'), error => error.code === 'offer_not_found');
});
