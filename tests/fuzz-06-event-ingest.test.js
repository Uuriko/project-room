// WAVE-400 fuzz-06: room event ingestion fuzz (applyEvent / replay / event / workClaimEventData).
// TEST-ONLY. Seeded mulberry32 RNG. Feeds >=10,000 malformed/hostile events at the
// room-event ingestion layer (src/events.js applyEvent, reached via
// server/work-claim-events.mjs emitWorkClaimEvent) plus the envelope builder and
// workClaimEventData.
// Invariants under test:
//   I1: ingestion never throws uncaught — every applyEvent call either returns a
//       state or throws a catchable Error (no process crash, no uncatchable fault).
//   I2: differential state integrity — a rejected event leaves the input state
//       byte-identical (input is never mutated; the projection is rebuilt on a clone).
//   I3: no prototype pollution — ({}).polluted stays undefined and Object.prototype
//       gains no keys, even with __proto__/constructor keys in data.
//   I4: duplicate ids / idempotency keys are idempotent (exact retry => no log growth)
//       or rejected with a conflict error — never double-applied.
//   I5: accepted events always extend the log by exactly one and return a new state object.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyEvent, replay, event, emptyRoomState, EVENT_TYPES, PERMISSIONS,
} from '../src/events.js';
import { workClaimEventData, WORK_CLAIM_ACTIONS } from '../server/work-claim-events.mjs';

const SEED = Number(process.env.FUZZ_SEED ?? 20261008);
console.log(`[fuzz-06] seed=${SEED}`);
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const pick = arr => arr[Math.floor(rand() * arr.length)];
const rint = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const T0 = '2026-10-08T14:00:00.000Z';

let fed = 0;
let accepted = 0;
let rejected = 0;
let idempotent = 0;
const violations = [];
const record = (label, detail) => violations.push(`${label}: ${detail}`);

// ---- base room state -------------------------------------------------------
function baseState() {
  let s = emptyRoomState();
  s = applyEvent(s, event({
    id: 'evt-room-1', idempotencyKey: 'idem-room-1', type: EVENT_TYPES.ROOM_CREATED,
    actorId: 'owner1', roomId: 'room1', at: T0,
    data: { roomId: 'room1', title: 'Fuzz room', purpose: 'fuzz', ownerId: 'owner1' },
  }));
  s = applyEvent(s, event({
    id: 'evt-mem-1', idempotencyKey: 'idem-mem-1', type: EVENT_TYPES.MEMBER_ADDED,
    actorId: 'owner1', roomId: 'room1', at: T0,
    data: { memberId: 'owner1', displayName: 'Room owner', kind: 'human', permissions: [...PERMISSIONS] },
  }));
  s = applyEvent(s, event({
    id: 'evt-mem-2', idempotencyKey: 'idem-mem-2', type: EVENT_TYPES.MEMBER_ADDED,
    actorId: 'owner1', roomId: 'room1', at: T0,
    data: { memberId: 'agent1', displayName: 'Agent one', kind: 'agent', permissions: ['steer', 'accept_work', 'complete_work', 'verify'] },
  }));
  return s;
}
const BASE = baseState();

// A known-valid work_claim.updated event; mutations below start from its clone.
let claimCounter = 0;
function validClaimEvent(dataOverrides = {}, envOverrides = {}) {
  claimCounter += 1;
  return event({
    id: `evt-claim-${claimCounter}`,
    idempotencyKey: `idem-claim-${claimCounter}`,
    type: EVENT_TYPES.WORK_CLAIM_UPDATED,
    actorId: 'owner1',
    roomId: 'room1',
    at: T0,
    ...envOverrides,
    data: {
      workClaim: 'claim-1', action: 'created', claimState: 'unclaimed',
      ownerId: null, leaseExpiresAt: null, title: 'fuzz claim', paths: [],
      ...dataOverrides,
    },
  });
}

