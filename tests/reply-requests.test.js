import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { auditRecovery } from "../server/recovery.mjs";
import { applyEvent, replay, event } from "../src/events.js";
import { replyContextOwners, MAX_REPLY_REQUESTS, prepareReplyPost } from "../src/reply-requests.js";
import { DEFAULT_CHANNEL_ID } from "../src/events.js";
import { auditReplyRequests, REPLY_PAGE_BYTES } from "../server/reply-requests.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { callHostedStdioTool } from "../server/mcp-full-profile.mjs";
import { createHostedRoomMcp } from "../server/mcp-room-profile.mjs";
import { validateReplyRead } from "../client/reply-actions.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";
import { linkWithProof } from "./helpers/link-with-proof.mjs";

function fixture(t, extra = []) {
  const store = new RoomStore(":memory:"); t.after(() => store.close());
  store.initialize([...initialRoom(), ...extra]);
  const keys = { owner: store.issueAccessKey("commons", "owner") };
  const send = (actor, command) => store.command(keys[actor], "commons", command);
  const post = (actor, data, id = crypto.randomUUID()) => send(actor, { id, type: "message.posted", data });
  for (const [memberId, kind, permissions] of [["guest", "human", []], ["agent", "agent", ["accept_work", "complete_work"]], ["reviewer", "agent", ["verify"]]]) {
    send("owner", { id: `add-${memberId}`, type: "member.added", data: { memberId, displayName: memberId, kind, permissions } });
    keys[memberId] = store.issueAccessKey("commons", memberId);
  }
  // #953: new agent members default to t1_readonly; these fixtures need write access
  for (const memberId of ["agent", "reviewer"])
    setTier(store.db, "commons", memberId, "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  // Consent-bound DMs: the reply-request flows DM between fixture members;
  // approve every direction up front so the tests exercise request/answer
  // logic, not the consent gate.
  for (const a of ["owner", "guest", "agent", "reviewer"])
    for (const b of ["owner", "guest", "agent", "reviewer"])
      if (a !== b) {
        store.dmConsents.request("commons", a, b, "test fixture");
        store.dmConsents.decide("commons", b, a, "approve");
      }
  const open = (actor = "guest", patch = {}, id = crypto.randomUUID()) => {
    const command = { id, type: "message.posted", data: { messageId: `message-${id}`, body: "Which option should we use?", toMemberId: "agent", requestKind: "reply", ...patch } };
    return { command, receipt: send(actor, command) };
  };
  const answer = (q, basis = q.receipt, patch = {}) => ({ id: crypto.randomUUID(), type: "message.posted", data: {
    messageId: crypto.randomUUID(), body: "Use the simple option.", responseToRequestId: q.command.data.messageId,
    expectedRequestRevision: 0, responseOutcome: "answered", contextEventId: basis.event.id, contextSequence: basis.sequence,
    replyToId: q.command.data.messageId, toMemberId: q.receipt.event.actorId, workItemId: q.command.data.workItemId ?? null, ...patch
  } });
  const cancel = (q, patch = {}) => ({ id: crypto.randomUUID(), type: "reply_request.cancelled", data: {
    requestMessageId: q.command.data.messageId, expectedRequestRevision: 0, reason: "No longer needed", ...patch
  } });
  const state = () => store.room("commons").state;
  return { store, keys, send, post, open, answer, cancel, state };
}

test("ordinary directed messages and ignored historical request fields remain ordinary", async t => {
  const old = event({ roomId: "commons", actorId: "owner", type: "message.posted", data: {
    body: "Legacy data", toMemberId: "historical", requestKind: "reply", responseToRequestId: "old-subject", expectedRequestRevision: "ignored", contextSequence: 9
  } });
  const member = event({ roomId: "commons", actorId: "owner", type: "member.added", data: {
    memberId: "historical", displayName: "Historical reader", kind: "agent", permissions: []
  } });
  const f = fixture(t, [member, old]); f.post("guest", { body: "Agent, a thought?", toMemberId: "agent" });
  assert.equal(Object.hasOwn(f.state(), "replyRequests"), false);
  assert.equal(f.state().messages[0].body, "Legacy data");
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const key = f.store.issueAccessKey("commons", "historical");
  const client = new RoomAgentClient({ origin: `http://127.0.0.1:${server.address().port}`, roomId: "commons", memberId: "historical", token: key });
  const hosted = await callHostedStdioTool(f.store, key, "room_read_messages", { roomId: "commons" });
  for (const result of [await client.roomMessages(), hosted.value]) {
    const legacy = result.messages.find(message => message.body === "Legacy data");
    assert.equal(legacy.workItemId, null);
    assert.equal(Object.hasOwn(legacy, "nextRead"), false);
    assert.equal(Object.hasOwn(legacy, "requestKind"), false);
  }
  auditRecovery(f.store);
});

test("compact message reads retain work links without exposing private messages to other members", async t => {
  const f = fixture(t);
  f.send("owner", { id: "linked-work", type: "work.proposed", data: {
    workItemId: "linked-work", title: "Review", definitionOfDone: "A useful answer", accountableMemberId: "agent", mode: "read"
  } });
  const publicMessage = f.post("owner", { messageId: "linked-public", body: "Public context", workItemId: "linked-work" });
  f.post("owner", { messageId: "unlinked", body: "No work selected" });
  const q = f.open("guest", { workItemId: "linked-work" }, "linked-private-question");
  const sequence = f.store.room("commons").sequence;
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  for (const memberId of ["agent", "reviewer"]) {
    const client = new RoomAgentClient({ origin: `http://127.0.0.1:${server.address().port}`, roomId: "commons", memberId, token: f.keys[memberId] });
    const args = { after: publicMessage.sequence - 1, limit: 100 };
    const hosted = await callHostedStdioTool(f.store, f.keys[memberId], "room_read_messages", { roomId: "commons", ...args });
    for (const result of [await client.roomMessages(args), hosted.value]) {
      assert.equal(result.messages.find(row => row.messageId === "linked-public").workItemId, "linked-work");
      assert.equal(result.messages.find(row => row.messageId === "unlinked").workItemId, null);
      const question = result.messages.find(row => row.messageId === q.command.data.messageId);
      if (memberId === "agent") {
        assert.equal(question.workItemId, "linked-work");
        assert.equal(question.requestKind, "reply");
        assert.equal(question.nextRead.arguments.requestMessageId, q.command.data.messageId);
      } else assert.equal(question, undefined);
      assert.equal(result.hasMore, false);
    }
  }
  assert.equal(f.store.room("commons").sequence, sequence);
});

test("explicit answer appends once, retains exact historical retries and does not complete work", t => {
  const f = fixture(t), before = f.state(), q = f.open();
  assert.equal(q.receipt.event.data.requestPolicyVersion, 1);
  let request = f.state().replyRequests[q.command.data.messageId];
  assert.equal(request.status, "open"); assert.equal(request.revision, 0);
  const command = f.answer(q), saved = f.send("agent", command);
  request = f.state().replyRequests[request.id];
  assert.equal(request.status, "answered"); assert.equal(request.revision, 1);
  assert.equal(request.responseMessageId, command.data.messageId); assert.equal(request.terminalActorId, "agent");
  assert.equal(request.contextEventId, q.receipt.event.id); assert.equal(request.responseContextSequence, q.receipt.sequence);
  f.post("owner", { body: "Later comment", replyToId: request.id });
  const sequence = f.store.room("commons").sequence;
  assert.equal(f.send("agent", command).event.id, saved.event.id); assert.equal(f.send("guest", q.command).duplicate, true);
  assert.equal(f.store.room("commons").sequence, sequence);
  assert.deepEqual(f.state().workItems, before.workItems); assert.deepEqual(f.state().members, before.members);
  assert.equal(f.store.snapshot(f.keys.agent, "commons").cursor, 0); auditRecovery(f.store);
});

test("request bundles reject missing, null, mixed, spoofed and proposal fields without any writes", t => {
  const f = fixture(t), before = auditRecovery(f.store).dataSha256;
  for (const patch of [{ messageId: null }, { body: " " }, { toMemberId: null }, { requestKind: null }, { requestKind: "other" },
    { responseOutcome: "answered" }, { packetId: null }, { expectedRequestRevision: 0 }, { toMemberId: "guest" }, { toMemberId: "missing" }, { requestPolicyVersion: 1 }]) {
    assert.throws(() => f.open("guest", patch));
  }
  assert.equal(auditRecovery(f.store).dataSha256, before);
  const q = f.open(), after = auditRecovery(f.store).dataSha256;
  for (const patch of [{ expectedRequestRevision: null }, { expectedRequestRevision: 1 }, { contextSequence: 0 }, { contextSequence: q.receipt.sequence - 1 },
    { contextEventId: "wrong" }, { responseOutcome: null }, { requestKind: "reply" }, { replyToId: null }, { toMemberId: "owner" }, { workItemId: "missing" }, { basisRevision: null }]) {
    assert.throws(() => f.send("agent", f.answer(q, q.receipt, patch)));
  }
  const missing = f.answer(q); delete missing.data.workItemId; assert.throws(() => f.send("agent", missing));
  assert.throws(() => f.send("reviewer", f.answer(q)), /requested participant/);
  assert.equal(auditRecovery(f.store).dataSha256, after);
});

test("ordinary clarification changes context, but independent request/work branches do not", t => {
  const f = fixture(t), q = f.open(), subject = q.command.data.messageId;
  const clarification = f.post("guest", { messageId: "clarification", body: "Consider accessibility too.", replyToId: subject });
  assert.equal(f.state().replyRequests[subject].contextEventId, clarification.event.id);
  assert.equal(f.state().replyRequests[subject].revision, 0);
  assert.throws(() => f.send("agent", f.answer(q)), /Stale reply request context/);
  const nested = f.open("owner", { messageId: "nested", replyToId: subject });
  f.post("agent", { messageId: "nested-child", body: "Different question", replyToId: nested.command.data.messageId });
  f.send("owner", { id: "work", type: "work.proposed", data: { workItemId: "other-work", title: "Independent", definitionOfDone: "Text", accountableMemberId: "agent", mode: "read" } });
  f.post("owner", { messageId: "different-work", workItemId: "other-work", body: "Separate work", replyToId: subject });
  f.post("agent", { messageId: "different-work-child", body: "Still separate", replyToId: "different-work" });
  let at = Date.now();
  f.store.now = () => at;
  for (let i = 0; i < 105; i++) { at += 2000; f.post("owner", { body: "Unrelated" }); }
  assert.equal(f.state().replyRequests[subject].contextEventId, clarification.event.id);
  const owners = replyContextOwners(f.state());
  assert.equal(owners.get("clarification"), subject); assert.equal(owners.get("nested-child"), "nested");
  assert.equal(owners.has("different-work-child"), false);
  f.send("agent", f.answer(q, clarification)); auditRecovery(f.store);
});

test("active recipient can decline after requester deactivation, without relaxing ordinary targeting", t => {
  const f = fixture(t), q = f.open();
  f.send("owner", { id: "end-guest", type: "member.access_changed", data: { memberId: "guest", expectedMemberRevision: 0, permissions: [], active: false } });
  assert.throws(() => f.post("agent", { body: "Ordinary directed message", toMemberId: "guest" }), /access revoked/);
  const response = f.answer(q, q.receipt, { responseOutcome: "declined", body: "I cannot judge this." });
  const saved = f.send("agent", response);
  assert.equal(f.state().replyRequests[q.command.data.messageId].status, "declined");
  assert.equal(f.send("agent", response).event.id, saved.event.id); auditRecovery(f.store);
});

test("requester or actual human owner can cancel; the first terminal operation wins", t => {
  const f = fixture(t), q = f.open();
  assert.throws(() => f.send("agent", f.cancel(q)), /requester or Room owner/);
  assert.throws(() => f.send("reviewer", f.cancel(q)), /requester or Room owner/);
  assert.throws(() => f.send("owner", f.cancel(q, { reason: null })), /reason/);
  const command = f.cancel(q), saved = f.send("owner", command), before = f.store.room("commons").sequence;
  assert.throws(() => f.send("agent", f.answer(q)), { status: 409 });
  assert.equal(f.send("owner", command).event.id, saved.event.id);
  assert.equal(f.store.room("commons").sequence, before);
  assert.equal(f.state().replyRequests[q.command.data.messageId].terminalActorId, "owner");
  const second = f.open(), answer = f.answer(second); f.send("agent", answer);
  assert.throws(() => f.send("guest", f.cancel(second)), { status: 409 }); auditRecovery(f.store);
});

test("full request history audit rejects matching forged checkpoints and projections", t => {
  const f = fixture(t), q = f.open(); f.send("agent", f.answer(q));
  const original = f.state(), sequence = f.store.room("commons").sequence, subject = q.command.data.messageId;
  f.store.db.prepare("INSERT INTO projection_checkpoints VALUES(?,?,?)").run("commons", sequence, JSON.stringify(original));
  auditRecovery(f.store);
  const changes = [state => { state.replyRequests[subject].requesterId = "owner"; },
    state => { delete state.replyRequests; }, state => { state.replyRequests.fake = { ...state.replyRequests[subject], id: "fake" }; },
    state => { state.replyRequests[subject].contextEventId = "fake"; }, state => { state.replyRequests[subject].responseContextSequence--; },
    state => { state.replyRequests[subject].terminalActorId = "owner"; }, state => { state.messages.at(-1).body = "Forged answer"; },
    state => { state.messages.at(-1).replyToId = null; }];
  for (const change of changes) {
    const changed = structuredClone(original); change(changed);
    f.store.db.prepare("UPDATE rooms SET projection=? WHERE id='commons'").run(JSON.stringify(changed));
    f.store.db.prepare("UPDATE projection_checkpoints SET projection=? WHERE room_id='commons'").run(JSON.stringify(changed));
    assert.deepEqual(f.store.rebuildProjection("commons").state, changed);
    assert.throws(() => auditRecovery(f.store), /Reply request history/);
  }
});

test("request map is bounded and unsupported event policies cannot be silently interpreted", () => {
  const original = replay(initialRoom()), stamped = event({ roomId: "commons", actorId: "owner", type: "message.posted",
    data: { messageId: "request", toMemberId: "another", body: "Question", requestKind: "reply", requestPolicyVersion: 1 } });
  for (const value of [null, 0, 2, "1"]) assert.throws(() => applyEvent(original, { ...stamped, data: { ...stamped.data, requestPolicyVersion: value } }), /Unsupported reply/);
  original.replyRequests = Object.fromEntries(Array.from({ length: MAX_REPLY_REQUESTS }, (_, i) => [`r${i}`, {}]));
  assert.throws(() => applyEvent(original, stamped), /capacity/);
});

test("selected exchange freezes pages, exposes basis only after context is drained, and stays read-only", t => {
  const f = fixture(t), q = f.open(), id = q.command.data.messageId;
  const clarify = f.post("guest", { messageId: "context", body: "Exact clarification 🪷", replyToId: id });
  f.open("owner", { messageId: "independent", replyToId: id });
  const before = auditRecovery(f.store), first = f.store.replyRequests.selected(f.keys.agent, "commons", id, { limit: 1 });
  assert.equal(first.current.answerBasis, null); assert.equal(first.page.hasMore, true);
  assert.deepEqual(first.page.items.map(row => row.kind), ["opened"]);
  assert.equal(first.page.items[0].message.body, q.command.data.body);
  const second = f.store.replyRequests.selected(f.keys.agent, "commons", id, { cursor: first.page.nextCursor, limit: 1 });
  assert.deepEqual(second.page.items.map(row => row.message.id), ["context"]);
  assert.deepEqual(second.current.answerBasis, { expectedRequestRevision: 0, contextEventId: clarify.event.id, contextSequence: clarify.sequence });
  assert.equal(second.page.hasMore, false); assert.ok(second.page.rowBytes <= REPLY_PAGE_BYTES);
  assert.equal(f.store.replyRequests.selected(f.keys.guest, "commons", id).current.answerBasis, null);
  assert.throws(() => f.store.replyRequests.selected(f.keys.owner, "commons", id), { status: 404 });
  assert.deepEqual(auditRecovery(f.store), before);
  const fresh = f.post("guest", { body: "New relevant context", replyToId: id });
  assert.equal(f.store.replyRequests.selected(f.keys.agent, "commons", id, { cursor: first.page.nextCursor }).current.answerBasis, null);
  assert.equal(f.store.replyRequests.selected(f.keys.agent, "commons", id).current.answerBasis.contextEventId, fresh.event.id);
  f.send("agent", f.answer(q, fresh));
  assert.equal(f.store.replyRequests.selected(f.keys.agent, "commons", id, { cursor: first.page.nextCursor }).current.actions.answer, false);
});

test("request history keeps between-poll terminals and sparse/empty anchored progress", t => {
  const f = fixture(t), initial = f.store.replyRequests.history(f.keys.agent, "commons");
  assert.deepEqual(initial.page.items, []); assert.ok(initial.page.completedCheckpoint);
  const q = f.open(), answer = f.answer(q); f.send("agent", answer);
  const incoming = f.store.replyRequests.history(f.keys.agent, "commons", { checkpoint: initial.page.completedCheckpoint, limit: 1 });
  assert.deepEqual(incoming.page.items.map(row => row.kind), ["opened"]);
  const terminal = f.store.replyRequests.history(f.keys.agent, "commons", { cursor: incoming.page.nextCursor });
  assert.deepEqual(terminal.page.items.map(row => row.kind), ["answered"]); assert.equal(terminal.page.items[0].message.body, answer.data.body);
  assert.equal(f.store.replyRequests.list(f.keys.agent, "commons").requests.length, 0);
  assert.equal(f.store.replyRequests.list(f.keys.guest, "commons", { direction: "outgoing", status: "answered" }).requests.length, 1);
  f.post("owner", { body: "Unrelated newest event" });
  const empty = f.store.replyRequests.history(f.keys.agent, "commons", { checkpoint: terminal.page.completedCheckpoint });
  assert.deepEqual(empty.page.items, []);
  assert.equal(empty.page.horizonSequence, f.store.room("commons").sequence);
  assert.notEqual(empty.page.completedCheckpoint, terminal.page.completedCheckpoint);
  assert.throws(() => f.store.replyRequests.history(f.keys.agent, "commons", { checkpoint: terminal.page.nextCursor, direction: "bogus" }));
  assert.equal(f.store.snapshot(f.keys.agent, "commons").cursor, 0);
});

test("historical selection is frozen even when a request resolves between pages", t => {
  const f = fixture(t), q = f.open(), second = f.open();
  const first = f.store.replyRequests.history(f.keys.agent, "commons", { limit: 1 });
  f.send("agent", f.answer(q));
  const rest = f.store.replyRequests.history(f.keys.agent, "commons", { cursor: first.page.nextCursor });
  assert.deepEqual(rest.page.items.map(row => [row.requestMessageId, row.kind]), [[second.command.data.messageId, "opened"]]);
  const next = f.store.replyRequests.history(f.keys.agent, "commons", { checkpoint: rest.page.completedCheckpoint });
  assert.deepEqual(next.page.items.map(row => row.kind), ["answered"]);
});

test("resume tokens bind selection, identity and every retained boundary; rotation preserves identity", t => {
  const f = fixture(t), q = f.open(); f.post("guest", { body: "Context", replyToId: q.command.data.messageId });
  const first = f.store.replyRequests.history(f.keys.agent, "commons", { limit: 1 }), cursor = first.page.nextCursor;
  const rotated = f.store.issueAccessKey("commons", "agent");
  assert.equal(f.store.replyRequests.history(rotated, "commons", { cursor }).page.items.length, 1);
  assert.throws(() => f.store.replyRequests.history(f.keys.agent, "commons", { cursor }), { code: "unauthenticated" });
  f.keys.agent = rotated;
  assert.throws(() => f.store.replyRequests.history(f.keys.guest, "commons", { cursor }), { code: "reply_cursor_identity_changed" });
  assert.throws(() => f.store.replyRequests.history(f.keys.agent, "commons", { cursor, direction: "outgoing" }), { code: "reply_cursor_identity_changed" });
  assert.throws(() => f.store.replyRequests.selected(f.keys.agent, "commons", q.command.data.messageId, { cursor }), { code: "reply_cursor_identity_changed" });
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url"), original = JSON.parse(Buffer.from(cursor, "base64url"));
  for (const change of [value => { value.afterEventId = "wrong"; }, value => { value.horizonEventId = "wrong"; },
    value => { value.afterSequence = 0; }, value => { value.horizonSequence++; }]) {
    const value = structuredClone(original); change(value);
    assert.throws(() => f.store.replyRequests.history(f.keys.agent, "commons", { cursor: encode(value) }), { code: "reply_history_changed" });
  }
  for (const change of [value => { value.viewerAccountId = "other"; }, value => { value.viewerAuthEpoch = 999; }, value => { value.roomCreatedEventId = "other"; }]) {
    const value = structuredClone(original); change(value);
    assert.throws(() => f.store.replyRequests.history(f.keys.agent, "commons", { cursor: encode(value) }), { code: "reply_cursor_identity_changed" });
  }
  for (const bad of [cursor + "=", encode({ ...original, extra: true }), encode({ ...original, kind: "checkpoint" })])
    assert.throws(() => f.store.replyRequests.history(f.keys.agent, "commons", { cursor: bad }), { code: "invalid_reply_cursor" });
  assert.throws(() => f.store.replyRequests.history(f.keys.agent, "commons", { cursor, checkpoint: cursor }), { code: "invalid_reply_selection" });
  const old = f.store.db.prepare("SELECT body FROM events WHERE room_id='commons' AND sequence=?").get(original.afterSequence);
  const parsedEvent = JSON.parse(old.body); parsedEvent.id = "replaced-retained-event";
  f.store.db.prepare("UPDATE events SET id=?,body=? WHERE room_id='commons' AND sequence=?").run(parsedEvent.id, JSON.stringify(parsedEvent), original.afterSequence);
  assert.throws(() => f.store.replyRequests.history(f.keys.agent, "commons", { cursor }), { code: "reply_history_changed" });
});

test("marked-event extras and malformed checkpoint-hidden clarification bytes are rejected", t => {
  const f = fixture(t), q = f.open(), before = f.state();
  assert.throws(() => applyEvent(before, { ...q.receipt.event, id: "forged", idempotencyKey: "forged", data: { ...q.receipt.event.data, extra: true } }));
  const cancelled = f.send("guest", f.cancel(q));
  assert.throws(() => applyEvent(before, { ...cancelled.event, data: { ...cancelled.event.data, expectedRevision: 0 } }), /Unexpected reply cancellation fields/);
  const other = f.open(), posted = f.post("guest", { body: "Valid context", replyToId: other.command.data.messageId });
  const state = f.state(), history = f.store.db.prepare("SELECT sequence,body FROM events WHERE room_id='commons' ORDER BY sequence").all();
  for (const body of ["", " ", 5, null, "x".repeat(65537)]) {
    const altered = structuredClone(state), rows = structuredClone(history);
    altered.messages.at(-1).body = body;
    const entry = JSON.parse(rows.at(-1).body); entry.data.body = body; rows.at(-1).body = JSON.stringify(entry);
    assert.throws(() => auditReplyRequests(altered, rows, { sequence: posted.sequence, projection: JSON.stringify(altered) }), /Reply request history/);
  }
});

test("real account-session resume survives relogin, rejects stale binding and fences a changed auth epoch", t => {
  const f = fixture(t), q = f.open(); f.post("guest", { body: "More context", replyToId: q.command.data.messageId });
  const accountId = f.store.authenticate(f.keys.guest).account.id;
  const sessionFor = account => {
    const key = f.store.issueAccountAccessKey(account), slot = f.store.createAccountSessionSlot();
    f.store.loginAccountSession(slot.token, key, slot.session.sessionRevision);
    return { token: slot.token, session: f.store.authenticateAccountSession(slot.token, "commons") };
  };
  const first = sessionFor(accountId), initial = f.store.replyRequests.history(first.token, "commons", {
    direction: "outgoing", limit: 1, expectedSessionBinding: first.session.sessionBinding });
  const second = sessionFor(accountId);
  const options = { direction: "outgoing", cursor: initial.page.nextCursor, expectedSessionBinding: second.session.sessionBinding };
  assert.equal(f.store.replyRequests.history(second.token, "commons", options).page.items.length, 1);
  assert.throws(() => f.store.replyRequests.history(second.token, "commons", { ...options, expectedSessionBinding: first.session.sessionBinding }), { code: "session_binding_changed" });
  f.store.changeAccountAccess(accountId, { expectedRevision: 0, active: false, reason: "Synthetic suspension" });
  f.store.changeAccountAccess(accountId, { expectedRevision: 1, active: true, reason: "Synthetic restoration" });
  const third = sessionFor(accountId);
  assert.throws(() => f.store.replyRequests.history(third.token, "commons", { ...options, expectedSessionBinding: third.session.sessionBinding }), { code: "reply_cursor_identity_changed" });
  auditRecovery(f.store);
});

test("zero checkpoints, post-terminal comments and pasted-draft provenance stay explicit", t => {
  const f = fixture(t);
  f.send("owner", { id: "propose", type: "work.proposed", data: { workItemId: "work", title: "Agenda", definitionOfDone: "Clear agenda", accountableMemberId: "agent", mode: "read" } });
  const q = f.open("guest", { workItemId: "work" }), id = q.command.data.messageId;
  const draft = f.post("owner", { messageId: "pasted", body: "Draft", replyToId: id, workItemId: "work", packetId: "packet", basisRevision: 0 });
  const context = f.store.replyRequests.selected(f.keys.agent, "commons", id);
  assert.deepEqual(context.page.items.at(-1).message.proposal, { packetId: "packet", basisRevision: 0, submittedAtRevision: 0, attribution: "manual-unverified" });
  f.send("agent", f.answer(q, draft));
  f.post("owner", { messageId: "after-answer", body: "Thanks", replyToId: id });
  assert.equal(f.store.replyRequests.selected(f.keys.agent, "commons", id).page.items.at(-1).message.id, "after-answer");
  const history = f.store.replyRequests.history(f.keys.agent, "commons");
  assert.equal(history.page.items.some(row => row.message?.id === "after-answer"), false);
  const checkpoint = JSON.parse(Buffer.from(history.page.completedCheckpoint, "base64url"));
  checkpoint.throughSequence = 0; checkpoint.throughEventId = null;
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  assert.deepEqual(f.store.replyRequests.history(f.keys.agent, "commons", { checkpoint: encode(checkpoint) }).page.items, history.page.items);
  checkpoint.throughEventId = "not-zero";
  assert.throws(() => f.store.replyRequests.history(f.keys.agent, "commons", { checkpoint: encode(checkpoint) }), { code: "reply_history_changed" });
});

// Every message the composer sends carries the channel it was written in, and
// message.posted's command shape has permitted channelId since channels
// landed. prepareReplyPost's own allowlist did not, so a reply request and an
// answer were both refused with "Unexpected reply request fields" - in the
// browser, before anything was sent, leaving the composer stuck in request
// mode with the request still open. Every fixture in this file omitted
// channelId, which is why the whole file passed while the feature did not
// work at all.
test("a reply request and its answer carry the channel they were written in", t => {
  const f = fixture(t);
  const question = f.open("guest", { channelId: DEFAULT_CHANNEL_ID });
  const request = f.state().replyRequests[question.command.data.messageId];
  assert.equal(request.status, "open");

  f.send("agent", f.answer(question, question.receipt, { channelId: DEFAULT_CHANNEL_ID }));
  assert.equal(f.state().replyRequests[question.command.data.messageId].status, "answered");

  // The channel is kept on the messages, not swallowed on the way through.
  for (const message of f.state().messages) assert.equal(message.channelId, DEFAULT_CHANNEL_ID);
  assert.doesNotThrow(() => auditRecovery(f.store), "the audit replays a channelled reply request");

  // Still an allowlist, and widening it by one name did not open it. No field
  // the command envelope permits can reach this branch today - the only ones
  // left are the proposal fields, which a reply request refuses by name one
  // line earlier - so it is exercised directly, which is also the shape the
  // next added field will arrive in.
  assert.throws(() => prepareReplyPost(f.state(), { actorId: "guest", id: "x", data: {
    requestPolicyVersion: 1, messageId: "m", body: "Another?", toMemberId: "agent", requestKind: "reply",
    channelId: DEFAULT_CHANNEL_ID, somethingNew: "not declared anywhere" } }),
    /Unexpected reply request fields/);
});

test("prepared instructions stay current while selected conversation pagination remains frozen", t => {
  const f = fixture(t), q = f.open(), id = q.command.data.messageId;
  f.post("guest", { messageId: "prep-context", body: "Please explain the tradeoff", replyToId: id });
  const first = f.store.replyRequests.selected(f.keys.agent, "commons", id, { limit: 1 });
  f.send("owner", { id: "prep-charter", type: "room.charter_updated", data: {
    expectedRevision: 0, purpose: "Updated instructions", outputs: null, boundaries: null, escalation: null
  } });
  const next = f.store.replyRequests.selected(f.keys.agent, "commons", id, { cursor: first.page.nextCursor, limit: 1 });
  assert.equal(next.page.horizonSequence, first.page.horizonSequence);
  assert.ok(next.preparation.evaluatedThrough > next.page.horizonSequence);
  assert.equal(next.preparation.instructions.revision, 1);
  assert.equal(next.preparation.room.purpose, "Updated instructions");
  assert.equal(next.current.answerBasis.contextEventId, next.current.contextEventId);
  assert.equal(f.store.replyRequests.history(f.keys.agent, "commons").preparation, undefined);
  assert.equal(f.store.replyRequests.list(f.keys.agent, "commons").preparation, undefined);
});

test("follow-up preparation carries bounded completed exchanges for the same pair only", t => {
  const f = fixture(t), q = f.open();
  const id = q.command.data.messageId;
  const clarification = f.post("guest", { messageId: "clarification", body: "Keep it small", replyToId: id });
  f.post("guest", { messageId: "side", body: "Private side conversation", replyToId: id, toMemberId: "reviewer" });
  f.send("agent", f.answer(q, clarification, { contextEventId: f.state().replyRequests[id].contextEventId,
    contextSequence: f.store.room("commons").sequence, messageId: "answer" }));
  f.post("guest", { messageId: "later", body: "Post-answer chatter", replyToId: id });
  const follow = f.open("guest", { replyToId: "answer", body: "Add a keyboard shortcut" });
  const read = (who, request = follow) => f.store.replyRequests.selected(f.keys[who], "commons", request.command.data.messageId);
  const earlier = read("agent").preparation.previousExchanges;
  const stripTrust = exchanges => exchanges.map(exchange => ({
    ...exchange,
    messages: exchange.messages.map(({ untrusted, ...message }) => message)
  }));
  assert.deepEqual(earlier[0].messages.map(message => message.id), [id, "clarification", "answer"]);
  assert.deepEqual(stripTrust(read("guest").preparation.previousExchanges), stripTrust(earlier));
  assert.throws(() => read("reviewer"), { code: "reply_request_not_found" });
  const changedPair = f.open("guest", { replyToId: "answer", toMemberId: "reviewer" });
  assert.deepEqual(read("reviewer", changedPair).preparation.previousExchanges, []);
  f.send("agent", f.answer(follow, follow.receipt, { messageId: "second-answer" }));
  const next = f.open("guest", { replyToId: "second-answer" });
  assert.deepEqual(read("agent", next).preparation.previousExchanges.map(exchange => exchange.requestMessageId), [id, follow.command.data.messageId]);
  assert.equal(f.state().replyRequests[id].status, "answered");
  auditRecovery(f.store);
});

test("follow-up refuses withdrawn context and oversized history instead of silently omitting it", t => {
  const f = fixture(t), q = f.open();
  f.send("agent", f.answer(q, q.receipt, { messageId: "answer" }));
  const follow = f.open("guest", { replyToId: "answer" });
  f.send("guest", { id: "delete-question", type: "message.deleted", data: { messageId: q.command.data.messageId, expectedMessageRevision: 0 } });
  assert.throws(() => f.store.replyRequests.selected(f.keys.agent, "commons", follow.command.data.messageId), { code: "reply_follow_up_unavailable" });
  const large = f.open(); let basis = large.receipt;
  for (let i = 0; i < 17; i++) basis = f.post("guest", { messageId: `long-${i}`, body: "x".repeat(4096), replyToId: large.command.data.messageId });
  f.send("agent", f.answer(large, basis, { messageId: "large-answer" }));
  const last = f.open("guest", { replyToId: "large-answer" });
  assert.throws(() => f.store.replyRequests.selected(f.keys.agent, "commons", last.command.data.messageId), { code: "reply_follow_up_too_large" });
});

test("follow-up chains stop at eight prior exchanges and never carry another work branch", t => {
  const f = fixture(t); let parent = null, q;
  for (let i = 0; i < 10; i++) {
    q = f.open("guest", { replyToId: parent });
    if (i === 8) assert.equal(f.store.replyRequests.selected(f.keys.agent, "commons", q.command.data.messageId).preparation.previousExchanges.length, 8);
    if (i === 9) {
      assert.throws(() => f.store.replyRequests.selected(f.keys.agent, "commons", q.command.data.messageId), { code: "reply_follow_up_too_large" });
      break;
    }
    parent = `chain-answer-${i}`;
    f.send("agent", f.answer(q, q.receipt, { messageId: parent }));
  }
  f.send("owner", { id: "propose-branch", type: "work.proposed", data: { workItemId: "another-work", title: "Other work", definitionOfDone: "Done", accountableMemberId: "agent", mode: "read" } });
  const other = f.open("guest", { replyToId: parent, workItemId: "another-work" });
  assert.deepEqual(f.store.replyRequests.selected(f.keys.agent, "commons", other.command.data.messageId).preparation.previousExchanges, []);
});

// These regressions guard discovery without bypassing scoped context preparation.
// Existing selected-read tests do not exercise list pointers or either orientation adapter.
// They use the real store/HTTP/hosted MCP boundaries and require no production seams.
test("reply discovery points to selected context and cannot bypass unfinished pages", async t => {
  const f = fixture(t);
  const q = f.open("guest", { messageId: "visible-request", body: "Visible question body" });
  f.post("guest", { messageId: "visible-context", body: "Visible clarification body", replyToId: "visible-request" });
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeStreams(); server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const read = async (path, method = "GET") => {
    const response = await fetch(new URL(path, origin), { method, headers: { Authorization: `Bearer ${f.keys.agent}` } });
    assert.equal(response.status, 200);
    return response.json();
  };
  const listed = await read("/api/rooms/commons/reply-requests");
  assert.equal(JSON.stringify(listed).includes("Visible question body"), false);
  const row = listed.requests[0];
  assert.equal(listed.nextReads.length, 1);
  const pointer = listed.nextReads[0];
  assert.equal(pointer.requestMessageId, row.id);
  assert.deepEqual(pointer.nextRead, { tool: "room_read_request", arguments: { requestMessageId: "visible-request" } });
  const complete = await read(pointer.http.path, pointer.http.method);
  assert.equal(complete.request.id, row.id);
  assert.deepEqual(complete.page.items.map(item => item.message.body), ["Visible question body", "Visible clarification body"]);
  assert.equal(Object.hasOwn(row, "nextRead"), false, "wire rows retain the legacy exact-key contract");
  assert.equal(Object.hasOwn(row, "answerBasis"), false);
  assert.equal(Object.hasOwn(row, "actions"), false);
  const opts = { name: "room_list_requests", args: { direction: "incoming", status: "open" }, roomId: "commons" };
  assert.equal(validateReplyRead(listed, opts).requests[0].id, row.id);
  const legacy = structuredClone(listed); delete legacy.nextReads;
  assert.equal(validateReplyRead(legacy, opts).requests[0].id, row.id);
  const forged = structuredClone(listed); forged.nextReads[0].nextRead.arguments.requestMessageId = "another-request";
  assert.throws(() => validateReplyRead(forged, opts), { code: "invalid_response" });
  for (const path of ["https://elsewhere.invalid/steal", "/api/rooms/other/reply-context?requestMessageId=visible-request", "/api/rooms/commons/reply-context?requestMessageId=another-request"]) {
    const bad = structuredClone(listed); bad.nextReads[0].http.path = path;
    assert.throws(() => validateReplyRead(bad, opts), { code: "invalid_response" });
  }
  const first = await read(`${pointer.http.path}&limit=1`, pointer.http.method);
  assert.equal(first.page.hasMore, true);
  assert.equal(first.current.answerBasis, null);
  assert.ok(first.preparation.instructions);
  const last = await read(`${pointer.http.path}&limit=1&cursor=${encodeURIComponent(first.page.nextCursor)}`, pointer.http.method);
  assert.equal(last.page.hasMore, false);
  assert.ok(last.current.answerBasis);
  f.send("agent", f.answer(q, { event: { id: last.current.answerBasis.contextEventId }, sequence: last.current.answerBasis.contextSequence }));
  assert.equal(f.store.replyRequests.list(f.keys.agent, "commons").requests.length, 0);
});

test("needs-me orientation includes only incoming open request metadata", async t => {
  const f = fixture(t);
  f.open("guest", { messageId: "needs-me-request", body: "Needs-me question body" });
  const answered = f.open("guest", { messageId: "answered-request" });
  f.send("agent", f.answer(answered));
  const cancelled = f.open("guest", { messageId: "cancelled-request" });
  f.send("guest", f.cancel(cancelled));
  const declined = f.open("guest", { messageId: "declined-request" });
  f.send("agent", f.answer(declined, declined.receipt, { responseOutcome: "declined" }));
  f.open("agent", { messageId: "outgoing-request", toMemberId: "guest" });
  f.open("guest", { messageId: "someone-else-request", toMemberId: "reviewer" });
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeStreams(); server.closeAllConnections(); server.close(resolve); }));
  let raced = false;
  const client = new RoomAgentClient({ origin: `http://127.0.0.1:${server.address().port}`, roomId: "commons", token: f.keys.agent, memberId: "agent",
    fetchImpl: async (url, init) => {
      if (!raced && new URL(url).pathname.endsWith("/reply-requests")) {
        raced = true;
        f.post("guest", { messageId: "between-reads", body: "A newer clarification", replyToId: "needs-me-request" });
      }
      return fetch(url, init);
    } });
  const needs = await client.orient({ focus: "needs_me" });
  assert.ok(needs.replyRequestsEvaluatedThrough > needs.evaluatedThrough, "reply discovery must not claim the earlier work snapshot sequence");
  assert.equal(needs.selection.openReplyRequests, 1);
  assert.deepEqual(needs.replyRequests.map(r => r.id), ["needs-me-request"]);
  assert.deepEqual(needs.replyRequests[0].nextRead, { tool: "room_read_request", arguments: { requestMessageId: "needs-me-request" } });
  assert.equal(needs.replyRequestsEvaluatedThrough, f.store.room("commons").sequence);
  assert.equal(Object.hasOwn(needs.replyRequests[0], "answerBasis"), false);
  assert.equal(JSON.stringify(needs).includes("Needs-me question body"), false);
  assert.equal(Object.hasOwn(await client.orient(), "replyRequests"), false);
});

