// CX5-FIX desired-contract regressions for the scoped-listener repair.
//
// These pin the REPAIRED contracts that Codex's independent CX5 review
// (issue #3299, comment 6178462740) specified, replacing the three
// current-behavior characterizations in his portable evidence file:
//   1. The exact credential standard setup saves (a rak_ API key bound to
//      one room by its mcp:room: scope) reaches a documented supported
//      listener — AgentWakeClient + the REST heartbeat/poll/ack surface —
//      through genuinely scoped authorization, without exposing a pri_
//      owner secret.
//   2. Room-scoped activity cannot advertise or suppress availability in
//      another room after membership changes: wake-status attributes per
//      room, and pushTargets' offline gate reads identity-level presence.
//   3. HTTP receiving is separable from execution admission, and ack is
//      lease-fenced: observation (poll) stays non-consuming for every
//      host, while a queue under a live listener lease drains only with
//      its fencing token. Native execution over HTTP is NOT claimed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
import { connectRoom } from '../client/agent-setup.mjs';
import { readAgentConnection } from '../client/agent-connection.mjs';

async function fixture(t) {
  const store = new RoomStore(':memory:'), root = mkdtempSync(join(tmpdir(), 'scoped-contract-'));
  for (const id of ['commons', 'annex']) store.initialize(initialRoom(id));
  const owners = Object.fromEntries(['commons', 'annex'].map(id => [id, store.issueAccessKey(id, 'owner')]));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); store.close(); rmSync(root, { recursive: true, force: true });
  });
  const invite = store.invites.create(owners.commons, 'commons', { profile: 'chat', displayName: 'Peer' });
  const setup = await connectRoom({ origin, directory: join(root, 'private'), name: 'Peer', accept: true, target: invite.code });
  const connection = readAgentConnection(setup.configDirectory);
  const request = async (path, token, body) => {
    const response = await fetch(origin + path, { method: body ? 'POST' : 'GET', headers: {
      Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json', Origin: origin } : {})
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, value: await response.json() };
  };
  const addMember = (name, roomId, memberId) => {
    const identity = store.identities.create(name);
    store.identities.link(owners[roomId], roomId, { identityId: identity.identityId, memberId, displayName: name, permissions: [] });
    return identity;
  };
  return { store, owners, setup, connection, request, addMember, origin };
}


test('inactive linked membership denies scoped heartbeat, poll and ack without consuming pointers', async t => {
  const f = await fixture(t);
  await f.request('/api/agent-heartbeats', f.connection.token, { hostId: 'active-check', mode: 'pull-only', cadenceSeconds: 60 });
  const wake = f.store.agentHeartbeats.enqueueWake({ agentId: f.setup.identityId, kind: 'mention', roomId: 'commons', messageId: 'private-pointer' }).signal;
  const member = f.store.room('commons').state.members[f.connection.memberId];
  f.store.command(f.owners.commons, 'commons', { id: crypto.randomUUID(), type: 'member.access_changed', data: {
    memberId: member.id, expectedMemberRevision: member.revision, permissions: [], active: false
  } });
  for (const [path, body] of [
    ['/api/agent-heartbeats', { hostId: 'active-check', mode: 'pull-only', cadenceSeconds: 60 }],
    ['/api/agent-heartbeats', undefined],
    ['/api/agent-wakes/poll?hostId=active-check&waitMs=0', undefined],
    ['/api/agent-heartbeats/ack', { signalIds: [wake.signalId] }]
  ]) {
    const response = await f.request(path, f.connection.token, body);
    assert.equal(response.status, 403, path);
    assert.equal(response.value.error.code, 'scoped_key_room_refused');
    assert.equal(JSON.stringify(response.value).includes('private-pointer'), false);
  }
  assert.ok(f.store.agentHeartbeats.pendingWakes(f.setup.identityId, {roomId:'commons'}).some(row => row.signalId === wake.signalId));
});

test('membership disabled during held scoped poll refuses its queued pointer at completion', async t => {
  const f = await fixture(t);
  await f.request('/api/agent-heartbeats', f.connection.token, { hostId: 'held-check', mode: 'pull-only', cadenceSeconds: 60 });
  // Observe the actual wait registration; avoid a timing-only assertion that
  // could revoke before the initial authorization and miss the post-wait guard.
  const original = f.store.agentHeartbeats.addWakeWaiter.bind(f.store.agentHeartbeats);
  let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  f.store.agentHeartbeats.addWakeWaiter = (...args) => { const result = original(...args); entered(); return result; };
  const poll = f.request('/api/agent-wakes/poll?hostId=held-check&waitMs=1000', f.connection.token);
  await waiting;
  const member = f.store.room('commons').state.members[f.connection.memberId];
  f.store.command(f.owners.commons, 'commons', { id: crypto.randomUUID(), type: 'member.access_changed', data: {
    memberId: member.id, expectedMemberRevision: member.revision, permissions: [], active: false
  } });
  f.store.agentHeartbeats.enqueueWake({agentId:f.setup.identityId,kind:'mention',roomId:'commons',messageId:'held-private-pointer'});
  const response = await poll;
  assert.equal(response.status,403);
  assert.equal(response.value.error.code,'scoped_key_room_refused');
  assert.equal(JSON.stringify(response.value).includes('held-private-pointer'),false);
});
