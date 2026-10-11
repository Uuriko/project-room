import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { RoomAssistant } from '../server/room-assistant.mjs';
import { RoomAgentClient } from '../client/room-agent.mjs';

async function setup(t) {
  const f = createAcceptanceFixture({ dmConsent: true });
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const client = new RoomAgentClient({ version: 1, origin, roomId: 'commons', memberId: 'producer', token: f.keys.producer });
  const service = new RoomAssistant(f.store);
  const auth = actor => () => f.store.authenticate(f.keys[actor], 'commons');
  const apply = (actor, input) => service.apply('commons', { requestId: randomUUID(), ...input }, auth(actor)).result;
  let clock = f.store.now(); f.store.now = () => clock;
  apply('owner', { action: 'configure', expectedRevision: 0, name: 'Room', coordinatorMemberId: 'producer' });
  const add = id => {
    clock += 2100;
    f.store.command(f.keys.owner, 'commons', { id: randomUUID(), type: 'message.posted', data: { messageId: `prompt-${id}`, body: 'Continue this work' } });
    return apply('owner', { action: 'invoke', runId: id, sourceMessageId: `prompt-${id}` });
  };
  const get = async (actor, query) => {
    const response = await fetch(`${origin}/api/rooms/commons/assistant?${new URLSearchParams(query)}`, { headers: { authorization: `Bearer ${f.keys[actor]}` } });
    return { status: response.status, body: await response.json() };
  };
  return { f, service, auth, apply, add, get, client };
}

test('1001 accepted requests are discoverable in bounded oldest-first pages and exact Stop survives history eviction', async t => {
  const { service, auth, apply, add, client } = await setup(t);
  const expected = [];
  for (let n = 0; n < 1001; n++) { const id = `work-${String(n).padStart(4, '0')}`; add(id); expected.push(id); }
  assert.equal(service.list('commons', auth('producer')).runs.some(r => r.id === expected[0]), false);
  const seen = []; let cursor;
  do {
    const page = await client.assistant(undefined, { work: true, cursor, limit: 37 });
    assert.ok(page.runs.length <= 37);
    seen.push(...page.runs.map(r => r.id)); cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(seen, expected);
  apply('producer', { action: 'claim', runId: expected[0], attemptId: 'original-host', expectedRevision: 0 });
  apply('owner', { action: 'cancel', runId: expected[0], expectedRevision: 1 });
  const exact = await client.assistant(undefined, { runId: expected[0] });
  assert.equal(exact.runs[0].status, 'cancel_requested');
  assert.equal(exact.runs[0].attemptId, 'original-host');
  assert.throws(() => apply('producer', { action: 'claim', runId: expected[0], attemptId: 'racing-host', expectedRevision: 0 }));
});

test('hidden rows yield bounded empty pages; cursors are scoped and exact reads retain visibility', async t => {
  const { f, service, auth, add, get, client } = await setup(t);
  const visible = add('visible');
  // Synthetic persisted hidden rows exercise bounded filtering without granting
  // a real member authority to create an assistant request for another's DM.
  const insert = f.store.db.prepare('INSERT INTO room_assistant_runs VALUES(?,?,?)');
  for (let n = 0; n < 205; n++) {
    const id = `hidden-${n}`;
    insert.run('commons', id, JSON.stringify({ ...visible, id, createdAt: visible.createdAt - 1000 + n, sourceMessageId: 'missing-private-source' }));
  }
  const first = await client.assistant(undefined, { work: true });
  assert.deepEqual(first.runs, []); assert.equal(typeof first.nextCursor, 'string');
  const second = await client.assistant(undefined, { work: true, cursor: first.nextCursor });
  assert.deepEqual(second.runs.map(r => r.id), ['visible']); assert.equal(second.nextCursor, null);
  assert.equal((await get('producer', { runId: 'hidden-0' })).status, 404);
  assert.equal((await get('reviewer', { view: 'work', cursor: first.nextCursor })).status, 409);
  assert.equal((await get('producer', { view: 'work', cursor: first.nextCursor + 'x' })).status, 409);
  assert.equal((await get('producer', { view: 'work', limit: '101' })).status, 422);
  assert.equal(service.readWork('commons', auth('reviewer')).runs.length, 0);
});

test('equal timestamps paginate once each and exact deleted-source reads expose only the control handle', async t => {
  const { f, add, apply, client, get } = await setup(t);
  const original = add('a'); add('b'); add('c');
  f.store.db.prepare("UPDATE room_assistant_runs SET value=json_set(value,'$.createdAt',?) WHERE room_id=?").run(original.createdAt, 'commons');
  let cursor; const seen = [];
  do { const page = await client.assistant(undefined, { work: true, cursor, limit: 1 }); seen.push(...page.runs.map(r => r.id)); cursor = page.nextCursor; } while (cursor);
  assert.deepEqual(seen, ['a', 'b', 'c']);
  apply('producer', { action: 'claim', runId: 'a', attemptId: 'host-a', expectedRevision: 0 });
  f.store.command(f.keys.owner, 'commons', { id: randomUUID(), type: 'message.deleted', data: { messageId: 'prompt-a', expectedMessageRevision: 0 } });
  const run = (await client.assistant(undefined, { runId: 'a' })).runs[0];
  assert.equal(run.sourceDeleted, true); assert.deepEqual(run.inputs, []); assert.deepEqual(run.activity, []);
  assert.equal((await get('reviewer', { runId: 'a' })).status, 404);
});
