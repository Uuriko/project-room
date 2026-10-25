import test from "node:test";
import assert from "node:assert/strict";
import { receiptCostOf, receiptCostLine } from "../server/receipt-cards.mjs";
import { applySessionFields, SESSION_EVENT_TYPES, attemptReceipts, validateAttemptModel } from "../src/work-item-session.js";
import { applyEvent, replay, EVENT_TYPES as T } from "../src/events.js";
import { seedEvents } from "../src/seed.js";

const run = ({ model, cap, spend, outcome = "done" } = {}) => {
  const item = { id: "w", title: "Job", state: "accepted", revision: 1, accountableMemberId: "owner" };
  applySessionFields(item, { type: SESSION_EVENT_TYPES.STARTED, actorId: "agent", at: "2026-10-22T10:00:00.000Z",
    data: { ...(cap !== undefined ? { budget: { maxSpendCents: cap } } : {}), ...(model !== undefined ? { model } : {}) } });
  applySessionFields(item, { type: SESSION_EVENT_TYPES.STOPPED, actorId: "agent", at: "2026-10-22T10:30:00.000Z",
    data: { status: outcome, ...(spend !== undefined ? { spendCents: spend } : {}) } });
  return item;
};

test("a recorded run puts its measured cost, cap and model on the receipt", () => {
  const cost = receiptCostOf(run({ model: "model-a", cap: 500, spend: 123 }));
  assert.deepEqual(cost, { spentCents: 123, capCents: 500, model: "model-a" });
  assert.equal(receiptCostLine(cost), " Cost $1.23 (cap $5.00, model model-a).");
  assert.equal(attemptReceipts(run({ model: "model-a" }))[0].model, "model-a");
});

test("nothing recorded reads as not recorded, never a number", () => {
  assert.deepEqual(receiptCostOf(null), { spentCents: null, capCents: null, model: null });
  assert.equal(receiptCostLine(receiptCostOf(null)), "");
  const partial = receiptCostOf(run({ cap: 500 }));
  assert.deepEqual(partial, { spentCents: null, capCents: 500, model: null });
  assert.equal(receiptCostLine(partial), " Cost not recorded (cap $5.00, model not recorded).");
});

test("an attempt without a model keeps its old shape", () => {
  const [receipt] = attemptReceipts(run({ spend: 5 }));
  assert.equal("model" in receipt, false);
  assert.equal(receipt.usageCents, 5);
});

test("a malformed model is refused at start", () => {
  for (const bad of ["", "   ", "x".repeat(101), "a\nb", 7, {}]) assert.throws(() => validateAttemptModel(bad));
  assert.equal(validateAttemptModel(" model-b "), "model-b");
  assert.equal(validateAttemptModel(undefined), null);
});

test("the projected receipt card admits only a well-formed cost", () => {
  const card = (id, cost) => ({ id, idempotencyKey: `key-${id}`, roomId: "room-project-room-v0",
    type: T.MESSAGE_POSTED, actorId: "potter", at: "2026-10-22T11:00:00.000Z", causationId: null,
    data: { messageId: id, body: "Job closed as result.", kind: "receipt_card", claimId: id, title: "Job",
      closedBy: "potter", deliveryMode: "result", evidence: "Closed.", ...(cost !== undefined ? { cost } : {}) } });
  let state = replay(seedEvents);
  state = applyEvent(state, card("rc-good", { spentCents: 42, capCents: null, model: "m" }));
  for (const bad of [{ spentCents: -1, capCents: null, model: null }, { spentCents: 1.5, capCents: null, model: null },
    { spentCents: null, capCents: null, model: 9 }, { spentCents: 1 }, { spentCents: 1, capCents: 2, model: "m", extra: 1 }, [1]])
    assert.throws(() => applyEvent(state, card("rc-bad", bad)), /Invalid cost/);
  state = applyEvent(state, card("rc-old"));
  const by = id => state.messages.find(m => m.id === id);
  assert.deepEqual(by("rc-good").cost, { spentCents: 42, capCents: null, model: "m" });
  assert.equal("cost" in by("rc-old"), false);
});

test("the store records a declared model on start and refuses it elsewhere", async t => {
  const { randomUUID } = await import("node:crypto");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { RoomStore } = await import("../server/store.mjs");
  const { initialRoom } = await import("../server/bootstrap.mjs");
  const { setTier } = await import("../server/autonomy-tiers.mjs");
  const directory = mkdtempSync(join(tmpdir(), "room-receipt-cost-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "agent", displayName: "Test agent", kind: "agent", permissions: ["accept_work", "complete_work"] } });
  setTier(store.db, "commons", "agent", "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.WORK_PROPOSED, data: {
    workItemId: "costed", title: "Costed job", definitionOfDone: "Done", accountableMemberId: "agent", mode: "read" } });
  const agentKey = store.issueAccessKey("commons", "agent");
  const mutate = request => store.mutateWorkSession(agentKey, "commons", { requestId: randomUUID(), workItemId: "costed", action: "set_status", ...request });
  assert.throws(() => mutate({ status: "processing", model: "" }), error => error.code === "invalid_session_model");
  mutate({ status: "processing", model: "model-c", budget: { maxSpendCents: 900 } });
  assert.throws(() => mutate({ status: "done", model: "model-c", spendCents: 10 }), error => error.code === "invalid_session_model");
  mutate({ status: "done", spendCents: 250 });
  const item = store.room("commons").state.workItems.costed;
  assert.deepEqual(receiptCostOf(item), { spentCents: 250, capCents: 900, model: "model-c" });
});
