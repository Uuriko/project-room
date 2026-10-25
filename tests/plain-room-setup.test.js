import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
import { AccessRequests } from '../server/access-requests.mjs';
import { createAgentIdentity } from '../client/room-agent.mjs';
import { ROOM_ORIGIN } from '../server/agent-discovery.mjs';

test('public entry points lead to the served setup skill before unrelated work', async t => {
  const store = new RoomStore(':memory:');
  store.initialize(initialRoom('muse-room'));
  const owner = store.issueAccessKey('muse-room', 'owner');
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const path of ['/llms.txt', '/llms-full.txt', '/SKILL.md', '/join.txt', '/AGENTS.md']) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 200, path);
    const text = await response.text();
    const start = text.indexOf('## Join the room your user named');
    assert.ok(start >= 0 && start < 900, path);
    assert.ok(text.includes(`${ROOM_ORIGIN}/#room/muse-room`));
    const skill = new URL(/\[the setup instructions\]\(([^)]+)\)/.exec(text)[1]);
    const setup = await fetch(origin + skill.pathname);
    assert.equal(setup.status, 200);
    assert.match(await setup.text(), /Join → Connect → Share → Test/);
    assert.match(text, /do not guess, enumerate private rooms, or substitute Muse/);
  }
  // Exercise the documented HTTP admission path without an invite code,
  // publishing a room, a browser account, or access to another machine.
  const identity = await createAgentIdentity(origin, 'Setup fixture');
  const headers = { Authorization: `Bearer ${identity.secret}`, 'Content-Type': 'application/json', Origin: origin };
  const data = { roomId: 'muse-room', identityId: identity.identityId, displayName: 'Setup fixture', requestedPermissions: [], requestId: 'plain-setup-fixture' };
  const request = () => fetch(origin + '/api/access-requests', { method: 'POST', headers, body: JSON.stringify(data) });
  const response = await request(); assert.equal(response.status, 201);
  const pending = await response.json(); assert.equal(pending.status, 'pending');
  const retry = await (await request()).json(); assert.equal(retry.requestId, pending.requestId);
  const pack = () => fetch(origin + '/api/rooms/muse-room/activation-pack?view=brief', { headers });
  assert.notEqual((await pack()).status, 200);
  new AccessRequests(store).decide(owner, 'muse-room', pending.requestId, { decision: 'approve', permissions: [] });
  assert.equal((await pack()).status, 200);
  // A newly joined peer can discover members, but enrollment is not a host.
  const presenceResponse = await fetch(origin + '/api/rooms/muse-room/presence', { headers });
  assert.equal(presenceResponse.status, 200);
  const presence = await presenceResponse.json();
  const self = presence.members.find(member => member.memberId === identity.identityId);
  assert.ok(self, 'the joined identity is discoverable without a directory card');
  assert.equal(self.watching, false);
  assert.ok(!['working', 'listening'].includes(self.state), 'membership alone does not advertise readiness');
  const capabilitiesResponse = await fetch(origin + '/api/rooms/muse-room/capabilities', { headers });
  assert.equal(capabilitiesResponse.status, 200);
  const capabilities = await capabilitiesResponse.json();
  assert.ok(!capabilities.members.some(member => member.memberId === identity.identityId && member.capabilities.length), 'joining grants no advertised capabilities');
  assert.equal((await fetch(origin + `/api/rooms/muse-room/members/${identity.identityId}/card`, { headers })).status, 404);
  assert.equal((await fetch(origin + '/api/rooms/muse-room/presence')).status, 401, 'roster discovery remains authenticated');
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM agent_identities').get().n, 1);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM access_requests').get().n, 1);
  assert.equal((await fetch(origin + '/r/muse-room')).status, 404);
});
