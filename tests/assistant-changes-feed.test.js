// GET /api/rooms/:roomId/assistant?since=<cursor>: changes since a cursor, so a
// host (and the desktop console) can stop re-reading every run every 2 s.
// Repro on main 83746c5b: reads carry no cursor and ?since is ignored, so every
// poll returns the whole run projection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { LOOKBACK_MS, assistantChangeKind, assistantVisibilityMark, changedRuns, parseAssistantCursor } from '../server/room-assistant-changes.mjs';

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
  assert.match(full.body.cursor, /^v1\.\d+\.\d+\.[0-9a-f]{8}\.[0-9a-f]{16}$/);
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
  for (const bad of ['', '7', 'v1.x.0.00000000.0000000000000000', 'v2.1.1.00000000.0123456789abcdef', 'v1.1.1.XYZ', 'v1.1.1.0123456789abcdef', 'v1.99999999999999999.1.00000000.0123456789abcdef']) {
    const response = await api('producer', null, since(bad));
    assert.equal(response.status, 422, `since=${bad}`);
    assert.equal(response.body.error.code, 'invalid_assistant_cursor');
  }
  const { cursor } = (await api('producer')).body;
  const [, newest, rev, visibility, digest] = cursor.split('.');
  const ahead = await api('producer', null, since(`v1.${Number(newest) + 3600000}.${rev}.${visibility}.${digest}`));
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
    const plain = await api(actor), delta = await api(actor, null, since(cursors[actor] ?? 'v1.0.0.00000000.0000000000000000'));
    assert.equal(delta.status, plain.status, actor);
    if (plain.status !== 200) continue;
    const visible = new Set(plain.body.runs.map(run => run.id));
    for (const run of delta.body.runs) assert.ok(visible.has(run.id), `${actor} sees ${run.id} only if the full read shows it`);
    for (const run of delta.body.runs) assert.deepEqual(run, plain.body.runs.find(item => item.id === run.id));
  }
});

test('cursor parsing and change kinds, without a server', () => {
  assert.equal(parseAssistantCursor(null), null);
  for (const bad of ['', 'v2.1.0.00000000.0123456789abcdef', 'v1.01.0.00000000.0123456789abcdef', 'v1.1.0.00000000.0123456789ABCDEF', 'v1.1.0.0123456789abcdef', 'v1.99999999999999999.0.00000000.0123456789abcdef'])
    assert.deepEqual(parseAssistantCursor(bad), { invalid: true }, bad);
  const since = parseAssistantCursor('v1.20000.3.89abcdef.0123456789abcdef');
  assert.deepEqual({ newest: since.newest, configRevision: since.configRevision, visibility: since.visibility, digest: since.digest }, { newest: 20000, configRevision: 3, visibility: '89abcdef', digest: '0123456789abcdef' });
  const same = { newest: 20000, configRevision: 3, visibility: '89abcdef', digest: '0123456789abcdef' };
  assert.equal(assistantChangeKind(null, same), 'plain');
  assert.equal(assistantChangeKind(since, same), 'none');
  assert.equal(assistantChangeKind(since, { ...same, digest: 'ffffffffffffffff' }), 'delta');
  assert.equal(assistantChangeKind(since, { ...same, configRevision: 4 }), 'full');
  assert.equal(assistantChangeKind(since, { ...same, visibility: '00000000', digest: 'ffffffffffffffff' }), 'full');
  assert.equal(assistantChangeKind(since, { ...same, newest: 10000, digest: 'ffffffffffffffff' }), 'full');
  const runs = [{ id: 'old', updatedAt: 20000 - LOOKBACK_MS - 1 }, { id: 'edge', updatedAt: 20000 - LOOKBACK_MS }, { id: 'new', updatedAt: 25000 }, { id: 'none' }];
  assert.deepEqual(changedRuns(runs, since).map(run => run.id), ['edge', 'new']);
  // The visibility mark moves with a deletion and with the reader's floor.
  const live = [{ id: 'm1' }, { id: 'm2' }];
  assert.match(assistantVisibilityMark(live, null), /^[0-9a-f]{8}$/);
  assert.notEqual(assistantVisibilityMark([{ id: 'm1', deletedAt: 5 }, { id: 'm2' }], null), assistantVisibilityMark(live, null));
  assert.notEqual(assistantVisibilityMark(live, 12), assistantVisibilityMark(live, null));
});

test('deleting a run\'s opening message answers full, so the run disappears at once (review 12188)', async t => {
  const { f, api, since, tick } = await setup(t);
  for (const actor of ['guest', 'owner', 'producer']) {
    const before = (await api(actor)).body;
    assert.deepEqual(ids(before), ['a', 'b'], actor);
    t.diagnostic(`${actor} cursor ${before.cursor}`);
  }
  const cursors = {};
  for (const actor of ['guest', 'owner', 'producer']) cursors[actor] = (await api(actor)).body.cursor;
  tick();
  f.store.command(f.keys.owner, 'commons', { id: randomUUID(), type: 'message.deleted', data: { messageId: 'a-opening', expectedMessageRevision: 0, reason: 'cleanup' } });
  for (const actor of ['guest', 'owner', 'producer']) {
    const plain = (await api(actor)).body, after = (await api(actor, null, since(cursors[actor]))).body;
    assert.equal(after.changes, 'full', actor);
    assert.notEqual(after.cursor, cursors[actor], actor);
    assert.deepEqual(after.runs, plain.runs, actor);
    assert.equal((await api(actor, null, since(after.cursor))).body.changes, 'none', actor);
  }
  // The guest no longer sees run a at all; it is not quoted from a stale delta.
  assert.deepEqual(ids((await api('guest', null, since(cursors.guest))).body), ['b']);
});
