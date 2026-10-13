// #2854: boardClaimId used to replace every character outside the board
// alphabet with "_" and truncate to 120 chars, so distinct work item ids
// ("task.1", "task:1", "task_1") collapsed onto one board card and
// claimBoard merged their claims. The mapping must be injective over the
// valid work-item id domain while leaving board-safe ids untouched.
import test from "node:test";
import assert from "node:assert/strict";
import { boardClaimId, mirrorProjectionClaim } from "../server/work-claim-mirror.mjs";
import { createWorkClaimRegistry } from "../server/work-claim-routes.mjs";

const BOARD_ID = /^[A-Za-z0-9_-]{1,128}$/;
const members = {
  owner: { id: "owner", kind: "human", active: true, permissions: ["manage_members", "steer", "manage_claims", "accept_work", "complete_work"] },
  other: { id: "other", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
};
const at = "2026-10-12T18:40:00.000Z";

test("board-safe work item ids pass through unchanged (existing cards keep their ids)", () => {
  for (const id of ["task_1", "MERGE-SLOT", "lane-next", "a", "A1_-z", "x".repeat(128)]) {
    assert.equal(boardClaimId(id), id);
  }
});

test("ids differing only in '.', ':' or '_' map to distinct board cards", () => {
  const ids = ["task.1", "task:1", "task_1", "task-1", "task..1", "task__1", "task_p1", "task_c1", "task.1-next", "task_1-next"];
  const mapped = ids.map(boardClaimId);
  assert.equal(new Set(mapped).size, ids.length, mapped.join(", "));
  for (const id of mapped) assert.match(id, BOARD_ID);
  // Encoded ids are themselves board-safe, so feeding one back is a fixed point.
  for (const id of mapped) assert.equal(boardClaimId(id), id);
});

test("long ids that differ only after character 120 do not collide", () => {
  const head = `d.${"p".repeat(118)}`;
  const a = `${head}aaaaaaa1`;
  const b = `${head}aaaaaaa2`;
  assert.equal(a.length, 128);
  assert.notEqual(boardClaimId(a), boardClaimId(b));
  assert.match(boardClaimId(a), BOARD_ID);
  assert.match(boardClaimId(b), BOARD_ID);
});

test("escape-heavy ids stay within the board limit, deterministically", () => {
  const dots = `a${".".repeat(127)}`;
  const colonTail = `a${".".repeat(126)}:`;
  assert.match(boardClaimId(dots), BOARD_ID);
  assert.notEqual(boardClaimId(dots), boardClaimId(colonTail));
  assert.equal(boardClaimId(dots), boardClaimId(dots));
});

test("mirror keeps claims for 'task.1' and 'task_1' on separate cards", () => {
  const registry = createWorkClaimRegistry();
  const store = {
    workClaims: registry,
    now: () => Date.parse(at),
    roomAuthority: () => ({ ownerId: "owner", members, sequence: 1 }),
  };
  mirrorProjectionClaim(store, "room1", "owner", { type: "claim.acquired", at, data: { workItemId: "task.1" } });
  mirrorProjectionClaim(store, "room1", "other", { type: "claim.acquired", at, data: { workItemId: "task_1" } });
  const cards = registry.list("room1");
  assert.equal(cards.length, 2);
  assert.deepEqual(cards.map(card => card.workItemId).sort(), ["task.1", "task_1"]);
  assert.notEqual(cards[0].id, cards[1].id);
  assert.equal(registry.get("room1", "task_1").workItemId, "task_1");
});
