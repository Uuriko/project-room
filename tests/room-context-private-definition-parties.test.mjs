// Positive controls for the composed-context private-definition cure: the
// requester and recipient of the private brief, and the accountable role
// holder, still read the title through /context and orient; a non-private
// item stays visible to an unrelated observer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { buildOrient } from '../server/orient.mjs';

test('parties and role holders keep the private title; public work stays visible to observers', async t => {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const send = (type, data) => f.store.command(f.keys.owner, 'commons', { id: crypto.randomUUID(), type, data });
  send('member.added', { memberId: 'observer', displayName: 'Observer agent', kind: 'agent', permissions: [] });
  send('work.proposed', { workItemId: 'private-brief', title: 'PRIVATE-TITLE-SENTINEL',
    definitionOfDone: 'PRIVATE-DONE-SENTINEL', accountableMemberId: 'producer', independentVerificationRequired: false, ownerDecisionRequired: false });
  send('work.proposed', { workItemId: 'public-brief', title: 'PUBLIC-TITLE',
    definitionOfDone: 'PUBLIC-DONE', accountableMemberId: 'producer', independentVerificationRequired: false, ownerDecisionRequired: false });
  f.store.dmConsents.request('commons', 'owner', 'producer', 'Synthetic private brief');
  f.store.dmConsents.decide('commons', 'producer', 'owner', 'approve');
  send('message.posted', { messageId: 'private-question', toMemberId: 'producer', workItemId: 'private-brief',
    requestKind: 'reply', body: 'PRIVATE-BODY-SENTINEL' });
  const titles = viewer => f.store.readTransaction(() => JSON.stringify(buildOrient(f.store, 'commons', viewer, { text: false })));
  for (const party of ['owner', 'producer']) assert.ok(titles(party).includes('PRIVATE-TITLE-SENTINEL'), `${party} keeps the private title`);
  const observerView = titles('observer');
  assert.ok(!observerView.includes('PRIVATE-TITLE-SENTINEL'), 'observer does not');
  assert.ok(observerView.includes('PUBLIC-TITLE'), 'public work stays visible to the observer');
  // HTTP: the owner's composed context still carries the private title.
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/rooms/commons/context`, { headers: { Authorization: `Bearer ${f.keys.owner}` } });
  assert.equal(response.status, 200);
  assert.ok(JSON.stringify(await response.json()).includes('PRIVATE-TITLE-SENTINEL'));
});
