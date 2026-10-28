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
import { AgentWakeClient } from '../client/agent-wake.mjs';
import { linkWithProof } from "./helpers/link-with-proof.mjs";

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
    linkWithProof(store, owners[roomId], roomId, identity, { memberId, displayName: name, permissions: [] });
    return identity;
  };
  return { store, owners, setup, connection, request, addMember, origin };
}

test('the standard setup credential (rak_) runs the room-scoped listener end to end', async t => {
  const f = await fixture(t);
  assert.equal(f.setup.status, 'connected');
  assert.match(f.connection.token, /^rak_/);
  // The adapter accepts the saved scoped connection (was invalid_config).
  const client = new AgentWakeClient({ connection: f.connection });
  // REST heartbeat with the saved credential registers the host (was 403
  // insufficient_scope). The response names the caller's own hostId; the
  // stored row is namespaced under the key.
  const beat = await f.request('/api/agent-heartbeats', f.connection.token,
    { hostId: 'saved-host', mode: 'pull-only', cadenceSeconds: 60 });
  assert.equal(beat.status, 200);
  assert.equal(beat.value.host.hostId, 'saved-host');
  const rows = f.store.db.prepare('SELECT host_id FROM agent_hosts WHERE agent_id=?').all(f.setup.identityId);
  assert.ok(rows.some(row => row.host_id.startsWith('ak_')), 'scoped registration is namespaced under the key');
  assert.equal(f.store.agentHeartbeats.statusOf(f.setup.identityId).status, 'online');
  // Reachability outside the room stays on the identity secret.
  for (const extra of [{ wakeUrl: 'https://host.example.test/wake' },
      { pushNotification: { url: 'https://push.example.test/hook', token: 'tok' } }]) {
    const refused = await f.request('/api/agent-heartbeats', f.connection.token,
      { hostId: 'saved-host', mode: 'wakeable', cadenceSeconds: 60, ...extra });
    assert.equal(refused.status, 403);
    assert.equal(refused.value.error.code, 'scoped_key_wake_refused');
  }
  // Scoped presence read: only this key's hosts, caller-facing ids.
  const presence = await f.request('/api/agent-heartbeats', f.connection.token);
  assert.equal(presence.status, 200);
  assert.deepEqual(presence.value.hosts.map(host => host.hostId), ['saved-host']);
  // Room filtering: an annex signal (the identity is not even a member)
  // is invisible to the scoped poll; a commons signal is delivered.
  const annexWake = f.store.agentHeartbeats.enqueueWake(
    { agentId: f.setup.identityId, kind: 'mention', roomId: 'annex', messageId: 'annex-pointer' }).signal;
  const poll0 = await f.request('/api/agent-wakes/poll?hostId=saved-host&waitMs=0', f.connection.token);
  assert.equal(poll0.status, 200);
  assert.ok(!poll0.value.pendingWakes.some(row => row.signalId === annexWake.signalId),
    'scoped poll must not observe another room\'s signals');
  const commonsWake = f.store.agentHeartbeats.enqueueWake(
    { agentId: f.setup.identityId, kind: 'mention', roomId: 'commons', messageId: 'commons-pointer' }).signal;
  // The full adapter flow on the saved credential: setup, wait, ack.
  const registered = await client.setup({ hostId: 'saved-host', cadenceSeconds: 60 });
  assert.equal(registered.status, 'registered_not_listening');
  const waited = await client.wait({ hostId: 'saved-host', cadenceSeconds: 60, waitMs: 0 });
  assert.ok(waited.pendingWakes.some(row => row.signalId === commonsWake.signalId));
  assert.ok(!waited.pendingWakes.some(row => row.signalId === annexWake.signalId));
  const acked = await client.ack({ signalIds: [commonsWake.signalId] });
  assert.deepEqual(acked.acknowledged, [commonsWake.signalId]);
  assert.equal(f.store.agentHeartbeats.pendingWakes(f.setup.identityId, { roomId: 'commons' }).length, 0);
  // Membership is re-verified on every authorization: unlink the identity
  // from the bound room and the same credential's listener dies.
  f.store.identities.unlink(f.owners.commons, 'commons', f.setup.identityId);
  const dead = await f.request('/api/agent-heartbeats', f.connection.token,
    { hostId: 'saved-host', mode: 'pull-only', cadenceSeconds: 60 });
  assert.equal(dead.status, 403);
  assert.equal(dead.value.error.code, 'scoped_key_room_refused');
});

test('the scoped listener lease fences ack for the standard credential too', async t => {
  const f = await fixture(t);
  const client = new AgentWakeClient({ connection: f.connection });
  const registered = await client.setup({ hostId: 'saved-host', cadenceSeconds: 60, listener: true });
  assert.equal(registered.listener.acquired, true);
  const wake = f.store.agentHeartbeats.enqueueWake(
    { agentId: f.setup.identityId, kind: 'mention', roomId: 'commons', messageId: 'leased-pointer' }).signal;
  // Tokenless ack against a lease-held queue is refused, even with the
  // otherwise-valid scoped credential.
  const tokenless = await f.request('/api/agent-heartbeats/ack', f.connection.token, { signalIds: [wake.signalId] });
  assert.equal(tokenless.status, 409);
  // The lease holder's client ack carries the fencing token and drains.
  const acked = await client.ack({ signalIds: [wake.signalId] });
  assert.deepEqual(acked.acknowledged, [wake.signalId]);
  assert.equal(f.store.agentHeartbeats.pendingWakes(f.setup.identityId, { roomId: 'commons' }).length, 0);
});

