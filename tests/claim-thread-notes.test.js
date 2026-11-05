// MVP flow: owner assigns a claim with an ask; the agent finishes it with a
// result note. The claim thread must show both, not only the state changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
import { attachEventNotes } from '../server/claim-thread.mjs';

test('attachEventNotes pairs each event with its own history note once', () => {
  const events = [{ at: 't1', actorId: 'o', action: 'claimed' }, { at: 't2', actorId: 'a', action: 'state_changed' }];
  const history = [{ at: 't1', agentId: 'o', action: 'created', note: 'ask' }, { at: 't1', agentId: 'a', action: 'retention_ack', note: 'x' },
    { at: 't2', agentId: 'a', action: 'state:done', note: 'result' }, { at: 't2', agentId: 'a', action: 'noted', note: 'own row' }];
  assert.deepEqual(attachEventNotes(events, history).map(e => e.note), ['ask', 'result']);
});

test('claim thread shows the ask and the result note', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'room-claim-thread-notes-'));
  const store = new RoomStore(join(directory, 'room.sqlite')); store.initialize(initialRoom());
  const server = createRoomServer({ store }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeStreams(); server.closeAllConnections(); server.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const token = store.issueAccessKey('commons', 'owner');
  const call = async (path, data) => {
    const result = await fetch(`${origin}/api/rooms/commons/work-claims${path}`, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, Origin: origin, 'Content-Type': 'application/json' },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return { status: result.status, body: await result.json().catch(() => null) };
  };
  assert.equal((await call('', { id: 'notes-1', title: 'Summarize', note: 'Reply with a one-line summary' })).status, 201);
  assert.equal((await call('/notes-1/claim', { leaseHours: 1 })).status, 200);
  assert.equal((await call('/notes-1/update', { state: 'in_progress' })).status, 200);
  assert.equal((await call('/notes-1/update', { state: 'done', deliveryMode: 'result', note: 'Summary: it works.' })).status, 200);
  const thread = await call('/notes-1/thread');
  assert.equal(thread.status, 200);
  const notes = thread.body.entries.map(entry => entry.note).filter(Boolean);
  assert.ok(notes.includes('Summary: it works.'), `result note missing: ${JSON.stringify(thread.body.entries)}`);
  assert.equal(notes.filter(note => note === 'Summary: it works.').length, 1);
});
