// P2 — history monotonicity (PRODUCT-200 reliability, worker C3).
//
// Property: after ANY op sequence (200 seeded sequences of 6-20 random
// ops, ~15% of ops faulted mid-write), every claim's history is:
//   * append-only — the stored history is exactly the stamps the successful
//     ops appended, in order; a faulted or refused op appends nothing;
//   * ordered — stamp `at` timestamps are strictly increasing;
//   * duplicate-free — no stamp appears twice;
//   * gapless in round numbering — rounds are numbered by round-start
//     stamps in history order (see roundStartOf below); round numbers are
//     non-decreasing, start at 0, and hit every integer 1..R with no gaps.
//
// Method: an independent model replays each op through the PURE state
// machine (server/work-claims.mjs) on detached items — never through the
// registry under test. After the sequence, every stored row's parsed
// envelope is deep-compared against the model's expected envelope, then
// the history invariants are asserted on the full (untrimmed) stamp
// sequence the model recorded. Any lost, duplicated, or reordered stamp —
// the classic symptoms of a torn write or a history-handling regression —
// fails the suite.
//
// Round definition (documented choice): a claim round starts when an owner
// takes the claim — a `claimed` stamp (fresh claim) or a `reassigned:<id>`
// stamp (ownership handed over; production clears attestations because
// reviews belong to the previous owner's round). `created` is round 0.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChaosFault,
  ROOM_ID,
  makeClaimRoom,
  makeClock,
  mulberry32,
  makeWorld,
  randomClaimOp,
  applyClaimOp,
  transitionForOp,
  snapshotState,
  expectedRowData,
  storedRowData,
  rowKey,
} from './work-claim-chaos-scaffold.mjs';
import { releaseExpired, claimHistoryLength } from '../../server/work-claims.mjs';

const SEQUENCES = 200;

// Round-start actions: taking ownership opens a new claim round.
const roundStartOf = stamp =>
  stamp.action === 'claimed' || stamp.action.startsWith('reassigned:');

// Pure-model result for one op: which rows the registry must have set or
// deleted. Throws exactly when the state machine refuses the op (mirrors
// the registry path, whose transitions start with workOf(item)).
function pureOpResult(model, op, nowMs) {
  switch (op.kind) {
    case 'create': {
      const next = transitionForOp(op, null, nowMs);
      return { sets: [[op.id, next]], deletes: [] };
    }
    case 'delete':
      return { sets: [], deletes: [op.id] };
    case 'sweep': {
      const ids = [...model.keys()];
      const next = releaseExpired(ids.map(id => model.get(id)), nowMs);
      return { sets: ids.map((id, i) => [id, next[i]]), deletes: [] };
    }
    default: {
      const before = model.has(op.id) ? model.get(op.id) : null;
      const next = transitionForOp(op, before, nowMs);
      return { sets: [[op.id, next]], deletes: [] };
    }
  }
}

function commitModel(model, fullStamps, op, result) {
  for (const id of result.deletes) { model.delete(id); fullStamps.delete(id); }
  for (const [id, next] of result.sets) {
    if (op.kind === 'create') {
      fullStamps.set(id, [...next.history]); // row replaced wholesale
    } else {
      const seen = new Set((model.get(id)?.history ?? []).map(s => JSON.stringify(s)));
      // `at` is globally unique (logical clock), so JSON identity is exact:
      // anything not seen before is a genuinely appended stamp, even across
      // the SEC-2 trim boundary.
      const appended = next.history.filter(s => !seen.has(JSON.stringify(s)));
      fullStamps.set(id, [...(fullStamps.get(id) ?? []), ...appended]);
    }
    model.set(id, next);
  }
}

function assertHistoryInvariants(id, full, storedItem) {
  // Ordered: strictly increasing `at`.
  for (let i = 1; i < full.length; i++) {
    assert.ok(full[i - 1].at < full[i].at,
      `${id}: history not ordered at index ${i - 1} -> ${i} (${full[i - 1].at} vs ${full[i].at})`);
  }
  // Duplicate-free.
  assert.equal(new Set(full.map(s => JSON.stringify(s))).size, full.length,
    `${id}: duplicate history stamps`);
  // Append-only vs the stored row: stored history is the newest <=200
  // stamps, older ones counted in historyOmitted (SEC-2 trim rule).
  assert.deepEqual(storedItem.history, full.slice(-200),
    `${id}: stored history is not the append-only suffix of the stamp sequence`);
  assert.equal(storedItem.historyOmitted ?? 0, Math.max(0, full.length - 200),
    `${id}: historyOmitted miscounts trimmed stamps`);
  assert.equal(claimHistoryLength(storedItem), full.length,
    `${id}: lifetime history length changed without an append`);
  // Round numbering: non-decreasing, starts at 0, no gaps in 1..R.
  let round = 0;
  const seenRounds = new Set([0]);
  for (const stamp of full) {
    if (roundStartOf(stamp)) round += 1;
    seenRounds.add(round);
  }
  for (let r = 1; r <= round; r++) {
    assert.ok(seenRounds.has(r), `${id}: gap in round numbering — round ${r} has no stamps`);
  }
}