// Hosted MCP has a separate orientation implementation and identity authenticator.
test("hosted needs-me discovers private incoming requests without exposing their bodies", async t => {
  const f = fixture(t), owner = f.store.identities.create("Host"), peer = f.store.identities.create("Responder");
  const rooms = new AgentRooms(f.store);
  const created = rooms.create(owner.secret, { roomId: "hosted-replies", title: "Replies", purpose: "Answer questions", kind: "personal", displayName: "Host" });
  linkWithProof(f.store, owner.secret, created.roomId, peer, { displayName: "Responder", permissions: [] });
  f.store.dmConsents.request(created.roomId, created.ownerMemberId, peer.identityId, "Fixture");
  f.store.dmConsents.decide(created.roomId, peer.identityId, created.ownerMemberId, "approve");
  const send = command => f.store.command(owner.secret, created.roomId, command);
  send({ id: "hosted-open", type: "message.posted", data: { messageId: "hosted-question", body: "Private hosted question", toMemberId: peer.identityId, requestKind: "reply" } });
  const mcp = createHostedRoomMcp(f.store, { agentRooms: rooms });
  const list = async secret => {
    const response = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "room_list_work", arguments: { roomId: created.roomId, focus: "needs_me" } } }, { authorization: `Bearer ${secret}` });
    assert.equal(response.result?.isError, undefined, JSON.stringify(response));
    return response.result.structuredContent;
  };
  const before = await list(peer.secret);
  assert.deepEqual(before.replyRequests.map(r => r.id), ["hosted-question"]);
  assert.deepEqual(before.replyRequests[0].nextRead, { tool: "room_read_request", arguments: { requestMessageId: "hosted-question" } });
  assert.equal(before.replyRequestsEvaluatedThrough, f.store.room(created.roomId).sequence);
  assert.equal(JSON.stringify(before).includes("Private hosted question"), false);
  assert.equal(Object.hasOwn(before.replyRequests[0], "answerBasis"), false);
  assert.deepEqual((await list(owner.secret)).replyRequests, []);
  send({ id: "hosted-cancel", type: "reply_request.cancelled", data: { requestMessageId: "hosted-question", expectedRequestRevision: 0, reason: "Resolved elsewhere" } });
  assert.deepEqual((await list(peer.secret)).replyRequests, []);
});