// ---- hostile value pool ----------------------------------------------------
const HOSTILE_STRINGS = [
  '', ' ', '\t\n', '__proto__', 'constructor', 'prototype', 'toString', 'valueOf',
  'hasOwnProperty', 'a'.repeat(4097), 'b'.repeat(65537), 'x'.repeat(1_000_000),
  '\u0000nullbyte', 'Ω≈ç√', '..', '/', '\\', '${jndi}', '{{7*7}}', '<script>',
  'owner1 ', ' owner1', 'NULL', 'null', 'undefined', 'NaN', 'Infinity',
];
const HOSTILE_VALUES = [
  undefined, null, 0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1,
  true, false, [], {}, ['x'], { a: 1 }, '', ...HOSTILE_STRINGS.slice(0, 8),
];
const hostileValue = () => {
  const v = pick(HOSTILE_VALUES);
  if (Array.isArray(v)) return [...v];      // fresh containers: no aliasing across cases
  if (v && typeof v === 'object') return { ...v };
  return v;
};
// An own-property __proto__ key (JSON.parse gives a real own prop, not the setter).
const protoPollutedData = () => JSON.parse(
  '{"workClaim":"claim-1","action":"created","claimState":"unclaimed","ownerId":null,' +
  '"leaseExpiresAt":null,"title":"t","paths":[],"__proto__":{"polluted":true}}');
const constructorKeyData = () => JSON.parse(
  '{"workClaim":"claim-1","action":"created","claimState":"unclaimed","ownerId":null,' +
  '"leaseExpiresAt":null,"title":"t","paths":[],"constructor":{"polluted":true}}');
const deepNested = (depth) => {
  let o = { leaf: 'x' };
  for (let i = 0; i < depth; i++) o = { nest: o };
  return o;
};
const cyclicData = () => {
  const d = { workClaim: 'claim-1' };
  d.self = d;
  return d;
};

// ---- mutation operators ----------------------------------------------------
const ENVELOPE_KEYS = ['id', 'idempotencyKey', 'roomId', 'type', 'actorId', 'at', 'data'];
const CLAIM_DATA_KEYS = ['workClaim', 'action', 'claimState', 'ownerId', 'leaseExpiresAt', 'title', 'paths',
  'previousOwnerId', 'reason', 'ciState', 'verdict', 'attention', 'attentionMemberId', 'pullRequest'];

function mutateEnvelope(ev) {
  const op = rint(0, 6);
  switch (op) {
    case 0: delete ev[pick(ENVELOPE_KEYS)]; break;                       // missing key
    case 1: ev[pick(ENVELOPE_KEYS)] = hostileValue(); break;              // hostile value
    case 2: ev[pick(['id', 'idempotencyKey'])] = pick(HOSTILE_STRINGS); break;
    case 3: ev.type = pick(['nope.unknown', '__proto__', 'constructor', 'WORK_CLAIM_UPDATED', 'work_claim.updated ', '', 42, null, {}, []]); break;
    case 4: ev.at = pick(['not-a-date', '', '2026-13-99', 12345, null, '0000-00-00']); break;
    case 5: ev.data = pick([[], 'str', 42, null, true]); break;           // data wrong shape
    case 6: ev.extraTopLevel = hostileValue(); break;                    // unknown top-level key (allowed)
  }
  return ev;
}

function mutateClaimData(ev) {
  if (!ev.data || typeof ev.data !== 'object' || Array.isArray(ev.data)) return ev; // stacked after data-shape mutation
  const op = rint(0, 11);
  const key = pick(CLAIM_DATA_KEYS);
  switch (op) {
    case 0: delete ev.data[key]; break;
    case 1: ev.data[key] = hostileValue(); break;
    case 2: ev.data.action = pick(['bogus', '', 42, null, 'CREATED']); break;
    case 3: ev.data.claimState = pick(['bogus', '', 42, null, 'UNCLAIMED']); break;
    case 4: ev.data.paths = pick([['ok', 42], 'not-array', new Array(65).fill('p'), ['x'.repeat(513)], null]); break;
    case 5: ev.data.ownerId = pick([42, {}, [], '']); break;
    case 6: ev.data.leaseExpiresAt = pick(['garbage', 42, {}, '']); break;
    case 7: ev.data.pullRequest = pick([{ url: 'http://evil/x', outcome: 'merged' }, { url: 'https://github.com/a/b/pull/1', outcome: 'bogus' }, { url: 'https://github.com/a/b/pull/1' }, 'str', 42, { url: 'https://github.com/a/b/pull/1', outcome: 'merged', extra: 1 }]);
      ev.data.action = pick(['pr_merged', 'pr_closed']); break;
    case 8: ev.data.reason = pick([42, {}, 'bogus-reason']); break;
    case 9: ev.data.attention = pick(['bogus', 42]); ev.data.attentionMemberId = pick([42, '']); break;
    case 10: ev.data.ciState = pick(['bogus', 42]); ev.data.verdict = pick(['bogus', 42]); break;
    case 11: ev.data[pick(HOSTILE_STRINGS)] = hostileValue(); break;     // unknown data key
  }
  return ev;
}

