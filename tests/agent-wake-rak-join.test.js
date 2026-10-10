// A2/A3: an agent that joined with a rak_ onboarding token (no pri_ identity
// secret on the host) must be able to run the REST wake path. Two gates were
// stacked against it: client/agent-wake.mjs refused any non-pri_ token with
// invalid_config, and the onboarding token's scopes lacked
// heartbeats:report/heartbeats:read, so /api/agent-heartbeats and
// /api/agent-wakes/poll answered 403 insufficient_scope. This pins both
// halves: the client accepts the rak_ shape and the scoped key passes the
// heartbeat scope check end to end.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { AgentRooms } from '../server/agent-rooms.mjs';
import { createRoomServer } from '../server/http.mjs';
import { AgentWakeClient } from '../client/agent-wake.mjs';

test('a rak_ onboarding join token drives doctor/setup/wait over REST', async t => {
  const store = new RoomStore(':memory:');
  const identity = store.identities.create('Wake owner');
  new AgentRooms(store).create(identity.secret, { roomId: 'wake-room', title: 'Wake', purpose: 'Synthetic rak_ wake testing' });
  const alias = store.identities.create('Joined agent');
  store.identities.link(identity.secret, 'wake-room', { identityId: alias.identityId, memberId: 'joined-agent', displayName: 'Joined', permissions: [] });
  // The credential a joined agent actually holds: the onboarding MCP token.
  const issued = store.agentPlugin.issueOnboardingMcpToken({ identityId: alias.identityId, roomId: 'wake-room', label: 'MCP client' });
  assert.ok(issued.credential.startsWith('rak_'));
  assert.ok(issued.scopes.includes('heartbeats:report') && issued.scopes.includes('heartbeats:read'));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const connection = { origin: 'http://127.0.0.1:' + server.address().port, roomId: 'wake-room', memberId: 'joined-agent', token: issued.credential };
  // A2: the client gate accepts the rak_ shape (was: invalid_config).
  const client = new AgentWakeClient({ connection });
  // A3: the scoped key passes the heartbeat scope check (was: 403).
  assert.equal((await client.doctor({ hostId: 'laptop' })).registration, 'not_registered');
  const registered = await client.setup({ hostId: 'laptop', cadenceSeconds: 300 });
  assert.equal(registered.status, 'registered_not_listening');
  const waited = await client.wait({ hostId: 'laptop', cadenceSeconds: 300, waitMs: 0 });
  assert.equal(waited.status, 'wait_completed');
});