test("reply audit rejects an access change for an inherited member id", () => {
  const state = {
    room: { id: "commons", ownerId: "owner" },
    members: { owner: { id: "owner", kind: "human", active: true } },
    messages: []
  };
  const history = [
    { sequence: 1, event: { type: "room.created", id: "room-created", roomId: "commons", actorId: "owner", at: "2026-09-27T00:00:00.000Z", data: { ownerId: "owner", roomId: "commons" } } },
    { sequence: 2, event: { type: "member.added", id: "member-added", roomId: "commons", actorId: "owner", at: "2026-09-27T00:00:01.000Z", data: { memberId: "owner", kind: "human", displayName: "Owner", permissions: [] } } },
    { sequence: 3, event: { type: "member.access_changed", id: "access-changed", roomId: "commons", actorId: "owner", at: "2026-09-27T00:00:02.000Z", data: { memberId: "toString", active: false, expectedMemberRevision: 0, permissions: [] } } }
  ];
  assert.throws(() => auditReplyRequests(state, history), /Reply request history requires operator reconciliation/);
  assert.equal(Object.hasOwn(Object.prototype.toString, "active"), false);
});

test("selected archived reply context does not refetch every message in ID batches", t => {
  const f = fixture(t, Array.from({ length: 600 }, (_, i) => event({
    roomId: "commons", actorId: "owner", type: "message.posted",
    data: { messageId: `unrelated-history-${i}`, body: `Unrelated history ${i}` }
  })));
  const q = f.open();
  f.post("guest", { messageId: "selected-context", body: "Additional context", replyToId: q.command.data.messageId, toMemberId: "agent" });
  const before = f.store.replyRequests.selected(f.keys.agent, "commons", q.command.data.messageId);
  while (!f.store.backfillMessages({ limit: 1000 }).done) { /* certify archive */ }
  assert.equal(f.store.checkMessagesParity().ok, true);
  assert.equal(f.store.archiveMessages("commons", { keepNewest: 1, dryRun: false }).ok, true);
  const prepare = f.store.db.prepare.bind(f.store.db);
  f.store.db.prepare = sql => {
    assert.ok(!sql.startsWith("SELECT message_id,record_json,body FROM messages WHERE")
      || !sql.includes("message_id IN (SELECT value FROM json_each(?))"), "ownership traversal must supply the same records used by the page");
    return prepare(sql);
  };
  const after = f.store.replyRequests.selected(f.keys.agent, "commons", q.command.data.messageId);
  assert.deepEqual(after.page, before.page);
  assert.deepEqual(after.responseActions, before.responseActions);
});

