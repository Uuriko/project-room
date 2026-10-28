// ask_owner part B (reason-take-3): an agent asks its accountable human one
// question in one call that returns at once, then reads the outcome. Generic
// outcomes only (answered / declined / cancelled / unanswered), never approval.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { auditRecovery } from "../server/recovery.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";
import { ASK_OWNER_MAX_CHARS } from "../server/reply-requests.mjs";

function fixture(t) {
  const store = new RoomStore(":memory:"); t.after(() => store.close());
  store.initialize(initialRoom());
  const keys = { owner: store.issueAccessKey("commons", "owner") };
  for (const [memberId, kind] of [["agent", "agent"], ["other", "agent"], ["guest", "human"]]) {
    store.command(keys.owner, "commons", { id: `add-${memberId}`, type: "member.added",
      data: { memberId, displayName: memberId, kind, permissions: kind === "agent" ? ["accept_work", "complete_work"] : [] } });
    keys[memberId] = store.issueAccessKey("commons", memberId);
    if (kind === "agent") setTier(store.db, "commons", memberId, "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  }
  const accountId = store.authenticate(keys.owner, "commons").account.id;
  const accountSession = () => {
    const key = store.issueAccountAccessKey(accountId), slot = store.createAccountSessionSlot();
    store.loginAccountSession(slot.token, key, slot.session.sessionRevision);
    return slot.token;
  };
  const ask = (requestId = crypto.randomUUID(), question = "Can I merge the release branch tonight?", who = "agent") =>
    store.replyRequests.askOwner(keys[who], "commons", { question, requestId });
  const status = (id, who = "agent") => store.replyRequests.askOwnerStatus(keys[who], "commons", id);
  const respond = (token, id, outcome, body) => {
    const request = store.room("commons").state.replyRequests[id];
    const context = store.replyRequests.selected(keys.owner, "commons", id).current;
    return store.command(token, "commons", { id: crypto.randomUUID(), type: "message.posted", data: {
      messageId: crypto.randomUUID(), body, responseToRequestId: id, expectedRequestRevision: request.revision,
      responseOutcome: outcome, contextEventId: context.contextEventId, contextSequence: context.contextSequence,
      replyToId: id, toMemberId: request.requesterId, workItemId: null } });
  };
  return { store, keys, ask, status, respond, accountSession };
}

test("an agent asks its owner and gets the request back at once, unanswered", t => {
  const f = fixture(t), view = f.ask();
  assert.equal(view.outcome, "unanswered");
  assert.equal(view.ownerId, "owner");
  assert.equal(view.duplicate, false);
  assert.equal(view.answeredBy, null);
  assert.equal(view.answerCredential, null);
  assert.match(view.meaning, /not approval/);
  const request = f.store.room("commons").state.replyRequests[view.requestMessageId];
  assert.deepEqual([request.requesterId, request.recipientId, request.status], ["agent", "owner", "open"]);
  assert.match(view.next.status.path, /\/api\/rooms\/commons\/ask-owner\?requestMessageId=/);
});

test("a retry with the same requestId returns the same request without posting again", t => {
  const f = fixture(t), first = f.ask("retry-1"), sequence = f.store.room("commons").sequence;
  const again = f.ask("retry-1");
  assert.equal(again.requestMessageId, first.requestMessageId);
  assert.equal(again.duplicate, true);
  assert.equal(f.store.room("commons").sequence, sequence);
});

test("one open question to the owner at a time", t => {
  const f = fixture(t), first = f.ask("one");
  assert.throws(() => f.ask("two", "A different question?"), error => error.code === "ask_pending" && error.status === 409
    && error.requestMessageId === first.requestMessageId);
  // Another agent asking the same owner is independent.
  assert.equal(f.ask("three", "Mine is separate?", "other").outcome, "unanswered");
});

test("answers read back with the note, who answered and the credential route", t => {
  const f = fixture(t), view = f.ask();
  f.respond(f.accountSession(), view.requestMessageId, "answered", "Yes, after CI is green.");
  const read = f.status(view.requestMessageId);
  assert.equal(read.outcome, "answered");
  assert.equal(read.note, "Yes, after CI is green.");
  assert.deepEqual(read.answeredBy, { memberId: "owner", kind: "human" });
  assert.equal(read.answerCredential, "account_session");
  assert.equal(Object.hasOwn(read, "duplicate"), false);
  // The owner can read it too; the next question can be asked once this closes.
  assert.equal(f.status(view.requestMessageId, "owner").outcome, "answered");
  assert.equal(f.ask("next", "And the docs?").outcome, "unanswered");
  auditRecovery(f.store);
});

test("declined with a room credential and cancelled by the agent read back plainly", t => {
  const f = fixture(t), declined = f.ask("d");
  f.respond(f.keys.owner, declined.requestMessageId, "declined", "Not tonight.");
  assert.deepEqual([f.status(declined.requestMessageId).outcome, f.status(declined.requestMessageId).answerCredential], ["declined", "room_credential"]);
  const cancelled = f.ask("c", "Should I also tag it?");
  f.store.command(f.keys.agent, "commons", { id: crypto.randomUUID(), type: "reply_request.cancelled",
    data: { requestMessageId: cancelled.requestMessageId, expectedRequestRevision: 0, reason: "Found the answer in the docs" } });
  const read = f.status(cancelled.requestMessageId);
  assert.deepEqual([read.outcome, read.note, read.answerCredential], ["cancelled", "Found the answer in the docs", null]);
});

test("people, unowned agents and bad input are refused without posting", t => {
  const f = fixture(t), before = f.store.room("commons").sequence;
  assert.throws(() => f.ask(undefined, undefined, "guest"), { code: "ask_owner_agents_only" });
  for (const question of ["", "  padded  ", "x".repeat(ASK_OWNER_MAX_CHARS + 1), 7]) assert.throws(() => f.ask(undefined, question), { code: "invalid_question" });
  assert.throws(() => f.store.replyRequests.askOwner(f.keys.agent, "commons", { question: "Ok?", requestId: "bad id" }), { code: "invalid_request_id" });
  assert.equal(f.store.room("commons").sequence, before);
  // An agent whose accountable human has left the room cannot ask anyone else.
  f.store.command(f.keys.owner, "commons", { id: "add-orphan", type: "member.added",
    data: { memberId: "orphan", displayName: "orphan", kind: "agent", permissions: [], accountableHumanId: "guest" } });
  f.keys.orphan = f.store.issueAccessKey("commons", "orphan");
  setTier(f.store.db, "commons", "orphan", "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  assert.equal(f.store.room("commons").state.members.orphan.accountableHumanId, "guest");
  const guest = f.store.room("commons").state.members.guest;
  f.store.command(f.keys.owner, "commons", { id: "remove-guest", type: "member.access_changed",
    data: { memberId: "guest", expectedMemberRevision: guest.revision, permissions: [], active: false } });
  const settled = f.store.room("commons").sequence;
  assert.throws(() => f.ask(undefined, undefined, "orphan"), { code: "owner_unavailable", status: 409 });
  assert.equal(f.store.room("commons").sequence, settled);
});

test("status is private to the two parties", t => {
  const f = fixture(t), view = f.ask();
  assert.throws(() => f.status(view.requestMessageId, "other"), { code: "reply_request_not_found", status: 404 });
});

test("HTTP: POST returns 201 at once, a retry 200, GET reads the outcome", async t => {
  const f = fixture(t), server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}/api/rooms/commons/ask-owner`;
  const call = (method, url, body) => fetch(url, { method, headers: { authorization: `Bearer ${f.keys.agent}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const created = await call("POST", base, { question: "Merge tonight?", requestId: "http-1" });
  assert.equal(created.status, 201, await created.clone().text());
  const view = await created.json();
  assert.equal((await call("POST", base, { question: "Merge tonight?", requestId: "http-1" })).status, 200);
  const unknown = await call("POST", base, { question: "Merge tonight?", requestId: "http-2", extra: true });
  assert.equal(unknown.status, 422);
  const read = await call("GET", `${base}?requestMessageId=${encodeURIComponent(view.requestMessageId)}`);
  assert.equal(read.status, 200);
  assert.equal((await read.json()).outcome, "unanswered");
  const pending = await call("POST", base, { question: "Something else?", requestId: "http-3" });
  assert.equal(pending.status, 409);
  assert.equal((await pending.json()).error?.code ?? "", "ask_pending");
});
