// HS2 3c: Stop always works. With a live host, Stop asks and waits for the
// host to confirm (unchanged). With a host silent past the 2-minute stall
// window, Stop closes the run at once, and the late host can't publish into it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { RoomAssistant, HOST_STALL_MS } from '../server/room-assistant.mjs';

function setup() {
  const f = createAcceptanceFixture({ dmConsent: true });
  const assistant = new RoomAssistant(f.store);
  let clock = f.store.now();
  f.store.now = () => clock;
  const apply = (actor, input) => assistant.apply('commons', { requestId: randomUUID(), ...input }, () => f.store.authenticate(f.keys[actor], 'commons')).result;
  const refused = (actor, input) => { try { apply(actor, input); } catch (error) { return error.code; } return null; };
  const message = id => f.store.command(f.keys.owner, 'commons', { id: randomUUID(), type: 'message.posted', data: { messageId: id, body: id } });
  apply('owner', { action: 'configure', expectedRevision: 0, name: 'Room', coordinatorMemberId: 'producer' });
  return { f, apply, refused, message, tick: ms => { clock += ms; } };
}

test('Stop on a run whose host went silent closes it at once and fences the late host', () => {
  const { apply, refused, message, tick } = setup();
  message('ask'); apply('owner', { action: 'invoke', runId: 'r', sourceMessageId: 'ask' });
  apply('producer', { action: 'claim', runId: 'r', attemptId: 'host', expectedRevision: 0 });
  tick(HOST_STALL_MS + 1000);
  const stopped = apply('owner', { action: 'cancel', runId: 'r', expectedRevision: 1 });
  assert.equal(stopped.status, 'cancelled', 'no waiting on a host that cannot answer');
  assert.match(stopped.activity.at(-1).summary, /stopped responding/);
  message('late-answer');
  assert.equal(refused('producer', { action: 'report', runId: 'r', attemptId: 'host', expectedRevision: 2, state: 'done', summary: 'Here you go', resultMessageId: 'late-answer' }), 'assistant_run_closed');
  assert.equal(refused('producer', { action: 'report', runId: 'r', attemptId: 'host', expectedRevision: 2, state: 'working', summary: 'still here' }), 'assistant_run_closed');
});

test('a second Stop on a request stuck in Stopping closes it once the host is silent', () => {
  const { apply, message, tick } = setup();
  message('ask'); apply('owner', { action: 'invoke', runId: 'r', sourceMessageId: 'ask' });
  apply('producer', { action: 'claim', runId: 'r', attemptId: 'host', expectedRevision: 0 });
  assert.equal(apply('owner', { action: 'cancel', runId: 'r', expectedRevision: 1 }).status, 'cancel_requested', 'a live host is asked first');
  tick(HOST_STALL_MS + 1000);
  assert.equal(apply('owner', { action: 'cancel', runId: 'r', expectedRevision: 2 }).status, 'cancelled');
});

test('with a live host, Stop still waits for the host, and Pause never force-closes', () => {
  const { apply, message, tick } = setup();
  message('ask'); apply('owner', { action: 'invoke', runId: 'r', sourceMessageId: 'ask' });
  apply('producer', { action: 'claim', runId: 'r', attemptId: 'host', expectedRevision: 0 });
  tick(HOST_STALL_MS - 1000);
  assert.equal(apply('owner', { action: 'cancel', runId: 'r', expectedRevision: 1 }).status, 'cancel_requested', 'inside the window the host confirms');
  message('ask2'); apply('owner', { action: 'invoke', runId: 'p', sourceMessageId: 'ask2' });
  apply('producer', { action: 'claim', runId: 'p', attemptId: 'host2', expectedRevision: 0 });
  tick(HOST_STALL_MS + 1000);
  assert.equal(apply('owner', { action: 'pause', runId: 'p', expectedRevision: 1 }).status, 'pause_requested');
  message('ask3'); apply('owner', { action: 'invoke', runId: 'q', sourceMessageId: 'ask3' });
  assert.equal(apply('owner', { action: 'cancel', runId: 'q', expectedRevision: 0 }).status, 'cancelled', 'an unclaimed request was always closed immediately');
});
