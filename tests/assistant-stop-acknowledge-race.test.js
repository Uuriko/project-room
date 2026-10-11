// Fail-first repro: a stop that the server completes independently (a second
// cancel while the host was silent revokes the attempt and bumps the run
// revision) can land between the host's final reread (cancel_requested) and
// its acknowledge report. The report is then rejected -- here with
// assistant_revision_conflict because the independent stop bumped the
// revision (without the bump it would be assistant_run_closed /
// assistant_run_owned) -- and runHostOnce does not handle any of those
// codes on the acknowledge path, so it throws instead of recording the
// already-cancelled outcome. The run is correctly cancelled server-side and
// nothing stale publishes; the host just fails its pass loudly on an
// expected condition.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { createRoomClient, runHostOnce } from '../scripts/room-assistant-scratch.mjs';

async function until(fn, message, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await delay(25); }
  assert.fail(message);
}

test('an independently completed stop between reread and acknowledge settles instead of throwing', async t => {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); });
  const client = actor => createRoomClient({ origin: `http://127.0.0.1:${server.address().port}`, roomId: 'commons', token: f.keys[actor] });
  const owner = client('owner'), producer = client('producer');
  await owner.act({ action: 'configure', requestId: 'config', name: 'Room', coordinatorMemberId: 'producer', expectedRevision: 0 });
  await owner.post('ask', 'Original instructions');
  await owner.act({ action: 'invoke', requestId: 'invoke', runId: 'run', sourceMessageId: 'ask' });
  const current = async () => (await owner.assistant()).runs.find(run => run.id === 'run');

  // Wrap the host client so the server's independent stop lands exactly in
  // the race window: after the host reread cancel_requested, before its
  // acknowledge report reaches the server.
  let revoked = false;
  const host = { ...producer, act: async input => {
    if (!revoked && input.action === 'report' && input.state === 'cancelled') {
      revoked = true;
      const row = f.store.db.prepare("SELECT value FROM room_assistant_runs WHERE room_id='commons' AND run_id='run'").get();
      const run = JSON.parse(row.value);
      run.status = 'cancelled';
      run.attemptId = null;
      run.revision++;
      f.store.db.prepare("UPDATE room_assistant_runs SET value=? WHERE room_id='commons' AND run_id='run'").run(JSON.stringify(run));
    }
    return producer.act(input);
  } };

  let release;
  const execute = () => new Promise(resolve => { release = resolve; });
  const pass = runHostOnce(host, { memberId: 'producer', execute });
  t.after(async () => { release?.('Late output'); await pass.catch(() => {}); });
  await until(() => Boolean(release), 'executor started');
  await owner.act({ action: 'cancel', requestId: 'stop', runId: 'run', expectedRevision: (await current()).revision });
  assert.equal((await current()).status, 'cancel_requested');

  release('Late output');
  const { outcomes } = await pass;
  assert.equal(revoked, true, 'the race window was exercised');
  assert.equal(outcomes[0].state, 'cancelled');
  assert.equal((await current()).status, 'cancelled');
  assert.equal((await owner.recent()).filter(message => message.authorId === 'producer').length, 0, 'no answer published');
});
