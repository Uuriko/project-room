// WAVE-500 guild-7 worker B3 — fail-first repro for John's Tab R36-2 (Stop wedge).
// Tab's flag (muse-room seq 10543): Stop is a request, not an interrupt. Once
// the owner stops a run whose host reported recently, the run sits at
// cancel_requested until the host reports back. When the host never reports
// back (crashed, demoted to t1_readonly, attempt revoked), nothing moves the
// run to a terminal state: the card wedges at "stopping" forever. The only
// current exits are a host acknowledgment or a *second* Stop after the 120 s
// stale window — there is no deadline on the first Stop.
// The Tab/Codex lane claim ("give Stop a deadline, then fence the attempt")
// should make the run below reach a terminal honest state within a deadline.
// Repro-only; no fix here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { RoomAssistant } from '../server/room-assistant.mjs';

const TERMINAL = new Set(['done', 'cancelled', 'failed']);

async function setup(t) {
  const f = createAcceptanceFixture({ dmConsent: true });
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  // The card read uses the real HTTP route, as the room renders it.
  const card = async actor => {
    const response = await fetch(`${origin}/api/rooms/commons/assistant`, { headers: { authorization: `Bearer ${f.keys[actor]}` } });
    const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value;
  };
  const message = (actor, id, body = 'Shared input') => f.store.command(f.keys[actor], 'commons', { id: randomUUID(), type: 'message.posted', data: { messageId: id, body } });
  return { f, card, message };
}

test('stop against a run whose host never reports back reaches a terminal honest state within a deadline', async t => {
  const { f, card, message } = await setup(t);
  const assistant = new RoomAssistant(f.store);
  let clock = f.store.now();
  f.store.now = () => clock;
  // Exercise production transitions directly; the externally observable read
  // below uses the actual route.
  const apply = (actor, input) => assistant.apply('commons', { requestId: randomUUID(), ...input }, () => f.store.authenticate(f.keys[actor], 'commons')).result;

  // Owner connects the assistant, asks for work, the host claims it.
  apply('owner', { action: 'configure', expectedRevision: 0, name: 'Room', coordinatorMemberId: 'producer' });
  message('owner', 'stop-wedge-prompt');
  apply('owner', { action: 'invoke', runId: 'stop-wedge', sourceMessageId: 'stop-wedge-prompt' });
  apply('producer', { action: 'claim', runId: 'stop-wedge', attemptId: 'silent-host', expectedRevision: 0 });
  assert.equal(apply('owner', { action: 'cancel', runId: 'stop-wedge', expectedRevision: 1 }).status, 'cancel_requested',
    'a recent host report turns the owner stop into a request, not an interrupt');

  // The host goes silent and never reports back: no 'cancelled' ack ever comes.
  clock += 10 * 60 * 1000; // far past any reasonable stop deadline (>> the 120 s stale window)

  // The card is what the room actually renders — it must not wedge at "stopping".
  const run = (await card('owner')).runs.find(entry => entry.id === 'stop-wedge');
  assert.ok(run, 'the stopped run is still on the card');
  assert.ok(TERMINAL.has(run.status),
    `R36-2 stop wedge: status is '${run.status}' (card shows '${run.displayStatus}') with no host report for 600 s — the card never reaches a terminal honest state`);
});
