/**
 * dm-room-wiring.test.js — tests for the 1:1 DM room wiring.
 *
 * Covers: canonical ordering, idempotent open, send validation (non-participant
 * rejected), block/unblock, unread counts, markRead, history pagination,
 * close/reopen, subscriber notifications, snapshot/restore, corrupt snapshot
 * rejection, and the coded-error contract.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDMRooms,
  canonicalPair,
  DM_SCHEMA_VERSION,
  DM_STATES,
} from '../src/dm-room-wiring.mjs';

/** Controllable clock: { now, clock(), advance(ms) }. */
function fakeClock(start = 1_000_000) {
  const box = { now: start };
  return {
    box,
    clock: () => box.now,
    advance: (ms) => {
      box.now += ms;
    },
  };
}

/** In-memory storage: { save, load, writes }. */
function memStorage() {
  const box = { state: null, writes: 0 };
  return {
    box,
    save: (state) => {
      box.state = state;
      box.writes += 1;
    },
    load: () => box.state,
  };
}

/** Fake deliver transport: records deliveries. */
function fakeDeliver() {
  const deliveries = [];
  return {
    deliveries,
    deliver: (d) => {
      deliveries.push(d);
    },
  };
}

function expectDMError(fn, code) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof Error, 'expected an Error');
    assert.equal(err.code, code, `expected code ${code}, got ${err.code}`);
    return true;
  });
}