test('room-scoped activity does not advertise or suppress availability in another room', async t => {
  const f = await fixture(t);
  const peer = f.addMember('Zaynab Haddad', 'commons', 'peer-two');
  const commonsObserver = f.addMember('Omar Farouk', 'commons', 'commons-observer');
  // Room-scoped activity only: a legacy room access key pull-only report.
  const roomKey = f.store.issueAccessKey('commons', 'peer-two');
  assert.equal((await f.request('/api/agent-heartbeats', roomKey,
    { hostId: 'legacy-host', mode: 'pull-only', cadenceSeconds: 60 })).status, 200);
  // The identity later joins annex. Annex observers must NOT see it as
  // wakeable from commons-scoped activity (was the pre-fix leak).
  linkWithProof(f.store, f.owners.annex, 'annex', peer, { memberId: 'annex-peer', displayName: 'Zaynab Haddad', permissions: [] });
  const annexObserver = f.addMember('Priya Nair', 'annex', 'annex-observer');
  const annexStatus = await f.request('/api/wake-status?roomId=annex', annexObserver.secret);
  assert.equal(annexStatus.status, 200);
  assert.ok(!annexStatus.value.wakeable.some(row => row.agentId === peer.identityId),
    'commons-scoped activity must not advertise wakeability in annex');
  assert.ok(annexStatus.value.notWakeable.some(row => row.agentId === peer.identityId));
  // Commons still sees it wakeable: the activity IS attributed there.
  const commonsStatus = await f.request('/api/wake-status?roomId=commons', commonsObserver.secret);
  assert.ok(commonsStatus.value.wakeable.some(row => row.agentId === peer.identityId));
  // Identity-level activity is different by contract: once the identity
  // itself polls with its secret, it is wakeable in its rooms.
  assert.equal((await f.request('/api/agent-heartbeats', peer.secret,
    { hostId: 'peer-host', mode: 'pull-only', cadenceSeconds: 60 })).status, 200);
  const annexAfter = await f.request('/api/wake-status?roomId=annex', annexObserver.secret);
  assert.ok(annexAfter.value.wakeable.some(row => row.agentId === peer.identityId),
    'identity-level listening counts in every room the identity belongs to');
});

test('a fresh room-scoped registration cannot suppress push for identity-level hosts', async t => {
  const f = await fixture(t);
  const identity = f.addMember('Tomas Berg', 'commons', 'push-peer');
  f.store.agentHeartbeats.setPushTransport({
    dnsResolvers: { resolve4: async () => ['93.184.216.34'], resolve6: async () => [] } });
  const beat = await f.request('/api/agent-heartbeats', identity.secret, {
    hostId: 'push-host', mode: 'wakeable', cadenceSeconds: 60,
    pushNotification: { url: 'https://push.example.test/hook', token: 'tok' } });
  assert.equal(beat.status, 200);
  // The identity-level host goes stale (offline): push becomes eligible.
  f.store.db.prepare('UPDATE agent_hosts SET last_seen_at=? WHERE agent_id=? AND host_id=?')
    .run(Date.now() - 3600000, identity.identityId, 'push-host');
  assert.equal(f.store.agentHeartbeats.pushTargets(identity.identityId).length, 1);
  // A fresh room-scoped (room key) pull-only registration in the same room
  // makes the identity-global status read online — it must not suppress
  // the push doorbell for the identity-level host.
  const roomKey = f.store.issueAccessKey('commons', 'push-peer');
  assert.equal((await f.request('/api/agent-heartbeats', roomKey,
    { hostId: 'seat-host', mode: 'pull-only', cadenceSeconds: 60 })).status, 200);
  assert.equal(f.store.agentHeartbeats.statusOf(identity.identityId).status, 'online');
  const targets = f.store.agentHeartbeats.pushTargets(identity.identityId);
  assert.deepEqual(targets.map(target => target.hostId), ['push-host']);
});

