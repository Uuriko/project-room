// Board-v2 durable machine lease expiry (H-7 regression).
//
// Contract: the durable machine must treat a lapsed lease exactly like the
// in-memory BoardV2 — a lapsed lease frees the file without anyone sweeping,
// while a live lease still blocks other lanes and a heartbeat renews the
// hold. The claim record itself is preserved (with expired=true), never
// deleted.
//
// Authoring gate (per .agents/skills/test-audit/SKILL.md):
// 1. Contract above; mirrors server/board-v2.mjs _holders semantics.
// 2. Credible regression: reverting the expiry check in the durable
//    `holders()` re-fails "a lapsed lease frees the file without sweeping"
//    (verified against the pre-fix code with the same probe shape).
// 3. Existing coverage: tests/board-v2-lapsed-lease.test.js covers only the
//    in-memory board; the durable machine's conflict path had no coverage.
// 4. No new production seams: real node:sqlite DatabaseSync + the production
//    boardV2Schema; the injected `now` is the module's own clock boundary.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { boardV2Schema } from "../server/board-v2-sqlite.mjs";
import { createDurableBoardV2Machine } from "../server/board-v2-durable.mjs";

function machineAt(clock) {
  const db = new DatabaseSync(":memory:");
  db.exec(boardV2Schema);
  return createDurableBoardV2Machine(db, { now: () => clock.ms });
}

test("a live lease still blocks another lane (durable)", () => {
  const clock = { ms: 1_000_000 };
  const m = machineAt(clock);
  m.postClaim({ task_id: "RC-2026-09-30-901", lane: "jill", files: ["server/store.mjs"], lease: "lease=4h", reason: "audit" });
  clock.ms += 3 * 3600_000;
  assert.throws(
    () => m.postClaim({ task_id: "RC-2026-09-30-902", lane: "fo", files: ["server/store.mjs"], lease: "lease=2h", reason: "fix" }),
    /claim_conflict|held live/
  );
});

test("a lapsed lease frees the file without anyone sweeping (durable)", () => {
  const clock = { ms: 1_000_000 };
  const m = machineAt(clock);
  m.postClaim({ task_id: "RC-2026-09-30-901", lane: "jill", files: ["server/store.mjs"], lease: "lease=1h", reason: "audit" });
  clock.ms += 2 * 3600_000;
  const taken = m.postClaim({ task_id: "RC-2026-09-30-902", lane: "fo", files: ["server/store.mjs"], lease: "lease=2h", reason: "fix" });
  assert.equal(taken.claim.lane, "fo");
});

test("a heartbeat renews the lease and keeps the file held (durable)", () => {
  const clock = { ms: 1_000_000 };
  const m = machineAt(clock);
  m.postClaim({ task_id: "RC-2026-09-30-901", lane: "jill", files: ["server/store.mjs"], lease: "lease=4h", reason: "audit" });
  clock.ms += 3 * 3600_000;
  m.heartbeat({ task_id: "RC-2026-09-30-901", lane: "jill" });
  clock.ms += 3 * 3600_000;
  assert.throws(
    () => m.postClaim({ task_id: "RC-2026-09-30-902", lane: "fo", files: ["server/store.mjs"], lease: "lease=2h", reason: "fix" }),
    /claim_conflict|held live/
  );
});

test("the lapsed claim is still on the record, flagged expired (durable)", () => {
  const clock = { ms: 1_000_000 };
  const m = machineAt(clock);
  m.postClaim({ task_id: "RC-2026-09-30-901", lane: "jill", files: ["a.mjs"], lease: "lease=1h", reason: "audit" });
  clock.ms += 2 * 3600_000;
  const board = m.readBoard({});
  const held = board.claims.find(c => c.task_id === "RC-2026-09-30-901");
  assert.ok(held, "lapsed claim must remain on the record");
  assert.equal(held.lane, "jill");
  assert.ok(["submitted", "working"].includes(held.state));
  assert.equal(held.expired, true);
});
