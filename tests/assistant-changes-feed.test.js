// GET /api/rooms/:roomId/assistant?since=<cursor>: changes since a cursor, so a
// host (and the desktop console) can stop re-reading every run every 2 s.
// Repro on main 83746c5b: reads carry no cursor and ?since is ignored, so every
// poll returns the whole run projection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';

async function setup(t) {
  const f = createAcceptanceFixture({ dmConsent: true });
  let clock = Date.parse('2026-10-11T00:00:00Z');
  f.store.now = () => clock;
  const tick = (ms = 10000) => { clock += ms; };
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const api = async (actor, input, query = '') => {
    const response = await fetch(`${origin}/api/rooms/commons/assistant${query}`, { method: input ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${f.keys[actor]}`, ...(input ? { 'content-type': 'application/json' } : {}) }, ...(input ? { body: JSON.stringify({ requestId: randomUUID(), ...input }) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const since = cursor => `?since=${encodeURIComponent(cursor)}`;
  const message = (actor, id, body) => f.store.command(f.keys[actor], 'commons', { id: randomUUID(), type: 'message.posted', data: { messageId: id, body } });
  await api('owner', { action: 'configure', expectedRevision: 0, name: 'Room', coordinatorMemberId: 'producer' });
  for (const id of ['a', 'b']) {
    tick();
    message('owner', `${id}-opening`, `Work on ${id}.`);
    await api('owner', { action: 'invoke', runId: id, sourceMessageId: `${id}-opening` });
  }
  tick();
  return { f, api, since, tick, message };
}

const ids = body => body.runs.map(run => run.id).sort();

test('the plain read carries a cursor and is otherwise unchanged', async t => {
  const { api } = await setup(t);
  const full = await api('producer');
  assert.equal(full.status, 200, JSON.stringify(full.body));
  assert.match(full.body.cursor, /^v1\.\d+\.\d+\.[0-9a-f]{16}$/);
  assert.deepEqual(ids(full.body), ['a', 'b']);
  assert.equal(full.body.changes, undefined);
});

test('nothing changed: none, same cursor, no runs', async t => {
  const { api, since, tick } = await setup(t);
  const { cursor } = (await api('producer')).body;
  tick();
  const quiet = await api('producer', null, since(cursor));
  assert.equal(quiet.status, 200);
  assert.equal(quiet.body.changes, 'none');
  assert.deepEqual(quiet.body.runs, []);
  assert.equal(quiet.body.cursor, cursor);
});

test('only runs written after the cursor come back, at their current state', async t => {
  const { api, since } = await setup(t);
  const { cursor } = (await api('producer')).body;
  const claim = await api('producer', { action: 'claim', runId: 'b', attemptId: 'host-1', expectedRevision: 0 });
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  const delta = await api('producer', null, since(cursor));
  assert.equal(delta.body.changes, 'delta');
  assert.deepEqual(ids(delta.body), ['b']);
  assert.equal(delta.body.runs[0].attemptId, 'host-1');
  assert.notEqual(delta.body.cursor, cursor);
  assert.equal((await api('producer', null, since(delta.body.cursor))).body.changes, 'none');
  assert.deepEqual(ids((await api('producer')).body), ['a', 'b'], 'the plain read still returns every run');
});

test('a write in the same millisecond as the cursor is delivered again, not lost', async t => {
  const { api, since } = await setup(t);
  const { cursor } = (await api('producer')).body; // no tick: same ms as the next write
  await api('producer', { action: 'claim', runId: 'b', attemptId: 'host-1', expectedRevision: 0 });
  const first = await api('producer', null, since(cursor));
  assert.ok(ids(first.body).includes('b'));
  // A second write in that same millisecond, after the reader's cursor.
  await api('producer', { action: 'report', runId: 'b', attemptId: 'host-1', expectedRevision: 1, state: 'working', summary: 'Reading' });
  const second = await api('producer', null, since(first.body.cursor));
  assert.equal(second.body.changes, 'delta');
  assert.equal(second.body.runs.find(run => run.id === 'b').revision, 2);
});

test('a draft (no revision bump) still shows up', async t => {
  const { api, since, tick } = await setup(t);
  await api('producer', { action: 'claim', runId: 'a', attemptId: 'host-1', expectedRevision: 0 });
  tick();
  const { cursor } = (await api('producer')).body;
  tick();
  const draft = await api('producer', { action: 'draft', runId: 'a', attemptId: 'host-1', expectedRevision: 1, sequence: 1, body: 'Half an answer' });
  assert.equal(draft.status, 200, JSON.stringify(draft.body));
  const delta = await api('producer', null, since(cursor));
  assert.equal(delta.body.changes, 'delta');
  assert.deepEqual(ids(delta.body), ['a']);
});

test('a new ask and a Stop both show up', async t => {
  const { api, since, tick, message } = await setup(t);
  await api('producer', { action: 'claim', runId: 'a', attemptId: 'host-1', expectedRevision: 0 });
  tick();
  const { cursor } = (await api('producer')).body;
  tick();
  message('owner', 'c-opening', 'Work on c.');
  await api('owner', { action: 'invoke', runId: 'c', sourceMessageId: 'c-opening' });
  const seen = (await api('owner')).body.runs.find(run => run.id === 'a');
  await api('owner', { action: 'cancel', runId: 'a', expectedRevision: seen.revision, expectedAttemptId: 'host-1' });
  const delta = await api('producer', null, since(cursor));
  assert.deepEqual(ids(delta.body), ['a', 'c']);
  assert.equal(delta.body.runs.find(run => run.id === 'a').status, 'cancel_requested');
});

test('a settings change answers full (it edits pending runs without updatedAt)', async t => {
  const { api, since, tick } = await setup(t);
  const { cursor, assistant } = (await api('producer')).body;
  tick();
  await api('owner', { action: 'configure', expectedRevision: assistant.revision, name: 'Helper', coordinatorMemberId: 'producer' });
  const after = await api('producer', null, since(cursor));
  assert.equal(after.body.changes, 'full');
  assert.equal(after.body.assistant.name, 'Helper');
  assert.deepEqual(ids(after.body), ['a', 'b']);
});

test('malformed cursors are refused; one from the future answers full', async t => {
  const { api, since } = await setup(t);
  for (const bad of ['', '7', 'v1.x.0.0000000000000000', 'v2.1.1.0123456789abcdef', 'v1.1.1.XYZ', 'v1.99999999999999999.1.0123456789abcdef']) {
    const response = await api('producer', null, since(bad));
    assert.equal(response.status, 422, `since=${bad}`);
    assert.equal(response.body.error.code, 'invalid_assistant_cursor');
  }
  const { cursor } = (await api('producer')).body;
  const [, newest, rev, digest] = cursor.split('.');
  const ahead = await api('producer', null, since(`v1.${Number(newest) + 3600000}.${rev}.${digest}`));
  assert.equal(ahead.body.changes, 'full');
  assert.deepEqual(ids(ahead.body), ['a', 'b']);
});

test('the delta never shows a run the full read hides, for every role', async t => {
  const { api, since, tick, message } = await setup(t);
  const cursors = {};
  for (const actor of ['owner', 'producer', 'guest']) cursors[actor] = (await api(actor)).body.cursor;
  tick();
  message('owner', 'd-opening', 'Work on d.');
  await api('owner', { action: 'invoke', runId: 'd', sourceMessageId: 'd-opening' });
  for (const actor of ['owner', 'producer', 'guest']) {
    const plain = await api(actor), delta = await api(actor, null, since(cursors[actor] ?? 'v1.0.0.0000000000000000'));
    assert.equal(delta.status, plain.status, actor);
    if (plain.status !== 200) continue;
    const visible = new Set(plain.body.runs.map(run => run.id));
    for (const run of delta.body.runs) assert.ok(visible.has(run.id), `${actor} sees ${run.id} only if the full read shows it`);
    for (const run of delta.body.runs) assert.deepEqual(run, plain.body.runs.find(item => item.id === run.id));
  }
});
