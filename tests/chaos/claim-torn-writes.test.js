// P1 — torn-write resistance (PRODUCT-200 reliability, worker C3).
//
// Property: for ANY claim op (create / claim / progress / note / renew /
// reassign / release / close / attest / review / pr-link / delete / sweep)
// with a failure injected at ANY internal mutating step, every work_claims
// row is either fully old (pre-op bytes) or fully new (post-op bytes) —
// never a mixture. A torn row would be, e.g., delete()'s dependents waived
// but the claim row still present, or a new history with an old state.
//
// Method: 240 seeded interleavings. Each interleaving builds two identical
// harnesses (real production registry + state machine over the killable
// fake DO storage). The shadow runs the op clean to count its mutating
// steps and to produce the expected post-state; the real run arms the chaos
// hook at a uniformly random internal step. The fault models the DO isolate
// dying mid-write; the transaction journal is discarded, exactly like
// production's durableStorage.transaction.
//
// This is a permanent prevention property: if a future refactor moves a
// multi-statement claim op outside the shared transaction (or the journal
// stops discarding on throw), some interleaving fails loudly.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChaosFault,
  makeClaimRoom,
  makeClock,
  mulberry32,
  makeWorld,
  randomClaimOp,
  applyClaimOp,
  seedRoom,
  snapshotState,
} from './work-claim-chaos-scaffold.mjs';

const INTERLEAVINGS = 240;

const sortedEntries = map => [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));

describe('P1 torn-write resistance: fault at any internal step leaves no torn claim rows', () => {
  for (let i = 0; i < INTERLEAVINGS; i++) {
    it(`interleaving ${i}: random op x random internal fault step is all-old or all-new`, () => {
      const rand = mulberry32(0xc3a0 + i * 7919);
      const clock = makeClock();
      const world = makeWorld('chaos-room', rand);
      const A = makeClaimRoom(clock); // faulted run
      const B = makeClaimRoom(clock); // shadow run: no fault, yields expected post-state
      seedRoom([A.registry, B.registry], world, clock, rand);
      const pre = snapshotState(A.storage);

      const op = randomClaimOp(world);
      const nowMs = clock.tick();

      // Shadow: run clean, count the op's mutating steps (permit acquire,
      // claim upsert(s)/delete, permit release) and capture expected post.
      const bStart = B.storage.mutatingOps;
      let bError = null;
      try { applyClaimOp(B.registry, world.roomId, op, nowMs); }
      catch (error) { bError = error; }
      const steps = B.storage.mutatingOps - bStart;
      // Note: a refused op (domain ClaimError) journals only the permit
      // acquire before the state machine throws, so steps can be 1. The
      // acquire is always journaled and always discarded on throw.
      assert.ok(steps >= 1, `op ${op.kind} ran no mutating statements at all`);
      const expectedPost = snapshotState(B.storage);

      // Arm the fault at a uniform random internal step of the op. k ranges
      // over 1..steps+1; steps+1 arms past the last mutating statement, i.e.
      // the fault never lands and the op must commit fully.
      const k = 1 + Math.floor(rand() * (steps + 1));
      A.storage.armKillBeforeMutatingOp(A.storage.mutatingOps + k);
      let aError = null;
      try { applyClaimOp(A.registry, world.roomId, op, nowMs); }
      catch (error) { aError = error; }
      A.storage.disarmKill();
      const post = snapshotState(A.storage);

      const faultFired = aError instanceof ChaosFault;
      const label = `op=${op.kind} id=${op.id ?? '-'} fault-step=${k}/${steps}`;
      if (faultFired) {
        assert.deepEqual(sortedEntries(post.claims), sortedEntries(pre.claims),
          `${label}: torn state — a faulted op left claim rows that are neither fully old nor fully new`);
        assert.deepEqual(sortedEntries(post.config), sortedEntries(pre.config),
          `${label}: torn state in work_claim_config after fault`);
      } else {
        assert.deepEqual(sortedEntries(post.claims), sortedEntries(expectedPost.claims),
          `${label}: committed state diverged from the clean run`);
        assert.deepEqual(sortedEntries(post.config), sortedEntries(expectedPost.config),
          `${label}: config state diverged from the clean run`);
      }

      // The explicit never-mixed check, row by row: each row's bytes must be
      // exactly the pre-op bytes or exactly the expected post-op bytes.
      const keys = new Set([...pre.claims.keys(), ...expectedPost.claims.keys()]);
      for (const key of keys) {
        const v = post.claims.get(key);
        assert.ok(v === pre.claims.get(key) || v === expectedPost.claims.get(key),
          `${label}: TORN ROW ${key} — bytes match neither the fully-old nor the fully-new version`);
      }
      for (const key of post.claims.keys()) {
        assert.ok(keys.has(key), `${label}: phantom row ${key} appeared out of nowhere`);
      }

      // No stuck writer state after the fault (C1 drill's stuck-permit check).
      assert.equal(A.db.isTransaction, false, `${label}: transaction flags stuck after fault`);
      assert.equal(A.db.readOnlyTransaction, false, `${label}: readOnlyTransaction stuck after fault`);
      assert.equal(A.storage.state.room_writer_permit.get(1).version, 0,
        `${label}: writer permit stuck held after fault — every later write would fail`);

      // Same domain outcome on both runs when the fault did not fire
      // (a ChaosFault pre-empts whatever the op would have done).
      if (!faultFired) {
        assert.equal(aError?.constructor?.name ?? 'ok', bError?.constructor?.name ?? 'ok',
          `${label}: nondeterministic domain outcome between identical runs`);
      } else {
        assert.ok(aError.isChaosFault, `${label}: expected a ChaosFault, got ${aError}`);
      }
    });
  }
});