test("selected archived context keeps unrelated body text out of SQL result materialization", t => {
  const secret = "unselected-archive-body-" + "x".repeat(2000);
  const f = fixture(t, Array.from({ length: 300 }, (_, i) => event({
    roomId: "commons", actorId: "owner", type: "message.posted",
    data: { messageId: `body-history-${i}`, body: secret }
  })));
  const q = f.open();
  f.post("guest", { body: "Selected clarification", replyToId: q.command.data.messageId, toMemberId: "agent" });
  const before = f.store.replyRequests.selected(f.keys.agent, "commons", q.command.data.messageId);
  while (!f.store.backfillMessages({ limit: 1000 }).done) { /* certify archive */ }
  assert.equal(f.store.checkMessagesParity().ok, true);
  assert.equal(f.store.archiveMessages("commons", { keepNewest: 1, dryRun: false }).ok, true);
  const prepare = f.store.db.prepare.bind(f.store.db);
  f.store.db.prepare = sql => {
    const statement = prepare(sql);
    if (!sql.includes("FROM messages")) return statement;
    return new Proxy(statement, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      return (...args) => {
        const result = value.apply(target, args);
        if (key === "all" || key === "get") assert.ok(!JSON.stringify(result)?.includes(secret), "unrelated archive bodies must not cross SQL result boundary");
        return result;
      };
    } });
  };
  const after = f.store.replyRequests.selected(f.keys.agent, "commons", q.command.data.messageId);
  assert.deepEqual(after.page, before.page);
  assert.deepEqual(after.preparation, before.preparation);
  assert.deepEqual(after.responseActions, before.responseActions);
});

