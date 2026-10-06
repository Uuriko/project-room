// Merge-slot queue tests (orch-merge-queue, phase 1: room-coordinated queue).
//
// Authoring-gate answers (repo .agents/skills/test-audit/SKILL.md):
// 1. Observable contract: at most one merge-slot holder per room; FIFO positions
//    are machine-readable; stale holders are swept and the next entry promoted;
//    heartbeat keeps a live worker's slot, a dead worker's slot becomes
//    re-acquirable. These are the safety + liveness invariants of the queue.
// 2. Credible regressions: an async check-then-act split in enqueue lets two
//    lanes both hold the slot (double-land); sweep that forgets to promote
//    wedges the queue after a worker crash; position off-by-one misreports
//    "queue busy, position N"; heartbeat accepted after expiry lets a dead
//    worker's stale merge proceed.
// 3. No existing coverage: server/merge-queue.mjs is new; work-claims leases
//    cover claim expiry, not slot serialization.
// 4. No test-only production seams: the module's public API (enqueue /
//    heartbeat / adopt / release / sweep / status) is exactly what the HTTP
//    handler and the worker script call. `now` injection is the same seam
//    work-claims.mjs uses for deterministic lease tests.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createMergeSlotQueue,
  MergeQueueError,
  DEFAULT_SLOT_LEASE_MS,
} from "../server/merge-queue.mjs";

const laneA = "ai_lane_a";
const laneB = "ai_lane_b";
const worker = "ai_worker";

function makeQueue(startMs = 1_000_000) {
  let nowMs = startMs;
  const queue = createMergeSlotQueue({ now: () => nowMs });
  return { queue, advance: ms => { nowMs += ms; }, now: () => nowMs };
}

const entryA = { pr: 1560, headSha: "a".repeat(40), claimId: "qa-fix-1", lane: laneA };
const entryB = { pr: 1562, headSha: "b".repeat(40), claimId: "qa-fix-2", lane: laneB };

test("two lanes racing for a free slot: exactly one holds, the other is queued at position 1", () => {
  const { queue } = makeQueue();
  const first = queue.enqueue(entryA);
  const second = queue.enqueue(entryB);
  assert.equal(first.status, "holding");
  assert.equal(first.position, 0);
  assert.equal(second.status, "queued");
  assert.equal(second.position, 1);
  const st = queue.status();
  assert.equal(st.active.claimId, "qa-fix-1");
  assert.equal(st.depth, 1);
  assert.equal(st.queue[0].position, 1);
});

test("enqueue is idempotent for the same claimId: no duplicate queue entries", () => {
  const { queue } = makeQueue();
  queue.enqueue(entryA);
  const again = queue.enqueue(entryB);
  const retry = queue.enqueue({ ...entryA, headSha: "a".repeat(40) });
  assert.equal(again.position, 1);
  assert.equal(retry.status, "holding");
  assert.equal(retry.position, 0);
  assert.equal(queue.status().depth, 1);
});

test("try mode: granted when free, refused with merge_queue_busy + position when locked", () => {
  const { queue } = makeQueue();
  const free = queue.enqueue({ ...entryA, mode: "try" });
  assert.equal(free.status, "holding");
  assert.throws(() => queue.enqueue({ ...entryB, mode: "try" }), err => {
    assert.ok(err instanceof MergeQueueError);
    assert.equal(err.code, "merge_queue_busy");
    assert.equal(err.position, 1);
    return true;
  });
  // Queue mode still works alongside try mode.
  const queued = queue.enqueue({ ...entryB, mode: "queue" });
  assert.equal(queued.status, "queued");
  assert.equal(queued.position, 1);
});

test("heartbeat renews the lease; heartbeat after expiry is rejected as unknown", () => {
  const { queue, advance } = makeQueue();
  const granted = queue.enqueue(entryA);
  advance(DEFAULT_SLOT_LEASE_MS - 1_000);
  const renewed = queue.heartbeat({ claimId: "qa-fix-1", caller: laneA });
  assert.ok(renewed.leaseExpiresAt > granted.leaseExpiresAt);
  advance(DEFAULT_SLOT_LEASE_MS + 1);
  assert.throws(() => queue.heartbeat({ claimId: "qa-fix-1", caller: laneA }), err => {
    assert.ok(err instanceof MergeQueueError);
    assert.equal(err.code, "merge_queue_unknown_entry");
    return true;
  });
});

test("sweep releases an expired holder and promotes the next entry with a fresh lease", () => {
  const { queue, advance, now } = makeQueue();
  queue.enqueue(entryA);
  queue.enqueue(entryB);
  advance(DEFAULT_SLOT_LEASE_MS + 1);
  const swept = queue.sweep();
  assert.deepEqual(swept.swept, ["qa-fix-1"]);
  assert.equal(swept.promoted, "qa-fix-2");
  const st = queue.status();
  assert.equal(st.active.claimId, "qa-fix-2");
  assert.ok(st.active.leaseExpiresAt > now());
  assert.equal(st.depth, 0);
});

