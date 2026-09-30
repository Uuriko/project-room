// Owner refresh must reflect public consent without publishing private settings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';

test('owner refresh retains declared public scope after reopening and public terms omit private controls', t => {
  const directory = mkdtempSync(join(tmpdir(), 'public-owner-')), file = join(directory, 'room.sqlite');
  let store = new RoomStore(file);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom());
  const terms = { kind: 'task', title: 'Small contribution', summary: 'Implement a scoped improvement', acceptanceCriteria: ['Return a checkable artifact'], repositoryUrl: 'https://github.com/Example/Project', reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'human' } };
  store.projectOffers.create('commons', 'owner', { requestId: 'owner-create', offerId: 'owner:task', terms, reviewerMemberIds: ['owner'] });
  assert.equal(store.projectOffers.ownerList('commons', 'owner').offers[0].publicClaims, null);
  store.projectOffers.transition('commons', 'owner', 'owner:task', 'publish', { requestId: 'owner-publish', expectedRevision: 1 });
  const input = { requestId: 'owner-enable', expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: ['src/contribution.js'] };
  store.publicWorkClaims.enable('commons', 'owner', 'owner:task', input);
  store.close(); store = new RoomStore(file);
  assert.deepEqual(store.projectOffers.ownerList('commons', 'owner').offers[0].publicClaims, { enabled: true, repositoryRef: 'main', files: ['src/contribution.js'] });
  assert.throws(() => store.projectOffers.ownerList('commons', 'not-owner'), error => error.code === 'owner_only');
  const publicTerms = store.projectOffers.read('owner:task');
  for (const privateKey of ['publicClaims', 'roomId', 'reviewerMemberIds']) assert.equal(Object.hasOwn(publicTerms, privateKey), false);
  assert.equal(store.publicWorkClaims.read('owner:task').repositoryRef, 'main');
});