test("metadata context traversal preserves canonical corruption rejection outside the selected exchange", t => {
  const f = fixture(t, [event({ roomId: "commons", actorId: "owner", type: "message.posted",
    data: { messageId: "unrelated-corruption", body: "Unrelated" } })]);
  const q = f.open();
  while (!f.store.backfillMessages({ limit: 1000 }).done) { /* certify archive */ }
  assert.equal(f.store.checkMessagesParity().ok, true);
  assert.equal(f.store.archiveMessages("commons", { keepNewest: 1, dryRun: false }).ok, true);
  const original = f.store.db.prepare("SELECT record_json FROM messages WHERE message_id=?").get("unrelated-corruption").record_json;
  const record = JSON.parse(original);
  const read = () => f.store.replyRequests.selected(f.keys.agent, "commons", q.command.data.messageId);
  for (const invalid of ["{invalid", "null", "[]", "{id:'unrelated-corruption'}",
    JSON.stringify({ ...record, id: "wrong-id" }), JSON.stringify({ ...record, authorId: "guest" }),
    JSON.stringify({ ...record, createdAt: "wrong-time" })]) {
    f.store.db.prepare("UPDATE messages SET record_json=? WHERE message_id=?").run(invalid, "unrelated-corruption");
    assert.throws(read, undefined, "unrelated canonical corruption must still refuse the entire read");
  }
  f.store.db.prepare("UPDATE messages SET record_json=?,author_id=?,reply_to_id=? WHERE message_id=?")
    .run(original, "guest", q.command.data.messageId, "unrelated-corruption");
  assert.deepEqual(read().page.items.map(item => item.message.id), [q.command.data.messageId],
    "denormalized ownership columns cannot override the canonical record");
});

