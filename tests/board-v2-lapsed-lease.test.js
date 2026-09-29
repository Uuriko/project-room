import { test } from "node:test";
import assert from "node:assert/strict";
import { BoardV2 } from "../server/board-v2.mjs";

function boardAt(clock) {
  const board = new BoardV2();
  board._now = () => clock.ms;
  return board;
}

test("a live lease still blocks another lane", () => {
  const clock = { ms: 1_000_000 };
  const board = boardAt(clock);
  board.postClaim({ task_id: "RC-2026-09-29-001", lane: "jill", files: ["server/store.mjs"], lease: "lease=4h", reason: "audit" });
  clock.ms += 3 * 3600_000;
  assert.throws(
    () => board.postClaim({ task_id: "RC-2026-09-29-002", lane: "fo", files: ["server/store.mjs"], lease: "lease=2h", reason: "fix" }),
    /claim_conflict|held live/
  );
});

test("a lapsed lease frees the file without anyone sweeping", () => {
  const clock = { ms: 1_000_000 };
  const board = boardAt(clock);
  board.postClaim({ task_id: "RC-2026-09-29-001", lane: "jill", files: ["server/store.mjs"], lease: "lease=4h", reason: "audit" });
  clock.ms += 5 * 3600_000;
  const taken = board.postClaim({ task_id: "RC-2026-09-29-002", lane: "fo", files: ["server/store.mjs"], lease: "lease=2h", reason: "fix" });
  assert.equal(taken.claim.lane, "fo");
});

test("a heartbeat renews the lease and keeps the file held", () => {
  const clock = { ms: 1_000_000 };
  const board = boardAt(clock);
  board.postClaim({ task_id: "RC-2026-09-29-001", lane: "jill", files: ["server/store.mjs"], lease: "lease=4h", reason: "audit" });
  clock.ms += 3 * 3600_000;
  board.heartbeat({ task_id: "RC-2026-09-29-001", lane: "jill" });
  clock.ms += 3 * 3600_000;
  assert.throws(
    () => board.postClaim({ task_id: "RC-2026-09-29-002", lane: "fo", files: ["server/store.mjs"], lease: "lease=2h", reason: "fix" }),
    /claim_conflict|held live/
  );
});

test("the lapsed claim is still on the record, not deleted", () => {
  const clock = { ms: 1_000_000 };
  const board = boardAt(clock);
  board.postClaim({ task_id: "RC-2026-09-29-001", lane: "jill", files: ["a.mjs"], lease: "lease=1h", reason: "audit" });
  clock.ms += 2 * 3600_000;
  board.postClaim({ task_id: "RC-2026-09-29-002", lane: "fo", files: ["a.mjs"], lease: "lease=1h", reason: "fix" });
  const held = board._claims.get("RC-2026-09-29-001");
  assert.equal(held.lane, "jill");
  assert.ok(["submitted", "working"].includes(held.state));
});
