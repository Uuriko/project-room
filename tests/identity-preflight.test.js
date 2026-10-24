import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { RoomAgentClient } from '../client/room-agent.mjs';

test('identity preflight omits history and rechecks revocation on the next read', async t => {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const identity = f.store.identities.create('Preflight');
  f.store.identities.link(f.keys.owner, 'commons', { identityId: identity.identityId, displayName: 'Preflight', permissions: [] });
  const memberId = f.store.authenticate(identity.secret, 'commons').member.id;
  for (let i = 0; i < 10; i++) f.store.command(f.keys.owner, 'commons', {
    id: `preflight-${i}`, type: 'message.posted', data: { messageId: `preflight-${i}`, body: 'HISTORY_ONLY ' + 'x'.repeat(500) }
  });
  const captures = [];
  const config = { origin, roomId: 'commons', memberId, token: identity.secret, fetchImpl: async (url, options) => {
    const response = await fetch(url, options);
    captures.push({ url, text: await response.clone().text() }); return response;
  } };
  const fullText = await (await fetch(origin + '/api/rooms/commons', { headers: { Authorization: `Bearer ${identity.secret}` } })).text();
  const full = JSON.parse(fullText), before = f.store.room('commons').sequence;
  const client = new RoomAgentClient(config);
  assert.equal((await client.checkConnection()).memberId, memberId);
  assert.equal(captures.length, 1);
  assert.equal(captures[0].url, origin + '/api/rooms/commons?view=work');
  const work = JSON.parse(captures[0].text);
  assert.deepEqual(work.state.members[memberId], full.state.members[memberId]);
  assert.equal(work.state.room.ownerId, full.state.room.ownerId);
  assert.equal(work.viewerId, full.viewerId);
  assert.equal(captures[0].text.includes('HISTORY_ONLY'), false);
  assert.ok(Buffer.byteLength(captures[0].text) < Buffer.byteLength(fullText));
  assert.equal(f.store.room('commons').sequence, before);
  await assert.rejects(new RoomAgentClient({ ...config, memberId: 'wrong-agent' }).checkConnection(), { code: 'identity_mismatch' });
  f.store.identities.revoke(identity.identityId, identity.secret);
  await assert.rejects(client.checkConnection(), error => error.status === 401);
});

test('work-view identity checks retain owner/delegate and mismatch validation for both credential prefixes', async () => {
  const memberId = 'agent-one';
  const base = () => ({ roomId: 'commons', viewerId: memberId, state: {
    room: { ownerId: 'owner' }, members: { [memberId]: { id: memberId, kind: 'agent', active: true, revision: 1, permissions: [] } }
  } });
  for (const prefix of ['pri_', 'rak_']) {
    for (const mutate of [
      s => { s.viewerId = 'other'; }, s => { s.roomId = 'other'; },
      s => { s.state.members[memberId].active = false; }, s => { s.state.members[memberId].kind = 'human'; },
      s => { s.state.members[memberId].permissions = ['manage_members']; }
    ]) {
      const value = base(); mutate(value);
      const client = new RoomAgentClient({ origin: 'https://room.example', roomId: 'commons', memberId,
        token: prefix + 'x'.repeat(43), fetchImpl: async () => Response.json(value) });
      await assert.rejects(client.checkConnection(), { code: 'identity_mismatch' });
    }
    for (const mode of ['owner', 'delegate']) {
      const value = base(); value.state.members[memberId].permissions = ['manage_members'];
      if (mode === 'owner') value.state.room.ownerId = memberId;
      else value.state.members[memberId].delegatedAdmin = true;
      const client = new RoomAgentClient({ origin: 'https://room.example', roomId: 'commons', memberId,
        token: prefix + 'x'.repeat(43), fetchImpl: async () => Response.json(value) });
      assert.equal((await client.checkConnection()).memberId, memberId);
    }
  }
});