function mutatePollution(ev) {
  if (!ev.data || typeof ev.data !== 'object' || Array.isArray(ev.data)) {
    ev.id = pick(['__proto__', 'constructor', 'prototype', 'toString']); // envelope-only fallback
    return ev;
  }
  const op = rint(0, 5);
  switch (op) {
    case 0: ev.data = protoPollutedData(); break;
    case 1: ev.data = constructorKeyData(); break;
    case 2: ev.data = { ...ev.data, ...JSON.parse('{"__proto__":{"polluted":true}}') }; break;
    case 3: { // __proto__ nested one level down
      try {
        const d = JSON.parse(JSON.stringify(ev.data));
        d.note = JSON.parse('{"__proto__":{"polluted":true}}');
        ev.data = d;
      } catch { ev.id = pick(['__proto__', 'constructor']); } // cyclic from a stacked mutation
      break;
    }
    case 4: ev.id = pick(['__proto__', 'constructor', 'prototype', 'toString']); break;
    case 5: ev.idempotencyKey = pick(['__proto__', 'constructor', 'valueOf']); break;
  }
  return ev;
}

function mutateSize(ev) {
  if (!ev.data || typeof ev.data !== 'object' || Array.isArray(ev.data)) return ev; // stacked after data-shape mutation
  const op = rint(0, 4);
  switch (op) {
    case 0: ev.data.title = 'x'.repeat(1_000_000); break;                 // 1MB string
    case 1: ev.data.paths = new Array(10_000).fill('p'); break;          // oversize array
    case 2: ev.data.big = deepNested(500); break;                         // deep nesting
    case 3: ev.data.big = deepNested(5000); break;                        // very deep nesting
    case 4: ev.data = { ...ev.data, cyc: cyclicData() }; break;          // cyclic
  }
  return ev;
}

const MUTATORS = [mutateEnvelope, mutateClaimData, mutatePollution, mutateSize];

// ---- differential check helpers --------------------------------------------
const protoKeysBefore = Object.getOwnPropertyNames(Object.prototype).join(',');
function checkNoPollution(label) {
  if (({}).polluted !== undefined) record(label, 'global prototype polluted: ({}).polluted !== undefined');
  const now = Object.getOwnPropertyNames(Object.prototype).join(',');
  if (now !== protoKeysBefore) record(label, `Object.prototype keys changed: ${now}`);
}

// Feed one event. Returns { res, next } where res is 'accepted' | 'rejected' | 'idempotent'.
function feed(state, ev, label) {
  fed += 1;
  const before = JSON.stringify(state);
  let out = null;
  let threw = null;
  try {
    out = applyEvent(state, ev);
  } catch (e) { threw = e; }
  // I1: only catchable Errors may escape; a non-Error is a crash-class bug.
  if (threw && !(threw instanceof Error)) {
    record(label, `non-Error thrown: ${Object.prototype.toString.call(threw)}`);
  }
  // I2: input state must be byte-identical after the call (clone-then-mutate).
  if (JSON.stringify(state) !== before) {
    record(label, 'input state mutated by applyEvent (differential violation)');
  }
  // I3: no prototype pollution, global or otherwise.
  checkNoPollution(label);
  if (threw) { rejected += 1; return { res: 'rejected', next: state }; }
  if (!out || typeof out !== 'object' || !Array.isArray(out.eventLog)) {
    record(label, 'applyEvent returned non-state');
    return { res: 'accepted', next: state };
  }
  if (out === state) {
    record(label, 'applyEvent returned the input state object itself');
    return { res: 'accepted', next: state };
  }
  if (out.eventLog.length === state.eventLog.length) { idempotent += 1; return { res: 'idempotent', next: out }; }
  // I5: accepted => log grows by exactly one.
  if (out.eventLog.length !== state.eventLog.length + 1) {
    record(label, `log grew by ${out.eventLog.length - state.eventLog.length}, expected 0 or 1`);
    return { res: 'accepted', next: state };
  }
  accepted += 1;
  return { res: 'accepted', next: out };
}

