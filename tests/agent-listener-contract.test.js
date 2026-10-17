// Direct unit coverage for server/agent-listener-contract.mjs, the shared
// heartbeat + receiving-lease operation that HTTP (agent-plugin-routes) and
// hosted MCP (mcp-room-profile) both call. Integration suites reach it only
// through those routes; this file imports it so the no-new-untested-module
// gate (scripts/untested-modules-lint.mjs) sees a real reference, and pins
// the lease-shape validator and the acquire / contend / room-mismatch paths.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { validListenerLease, heartbeatWithListener } from '../server/agent-listener-contract.mjs';

test('validListenerLease accepts absent, true, or exactly {roomId: non-empty string}', () => {
  for (const ok of [undefined, true, { roomId: 'commons' }]) assert.equal(validListenerLease(ok), true, JSON.stringify(ok));
  for (const bad of [false, null, 0, 1, 'commons', [], ['commons'], {}, { roomId: '' }, { roomId: 7 },
    { roomId: 'commons', extra: 1 }, { room: 'commons' }]) assert.equal(validListenerLease(bad), false, JSON.stringify(bad));
});

function fixture(t) {
  const store = new RoomStore(':memory:');
  store.initialize(initialRoom('commons'));
  t.after(() => store.close());
  return store;
}

test('heartbeatWithListener without listenerLease reports presence and no listener', t => {
  const store = fixture(t);
  const out = heartbeatWithListener(store, { identityId: 'ai_unit_a' }, { hostId: 'host-a', mode: 'pull-only' });
  assert.equal(out.listener, null);
});

test('heartbeatWithListener passes cadenceSeconds through: omit preserves, explicit null clears', t => {
  // The shared contract is the seam both the HTTP route and hosted MCP
  // cross; collapsing data.cadenceSeconds with ?? null here would turn
  // every bare heartbeat back into a cadence reset (rotation review
  // P5-F2), whatever the store does.
  const store = fixture(t);
  const auth = { identityId: 'ai_unit_e' };
  const declared = heartbeatWithListener(store, auth, { hostId: 'host-e', mode: 'pull-only', cadenceSeconds: 900 });
  assert.equal(declared.host.cadenceSeconds, 900);
  const bare = heartbeatWithListener(store, auth, { hostId: 'host-e', mode: 'pull-only' });
  assert.equal(bare.host.cadenceSeconds, 900, 'a body without cadenceSeconds preserves the declaration');
  const cleared = heartbeatWithListener(store, auth, { hostId: 'host-e', mode: 'pull-only', cadenceSeconds: null });
  assert.equal(cleared.host.cadenceSeconds, null, 'an explicit null clears the declaration');
});

test('identity-level roomless lease: first host acquires, a second host is told who holds it', t => {
  const store = fixture(t);
  const auth = { identityId: 'ai_unit_b' };
  const a = heartbeatWithListener(store, auth, { hostId: 'host-a', mode: 'pull-only', listenerLease: true });
  assert.equal(a.listener.acquired, true);
  assert.ok(a.listener.fencingToken, 'acquired lease carries a fencing token');
  const again = heartbeatWithListener(store, auth, { hostId: 'host-a', mode: 'pull-only', listenerLease: true });
  assert.equal(again.listener.acquired, true);
  assert.equal(again.listener.renewed, true);
  const b = heartbeatWithListener(store, auth, { hostId: 'host-b', mode: 'pull-only', listenerLease: true });
  assert.equal(b.listener.acquired, false);
  assert.equal(b.listener.activeListenerId, 'host-a');
});

test('identity-level lease for a room the identity is not a member of is refused 403 room_mismatch', t => {
  const store = fixture(t);
  assert.throws(
    () => heartbeatWithListener(store, { identityId: 'ai_unit_c' }, { hostId: 'host-c', mode: 'pull-only', listenerLease: { roomId: 'commons' } }),
    err => err.status === 403 && err.code === 'room_mismatch');
});

test('a room-bound credential cannot lease a different room', t => {
  const store = fixture(t);
  assert.throws(
    () => heartbeatWithListener(store, { identityId: 'ai_unit_d', roomId: 'commons' }, { hostId: 'host-d', mode: 'pull-only', listenerLease: { roomId: 'annex' } }),
    err => err.status === 403 && err.code === 'room_mismatch');
});
