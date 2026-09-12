import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { auditRecovery } from "../server/recovery.mjs";
import { applyEvent, replay, event } from "../src/events.js";
import { replyContextOwners, MAX_REPLY_REQUESTS } from "../src/reply-requests.js";
import { auditReplyRequests, REPLY_PAGE_BYTES } from "../server/reply-requests.mjs";

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

test("ordinary directed messages and ignored historical request fields remain ordinary", t => {
  const old = event({ roomId: "commons", actorId: "owner", type: "message.posted", data: {
    body: "Legacy data", requestKind: "reply", responseToRequestId: "old-subject", expectedRequestRevision: "ignored", contextSequence: 9
  } });
  const f = fixture(t, [old]); f.post("guest", { body: "Agent, a thought?", toMemberId: "agent" });
  assert.equal(Object.hasOwn(f.state(), "replyRequests"), false);
  assert.equal(f.state().messages[0].body, "Legacy data");
  auditRecovery(f.store);
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

test("ordinary clarification changes context, but reactions and independent request/work branches do not", t => {
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
  f.send("owner", { id: "reaction", type: "message.reaction_set", data: { messageId: subject, reaction: "like", active: true } });
  for (let i = 0; i < 105; i++) f.post("owner", { body: "Unrelated" });
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
  assert.equal(f.store.replyRequests.selected(f.keys.owner, "commons", id).current.answerBasis, null);
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
  for (const body of ["", " ", 5, null, "x".repeat(4097)]) {
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
