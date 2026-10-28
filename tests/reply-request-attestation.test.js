// ask_owner part A (reason-take-3): the server stamps which credential closed a
// reply request. Only a human member's signed-in account session reads as a
// person answering; access keys, identity secrets, API keys and agent sessions
// are "room_credential" because software can hold them. Never caller-supplied.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { auditRecovery } from "../server/recovery.mjs";
import { applyEvent } from "../src/events.js";
import { confirmsReplyCommand } from "../src/reply-requests.js";
import { confirmsAgentCommand } from "../client/work-actions.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";

function fixture(t) {
  const store = new RoomStore(":memory:"); t.after(() => store.close());
  store.initialize(initialRoom());
  const keys = { owner: store.issueAccessKey("commons", "owner") };
  store.command(keys.owner, "commons", { id: "add-agent", type: "member.added",
    data: { memberId: "agent", displayName: "agent", kind: "agent", permissions: ["accept_work", "complete_work"] } });
  keys.agent = store.issueAccessKey("commons", "agent");
  setTier(store.db, "commons", "agent", "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  for (const [a, b] of [["owner", "agent"], ["agent", "owner"]]) {
    store.dmConsents.request("commons", a, b, "test fixture");
    store.dmConsents.decide("commons", b, a, "approve");
  }
  const accountId = store.authenticate(keys.owner, "commons").account.id;
  const accountSession = () => {
    const key = store.issueAccountAccessKey(accountId), slot = store.createAccountSessionSlot();
    store.loginAccountSession(slot.token, key, slot.session.sessionRevision);
    return slot.token;
  };
  const ask = (from, to, extra = {}) => {
    const id = crypto.randomUUID();
    const command = { id, type: "message.posted", data: { messageId: `ask-${id}`, body: "Ship the release tonight?", toMemberId: to, requestKind: "reply", ...extra } };
    return { command, receipt: store.command(keys[from] ?? from, "commons", command) };
  };
  const answer = (q, outcome = "answered", extra = {}) => ({ id: crypto.randomUUID(), type: "message.posted", data: {
    messageId: crypto.randomUUID(), body: outcome === "answered" ? "Yes, ship it." : "Not tonight.",
    responseToRequestId: q.command.data.messageId, expectedRequestRevision: 0, responseOutcome: outcome,
    contextEventId: q.receipt.event.id, contextSequence: q.receipt.sequence,
    replyToId: q.command.data.messageId, toMemberId: q.receipt.event.actorId, workItemId: null, ...extra } });
  const request = q => store.room("commons").state.replyRequests[q.command.data.messageId];
  return { store, keys, accountSession, ask, answer, request };
}

test("a human answering from a signed-in account session is stamped account_session", async t => {
  const f = fixture(t), q = f.ask("agent", "owner"), session = f.accountSession();
  const command = f.answer(q), receipt = f.store.command(session, "commons", command);
  assert.equal(receipt.event.data.answerCredential, "account_session");
  assert.equal(f.request(q).answerCredential, "account_session");
  assert.equal(f.request(q).terminalActorId, "owner");
  const read = f.store.replyRequests.selected(f.keys.agent, "commons", q.command.data.messageId);
  assert.equal(read.request.answerCredential, "account_session");
  assert.equal(await confirmsReplyCommand(receipt, command, "commons", "owner"), true);
  // Agent and MCP clients confirm receipts too; the stamp must not make them "unconfirmed".
  assert.equal(confirmsAgentCommand(receipt, command, { roomId: "commons", memberId: "owner" }), true);
  assert.equal(confirmsAgentCommand({ ...receipt, event: { ...receipt.event, data: { ...receipt.event.data, answerCredential: "notarized" } } },
    command, { roomId: "commons", memberId: "owner" }), false);
  auditRecovery(f.store);
});

test("the same human answering with a room access key is only room_credential", t => {
  const f = fixture(t), q = f.ask("agent", "owner");
  const receipt = f.store.command(f.keys.owner, "commons", f.answer(q, "declined"));
  assert.equal(receipt.event.data.answerCredential, "room_credential");
  assert.equal(f.request(q).status, "declined");
  assert.equal(f.request(q).answerCredential, "room_credential");
});

test("an agent answering is room_credential", t => {
  const f = fixture(t), q = f.ask("owner", "agent");
  assert.equal(f.store.command(f.keys.agent, "commons", f.answer(q)).event.data.answerCredential, "room_credential");
});

test("a caller cannot supply the stamp on a response or an opening request", t => {
  const f = fixture(t), q = f.ask("agent", "owner");
  assert.throws(() => f.store.command(f.keys.owner, "commons", f.answer(q, "answered", { answerCredential: "account_session" })),
    /Unexpected field: answerCredential/);
  assert.equal(f.request(q).status, "open");
  assert.throws(() => f.ask("agent", "owner", { answerCredential: "account_session" }), /Unexpected field: answerCredential/);
});

test("replay refuses an unknown stamp value and a stamp on an opening event", t => {
  const f = fixture(t), q = f.ask("agent", "owner"), before = f.store.room("commons").state;
  const receipt = f.store.command(f.keys.owner, "commons", f.answer(q));
  assert.throws(() => applyEvent(before, { ...receipt.event, id: "forged", idempotencyKey: "forged",
    data: { ...receipt.event.data, answerCredential: "notarized" } }), /Invalid answer credential/);
  const fresh = fixture(t), opening = fresh.ask("agent", "owner");
  const base = structuredClone(fresh.store.room("commons").state);
  delete base.replyRequests[opening.command.data.messageId];
  base.messages = base.messages.filter(message => message.id !== opening.command.data.messageId);
  assert.throws(() => applyEvent(base, { ...opening.receipt.event, id: "forged-open", idempotencyKey: "forged-open",
    data: { ...opening.receipt.event.data, answerCredential: "account_session" } }), /Invalid answer credential/);
});

test("requests without a response carry no stamp", t => {
  const f = fixture(t), q = f.ask("agent", "owner");
  assert.equal(Object.hasOwn(f.request(q), "answerCredential"), false);
  assert.equal(Object.hasOwn(q.receipt.event.data, "answerCredential"), false);
});