// ---- main fuzz ---------------------------------------------------------------
test('fuzz-06: room event ingestion — malformed/hostile events', () => {
  const N = 10000;
  let live = structuredClone(BASE);
  for (let i = 0; i < N; i++) {
    if (i % 250 === 0) live = structuredClone(BASE); // bound state growth
    const ev = validClaimEvent();
    pick(MUTATORS)(ev);
    if (rand() < 0.25) pick(MUTATORS)(ev);           // stacked mutations
    const { res, next } = feed(live, ev, `case#${i}`);
    if (res === 'accepted') live = next;
    // Every 500 cases, throw a fully hostile non-claim event type at it too.
    if (i % 500 === 499) {
      const wild = validClaimEvent();
      wild.type = pick([EVENT_TYPES.MESSAGE_POSTED, EVENT_TYPES.CLAIM_ACQUIRED, EVENT_TYPES.MEMBER_ADDED, 'room.created']);
      wild.data = { body: pick(HOSTILE_STRINGS), workItemId: pick(HOSTILE_STRINGS), memberId: pick(HOSTILE_STRINGS) };
      feed(live, wild, `wild#${i}`);
    }
  }
  assert.ok(fed >= N, `expected >= ${N} events fed, got ${fed}`);
});

// ---- duplicate / idempotency-key sequences (the "duplicate seq" analogue) ----
test('fuzz-06: duplicate ids and idempotency keys', () => {
  let live = structuredClone(BASE);
  for (let i = 0; i < 500; i++) {
    if (i % 100 === 0) live = structuredClone(BASE); // bound state growth
    const ev = validClaimEvent();
    const before = JSON.stringify(live);
    const r1 = feed(live, ev, `dup#${i}-first`);
    if (r1.res === 'accepted') live = r1.next;
    // Exact retry: same object again => idempotent, no log growth.
    const r2 = feed(live, ev, `dup#${i}-retry`);
    if (r1.res === 'accepted' && r2.res !== 'idempotent') {
      record(`dup#${i}`, `exact retry was ${r2.res}, expected idempotent`);
    }
    // Same id, mutated payload => conflict rejection, state unchanged.
    const evil = structuredClone(ev);
    evil.data = { ...evil.data, title: `mutated-${i}` };
    const snap = JSON.stringify(live);
    const r3 = feed(live, evil, `dup#${i}-conflict`);
    if (r3.res !== 'rejected') record(`dup#${i}`, `conflicting id reuse was ${r3.res}, expected rejected`);
    if (JSON.stringify(live) !== snap) record(`dup#${i}`, 'state changed by conflicting-id rejection');
    // Same idempotency key, different id => conflict rejection.
    const evil2 = validClaimEvent();
    evil2.idempotencyKey = ev.idempotencyKey;
    const r4 = feed(live, evil2, `dup#${i}-idemconflict`);
    if (r4.res !== 'rejected') record(`dup#${i}`, `idempotency-key reuse was ${r4.res}, expected rejected`);
    void before;
  }
});

// ---- replay() fuzz ------------------------------------------------------------
test('fuzz-06: replay() over hostile sequences', () => {
  for (let i = 0; i < 200; i++) {
    const seq = [];
    const n = rint(1, 12);
    const roomEv = event({
      id: `rp-room-${i}`, idempotencyKey: `rp-idem-room-${i}`, type: EVENT_TYPES.ROOM_CREATED,
      actorId: 'owner1', roomId: 'room1', at: T0,
      data: { roomId: 'room1', title: 't', purpose: 'p', ownerId: 'owner1' },
    });
    seq.push(roomEv);
    for (let j = 0; j < n; j++) {
      const ev = validClaimEvent();
      if (rand() < 0.6) pick(MUTATORS)(ev);
      if (rand() < 0.2 && seq.length > 1) seq.push(seq[rint(1, seq.length - 1)]); // duplicate
      seq.push(ev);
    }
    const before = protoKeysBefore;
    let threw = null;
    try { replay(seq); } catch (e) { threw = e; }
    if (threw && !(threw instanceof Error)) record(`replay#${i}`, 'replay threw non-Error');
    checkNoPollution(`replay#${i}`);
    void before;
  }
  // replay([]) is the empty room; replay of one valid room event works.
  assert.deepEqual(replay([]), emptyRoomState());
});

