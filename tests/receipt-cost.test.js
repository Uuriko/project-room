import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { receiptCostOf, receiptCostLine, postReceiptCard } from "../server/receipt-cards.mjs";
import { applySessionFields, SESSION_EVENT_TYPES, attemptReceipts, validateAttemptModel } from "../src/work-item-session.js";
import { applyEvent, replay, EVENT_TYPES as T } from "../src/events.js";
import { seedEvents } from "../src/seed.js";
import { messageBodyHtml } from "../src/conversation.js";

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
  assert.equal(receiptCostLine(partial), "");
  assert.equal(partial.spentCents, null);
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
  assert.equal(by("rc-old").cost, null);
});

test("the store records a declared model on start and refuses it elsewhere", async t => {
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

const esc = value => String(value).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

test("a receipt names a cost only when spend was measured, in the room, the API and MCP", async t => {
  const { RoomStore } = await import("../server/store.mjs");
  const { initialRoom } = await import("../server/bootstrap.mjs");
  const { setTier } = await import("../server/autonomy-tiers.mjs");
  const { createRoomServer } = await import("../server/http.mjs");
  const { callHostedStdioTool } = await import("../server/mcp-full-profile.mjs");
  const directory = mkdtempSync(join(tmpdir(), "room-receipt-read-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "agent", displayName: "Test agent", kind: "agent", permissions: ["accept_work", "complete_work"] } });
  setTier(store.db, "commons", "agent", "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  const agentKey = store.issueAccessKey("commons", "agent");
  for (const id of ["spent-job", "plain-job"]) {
    store.command(ownerKey, "commons", { id: randomUUID(), type: T.WORK_PROPOSED, data: {
      workItemId: id, title: id, definitionOfDone: "Done", accountableMemberId: "agent", mode: "read" } });
  }
  const mutate = (workItemId, request) => store.mutateWorkSession(agentKey, "commons", {
    requestId: randomUUID(), workItemId, action: "set_status", ...request });
  mutate("spent-job", { status: "processing", model: "model-c", budget: { maxSpendCents: 900 } });
  mutate("spent-job", { status: "done", spendCents: 250 });
  mutate("plain-job", { status: "processing", budget: { maxSpendCents: 500 } });
  mutate("plain-job", { status: "done" });
  const claim = (id, title) => ({
    id, state: "done", deliveryMode: "result", title, owner: "agent",
    history: [{ action: "state:done", note: "Closed.", at: "2026-10-22T12:00:00.000Z" }]
  });
  postReceiptCard(store, "commons", claim("spent-job", "Spent job"));
  postReceiptCard(store, "commons", claim("plain-job", "Plain job"));
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: "plain-note", body: "A normal note." } });
  for (const id of ["spent-job", "plain-job"]) store.workClaims.set("commons", claim(id, id === "spent-job" ? "Spent job" : "Plain job"));
  const card = title => store.room("commons").state.messages.find(message => message.kind === "receipt_card" && message.title === title);
  const spent = card("Spent job");
  const plain = card("Plain job");
  const spentHtml = messageBodyHtml(spent.body, [], esc, spent.id);
  const plainHtml = messageBodyHtml(plain.body, [], esc, plain.id);
  assert.match(spentHtml, /Cost \$2\.50 \(cap \$9\.00, model model-c\)\./);
  assert.doesNotMatch(spentHtml, /Cost not recorded/);
  assert.doesNotMatch(plainHtml, /Cost/);
  assert.equal(plain.body.includes("Cost not recorded"), false);
  const stored = id => JSON.parse(store.db.prepare("SELECT body FROM events WHERE room_id=? AND json_extract(body,'$.data.messageId')=?").get("commons", id).body);
  assert.deepEqual(stored(spent.id).data.cost, { spentCents: 250, capCents: 900, model: "model-c" });
  assert.equal("cost" in stored(plain.id).data, false);
  assert.deepEqual(spent.cost, { spentCents: 250, capCents: 900, model: "model-c" });
  assert.equal(plain.cost, null);
  const get = async path => {
    const res = await fetch(`${origin}${path}`, { headers: { authorization: `Bearer ${ownerKey}` } });
    const json = await res.json();
    assert.equal(res.status, 200, JSON.stringify(json));
    return json;
  };
  const snapshot = await get("/api/rooms/commons");
  const conversation = await get("/api/rooms/commons/conversation?limit=100");
  const receipts = await get("/api/rooms/commons/receipts?limit=50");
  const from = (messages, title) => messages.find(message => message.kind === "receipt_card" && message.title === title);
  for (const messages of [snapshot.state.messages, conversation.messages]) {
    assert.deepEqual(from(messages, "Spent job").cost, { spentCents: 250, capCents: 900, model: "model-c" });
    assert.equal(from(messages, "Plain job").cost, null);
    assert.equal(from(messages, "Plain job").body.includes("Cost not recorded"), false);
  }
  const listed = id => receipts.receipts.find(receipt => receipt.workItemId === id);
  assert.deepEqual(listed("spent-job").cost, { spentCents: 250, capCents: 900, model: "model-c" });
  assert.equal(listed("plain-job").cost, null);
  const read = await callHostedStdioTool(store, ownerKey, "room_read_messages", { roomId: "commons", limit: 100 });
  const mcp = title => read.value.messages.find(message => message.body.startsWith(title));
  assert.deepEqual(mcp("Spent job").cost, { spentCents: 250, capCents: 900, model: "model-c" });
  assert.equal(mcp("Plain job").cost, null);
  assert.equal(mcp("Plain job").body.includes("Cost not recorded"), false);
  const ordinary = read.value.messages.find(message => message.body === "A normal note.");
  assert.ok(ordinary);
  assert.equal("cost" in ordinary, false);
});