for (const count of [10, 100]) test(`request listing avoids full room hydration with ${count} unrelated messages`, async t => {
  const f = fixture(t);
  const answered = f.open('guest', {}, 'cold-answered');
  f.send('agent', f.answer(answered));
  f.open('guest', {}, 'cold-open');
  f.store.roomFlood = { consume() {} };
  for (let i = 0; i < count; i++) f.post('owner', { body: `UNRELATED-LIST-${i} ` + 'x'.repeat(2000) });
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  // Capture the prior full-projection behavior as the semantic oracle.
  const read = f.store.replyRequests.read.bind(f.store.replyRequests);
  f.store.replyRequests.read = (token, roomId, binding, fn) => read(token, roomId, binding, fn);
  const selections = [];
  for (const actor of ['agent', 'guest', 'reviewer']) for (const direction of ['incoming', 'outgoing', 'both']) for (const status of ['open', 'answered', 'all']) {
    const options = { direction, status };
    selections.push({ actor, options, expected: await new RoomAgentClient({ origin: `http://127.0.0.1:${server.address().port}`, roomId: 'commons', token: f.keys[actor] }).replyRequests(options) });
  }
  f.store.replyRequests.read = read;
  f.store._dropProjectionCache();
  const guard = t.mock.method(f.store, 'room', () => { throw new Error('request list hydrated full room'); });
  for (const { actor, options, expected } of selections) {
    const client = new RoomAgentClient({ origin: `http://127.0.0.1:${server.address().port}`, roomId: 'commons', token: f.keys[actor] });
    const actual = await client.replyRequests(options);
    assert.deepEqual(actual, expected);
    assert.equal(JSON.stringify(actual).includes('UNRELATED-LIST-'), false);
  }
  assert.equal(guard.mock.callCount(), 0);
  f.store.revoke(f.keys.agent);
  await assert.rejects(new RoomAgentClient({ origin: `http://127.0.0.1:${server.address().port}`, roomId: 'commons', token: f.keys.agent }).replyRequests());
});