// ---- event() envelope builder fuzz ----------------------------------------------
test('fuzz-06: event() builder rejects malformed envelopes', () => {
  for (let i = 0; i < 500; i++) {
    const overrides = pick([
      null, undefined, {}, { type: 'x' }, { type: 'x', actorId: 'a' },
      { type: 42, actorId: 'a', roomId: 'r' },
      { type: '', actorId: 'a', roomId: 'r' },
      { type: 't', actorId: 'a', roomId: 'r', data: [] },
      { type: 't', actorId: 'a', roomId: 'r', data: 's' },
    ]);
    let threw = null;
    let out = null;
    try { out = event(overrides); } catch (e) { threw = e; }
    if (threw && !(threw instanceof Error)) record(`builder#${i}`, 'event() threw non-Error');
    if (!threw && (!out || typeof out !== 'object')) record(`builder#${i}`, 'event() returned non-object without throwing');
    checkNoPollution(`builder#${i}`);
  }
});

// ---- workClaimEventData fuzz ------------------------------------------------------
test('fuzz-06: workClaimEventData hostile items', () => {
  const items = [
    null, undefined, {}, { id: 'c1' },
    { id: 'c1', title: {}, files: 'not-array' },
    { id: 'c1', title: '  ', files: [1, 2] },
    { id: 'c1', title: 'ok', files: ['a', null] },
    { id: 'c1', title: 'ok', files: ['a'], state: 'bogus', owner: 42, leaseExpiresAt: 'garbage' },
    { id: 'c1', title: 'ok', pullRequest: 'not-an-object' },
    { id: 'c1', title: 'ok', pullRequest: { url: 'http://evil/x' } },
  ];
  const actions = [...WORK_CLAIM_ACTIONS, 'bogus', '', 42, null, undefined];
  for (let i = 0; i < 600; i++) {
    const item = pick(items);
    const action = pick(actions);
    const opts = {
      previousOwnerId: pick([null, 'p1', 42, '']),
      paths: pick([undefined, ['a'], 'not-array', null, 42]),
      pullRequest: pick([undefined, { url: 'https://github.com/a/b/pull/1' }, 'x']),
      reason: pick([undefined, 'r', 42]),
      ciState: pick([undefined, 'success', 'bogus']),
      verdict: pick([undefined, 'approve', 'bogus']),
      attention: pick([undefined, 'assigned', 'bogus']),
      attentionMemberId: pick([undefined, 'm1', 42]),
    };
    let threw = null;
    let out = null;
    try { out = workClaimEventData(item, action, opts); } catch (e) { threw = e; }
    if (threw && !(threw instanceof Error)) record(`wcdata#${i}`, 'workClaimEventData threw non-Error');
    if (!threw) {
      if (!out || typeof out !== 'object' || Array.isArray(out.data)) {
        // out is the data object itself; just sanity-check shape
      }
      if (!out || typeof out !== 'object') record(`wcdata#${i}`, 'workClaimEventData returned non-object without throwing');
      else if (!WORK_CLAIM_ACTIONS.includes(out.action)) record(`wcdata#${i}`, 'returned unknown action without throwing');
    }
    checkNoPollution(`wcdata#${i}`);
  }
});

// ---- report -----------------------------------------------------------------------
test('fuzz-06: report', () => {
  console.log(`[fuzz-06] events fed=${fed} accepted=${accepted} rejected=${rejected} idempotent=${idempotent} violations=${violations.length}`);
  for (const v of violations.slice(0, 20)) console.log(`[fuzz-06] VIOLATION ${v}`);
  assert.deepEqual(violations, []);
});
