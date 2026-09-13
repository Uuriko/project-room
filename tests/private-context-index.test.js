import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rmSync} from 'node:fs';
import {createAcceptanceFixture} from '../scripts/acceptance-fixture.mjs';
import {createRoomServer} from '../server/http.mjs';
import {privateContextIndexes} from '../server/inbox.mjs';

test('grant discovery uses additive expression indexes and still hides bodies', async t => {
  const f = createAcceptanceFixture(), account = f.store.accountForMember('commons', 'owner'), slot = f.store.createAccountSessionSlot();
  const auth = f.store.loginAccountSession(slot.token, f.store.issueAccountAccessKey(account.id), 0);
  const apply = r => f.store.inbox.apply(slot.token, r, auth.sessionBinding);
  apply({action: 'source.save', requestId: 'source', sourceId: 'source', expectedRevision: 0,
    data: {adapter: 'synthetic', sender: 'PRIVATE SENDER', recipient: 'owner', subject: 'PRIVATE SUBJECT', paragraphs: ['PRIVATE BODY']}});
  const share = memberId => apply({action: 'source.grant', requestId: randomUUID(), sourceId: 'source', sourceRevision: 1, roomId: 'commons', paragraphs: [0], memberIds: [memberId],
    audienceVersion: f.store.inbox.shareContext(slot.token, 'source', 'commons', auth.sessionBinding).audienceVersion}).receipt.grantId;
  const ids = Array.from({length: 28}, () => share('producer'));
  t.after(() => { f.store.close(); rmSync(f.directory, {recursive: true, force: true}); });
  const names = f.store.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='private_inbox_commands'").all().map(r => r.name);
  assert.ok(names.includes('private_inbox_grant_list'));
  assert.ok(names.includes('private_inbox_grant_revoke'));
  assert.equal(privateContextIndexes.length, 2);
  const revokePlan = f.store.db.prepare(`EXPLAIN QUERY PLAN SELECT 1 FROM private_inbox_commands revoked
    WHERE revoked.account_id=? AND json_extract(revoked.request_json,'$.action')='grant.revoke'
      AND json_extract(revoked.request_json,'$.grantId')=?`).all(account.id, ids[0]);
  assert.ok(revokePlan.some(row => /INDEX private_inbox_grant_revoke/i.test(row.detail)), JSON.stringify(revokePlan));
  const server = createRoomServer({store: f.store});
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const page = await (await fetch(`http://127.0.0.1:${server.address().port}/api/rooms/commons/private-context`, {
    headers: {Authorization: 'Bearer ' + f.keys.producer}
  })).json();
  assert.equal(page.shares.length, 25);
  assert.equal(page.next, ids[3]);
  assert.ok(!JSON.stringify(page).includes('PRIVATE'));
  for (const g of page.shares) assert.deepEqual(Object.keys(g).sort(), ['expiresAt', 'grantId', 'permissions']);
});