describe('P2 history monotonicity: any op sequence keeps history append-only, ordered, duplicate-free, gapless', () => {
  for (let s = 0; s < SEQUENCES; s++) {
    it(`sequence ${s}: random ops with interleaved faults preserve history invariants`, () => {
      const rand = mulberry32(0x9157 + s * 104729);
      const clock = makeClock();
      const world = makeWorld(ROOM_ID, rand);
      const { storage, db, registry } = makeClaimRoom(clock);
      const model = new Map(); // id -> raw item (pure state machine output)
      const fullStamps = new Map(); // id -> full untrimmed stamp sequence

      const ops = 6 + Math.floor(rand() * 15);
      for (let o = 0; o < ops; o++) {
        if (rand() < 0.08) clock.advance(30 * 3600 * 1000); // time passes; leases lapse
        const op = randomClaimOp(world);
        const nowMs = clock.tick();
        const preSnap = snapshotState(storage);

        let expected = null;
        let modelThrew = false;
        try { expected = pureOpResult(model, op, nowMs); }
        catch { modelThrew = true; }

        // Interleave a partial failure on ~15% of ops: throw at a random
        // internal mutating step. A faulted op must append nothing.
        if (rand() < 0.15) {
          storage.armKillBeforeMutatingOp(storage.mutatingOps + 1 + Math.floor(rand() * 8));
        }
        let error = null;
        try { applyClaimOp(registry, world.roomId, op, nowMs); }
        catch (e) { error = e; }
        storage.disarmKill();

        const label = `seq=${s} op#${o} kind=${op.kind} id=${op.id ?? '-'}`;
        if (error instanceof ChaosFault) {
          assert.deepEqual(snapshotState(storage), preSnap,
            `${label}: faulted op changed durable state — a failed op must append nothing`);
          // Model keeps the pre-op expectation (the op never happened).
        } else if (error) {
          assert.ok(modelThrew,
            `${label}: registry refused (${error.constructor.name}: ${error.message}) but the pure model accepted`);
          assert.deepEqual(snapshotState(storage), preSnap,
            `${label}: refused op changed durable state`);
        } else {
          assert.ok(!modelThrew, `${label}: registry accepted but the pure model refused`);
          commitModel(model, fullStamps, op, expected);
        }
        assert.equal(db.isTransaction, false, `${label}: transaction flags stuck`);
      }

      // End of sequence: every stored row matches the independent model
      // byte-for-byte (parsed envelope), then the history invariants hold.
      for (const [id, item] of model) {
        const row = storage.state.work_claims.get(rowKey(ROOM_ID, id));
        assert.ok(row, `seq=${s}: model has claim ${id} but no row is stored`);
        assert.deepEqual(storedRowData(row.item_json), expectedRowData(item),
          `seq=${s}: stored row for ${id} diverged from the pure model (lost/duplicated/reordered data)`);
        const storedItem = registry.get(world.roomId, id);
        assertHistoryInvariants(id, fullStamps.get(id) ?? [], storedItem);
      }
      // No phantom rows: everything stored is in the model.
      for (const key of storage.state.work_claims.keys()) {
        const id = key.split('\0')[1];
        assert.ok(model.has(id), `seq=${s}: phantom stored row for ${id}`);
      }
    });
  }

  it('SEC-2 trim boundary: past 200 stamps the newest 200 are kept and the rest counted', () => {
    const clock = makeClock();
    const { registry } = makeClaimRoom(clock);
    const id = 'trim-claim';
    applyClaimOp(registry, ROOM_ID, { kind: 'create', id, agent: 'agent-a' }, clock.tick());
    applyClaimOp(registry, ROOM_ID, { kind: 'claim', id, agent: 'agent-a', leaseHours: null }, clock.tick());
    const NOTES = 250;
    for (let i = 0; i < NOTES; i++) {
      applyClaimOp(registry, ROOM_ID, { kind: 'note', id, agent: 'agent-a', text: `note ${i}` }, clock.tick());
    }
    const item = registry.get(ROOM_ID, id);
    const totalAppends = 2 + NOTES; // created + claimed + notes
    assert.equal(item.history.length, 200, 'history keeps at most 200 entries');
    assert.equal(item.historyOmitted, totalAppends - 200, 'trimmed stamps are counted, not lost');
    assert.equal(claimHistoryLength(item), totalAppends, 'lifetime length still changes on every write');
    // Newest 200, ordered, duplicate-free, gapless rounds (single round here).
    for (let i = 1; i < item.history.length; i++) {
      assert.ok(item.history[i - 1].at < item.history[i].at, 'trimmed history stays ordered');
    }
    assert.equal(new Set(item.history.map(s => JSON.stringify(s))).size, 200, 'no duplicates across the trim');
    assert.equal(item.history[0].action, 'note', 'oldest stamps (created/claimed/early notes) trimmed first');
    assert.equal(item.history[199].note, `note ${NOTES - 1}`, 'newest stamp is last');
  });
});
