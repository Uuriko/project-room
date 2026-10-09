import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRoomServer } from '../server/http.mjs';
import { EVENT_TYPES as T } from '../src/events.js';

// F1 (WAVE-300): shared SSE pump per room. The fake store below implements
// the store surface the stream path touches; its eventsAfter() returns the
// RAW page (what { includeInvisible: true } means on the real store) and
// counts calls so the tests can assert the pump fetches once per room per
// tick instead of once per stream per tick.
const tok = name => (name + 'x'.repeat(43)).slice(0, 43);
const err = (status, code) => Object.assign(new Error(code), { status, code });

function fakeStore() {
  const members = {
    'member-a': { id: 'member-a', active: true },
    'member-b': { id: 'member-b', active: true },
    'member-c': { id: 'member-c', active: true },
  };
  const tokens = new Map(); // token -> memberId
  const revoked = new Set();
  const rooms = new Map(); // roomId -> { events: [{ sequence, event }] }
  const store = {
    eventsAfterCalls: 0,
    addMemberToken(memberId, name) { const t = tok(name); tokens.set(t, memberId); return t; },
    revoke(token) { revoked.add(token); },
    roomEvents(roomId) {
      let room = rooms.get(roomId);
      if (!room) { room = { events: [] }; rooms.set(roomId, room); }
      return room;
    },
    post(roomId, event) {
      const room = this.roomEvents(roomId);
      const sequence = room.events.length + 1;
      room.events.push({ sequence, event: { id: `evt-${sequence}`, ...event } });
      return sequence;
    },
    authenticate(token, roomId) {
      const memberId = tokens.get(token);
      if (!memberId || revoked.has(token)) throw err(401, 'unauthenticated');
      return { member: members[memberId], credentialHash: `hash-${token}`, credentialScope: 'room', kind: 'identity', sessionBinding: null };
    },
    eventsAfter(token, roomId, after = 0, limit = 100) {
      this.eventsAfterCalls++;
      const room = this.roomEvents(roomId);
      const sequence = room.events.length;
      if (after > sequence) throw err(409, 'cursor_ahead');
      const rows = room.events.filter(row => row.sequence > after).slice(0, limit);
      const reachedEnd = rows.length < limit;
      const next = reachedEnd ? sequence : rows.at(-1).sequence;
      // Raw page: no per-viewer filtering (the shared pump fans out per
      // viewer itself, exactly like { includeInvisible: true }).
      return { events: rows, next, hasMore: next < sequence };
    },
    room(roomId) {
      void roomId;
      return { state: { messages: [], room: { ownerId: 'owner' } } };
    },
    roomAuthority(roomId) {
      return { ownerId: 'owner', sequence: this.roomEvents(roomId).events.length, members };
    },
    historyFloor() { return null; },
    bonds: { identityForMember() { return null; } },
  };
  return store;
}

async function fixture(t, { streamInterval = 40 } = {}) {
  const store = fakeStore();
  // Room 'room-a': two public messages and one DM (member-a -> member-b).
  store.post('room-a', { type: T.MESSAGE_POSTED, actorId: 'member-a', data: { body: 'hello' } });
  store.post('room-a', { type: T.MESSAGE_POSTED, actorId: 'member-a', data: { body: 'secret', toMemberId: 'member-b' } });
  store.post('room-a', { type: T.MESSAGE_POSTED, actorId: 'member-c', data: { body: 'world' } });
  store.post('room-b', { type: T.MESSAGE_POSTED, actorId: 'member-a', data: { body: 'other room' } });
  const tokenA = store.addMemberToken('member-a', 'token-a');
  const tokenB = store.addMemberToken('member-b', 'token-b');
  const tokenC = store.addMemberToken('member-c', 'token-c');
  const server = createRoomServer({ store, streamInterval });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const readers = [];
  t.after(async () => {
    for (const reader of readers) await reader.cancel().catch(() => {});
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  async function open(roomId, token, { after = 0, lastEventId = null } = {}) {
    const headers = { Authorization: `Bearer ${token}` };
    if (lastEventId !== null) headers['Last-Event-ID'] = String(lastEventId);
    const response = await fetch(`${origin}/api/rooms/${roomId}/stream?after=${after}`, { headers });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    readers.push(reader);
    const stream = { response, reader, ids: [], frames: [], done: false, buffer: '' };
    const decoder = new TextDecoder();
    stream.pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) { stream.done = true; return; }
        stream.buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = stream.buffer.indexOf('\n\n')) !== -1) {
          const frame = stream.buffer.slice(0, idx);
          stream.buffer = stream.buffer.slice(idx + 2);
          stream.frames.push(frame);
          const id = /^id: (\d+)$/m.exec(frame)?.[1];
          if (id !== undefined && frame.includes('event: room-event')) stream.ids.push(Number(id));
        }
      }
    })();
    return stream;
  }
  async function waitFor(stream, wantIds, timeoutMs = 3000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (wantIds.every(id => stream.ids.includes(id))) return;
      await sleep(25);
    }
    assert.deepEqual(stream.ids, wantIds, `stream received ${JSON.stringify(stream.ids)}, wanted ${JSON.stringify(wantIds)}`);
  }
  return { store, open, waitFor, tokenA, tokenB, tokenC };
}