test('HTTP observation is non-consuming for every host; ack under a live lease requires its fencing token', async t => {
  const f = await fixture(t);
  const identity = f.addMember('Ingrid Voss', 'commons', 'lease-peer');
  const first = await f.request('/api/agent-heartbeats', identity.secret,
    { hostId: 'first', mode: 'pull-only', cadenceSeconds: 60, listenerLease: { roomId: 'commons' } });
  assert.equal(first.status, 200);
  assert.equal(first.value.listener.acquired, true);
  assert.equal(typeof first.value.listener.fencingToken, 'string');
  // A second host's presence report still succeeds; the lease names the
  // active listener instead of failing the heartbeat.
  const second = await f.request('/api/agent-heartbeats', identity.secret,
    { hostId: 'second', mode: 'pull-only', cadenceSeconds: 60, listenerLease: { roomId: 'commons' } });
  assert.equal(second.status, 200);
  assert.equal(second.value.listener.acquired, false);
  assert.equal(second.value.listener.activeListenerId, 'first');
  const wake = f.store.agentHeartbeats.enqueueWake(
    { agentId: identity.identityId, kind: 'mention', roomId: 'commons', messageId: 'shared-pointer' }).signal;
  // Observation is separate from ownership: both hosts' polls return the
  // same pending pointer, and polling consumes nothing.
  for (const hostId of ['first', 'second']) {
    const poll = await f.request(`/api/agent-wakes/poll?hostId=${hostId}&waitMs=0`, identity.secret);
    assert.equal(poll.status, 200);
    assert.ok(poll.value.pendingWakes.some(row => row.signalId === wake.signalId));
  }
  // Tokenless ack is fenced while the lease lives (was: succeeds).
  const tokenless = await f.request('/api/agent-heartbeats/ack', identity.secret, { signalIds: [wake.signalId] });
  assert.equal(tokenless.status, 409);
  const wrongToken = await f.request('/api/agent-heartbeats/ack', identity.secret,
    { signalIds: [wake.signalId], fencingToken: 'not-the-lease-token' });
  assert.equal(wrongToken.status, 409);
  // The lease holder's fenced ack drains exactly once.
  const fenced = await f.request('/api/agent-heartbeats/ack', identity.secret,
    { signalIds: [wake.signalId], fencingToken: first.value.listener.fencingToken });
  assert.equal(fenced.status, 200);
  assert.deepEqual(fenced.value.acknowledged, [wake.signalId]);
  const after = await f.request('/api/agent-wakes/poll?hostId=first&waitMs=0', identity.secret);
  assert.ok(!after.value.pendingWakes.some(row => row.signalId === wake.signalId));
});

test('an identity credential\'s {roomId} lease requires the live active agent member, not just the link row', async t => {
  const f = await fixture(t);
  const identity = f.addMember('Marta Kessler', 'commons', 'lease-member');
  // Active member: the identity credential acquires the room lease and
  // its fenced ack drains the room's signal.
  const beat = await f.request('/api/agent-heartbeats', identity.secret,
    { hostId: 'member-host', mode: 'pull-only', cadenceSeconds: 60, listenerLease: { roomId: 'commons' } });
  assert.equal(beat.status, 200);
  assert.equal(beat.value.listener.acquired, true);
  const wake = f.store.agentHeartbeats.enqueueWake(
    { agentId: identity.identityId, kind: 'mention', roomId: 'commons', messageId: 'member-pointer' }).signal;
  const acked = await f.request('/api/agent-heartbeats/ack', identity.secret,
    { signalIds: [wake.signalId], fencingToken: beat.value.listener.fencingToken });
  assert.equal(acked.status, 200);
  assert.deepEqual(acked.value.acknowledged, [wake.signalId]);
  // Suspend the member. The identity_links row survives suspension, so a
  // link-row-only membership check would keep renewing this lease
  // (F-3497-1); the live member check the scoped-key path applies must
  // refuse it here too.
  const member = f.store.room('commons').state.members['lease-member'];
  f.store.command(f.owners.commons, 'commons', { id: crypto.randomUUID(), type: 'member.access_changed', data: {
    memberId: member.id, expectedMemberRevision: member.revision, permissions: [], active: false } });
  const leaseRow = () => f.store.db.prepare(
    'SELECT lease_expires_at AS expiresAt FROM agent_wake_listener_leases WHERE agent_id=? AND room_key=?')
    .get(identity.identityId, 'commons');
  const expiryBefore = leaseRow().expiresAt;
  const renewed = await f.request('/api/agent-heartbeats', identity.secret,
    { hostId: 'member-host', mode: 'pull-only', cadenceSeconds: 60, listenerLease: { roomId: 'commons' } });
  assert.equal(renewed.status, 403);
  assert.equal(renewed.value.error.code, 'room_mismatch');
  // The refused heartbeat extended nothing: once the pre-suspension lease
  // lapses, the suspended member's token claims nothing, so it can no
  // longer ack the room's signals as their listener.
  assert.equal(leaseRow().expiresAt, expiryBefore);
  f.store.db.prepare('UPDATE agent_wake_listener_leases SET lease_expires_at=? WHERE agent_id=? AND room_key=?')
    .run(Date.now() - 1000, identity.identityId, 'commons');
  assert.throws(() => f.store.agentHeartbeats.claimWakeBatch(
    { agentId: identity.identityId, roomId: 'commons', fencingToken: beat.value.listener.fencingToken }),
    error => error.status === 409 && error.code === 'stale_listener');
  // Plain presence is not membership-gated for identity credentials and
  // is unchanged: only the lease branch carries the live check.
  const plain = await f.request('/api/agent-heartbeats', identity.secret,
    { hostId: 'member-host', mode: 'pull-only', cadenceSeconds: 60 });
  assert.equal(plain.status, 200);
});
