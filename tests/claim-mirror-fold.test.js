import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { EVENT_TYPES as T } from '../src/events.js';
import { boardClaimId } from '../server/work-claim-mirror.mjs';
import { makeTestSigner } from '../scripts/helpers/signed-evidence.mjs';
import { setTier } from '../server/autonomy-tiers.mjs';

const command = (type, data) => ({ id: crypto.randomUUID(), type, data });
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'room-scopes-'));
  const filename = join(directory, 'room.sqlite');
  let now = Date.now();
  const store = new RoomStore(filename, { now: () => now });
  store.initialize(initialRoom());
  const keys = { owner: store.issueAccessKey('commons', 'owner') };
  for (const id of ['a', 'b', 'viewer']) {
    store.command(keys.owner, 'commons', command(T.MEMBER_ADDED, { memberId: id, displayName: id, kind: 'agent', accountableHumanId: 'owner',
      permissions: id === 'viewer' ? [] : ['accept_work', 'complete_work', 'write_external'] }));
    keys[id] = store.issueAccessKey('commons', id);
  }
  // #953: new agent members default to t1_readonly; a and b need write access
  for (const id of ['a', 'b'])
    setTier(store.db, 'commons', id, 't2_standard', { updatedBy: 'owner', nowMs: Date.now() });
  const item = id => store.room('commons').state.workItems[id];
  const mutate = (actor, type, id, data = {}) => store.command(keys[actor], 'commons', command(type, { workItemId: id, expectedRevision: item(id).revision, ...data }));
  const propose = (id, actor = 'a', mode = 'write') => {
    store.command(keys.owner, 'commons', command(T.WORK_PROPOSED, { workItemId: id, title: id, definitionOfDone: 'Versioned result', accountableMemberId: actor, mode, independentVerificationRequired: false, ownerDecisionRequired: false }));
    mutate(actor, T.WORK_ACCEPTED, id);
  };
  const scope = (paths = ['src/**']) => ({ repository: 'test/repo', ref: 'draft', paths, expiresAt: new Date(now + 60000).toISOString() });
  const signEvidence = makeTestSigner(store);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, filename, keys, item, mutate, propose, scope, signEvidence, advance: ms => { now += ms; } };
}


test('C10: a folded projection id cannot release another member\'s board card', t => {
  const f = fixture(t);
  f.propose('lane_a', 'a');
  f.mutate('a', T.CLAIM_ACQUIRED, 'lane_a', f.scope(['server/http.mjs']));
  assert.equal(f.store.workClaims.get('commons', 'lane_a').owner, 'a');
  f.propose('lane.a', 'b');
  assert.equal(boardClaimId('lane.a'), 'lane_a');
  f.mutate('b', T.CLAIM_ACQUIRED, 'lane.a', f.scope(['docs/b.md']));
  f.mutate('b', T.CLAIM_RELEASED, 'lane.a');
  const card = f.store.workClaims.get('commons', 'lane_a');
  assert.equal(card.state, 'claimed');
  assert.equal(card.owner, 'a');
});

test('C10: a projection release by the holder still frees its own board card', t => {
  const f = fixture(t);
  f.propose('lane.b', 'a');
  f.mutate('a', T.CLAIM_ACQUIRED, 'lane.b', f.scope(['docs/a.md']));
  assert.equal(f.store.workClaims.get('commons', 'lane_b').owner, 'a');
  f.mutate('a', T.CLAIM_RELEASED, 'lane.b');
  assert.equal(f.store.workClaims.get('commons', 'lane_b').state, 'unclaimed');
});