test('shared pump fetches once per tick per room, not once per stream', async t => {
  const { store, open } = await fixture(t);
  const streams = [];
  for (let i = 0; i < 10; i++) {
    const token = store.addMemberToken(['member-a', 'member-b', 'member-c'][i % 3], `many-${i}`);
    streams.push(await open('room-a', token));
  }
  await sleep(120); // let opens settle; opens each trigger one shared fetch
  const before = store.eventsAfterCalls;
  await sleep(250); // ~6 ticks at 40ms
  const delta = store.eventsAfterCalls - before;
  assert.ok(delta >= 2, `pump ticked at all (delta=${delta})`);
  assert.ok(delta < 10, `one fetch per tick, not per stream (delta=${delta} for 10 streams)`);
  void streams;
});

test('each stream receives exactly its visible events in order', async t => {
  const { open, tokenA, tokenB, tokenC } = await fixture(t);
  const streamA = await open('room-a', tokenA); // DM sender: sees all
  const streamB = await open('room-a', tokenB); // DM addressee: sees all
  const streamC = await open('room-a', tokenC); // outsider: no DM
  const streamLate = await open('room-a', tokenA, { after: 2 }); // resume cursor
  const start = Date.now();
  while (Date.now() - start < 3000) {
    if (streamA.ids.length >= 3 && streamB.ids.length >= 3 && streamC.ids.length >= 2 && streamLate.ids.length >= 1) break;
    await sleep(25);
  }
  assert.deepEqual(streamA.ids, [1, 2, 3], 'DM sender sees everything in order');
  assert.deepEqual(streamB.ids, [1, 2, 3], 'DM addressee sees everything in order');
  assert.deepEqual(streamC.ids, [1, 3], 'outsider never sees the DM');
  assert.deepEqual(streamLate.ids, [3], 'after=2 resumes past earlier events');
});

test('Last-Event-ID resume continues from the shared cursor', async t => {
  const { store, open } = await fixture(t);
  const first = await open('room-a', store.addMemberToken('member-a', 'resume-1'));
  const start = Date.now();
  while (first.ids.length < 3 && Date.now() - start < 3000) await sleep(25);
  assert.deepEqual(first.ids, [1, 2, 3]);
  await first.reader.cancel();
  const seq4 = store.post('room-a', { type: T.MESSAGE_POSTED, actorId: 'member-b', data: { body: 'after resume' } });
  const second = await open('room-a', store.addMemberToken('member-a', 'resume-2'), { lastEventId: 3 });
  const begin = Date.now();
  while (second.ids.length < 1 && Date.now() - begin < 3000) await sleep(25);
  assert.deepEqual(second.ids, [seq4], 'resumed stream receives only events after its cursor');
});

test('a revoked credential ends only its stream with access-ended', async t => {
  const { store, open } = await fixture(t);
  const tokenA = store.addMemberToken('member-a', 'revoke-a');
  const tokenB = store.addMemberToken('member-b', 'revoke-b');
  const streamA = await open('room-a', tokenA);
  const streamB = await open('room-a', tokenB);
  await sleep(120);
  store.revoke(tokenB);
  const start = Date.now();
  while (!streamB.done && Date.now() - start < 3000) await sleep(25);
  assert.ok(streamB.done, 'revoked stream ended');
  assert.ok(streamB.frames.some(f => f.includes('event: access-ended')), 'revoked stream got access-ended');
  assert.ok(!streamA.done, 'healthy peer stream stays open');
  assert.ok(streamA.frames.length > 0, 'healthy peer keeps receiving frames');
});

test('rooms pump independently on their own intervals', async t => {
  const { store, open } = await fixture(t);
  const streamA = await open('room-a', store.addMemberToken('member-a', 'iso-a'));
  const streamBx = await open('room-b', store.addMemberToken('member-b', 'iso-b'));
  const seq = store.post('room-a', { type: T.MESSAGE_POSTED, actorId: 'member-c', data: { body: 'room-a only' } });
  const start = Date.now();
  while (!streamA.ids.includes(seq) && Date.now() - start < 3000) await sleep(25);
  assert.ok(streamA.ids.includes(seq), 'room-a stream got the room-a event');
  await sleep(150);
  assert.ok(!streamBx.ids.includes(seq), 'room-b stream never sees room-a events');
  assert.deepEqual(streamBx.ids, [1], 'room-b stream only has its own room events');
});