test("request reads respect since-join history after member reactivation", async t => {
  const f = fixture(t);
  const frozen = Date.now() + 10000; f.store.now = () => frozen;
  f.send('owner', { id: 'floor-policy', type: 'room.history_visibility_set', data: { historyVisibility: 'since_join' } });
  const old = f.open('guest', { body: 'Private before reactivation' }, 'before-reactivation');
  f.post('guest', { messageId: 'older-context', body: 'Older context', replyToId: old.command.data.messageId });
  const oldRead = f.store.replyRequests.history(f.keys.agent, 'commons', { limit: 1 });
  f.send('owner', { id: 'remove-agent', type: 'member.access_changed', data: { memberId: 'agent', active: false, permissions: f.state().members.agent.permissions, expectedMemberRevision: f.state().members.agent.revision ?? 0 } });
  f.send('owner', { id: 'restore-agent', type: 'member.access_changed', data: { memberId: 'agent', active: true, permissions: f.state().members.agent.permissions, expectedMemberRevision: f.state().members.agent.revision ?? 0 } });
  f.keys.agent = f.store.issueAccessKey('commons', 'agent');
  const fresh = f.open('guest', { body: 'Visible after reactivation' }, 'after-reactivation');
  assert.deepEqual(f.store.replyRequests.list(f.keys.agent, 'commons').requests.map(r => r.id), [fresh.command.data.messageId]);
  assert.throws(() => f.store.replyRequests.selected(f.keys.agent, 'commons', old.command.data.messageId), { code: 'reply_request_not_found' });
  const history = f.store.replyRequests.history(f.keys.agent, 'commons');
  assert.deepEqual(history.page.items.map(i => i.message?.id), [fresh.command.data.messageId]);
  assert.equal(JSON.stringify(history).includes('Private before reactivation'), false);
  assert.equal(f.store.replyRequests.selected(f.keys.agent, 'commons', fresh.command.data.messageId).current.answerBasis.contextEventId, fresh.receipt.event.id);
  assert.ok(oldRead.page.nextCursor);
  assert.throws(() => f.store.replyRequests.history(f.keys.agent, 'commons', { cursor: oldRead.page.nextCursor }), { code: 'invalid_reply_cursor' });
  assert.equal(f.store.replyRequests.list(f.keys.guest, 'commons', { direction: 'outgoing' }).requests.length, 2);
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeStreams(); server.closeAllConnections(); server.close(resolve); }));
  const client = new RoomAgentClient({ origin: `http://127.0.0.1:${server.address().port}`, roomId: 'commons', memberId: 'agent', token: f.keys.agent });
  assert.deepEqual((await client.replyRequests()).requests.map(r => r.id), [fresh.command.data.messageId]);
  await assert.rejects(client.replyContext(old.command.data.messageId), /not found/i);
  assert.equal(JSON.stringify(await client.replyHistory()).includes('Private before reactivation'), false);
  const hosted = await callHostedStdioTool(f.store, f.keys.agent, 'room_list_requests', { roomId: 'commons' });
  assert.deepEqual(hosted.value.requests.map(r => r.id), [fresh.command.data.messageId]);
  await assert.rejects(callHostedStdioTool(f.store, f.keys.agent, 'room_read_request', { roomId: 'commons', requestMessageId: old.command.data.messageId }), /not found/i);

});