describe('dm-room-wiring', () => {
  it('canonical ordering: dm(a,b) === dm(b,a)', () => {
    assert.deepEqual(canonicalPair('quill', 'instinct'), ['instinct', 'quill']);
    assert.deepEqual(canonicalPair('instinct', 'quill'), ['instinct', 'quill']);
  });

  it('openDM is idempotent and canonical', () => {
    const w = createDMRooms();
    const r1 = w.openDM('quill', 'instinct');
    assert.equal(r1.agentA, 'instinct');
    assert.equal(r1.agentB, 'quill');
    assert.equal(r1.state, 'open');
    assert.deepEqual(r1.messages, []);

    const r2 = w.openDM('instinct', 'quill');
    assert.equal(r2.id, r1.id, 'same pair in either order returns the same room');
    assert.equal(w.listDMs('quill').length, 1, 'only one room exists for the pair');
  });

  it('openDM validates args', () => {
    const w = createDMRooms();
    expectDMError(() => w.openDM('quill', 'quill'), 'DM_INVALID_ARG');
    expectDMError(() => w.openDM('', 'instinct'), 'DM_INVALID_ARG');
    expectDMError(() => w.openDM('quill', null), 'DM_INVALID_ARG');
  });

  it('sendDM happy path: stores message, bumps unread, calls deliver', () => {
    const t = fakeDeliver();
    const w = createDMRooms({ deliver: t.deliver });
    const room = w.openDM('quill', 'instinct');
    const msg = w.sendDM(room.id, 'quill', 'hello');
    assert.equal(msg.from, 'quill');
    assert.equal(msg.text, 'hello');
    assert.ok(msg.id);
    assert.ok(Number.isInteger(msg.at));

    assert.equal(t.deliveries.length, 1);
    assert.equal(t.deliveries[0].roomId, room.id);
    assert.equal(t.deliveries[0].from, 'quill');
    assert.equal(t.deliveries[0].to, 'instinct');
    assert.equal(t.deliveries[0].message.id, msg.id);

    assert.equal(w.unreadCount(room.id, 'instinct'), 1);
    assert.equal(w.unreadCount(room.id, 'quill'), 0, 'sender unread untouched');
  });

  it('sendDM rejects non-participant senders', () => {
    const w = createDMRooms();
    const room = w.openDM('quill', 'instinct');
    expectDMError(() => w.sendDM(room.id, 'grokbot', 'hi'), 'DM_INVALID_ARG');
    assert.equal(w.history(room.id).messages.length, 0, 'nothing stored on failure');
  });

  it('sendDM rejects unknown rooms, empty text, and closed rooms', () => {
    const w = createDMRooms();
    expectDMError(() => w.sendDM('nope', 'quill', 'hi'), 'DM_NOT_FOUND');
    const room = w.openDM('quill', 'instinct');
    expectDMError(() => w.sendDM(room.id, 'quill', ''), 'DM_INVALID_ARG');
    w.closeDM(room.id);
    expectDMError(() => w.sendDM(room.id, 'quill', 'hi'), 'DM_CLOSED');
  });

  it('sendDM surfaces deliver failures as DM_DELIVER_FAILED without losing the message', () => {
    const w = createDMRooms({
      deliver: () => {
        throw new Error('boom');
      },
    });
    const room = w.openDM('quill', 'instinct');
    expectDMError(() => w.sendDM(room.id, 'quill', 'hi'), 'DM_DELIVER_FAILED');
    assert.equal(w.history(room.id).messages.length, 1, 'message stored before deliver');
  });

  it('block/unblock: blocked pairs cannot open rooms and sends are rejected', () => {
    const w = createDMRooms();
    w.block('quill', 'instinct');
    assert.equal(w.isBlocked('instinct', 'quill'), true, 'block is order-independent');
    expectDMError(() => w.openDM('quill', 'instinct'), 'DM_CANNOT_OPEN');

    const room = w.openDM('quill', 'grokbot');
    w.block('grokbot', 'quill');
    expectDMError(() => w.sendDM(room.id, 'quill', 'hi'), 'DM_BLOCKED');

    w.unblock('quill', 'instinct');
    assert.equal(w.isBlocked('quill', 'instinct'), false);
    const reopened = w.openDM('instinct', 'quill');
    assert.equal(reopened.state, 'open');

    w.unblock('quill', 'grokbot');
    w.sendDM(room.id, 'quill', 'hi again');
    assert.equal(w.history(room.id).messages.length, 1);
  });

  it('unread counts and markRead', () => {
    const w = createDMRooms();
    const r1 = w.openDM('quill', 'instinct');
    const r2 = w.openDM('quill', 'grokbot');
    w.sendDM(r1.id, 'instinct', 'one');
    w.sendDM(r1.id, 'instinct', 'two');
    w.sendDM(r2.id, 'grokbot', 'three');

    assert.equal(w.unreadCount(r1.id, 'quill'), 2);
    assert.equal(w.unreadTotal('quill'), 3);
    assert.equal(w.unreadTotal('instinct'), 0);

    w.markRead(r1.id, 'quill');
    assert.equal(w.unreadCount(r1.id, 'quill'), 0);
    assert.equal(w.unreadTotal('quill'), 1);

    expectDMError(() => w.markRead(r1.id, 'grokbot'), 'DM_INVALID_ARG');
  });

  it('history pagination: limit and before', () => {
    const w = createDMRooms();
    const room = w.openDM('quill', 'instinct');
    const ids = [];
    for (let i = 0; i < 5; i += 1) {
      ids.push(w.sendDM(room.id, i % 2 === 0 ? 'quill' : 'instinct', `m${i}`).id);
    }
    const all = w.history(room.id);
    assert.equal(all.messages.length, 5);
    assert.equal(all.hasMore, false);
    assert.deepEqual(all.messages.map((m) => m.text), ['m0', 'm1', 'm2', 'm3', 'm4']);

    const tail = w.history(room.id, 2);
    assert.deepEqual(tail.messages.map((m) => m.text), ['m3', 'm4']);
    assert.equal(tail.hasMore, true);

    const before = w.history(room.id, 50, ids[3]);
    assert.deepEqual(before.messages.map((m) => m.text), ['m0', 'm1', 'm2']);
    assert.equal(before.hasMore, false);

    const unknown = w.history(room.id, 50, 'nope');
    assert.deepEqual(unknown.messages, []);
    assert.equal(unknown.hasMore, false);

    expectDMError(() => w.history(room.id, 0), 'DM_INVALID_ARG');
    expectDMError(() => w.history('nope'), 'DM_NOT_FOUND');
  });

  it('close/reopen lifecycle', () => {
    const w = createDMRooms();
    const room = w.openDM('quill', 'instinct');
    assert.equal(w.closeDM(room.id).state, 'closed');
    expectDMError(() => w.closeDM(room.id), 'DM_CANNOT_OPEN');
    assert.equal(w.reopenDM(room.id).state, 'open');
    expectDMError(() => w.reopenDM(room.id), 'DM_CANNOT_OPEN');
    expectDMError(() => w.closeDM('nope'), 'DM_NOT_FOUND');

    // openDM on an existing closed room returns the closed room, not a new one
    w.closeDM(room.id);
    const again = w.openDM('instinct', 'quill');
    assert.equal(again.id, room.id);
    assert.equal(again.state, 'closed');
  });

  it('listDMs returns only the agent’s rooms', () => {
    const w = createDMRooms();
    w.openDM('quill', 'instinct');
    w.openDM('quill', 'grokbot');
    w.openDM('instinct', 'grokbot');
    assert.equal(w.listDMs('quill').length, 2);
    assert.equal(w.listDMs('grokbot').length, 2);
    assert.equal(w.listDMs('codex').length, 0);
    expectDMError(() => w.listDMs(''), 'DM_INVALID_ARG');
  });

  it('subscriber notifications fire for room and message events', () => {
    const w = createDMRooms();
    const seen = [];
    const unsub = w.onEvent((e) => seen.push(e.type));

    const room = w.openDM('quill', 'instinct');
    w.sendDM(room.id, 'quill', 'hi');
    w.closeDM(room.id);
    w.reopenDM(room.id);
    w.block('quill', 'codex');
    w.unblock('quill', 'codex');
    w.markRead(room.id, 'instinct');

    assert.deepEqual(seen, [
      'room.opened',
      'message.sent',
      'room.closed',
      'room.reopened',
      'agent.blocked',
      'agent.unblocked',
      'room.read',
    ]);

    unsub();
    w.openDM('quill', 'grokbot');
    assert.equal(seen.length, 7, 'unsubscribed listener sees nothing new');

    expectDMError(() => w.onEvent('nope'), 'DM_INVALID_ARG');
  });

  it('snapshot/restore round-trips state', () => {
    const store = memStorage();
    const w1 = createDMRooms({ storage: store });
    const room = w1.openDM('quill', 'instinct');
    w1.sendDM(room.id, 'quill', 'hello');
    w1.block('quill', 'codex');

    const snap = w1.snapshot();
    const parsed = JSON.parse(snap);
    assert.equal(parsed.version, DM_SCHEMA_VERSION);

    const w2 = createDMRooms();
    assert.equal(w2.restore(snap), true);
    assert.equal(w2.unreadCount(room.id, 'instinct'), 1);
    assert.equal(w2.history(room.id).messages[0].text, 'hello');
    assert.equal(w2.isBlocked('codex', 'quill'), true);
    expectDMError(() => w2.openDM('quill', 'codex'), 'DM_CANNOT_OPEN');
  });

  it('write-through storage hydrates a fresh store', () => {
    const store = memStorage();
    const w1 = createDMRooms({ storage: store });
    const room = w1.openDM('quill', 'instinct');
    w1.sendDM(room.id, 'quill', 'persisted');
    assert.ok(store.box.writes > 0, 'mutations write through to storage');

    const w2 = createDMRooms({ storage: store });
    assert.equal(w2.history(room.id).messages[0].text, 'persisted');
    const again = w2.openDM('instinct', 'quill');
    assert.equal(again.id, room.id, 'hydrated pair index keeps openDM idempotent');
  });

  it('restore rejects corrupt snapshots with DM_CORRUPT_SNAPSHOT', () => {
    const w = createDMRooms();
    expectDMError(() => w.restore('not json{{'), 'DM_CORRUPT_SNAPSHOT');
    expectDMError(
      () => w.restore(JSON.stringify({ version: 999, rooms: [], blocked: [] })),
      'DM_CORRUPT_SNAPSHOT',
    );
    expectDMError(() => w.restore(JSON.stringify({ version: DM_SCHEMA_VERSION })), 'DM_CORRUPT_SNAPSHOT');
    expectDMError(
      () =>
        w.restore(
          JSON.stringify({
            version: DM_SCHEMA_VERSION,
            rooms: [{ id: 'dm-x' }],
            blocked: [],
          }),
        ),
      'DM_CORRUPT_SNAPSHOT',
    );
    // message from a non-participant
    expectDMError(
      () =>
        w.restore(
          JSON.stringify({
            version: DM_SCHEMA_VERSION,
            rooms: [
              {
                id: 'dm-x',
                agentA: 'a',
                agentB: 'b',
                createdAt: 1,
                state: 'open',
                messages: [{ id: 'm1', from: 'zzz', text: 'x', at: 1 }],
                unread: {},
              },
            ],
            blocked: [],
          }),
        ),
      'DM_CORRUPT_SNAPSHOT',
    );
    // duplicate pair rooms
    const dupRoom = (id) => ({
      id,
      agentA: 'a',
      agentB: 'b',
      createdAt: 1,
      state: 'open',
      messages: [],
      unread: {},
    });
    expectDMError(
      () =>
        w.restore(
          JSON.stringify({ version: DM_SCHEMA_VERSION, rooms: [dupRoom('d1'), dupRoom('d2')], blocked: [] }),
        ),
      'DM_CORRUPT_SNAPSHOT',
    );
  });

  it('coded-error contract: every failure carries a code', () => {
    const w = createDMRooms();
    const room = w.openDM('quill', 'instinct');
    const cases = [
      [() => w.openDM('quill', 'quill'), 'DM_INVALID_ARG'],
      [() => w.sendDM('missing', 'quill', 'x'), 'DM_NOT_FOUND'],
      [() => w.sendDM(room.id, 'outsider', 'x'), 'DM_INVALID_ARG'],
      [() => w.closeDM('missing'), 'DM_NOT_FOUND'],
      [() => w.unreadCount('missing', 'quill'), 'DM_NOT_FOUND'],
      [() => w.restore('junk'), 'DM_CORRUPT_SNAPSHOT'],
    ];
    for (const [fn, code] of cases) {
      expectDMError(fn, code);
    }
    // DM_STATES documents the only legal room states
    assert.deepEqual([...DM_STATES], ['open', 'closed']);
  });

  it('fake clock drives createdAt and message timestamps', () => {
    const fc = fakeClock();
    const w = createDMRooms({ clock: fc.clock });
    fc.advance(5000);
    const room = w.openDM('quill', 'instinct');
    assert.equal(room.createdAt, 1_005_000);
    const msg = w.sendDM(room.id, 'quill', 'timed');
    assert.equal(msg.at, 1_005_000);
  });
});