test("status never shows a stale holder: expiry is evaluated on read", () => {
  const { queue, advance } = makeQueue();
  queue.enqueue(entryA);
  queue.enqueue(entryB);
  advance(DEFAULT_SLOT_LEASE_MS + 1);
  const st = queue.status();
  assert.equal(st.active.claimId, "qa-fix-2");
  assert.equal(st.depth, 0);
});

test("release by a non-holder is refused; the lane can dequeue its own queued entry", () => {
  const { queue } = makeQueue();
  queue.enqueue(entryA);
  queue.enqueue(entryB);
  assert.throws(() => queue.release({ claimId: "qa-fix-1", caller: laneB }), err => {
    assert.ok(err instanceof MergeQueueError);
    assert.equal(err.code, "merge_queue_forbidden");
    return true;
  });
  // Lane B removes its own queued entry; the holder is untouched.
  const removed = queue.release({ claimId: "qa-fix-2", caller: laneB });
  assert.equal(removed.released, true);
  assert.equal(removed.promoted, null);
  assert.equal(queue.status().active.claimId, "qa-fix-1");
  assert.equal(queue.status().depth, 0);
});

test("release by the holder promotes the next entry; unknown claimId is 404-class", () => {
  const { queue } = makeQueue();
  queue.enqueue(entryA);
  queue.enqueue(entryB);
  const out = queue.release({ claimId: "qa-fix-1", caller: laneA });
  assert.equal(out.released, true);
  assert.equal(out.promoted, "qa-fix-2");
  assert.throws(() => queue.release({ claimId: "nope", caller: laneA }), err => {
    assert.ok(err instanceof MergeQueueError);
    assert.equal(err.code, "merge_queue_unknown_entry");
    return true;
  });
});

test("adopt lets the automation heartbeat and release; a stranger cannot", () => {
  const { queue } = makeQueue();
  queue.enqueue(entryA);
  const adopted = queue.adopt({ claimId: "qa-fix-1", caller: worker });
  assert.equal(adopted.adoptedBy, worker);
  // Worker heartbeat keeps the lane's slot alive.
  const hb = queue.heartbeat({ claimId: "qa-fix-1", caller: worker });
  assert.ok(hb.leaseExpiresAt);
  // Stranger (not lane, not adopter) is refused.
  assert.throws(() => queue.heartbeat({ claimId: "qa-fix-1", caller: laneB }), err => {
    assert.ok(err instanceof MergeQueueError);
    assert.equal(err.code, "merge_queue_forbidden");
    return true;
  });
  // Worker releases after the merge; nothing left behind.
  const out = queue.release({ claimId: "qa-fix-1", caller: worker });
  assert.equal(out.released, true);
  assert.equal(queue.status().active, null);
});

test("invalid enqueue input is rejected with merge_queue_invalid_input", () => {
  const { queue } = makeQueue();
  for (const bad of [
    { ...entryA, pr: 0 },
    { ...entryA, pr: -5 },
    { ...entryA, headSha: "zzz" },
    { ...entryA, headSha: "a".repeat(39) },
    { ...entryA, claimId: "not a valid id!" },
    { ...entryA, lane: "" },
    { ...entryA, mode: "eventually" },
  ]) {
    assert.throws(() => queue.enqueue(bad), err => {
      assert.ok(err instanceof MergeQueueError, `expected MergeQueueError for ${JSON.stringify(bad)}`);
      assert.equal(err.code, "merge_queue_invalid_input");
      return true;
    });
  }
});

test("HTTP handler: try-mode refusal surfaces 409 with machine-readable position", async () => {
  const { handleMergeQueue, createMergeQueueRegistry } = await import("../server/merge-queue.mjs");
  const registry = createMergeQueueRegistry();
  const roomId = "muse-room";
  const calls = [];
  const helpers = {
    json: (status, body) => calls.push({ status, body }),
    reject: (status, code, message, extra) => {
      const err = new Error(message);
      err.httpStatus = status; err.code = code; err.extra = extra;
      throw err;
    },
    body: async () => ({ pr: 1562, headSha: "b".repeat(40), claimId: "qa-fix-2", lane: laneB, mode: "try" }),
  };
  // Occupy the slot first.
  await handleMergeQueue({
    req: { method: "POST" }, res: {}, url: new URL("http://x/api/rooms/muse-room/merge-queue/enqueue"),
    roomId, auth: { member: { id: laneA } }, mergeQueueRoute: "enqueue", registry,
    helpers: { ...helpers, body: async () => ({ pr: 1560, headSha: "a".repeat(40), claimId: "qa-fix-1" }) },
  });
  // Now the try-mode attempt must be refused 409 with position.
  let refused = null;
  try {
    await handleMergeQueue({
      req: { method: "POST" }, res: {}, url: new URL("http://x/api/rooms/muse-room/merge-queue/enqueue"),
      roomId, auth: { member: { id: laneB } }, mergeQueueRoute: "enqueue", registry, helpers,
    });
  } catch (err) { refused = err; }
  assert.ok(refused, "expected the try-mode enqueue to be refused");
  assert.equal(refused.httpStatus, 409);
  assert.equal(refused.code, "merge_queue_busy");
  assert.equal(refused.extra.position, 1);
});