test('follow-up preparation refuses prior exchanges hidden by a new history policy', t => {
  const f = fixture(t), frozen = Date.now() + 10000; f.store.now = () => frozen;
  const old = f.open();
  f.send('agent', f.answer(old, old.receipt, { messageId: 'old-answer' }));
  for (const active of [false, true]) f.send('owner', { id: crypto.randomUUID(), type: 'member.access_changed', data: {
    memberId: 'agent', active, permissions: f.state().members.agent.permissions, expectedMemberRevision: f.state().members.agent.revision ?? 0
  } });
  f.keys.agent = f.store.issueAccessKey('commons', 'agent');
  const follow = f.open('guest', { replyToId: 'old-answer' });
  assert.equal(f.store.replyRequests.selected(f.keys.agent, 'commons', follow.command.data.messageId).preparation.previousExchanges.length, 1);
  f.send('owner', { id: 'restrict-history', type: 'room.history_visibility_set', data: { historyVisibility: 'since_join' } });
  assert.throws(() => f.store.replyRequests.selected(f.keys.agent, 'commons', follow.command.data.messageId), { code: 'reply_follow_up_unavailable' });
  assert.equal(f.store.replyRequests.selected(f.keys.guest, 'commons', follow.command.data.messageId).preparation.previousExchanges.length, 1);
  f.send('owner', { id: 'restore-history', type: 'room.history_visibility_set', data: { historyVisibility: 'all' } });
  assert.equal(f.store.replyRequests.selected(f.keys.agent, 'commons', follow.command.data.messageId).preparation.previousExchanges.length, 1);
});

for (const outcome of ['answered', 'cancelled']) test(`history checkpoints do not disclose hidden ${outcome} exchanges after reactivation`, t => {
  const f = fixture(t), frozen = Date.now() + 10000; f.store.now = () => frozen;
  f.send('owner', { id: 'set-history', type: 'room.history_visibility_set', data: { historyVisibility: 'since_join' } });
  const checkpoint = f.store.replyRequests.history(f.keys.agent, 'commons').page.completedCheckpoint;
  const old = f.open('guest', { body: 'Hidden terminal question' });
  if (outcome === 'answered') f.send('agent', f.answer(old, old.receipt, { body: 'Hidden terminal answer' }));
  else f.send('guest', f.cancel(old, { reason: 'Hidden cancellation reason' }));
  for (const active of [false, true]) f.send('owner', { id: crypto.randomUUID(), type: 'member.access_changed', data: {
    memberId: 'agent', active, permissions: f.state().members.agent.permissions, expectedMemberRevision: f.state().members.agent.revision ?? 0
  } });
  f.keys.agent = f.store.issueAccessKey('commons', 'agent');
  const fresh = f.open('guest', { body: 'Current question' });
  const history = f.store.replyRequests.history(f.keys.agent, 'commons', { checkpoint });
  assert.deepEqual(history.page.items.map(item => item.requestMessageId), [fresh.command.data.messageId]);
  assert.equal(JSON.stringify(history).includes('Hidden'), false);
  assert.deepEqual(f.store.replyRequests.list(f.keys.agent, 'commons', { status: 'all' }).requests.map(r => r.id), [fresh.command.data.messageId]);
  assert.throws(() => f.store.replyRequests.selected(f.keys.agent, 'commons', old.command.data.messageId), { code: 'reply_request_not_found' });
});
