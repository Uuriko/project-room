// HUNT-COVERAGE (2026-10-18) — mutation-survivor pins for the patrol
// (server/patrol.mjs).
//
//   M11 — patrolPending's parked-room clause without its head condition
//         (parked at ANY head counts as not-pending): survived all 14
//         patrol tests. The park tests drive patrolTick directly, and
//         assert patrolPending is false only while the head is UNCHANGED.
//         Nothing pinned the scheduler-facing half of the design: once a
//         parked room's head moves, the job must wake to retry it —
//         otherwise the retry the park promises never fires on its own.
//   M12 — PATROL_INVARIANTS without "receipt_linkage": survived all 14
//         patrol tests (no fault-injection exercises that invariant).
//         The frozen list is the contract for which checkers run; this
//         pins the full set by name.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { patrolPending, PATROL_INVARIANTS } from "../server/patrol.mjs";
import { event as makeEvent, EVENT_TYPES } from "../src/events.js";

test("M12: the patrol runs all four invariants, receipt_linkage included", () => {
  assert.deepEqual([...PATROL_INVARIANTS].sort(),
    ["claim_legality", "messages_parity", "receipt_linkage", "sequence"]);
});

test("M11: a parked room re-arms the patrol job once its head moves", t => {
  const directory = mkdtempSync(join(tmpdir(), "hunt-coverage-patrol-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom("aaa-poison"));
  const key = store.issueAccessKey("aaa-poison", "owner");
  store.command(key, "aaa-poison",
    { id: "cmd-p1", type: "message.posted", data: { body: "first", messageId: "p1" } });
  store.db.prepare("UPDATE rooms SET projection=? WHERE id='aaa-poison'").run("{corrupt-projection");
  assert.equal(store.patrolTick().errors, 1, "the fresh park surfaces once as a named failure");
  assert.equal(store.patrolTick().errors, undefined, "a standing park does not re-fail the tick");
  assert.equal(patrolPending(store), false,
    "a parked room at an unchanged head does not re-arm the job");

  // The head moves (a new stored message event), exactly the shape the
  // patrol suite uses to earn a parked room one retry.
  const head = store.db.prepare("SELECT sequence FROM rooms WHERE id='aaa-poison'").get().sequence;
  const movedHead = head + 1;
  const raw = makeEvent({
    id: randomUUID(), idempotencyKey: randomUUID(), type: EVENT_TYPES.MESSAGE_POSTED,
    actorId: "owner", roomId: "aaa-poison", at: new Date().toISOString(),
    data: { messageId: "p2", body: "second message" }
  });
  store.db.prepare("INSERT INTO events VALUES(?,?,?,?)").run("aaa-poison", movedHead, raw.id, JSON.stringify(raw));
  store.db.prepare("UPDATE rooms SET sequence=? WHERE id='aaa-poison'").run(movedHead);
  assert.equal(patrolPending(store), true,
    "once the head moves, the parked room is pending again — the job must wake to retry it");
});
