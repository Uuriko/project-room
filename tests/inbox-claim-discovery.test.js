import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { callHostedStdioTool } from '../server/mcp-full-profile.mjs';
import { resolveNamedReviewers, hasCurrentReview } from '../server/work-claims.mjs';

const claim = (id, extra = {}) => ({ id, state: 'in_progress', owner: 'other', tags: ['rev-owner'], reviews: [], claimedAt: null, ...extra });
const setup = t => {
  const store = new RoomStore(':memory:'); store.initialize(initialRoom());
  t.after(() => store.close());
  const secret = store.issueAccessKey('commons', 'owner');
  return { store, read: async () => (await callHostedStdioTool(store, secret, 'room_read_inbox', { roomId: 'commons', limit: 1 })).value };
};

test('inbox preserves exact discovery across batches without hydrating Board histories', async t => {
  const { store, read } = setup(t);
  for (let i = 0; i < 270; i++) store.workClaims.set('commons', claim(`unrelated-${i}`, { tags: ['rev-nobody'], history: [{ note: 'x'.repeat(10000) }] }));
  for (let i = 0; i < 52; i++) {
    store.workClaims.set('commons', claim(`owned-${i}`, { owner: 'owner' }));
    store.workClaims.set('commons', claim(`review-${i}`));
  }
  store.workClaims.set('private-room', claim('private-owned', { owner: 'owner' }));
  store.workClaims.set('private-room', claim('private-review'));
  const original = store.workClaims.list('commons');
  const members = store.roomAuthority('commons').members;
  const expected = original.filter(item => item.owner && item.owner !== 'owner'
    && !['done', 'closed'].includes(item.state) && !item.supersededBy
    && (item.state === 'in_progress' || item.pullRequest || item.pullRequests?.length)
    && resolveNamedReviewers(item, members).includes('owner') && !hasCurrentReview(item, 'owner'));
  store.workClaims.list = () => { throw Error('full Board hydration forbidden'); };
  const inbox = await read();
  assert.equal(inbox.boardAssignments.length, 50);
  assert.equal(inbox.boardAssignmentsHasMore, true);
  assert.equal(inbox.boardReviewRequestsHasMore, true);
  assert.deepEqual(inbox.boardReviewRequests.map(x => x.claimId), expected.slice(0, 50).map(x => x.id));
  assert.ok(!JSON.stringify(inbox).includes('private-'));
  store.workClaims.set('commons', claim('owned-0', { owner: 'other', tags: [] }));
  store.workClaims.set('commons', claim('review-0', { state: 'done' }));
  const changed = await read();
  assert.equal(changed.boardAssignments[0].claimId, 'owned-1');
  assert.equal(changed.boardReviewRequests[0].claimId, 'review-1');
});

test('legacy/enveloped rows preserve reviewer aliases, delivery basis and supersession', async t => {
  const { store, read } = setup(t);
  const members = store.roomAuthority('commons').members;
  const alias = members.owner.displayName.toLowerCase().replace(/[^a-z0-9]/g, '');
  const basis = { version: 1, owner: 'other', claimedAt: null, revision: null, headSha: null, deliveryDigest: 'first', deliveryGeneration: 1 };
  const items = [
    claim('legacy-alias', { v: true, tags: [`rev-${alias}`] }),
    claim('current', { delivery: { digest: 'first' }, reviews: [{ memberId: 'owner', basis }] }),
    claim('new-delivery', { delivery: { digest: 'second' }, reviews: [{ memberId: 'owner', basis }] }),
    claim('new-generation', { deliveryGeneration: 2, reviews: [{ memberId: 'owner', basis: { ...basis, deliveryDigest: null, deliveryGeneration: 0 } }] }),
    claim('superseded', { supersededBy: 'replacement' }),
    claim('closed', { state: 'closed' }),
    claim('no-tags', { tags: [] }),
    { id: 'legacy-missing-state', owner: 'other', tags: ['rev-owner'], pullRequest: 'https://example.test/pr' },
  ];
  const insert = store.db.prepare('INSERT INTO work_claims VALUES(?,?,?,?)');
  items.forEach((item, i) => insert.run('commons', item.id, JSON.stringify(i % 2 ? { v: 1, kind: 'work-claim', data: item } : item), 0));
  const inbox = await read();
  assert.deepEqual(inbox.boardReviewRequests.map(x => x.claimId), ['legacy-alias', 'new-delivery', 'new-generation', 'legacy-missing-state']);
  assert.equal(inbox.boardReviewRequests.at(-1).state, 'unclaimed');
  assert.equal(inbox.boardReviewRequestsHasMore, false);
  const projected = [...store.workClaims.inboxCandidates('commons', 'owner', { review: true })];
  assert.ok(projected.every(item => !('history' in item) && !('files' in item) && !('blobs' in item)));
});

test('index migration converges on warm startup and discovery survives restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-index-'));
  const filename = join(dir, 'room.sqlite');
  try {
    const first = new RoomStore(filename); first.initialize(initialRoom());
    first.workClaims.set('commons', claim('retained', { owner: 'owner' }));
    first.db.exec('DROP INDEX work_claim_inbox_owner; DROP INDEX work_claim_inbox_review');
    first.db.prepare('UPDATE room_schema_stamp SET stamp=? WHERE singleton=1').run('pre-inbox-index');
    first.close();
    const second = new RoomStore(filename, { integrity: 'deferred' });
    try {
      assert.equal(second.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND name LIKE 'work_claim_inbox_%'").get().n, 2);
      assert.deepEqual([...second.workClaims.inboxCandidates('commons', 'owner')].map(x => x.id), ['retained']);
    } finally { second.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('index DDL fails atomically on corrupt data and rejects conflicting definitions', async t => {
  const { store } = setup(t);
  store.db.exec('DROP INDEX work_claim_inbox_owner; DROP INDEX work_claim_inbox_review');
  store.db.prepare('INSERT INTO work_claims VALUES(?,?,?,?)').run('commons', 'corrupt', '{', 0);
  const { workClaimInboxIndexSchema } = await import('../server/work-claim-sqlite.mjs');
  store.db.exec('BEGIN');
  assert.throws(() => store.db.exec(workClaimInboxIndexSchema), /malformed JSON/);
  store.db.exec('ROLLBACK');
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'work_claim_inbox_%'").get().n, 0);
  assert.equal(store.db.prepare('SELECT item_json FROM work_claims WHERE claim_id=?').get('corrupt').item_json, '{');
  store.db.exec('CREATE INDEX work_claim_inbox_owner ON work_claims(updated_at)');
  assert.throws(() => store.workClaims.verifySchema(), /inbox index requires operator reconciliation/);
});
