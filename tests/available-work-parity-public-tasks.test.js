// Shadow-compare parity harness — redesign charter B-2, PR2 (public arm).
//
// The public board's claimable read moved from PublicWorkClaims.list's
// own claimable filter to the AvailableWork projection
// (listClaimable → availablePublicTasks). This harness runs BOTH reads
// over the same production-shaped store and requires identical pages:
// same packets, same claimableCount, same nextCursor, for every
// (limit, after) combination in the matrix — including cursors that
// name claimed/submitted tasks and cursors beyond the claimable set.
//
// Remove after one clean release on the B-2 stack (the standing
// regression coverage is tests/public-work-claimable.test.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { PublicWorkClaims, publicWorkClaimsSchema } from '../server/public-work-claims.mjs';
import { publicWorkClaimFenceSchema } from '../server/public-work-claim-fence.mjs';

const claim = (requestId, extra = {}) => ({ requestId, expectedTermsVersion: 1, ...extra });
const owned = (requestId, generation, extra = {}) => ({ ...claim(requestId), generation, ...extra });

// Mixed states in offer_id order: a submitted, b open, c claimed,
// d open, e open. Claimable order is [b, d, e]; the browse order is
// claimable-first [b, d, e, a, c].
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aw-parity-tasks-')), file = join(dir, 'room.sqlite');
  const store = new RoomStore(file, { now: () => Date.now() });
  store.initialize(initialRoom());
  store.db.exec(publicWorkClaimsSchema); store.db.exec(publicWorkClaimFenceSchema);
  const service = new PublicWorkClaims(store);
  const [w1, w2] = [store.identities.create('Parity worker one'), store.identities.create('Parity worker two')];
  const enable = id => {
    store.projectOffers.create('commons', 'owner', { requestId: `create-${id}`, offerId: id, reviewerMemberIds: ['owner'],
      terms: { kind: 'task', title: id, summary: 'Public result', acceptanceCriteria: ['Deliver the declared change'],
        repositoryUrl: 'https://github.com/Example/Project', reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'human' } } });
    store.projectOffers.transition('commons', 'owner', id, 'publish', { requestId: `publish-${id}`, expectedRevision: 1 });
    return service.enable('commons', 'owner', id, { requestId: `enable-${id}`, expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: [`src/${id}.js`] });
  };
  for (const id of ['a-submitted', 'b-open', 'c-claimed', 'd-open', 'e-open']) enable(id);
  service.act('a-submitted', w1.secret, 'claim', claim('claim-a'));
  service.act('a-submitted', w1.secret, 'finish', owned('finish-a', 1, { artifactText: 'Done a', checksReported: [] }));
  service.act('c-claimed', w2.secret, 'claim', claim('claim-c'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, service };
}

test('listClaimable (projection) ≡ list({claimable:true}) (facade) over the page matrix', t => {
  const { service } = fixture(t);
  // Sanity: the fixture really is the mixed board this harness claims.
  assert.equal(service.list({}).claimableCount, 3);
  const afters = ['', 'a-submitted', 'b-open', 'c-claimed', 'd-open', 'e-open', '0-before-all', 'zz-after-all'];
  for (const limit of [1, 2, 3, 5, 20, 100]) {
    for (const after of afters) {
      const viaProjection = service.listClaimable({ limit, after });
      const viaFacade = service.list({ limit, after, claimable: true });
      assert.deepEqual(viaProjection, viaFacade, `limit=${limit} after=${JSON.stringify(after)}`);
    }
  }
});

test('listClaimable walks the whole claimable set exactly once, in order', t => {
  const { service } = fixture(t);
  for (const limit of [1, 2, 3]) {
    const seen = [];
    let after = '';
    for (let guard = 0; guard < 10; guard++) {
      const page = service.listClaimable({ limit, after });
      seen.push(...page.tasks.map(task => task.taskId));
      assert.equal(page.claimableCount, 3, `limit=${limit}: count is the full set on every page`);
      if (page.nextCursor === null) break;
      assert.equal(page.nextCursor, page.tasks.at(-1).taskId);
      after = page.nextCursor;
    }
    assert.deepEqual(seen, ['b-open', 'd-open', 'e-open'], `limit=${limit} walk`);
  }
});

test('listClaimable keeps the facade page validation and empty-board shape', t => {
  const { service } = fixture(t);
  for (const bad of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { after: 'bad id!' }]) {
    assert.throws(() => service.listClaimable(bad), error => error?.code === 'invalid_public_work', JSON.stringify(bad));
    assert.throws(() => service.list({ ...bad, claimable: true }), error => error?.code === 'invalid_public_work', JSON.stringify(bad));
  }
});
