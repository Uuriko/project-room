import test from "node:test";
import assert from "node:assert/strict";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { emailContractFixture } from "../scripts/email-contract-fixture.mjs";
import { normalizeGraphEmail } from "../server/graph-email.mjs";
import { prepareGraphReplyDraft, inspectRecordedGraphReplyDraft } from "../server/graph-reply-draft.mjs";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { inboxLimits } from "../server/inbox.mjs";
import { auditRecovery } from "../server/recovery.mjs";
import { backupRoom } from "../server/backup.mjs";
import { createRuntimePackage } from "../scripts/runtime-package.mjs";
import { frozenAcceptanceFixture, v20ReplyJournalBaseline, v21ReplyReviewBaseline } from "../scripts/frozen-runtime-fixture.mjs";

function setup(t) {
  const f = createAcceptanceFixture(); f.filename = join(f.directory, "room.sqlite");
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  f.raw = emailContractFixture(); f.account = f.store.accountForMember("commons", "owner");
  f.raw.connection.accountId = f.account.id;
  f.login = () => {
    const slot = f.store.createAccountSessionSlot();
    f.token = slot.token; f.binding = f.store.loginAccountSession(slot.token, f.store.issueAccountAccessKey(f.account.id), 0).sessionBinding;
  }; f.login();
  f.store.email.apply(f.token, { action: "connection.configure", requestId: "connect", connectionId: f.raw.connection.id,
    expectedRevision: 0, profile: f.raw.connection }, f.binding);
  const envelope = normalizeGraphEmail(f.raw.connection, f.raw.message, f.raw.options); f.sourceId = envelope.sourceId;
  f.page = { action: "page.apply", requestId: "import", connectionId: f.raw.connection.id, connectionRevision: 1,
    folderId: f.raw.message.parentFolderId, expectedRevision: 0, expectedCursor: null, cursor: "cursor", reset: true, complete: true,
    observations: [{ kind: "message", expectedSourceRevision: 0, envelope }] };
  f.store.email.apply(f.token, f.page, f.binding);
  f.save = (body, expectedRevision = 0, sourceRevision = 1) => f.store.inbox.apply(f.token, {
    action: "draft.save", requestId: randomUUID(), sourceId: f.sourceId, expectedRevision, sourceRevision, body }, f.binding);
  f.save("A private reply. 🪷");
  f.reserve = () => {
    const requestId = randomUUID(), plan = prepareGraphReplyDraft({ store: f.store, token: f.token, binding: f.binding, sourceId: f.sourceId, requestId });
    return { action: "reply.reserve", requestId, sourceId: f.sourceId, mode: "reply", planVersion: plan.planVersion };
  };
  f.apply = request => f.store.inbox.reply(f.token, request, f.binding);
  f.attempts = () => f.store.inbox.replyAttempts(f.token, f.sourceId, f.binding).attempts;
  f.command = (action, attempt = f.attempts()[0]) => ({ action, requestId: randomUUID(), sourceId: f.sourceId,
    attemptId: attempt.id, expectedRevision: attempt.revision });
  f.response = (id = "opaque-provider+/=") => ({ status: 201, idType: "immutable", connection: f.raw.connection, message: { id } });
  f.record = (response, input = f.command("reply.created")) => {
    const { action, ...request } = input;
    return f.store.inbox.recordReplyCreation(f.token, { ...request, response }, f.binding);
  };
  f.created = () => { f.apply(f.reserve()); f.apply(f.command("reply.dispatch")); f.record(f.response()); };
  f.provider = () => {
    const expected = f.attempts()[0].plan.expected, address = value => ({ emailAddress: value });
    const message = { ...structuredClone(f.raw.message), id: "opaque-provider+/=", changeKey: "draft-v1", isDraft: true, hasAttachments: false,
      from: address(expected.from), sender: address(expected.from), replyTo: [], toRecipients: expected.to.map(address), ccRecipients: expected.cc.map(address),
      bccRecipients: [], body: { contentType: "text", content: expected.body } };
    return { status: 200, connection: f.raw.connection, message, options: { idType: "immutable",
      attachmentObservation: { messageId: message.id, messageRevision: message.changeKey, complete: true, items: [] } } };
  };
  f.observe = (response = f.provider(), input = f.command("reply.observed")) => {
    const { action, ...request } = input;
    return f.store.inbox.recordReplyObservation(f.token, { ...request, response }, f.binding);
  };
  f.review = () => ({ ...f.command("reply.review"), reviewVersion: f.attempts()[0].observation.reviewVersion });
  return f;
}

test("negotiated private review projection strips provider internals; HTTP accepts only exact human acknowledgment", async t => {
  const f = setup(t); f.created(); f.observe();
  const server = createRoomServer({ store: f.store }); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = "http://127.0.0.1:" + server.address().port, session = f.store.authenticateAccountSession(f.token, null, f.binding);
  const headers = { Cookie: "account_session=" + f.token, "X-Session-Binding": f.binding, "X-CSRF-Token": session.csrf,
    Origin: origin, "Content-Type": "application/json" };
  const path = "/api/inbox/sources/" + f.sourceId + "/reply-review";
  const get = suffix => fetch(origin + path + suffix, { headers });
  for (const suffix of ["", "?view=wrong", "?view=reply-review-v1&view=reply-review-v1", "?view=reply-review-v1&extra=1"])
    assert.equal((await get(suffix)).status, 422);
  const response = await get("?view=reply-review-v1"), context = await response.json();
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(context.attempt.canReview, true); assert.equal(context.attempt.canSend, false);
  for (const value of ["planVersion", "providerDraftId", "sourceMessageId", "create", "4200", "internetMessageHeaders"])
    assert.equal(JSON.stringify(context).includes('"' + value + '"'), false);
  for (const value of [f.raw.message.body.content, "observer@example.test", f.attempts()[0].providerDraftId])
    assert.equal(JSON.stringify(context).includes(value), false);
  const post = (request, extra = {}, route = "/api/inbox/review") => fetch(origin + route,
    { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(request) });
  const request = f.review();
  assert.equal((await post(request, { "X-CSRF-Token": "" })).status, 403);
  assert.equal((await post(request, { "X-Session-Binding": "f".repeat(64) })).status, 409);
  assert.equal((await fetch(origin + path + "?view=reply-review-v1", { headers: { ...headers, Authorization: "Bearer " + f.keys.producer } })).status, 401);
  const guest = f.store.accountForMember("commons", "guest"), slot = f.store.createAccountSessionSlot();
  const guestSession = f.store.loginAccountSession(slot.token, f.store.issueAccountAccessKey(guest.id), 0);
  const guestHeaders = { Cookie: "account_session=" + slot.token, "X-Session-Binding": guestSession.sessionBinding, "X-CSRF-Token": guestSession.csrf };
  assert.equal((await fetch(origin + path + "?view=reply-review-v1", { headers: guestHeaders })).status, 404);
  assert.equal((await post(request, guestHeaders)).status, 404);
  for (const action of ["reply.reserve", "reply.dispatch", "reply.created", "reply.observed", "send.reserve"]) {
    assert.equal((await post({ ...request, action })).status, 422);
  }
  assert.equal((await post(request, {}, "/api/inbox/commands")).status, 403);
  const savedResponse = await post(request), saved = await savedResponse.json();
  assert.equal(savedResponse.status, 201); assert.equal(saved.receipt.attempt, undefined);
  assert.deepEqual(saved.receipt, { action: request.action, requestId: request.requestId, sourceId: request.sourceId,
    attemptId: request.attemptId, revision: request.expectedRevision + 1, reviewVersion: request.reviewVersion });
  f.save("Changed local draft", 1);
  assert.equal((await post(request)).status, 200);
  assert.equal((await (await get("?view=reply-review-v1")).json()).attempt.review.current, false);
  assert.equal((await post({ ...request, requestId: randomUUID(), expectedRevision: f.attempts()[0].revision })).status, 409);
  auditRecovery(f.store);
});

test("exact provider observations and content review survive reopen, backup and retries without sending", async t => {
  const f = setup(t); f.created();
  const response = f.provider(); response.unretainedSecret = "not journaled";
  const input = f.command("reply.observed"), observed = f.observe(response, input);
  assert.equal(observed.receipt.attempt.status, "awaiting_review");
  assert.equal(f.observe(response, input).duplicate, true);
  assert.equal(JSON.stringify(f.store.db.prepare("SELECT request_json,receipt_json FROM private_inbox_commands").all()).includes("unretainedSecret"), false);
  const request = f.review(), reviewed = f.apply(request);
  assert.equal(reviewed.receipt.attempt.status, "draft_reviewed"); assert.equal(reviewed.receipt.attempt.canSend, false);
  assert.equal(f.attempts()[0].reviewCurrent, true);
  assert.deepEqual(reviewed.receipt.attempt.review, { version: request.reviewVersion, accountId: f.account.id,
    authEpoch: f.account.authEpoch, at: reviewed.receipt.attempt.updatedAt });
  const before = auditRecovery(f.store), attempts = f.attempts(); f.store.close(); f.store = new RoomStore(f.filename);
  assert.deepEqual(auditRecovery(f.store), before); assert.deepEqual(f.attempts(), attempts); assert.equal(f.apply(request).duplicate, true);
  const backup = await backupRoom(f.filename, f.directory), restored = new RoomStore(backup.filename, { readOnly: true });
  try { assert.deepEqual(auditRecovery(restored), before); } finally { restored.close(); }
  f.save("Newer local intent", 1);
  assert.equal(f.attempts()[0].reviewCurrent, false); assert.equal(f.apply(request).duplicate, true);
  assert.throws(() => f.apply(f.review()), { code: "stale_email_reply_plan" }); auditRecovery(f.store);
});

test("identical observations retain review; a changed opaque version or unavailable read invalidates it", t => {
  const f = setup(t); f.created(); f.observe(); f.apply(f.review());
  const review = f.attempts()[0].review;
  assert.deepEqual(f.observe().receipt.attempt.review, review);
  const response = f.provider(); response.message.changeKey = "opaque-not-sortable";
  response.options.attachmentObservation.messageRevision = response.message.changeKey;
  assert.equal(f.observe(response).receipt.attempt.review, null);
  assert.equal(f.attempts()[0].status, "awaiting_review"); f.apply(f.review());
  assert.equal(f.observe({ status: 404 }).receipt.attempt.status, "draft_unavailable");
  assert.equal(f.attempts()[0].review, null); assert.equal(f.attempts()[0].providerDraftId, response.message.id);
  assert.throws(() => f.apply({ ...f.command("reply.review"), reviewVersion: review.version }), { code: "stale_reply_review" });
  assert.throws(() => f.apply(f.reserve()), { code: "email_reply_unresolved" }); auditRecovery(f.store);
});

test("old reads and old review versions cannot overwrite a newer observation", t => {
  const f = setup(t); f.created(); f.observe();
  const oldRead = f.command("reply.observed"), oldReview = f.review(), response = f.provider();
  response.message.body.content = "A newer mailbox edit"; f.observe(response);
  const before = auditRecovery(f.store);
  assert.throws(() => f.observe(f.provider(), oldRead), { code: "stale_reply_attempt" });
  assert.throws(() => f.apply(oldReview), { code: "stale_reply_attempt" });
  assert.throws(() => f.apply({ ...f.review(), reviewVersion: oldReview.reviewVersion }), { code: "stale_reply_review" });
  assert.deepEqual(auditRecovery(f.store), before);
});

test("human review may acknowledge the exact visible recipient, subject and body differences", t => {
  const f = setup(t); f.created(); const response = f.provider();
  response.message.subject = "Re: A small collaboration"; response.message.body.content = "Provider signature and revised body";
  for (const field of ["toRecipients", "ccRecipients", "bccRecipients"]) response.message[field] = [{ emailAddress: { name: field, address: field + "@example.test" } }];
  f.observe(response);
  assert.deepEqual(f.attempts()[0].observation.differences, ["to", "cc", "bcc", "subject", "body"]);
  assert.equal(f.apply(f.review()).receipt.attempt.status, "draft_reviewed");
  assert.equal(f.attempts()[0].observation.draft.bcc[0].address, "bccRecipients@example.test");
  auditRecovery(f.store);
});

for (const change of ["draft_state", "thread", "from", "sender", "html", "attachments", "empty_recipients"]) test(`unsupported ${change} cannot be acknowledged as a supported reply`, t => {
  const f = setup(t); f.created(); const response = f.provider(), m = response.message;
  if (change === "draft_state") m.isDraft = false;
  if (change === "thread") m.conversationId = "different-thread";
  if (["from", "sender"].includes(change)) m[change].emailAddress = { name: "Other", address: "other@example.test" };
  if (change === "html") m.body = { contentType: "html", content: "<img src='https://example.test/not-requested'>" };
  if (change === "attachments") response.options.attachmentObservation = null;
  if (change === "empty_recipients") m.toRecipients = m.ccRecipients = m.bccRecipients = [];
  f.observe(response); const before = auditRecovery(f.store);
  assert.throws(() => f.apply(f.review()), { code: "unsupported_reply_review" });
  assert.deepEqual(auditRecovery(f.store), before);
});

test("wrong identities, mismatched scopes and oversized observations are rejected without changing history", t => {
  const f = setup(t); f.created(); f.observe(); f.apply(f.review());
  const before = auditRecovery(f.store);
  let response = f.provider(); response.message.id = "wrong"; response.options.attachmentObservation.messageId = "wrong";
  assert.throws(() => f.observe(response), { code: "email_reply_identity_changed" });
  response = f.provider(); response.connection = { ...response.connection, mailboxId: "wrong" };
  assert.throws(() => f.observe(response), { code: "email_reply_scope_changed" });
  response = f.provider(); response.message.body.content = "x".repeat(32768);
  assert.throws(() => f.observe(response), { code: "reply_observation_limit" });
  assert.throws(() => f.store.inbox.apply(f.token, f.review(), f.binding), { code: "reply_driver_required" });
  assert.deepEqual(auditRecovery(f.store), before);
});

for (const change of ["source", "connection", "account"]) test(`changed ${change} leaves review historical, not current`, t => {
  const f = setup(t); f.created(); f.observe(); f.apply(f.review()); const review = f.attempts()[0].review;
  if (change === "source") {
    f.raw.message.body.content = "Changed source"; const envelope = normalizeGraphEmail(f.raw.connection, f.raw.message, f.raw.options);
    f.store.email.apply(f.token, { ...f.page, requestId: "changed-source", expectedRevision: 1, expectedCursor: "cursor", cursor: "next",
      reset: false, observations: [{ kind: "message", expectedSourceRevision: 1, envelope }] }, f.binding);
  }
  if (change === "connection") f.store.email.apply(f.token, { action: "connection.disconnect", requestId: "disconnect",
    connectionId: f.raw.connection.id, expectedRevision: 1 }, f.binding);
  if (change === "account") {
    f.store.changeAccountAccess(f.account.id, { expectedRevision: 0, active: false, reason: "fixture revoke" });
    f.store.changeAccountAccess(f.account.id, { expectedRevision: 1, active: true, reason: "fixture restore" }); f.login();
  }
  assert.equal(f.attempts()[0].reviewCurrent, false); assert.deepEqual(f.attempts()[0].review, review);
  assert.throws(() => f.apply(f.review()), error => ["stale_email_reply", "email_connection_changed"].includes(error.code));
  f.observe(); if (change === "account") assert.equal(f.attempts()[0].review, null);
  auditRecovery(f.store);
});

test("reply attempts reuse the private journal with exact retries and no room or draft mutation", t => {
  const f = setup(t), room = f.store.snapshot(f.keys.producer, "commons"), draft = f.store.inbox.read(f.token, f.sourceId, f.binding).draft;
  const request = f.reserve(), saved = f.apply(request);
  assert.equal(saved.receipt.attempt.status, "reserved"); assert.equal(saved.receipt.attempt.canSend, false);
  assert.equal(f.apply(request).duplicate, true);
  assert.throws(() => f.apply({ ...request, mode: "replyAll" }), { code: "idempotency_conflict" });
  assert.throws(() => f.apply(f.reserve()), { code: "email_reply_unresolved" });
  assert.throws(() => f.store.inbox.apply(f.token, request, f.binding), { code: "reply_driver_required" });
  assert.throws(() => f.store.inbox.replyAttempts(f.keys.producer, f.sourceId, f.binding), { status: 401 });
  const guest = f.store.accountForMember("commons", "guest"), slot = f.store.createAccountSessionSlot();
  const session = f.store.loginAccountSession(slot.token, f.store.issueAccountAccessKey(guest.id), 0);
  assert.throws(() => f.store.inbox.replyAttempts(slot.token, f.sourceId, session.sessionBinding), { status: 404 });
  assert.deepEqual(f.store.snapshot(f.keys.producer, "commons"), room);
  assert.deepEqual(f.store.inbox.read(f.token, f.sourceId, f.binding).draft, draft);
  auditRecovery(f.store);
});

test("dispatch marker survives restart and missing responses; exact receipt retry does not create a new grant", async t => {
  const f = setup(t), reserve = f.reserve(); f.apply(reserve);
  const dispatch = f.command("reply.dispatch"), result = f.apply(dispatch), before = auditRecovery(f.store);
  assert.equal(result.duplicate, false); assert.equal(result.receipt.attempt.status, "creation_unconfirmed");
  assert.equal(f.apply(dispatch).duplicate, true);
  f.store.close(); f.store = new RoomStore(f.filename);
  assert.deepEqual(auditRecovery(f.store), before);
  for (const response of [null, { status: 404 }, { status: 503 }, { status: 200 }, { status: 201 },
    { ...f.response(), connection: { ...f.raw.connection, mailboxId: "wrong" } }]) {
    const observed = f.record(response);
    assert.equal(observed.recorded, false); assert.equal(observed.attempt.status, "creation_unconfirmed");
    assert.equal(observed.canRetryCreate, false);
  }
  assert.deepEqual(auditRecovery(f.store), before);
  assert.throws(() => f.apply(f.command("reply.dispatch")), { code: "reply_creation_started" });
  assert.throws(() => f.apply(f.command("reply.cancel")), { code: "reply_creation_started" });
  assert.throws(() => f.apply(f.reserve()), { code: "email_reply_unresolved" });
  const observation = f.command("reply.created"), created = f.record(f.response(), observation);
  assert.equal(created.receipt.attempt.status, "created_unverified");
  assert.equal(created.receipt.attempt.providerDraftId, "opaque-provider+/=");
  assert.equal(created.receipt.attempt.canSend, false); assert.equal(f.record(f.response(), observation).duplicate, true);
  assert.throws(() => f.record(f.response("different"), observation), { code: "idempotency_conflict" });
  const backup = await backupRoom(f.filename, f.directory), restored = new RoomStore(backup.filename, { readOnly: true });
  try { assert.deepEqual(auditRecovery(restored), auditRecovery(f.store)); } finally { restored.close(); }
});

for (const change of ["draft", "source", "connection", "account"]) test(`changed ${change} blocks dispatch but preserves cancellation and original history`, t => {
  const f = setup(t); f.apply(f.reserve());
  if (change === "draft") f.save("Changed", 1);
  if (change === "source") {
    f.raw.message.body.content = "Changed source"; const envelope = normalizeGraphEmail(f.raw.connection, f.raw.message, f.raw.options);
    f.store.email.apply(f.token, { ...f.page, requestId: "next-page", expectedRevision: 1, expectedCursor: "cursor", cursor: "next",
      reset: false, observations: [{ kind: "message", expectedSourceRevision: 1, envelope }] }, f.binding);
  }
  if (change === "connection") f.store.email.apply(f.token, { action: "connection.disconnect", requestId: "disconnect",
    connectionId: f.raw.connection.id, expectedRevision: 1 }, f.binding);
  if (change === "account") {
    f.store.changeAccountAccess(f.account.id, { expectedRevision: 0, active: false, reason: "fixture revoke" });
    assert.throws(() => f.apply(f.command("reply.dispatch", { id: "unknown", revision: 0 })), { status: 401 });
    f.store.changeAccountAccess(f.account.id, { expectedRevision: 1, active: true, reason: "fixture restore" }); f.login();
  }
  const before = auditRecovery(f.store);
  assert.throws(() => f.apply(f.command("reply.dispatch")), error => ["stale_email_reply_plan", "stale_email_reply", "email_connection_changed"].includes(error.code));
  assert.deepEqual(auditRecovery(f.store), before);
  assert.equal(f.apply(f.command("reply.cancel")).receipt.attempt.status, "cancelled"); auditRecovery(f.store);
});

test("late provider evidence belongs to the original attempt after draft/source edits and mailbox disconnect", t => {
  const f = setup(t); f.apply(f.reserve()); f.apply(f.command("reply.dispatch"));
  const original = f.attempts()[0].plan;
  f.save("A different private reply", 1);
  f.raw.message.body.content = "The request changed";
  const envelope = normalizeGraphEmail(f.raw.connection, f.raw.message, f.raw.options);
  f.store.email.apply(f.token, { ...f.page, requestId: "source-change", expectedRevision: 1, expectedCursor: "cursor", cursor: "next",
    reset: false, observations: [{ kind: "message", expectedSourceRevision: 1, envelope }] }, f.binding);
  f.store.email.apply(f.token, { action: "connection.disconnect", requestId: "disconnect", connectionId: f.raw.connection.id, expectedRevision: 1 }, f.binding);
  const created = f.record(f.response()).receipt.attempt;
  assert.deepEqual(created.plan, original); assert.equal(created.status, "created_unverified");
  assert.equal(f.store.inbox.read(f.token, f.sourceId, f.binding).draft.body, "A different private reply");
  auditRecovery(f.store);
});

test("an account revocation refuses observations until reauthentication; restored owner can retain old outcome", t => {
  const f = setup(t); f.apply(f.reserve()); f.apply(f.command("reply.dispatch")); const input = f.command("reply.created");
  f.store.changeAccountAccess(f.account.id, { expectedRevision: 0, active: false, reason: "fixture revoke" });
  assert.throws(() => f.record(f.response(), input), { status: 401 });
  f.store.changeAccountAccess(f.account.id, { expectedRevision: 1, active: true, reason: "fixture restore" }); f.login();
  assert.equal(f.record(f.response(), input).receipt.attempt.status, "created_unverified"); auditRecovery(f.store);
});

test("journal insertion failure rolls back dispatch; capacity never prevents the single terminal observation", t => {
  const f = setup(t); f.apply(f.reserve()); const before = auditRecovery(f.store);
  f.store.db.exec("CREATE TRIGGER test_reply_failure BEFORE INSERT ON private_inbox_commands BEGIN SELECT RAISE(ABORT,'fixture reply journal failure'); END");
  assert.throws(() => f.apply(f.command("reply.dispatch")), /fixture reply journal failure/);
  f.store.db.exec("DROP TRIGGER test_reply_failure"); assert.deepEqual(auditRecovery(f.store), before);
  f.apply(f.command("reply.dispatch"));
  // Move the configured pilot count above its limit without inventing invalid history.
  const prepare = f.store.db.prepare.bind(f.store.db);
  f.store.db.prepare = sql => sql === "SELECT count(*) n FROM private_inbox_commands WHERE account_id=?"
    ? { get: () => ({ n: inboxLimits.commands }) } : prepare(sql);
  try {
    assert.equal(f.record(f.response()).receipt.attempt.status, "created_unverified");
    assert.throws(() => f.apply(f.reserve()), { code: "inbox_limit" });
  } finally { f.store.db.prepare = prepare; }
  auditRecovery(f.store);
});

test("pre-dispatch cancellation permits a fresh reservation and remains available at capacity", t => {
  const f = setup(t); f.apply(f.reserve());
  const prepare = f.store.db.prepare.bind(f.store.db);
  f.store.db.prepare = sql => sql === "SELECT count(*) n FROM private_inbox_commands WHERE account_id=?"
    ? { get: () => ({ n: inboxLimits.commands }) } : prepare(sql);
  try { assert.equal(f.apply(f.command("reply.cancel")).receipt.attempt.status, "cancelled"); }
  finally { f.store.db.prepare = prepare; }
  const fresh = f.apply(f.reserve()).receipt.attempt;
  assert.equal(fresh.status, "reserved"); assert.notEqual(fresh.id, f.attempts()[0].id); auditRecovery(f.store);
});

test("one provider draft ID cannot be attached to two different source attempts", t => {
  const f = setup(t); f.apply(f.reserve()); f.apply(f.command("reply.dispatch")); f.record(f.response());
  f.raw.message.id = "another-source"; f.raw.options.attachmentObservation.messageId = f.raw.message.id;
  const envelope = normalizeGraphEmail(f.raw.connection, f.raw.message, f.raw.options); f.sourceId = envelope.sourceId;
  f.store.email.apply(f.token, { ...f.page, requestId: "second-source", expectedRevision: 1, expectedCursor: "cursor", cursor: "next",
    reset: false, observations: [{ kind: "message", expectedSourceRevision: 0, envelope }] }, f.binding);
  f.save("Reply to another request"); f.apply(f.reserve()); f.apply(f.command("reply.dispatch"));
  assert.throws(() => f.record(f.response()), { code: "conflicting_reply_observation" }); auditRecovery(f.store);
});

test("provider inspection uses the journal's draft identity and original intent, never a caller-selected replacement", t => {
  const f = setup(t); f.apply(f.reserve());
  const attempt = f.attempts()[0], args = { store: f.store, token: f.token, binding: f.binding, sourceId: f.sourceId, attemptId: attempt.id };
  assert.throws(() => inspectRecordedGraphReplyDraft({ ...args, response: null }), { code: "reply_draft_unconfirmed" });
  f.apply(f.command("reply.dispatch")); f.record(f.response()); f.save("Newer local reply", 1);
  const address = value => ({ emailAddress: value }), expected = attempt.plan.expected;
  const message = { ...structuredClone(f.raw.message), id: "opaque-provider+/=", changeKey: "draft-v1", isDraft: true, hasAttachments: false,
    from: address(expected.from), sender: address(expected.from), replyTo: [], toRecipients: expected.to.map(address), ccRecipients: expected.cc.map(address),
    bccRecipients: [], body: { contentType: "text", content: expected.body } };
  const response = { status: 200, connection: f.raw.connection, message,
    options: { idType: "immutable", attachmentObservation: { messageId: message.id, messageRevision: message.changeKey, complete: true, items: [] } } };
  const before = auditRecovery(f.store), inspected = inspectRecordedGraphReplyDraft({ ...args, response });
  assert.equal(inspected.status, "content_matches"); assert.equal(inspected.basis, "retained_attempt"); assert.equal(inspected.canSend, false);
  response.message.id = "substituted-draft"; response.options.attachmentObservation.messageId = response.message.id;
  assert.throws(() => inspectRecordedGraphReplyDraft({ ...args, response }), { code: "email_reply_identity_changed" });
  assert.deepEqual(auditRecovery(f.store), before);
});

for (const action of ["reserve", "dispatch", "review-observation"]) test(`independent database connections admit exactly one reply ${action}`, { timeout: 15000 }, async t => {
  const f = setup(t);
  if (action === "dispatch") f.apply(f.reserve());
  if (action === "review-observation") { f.created(); f.observe(); }
  const commands = action === "reserve" ? [f.reserve(), f.reserve()] : action === "dispatch" ? [f.command("reply.dispatch"), f.command("reply.dispatch")]
    : [f.review(), { ...f.command("reply.observed"), observation: null }];
  const barrier = new SharedArrayBuffer(4);
  const workers = commands.map(command => new Worker(`
    const {parentPort,workerData:d}=require('node:worker_threads');
    import(d.module).then(({RoomStore})=>{
      const store=new RoomStore(d.filename);
      parentPort.postMessage({ready:true}); Atomics.wait(new Int32Array(d.barrier),0,0);
      try { parentPort.postMessage({result:store.inbox.reply(d.token,d.command,d.binding)}); }
      catch(e) { parentPort.postMessage({error:{code:e.code,message:e.message}}); }
      finally { store.close(); }
    });
  `, { eval: true, workerData: { module: new URL("../server/store.mjs", import.meta.url).href,
    filename: f.filename, token: f.token, binding: f.binding, command, barrier } }));
  t.after(async () => { await Promise.all(workers.map(worker => worker.terminate())); });
  const results = workers.map(worker => new Promise((resolve, reject) => {
    worker.on("message", value => { if (!value.ready) resolve(value); }); worker.once("error", reject);
  }));
  await Promise.all(workers.map(worker => new Promise((resolve, reject) => {
    worker.on("message", value => { if (value.ready) resolve(); }); worker.once("error", reject);
  })));
  Atomics.store(new Int32Array(barrier), 0, 1); Atomics.notify(new Int32Array(barrier), 0, workers.length);
  const observed = await Promise.all(results);
  assert.equal(observed.filter(value => value.result && !value.result.duplicate).length, 1);
  assert.equal(observed.filter(value => value.error).length, 1);
  assert.equal(f.attempts().length, 1);
  if (action === "review-observation") {
    assert.ok(["draft_reviewed", "draft_unavailable"].includes(f.attempts()[0].status));
    assert.equal(f.attempts()[0].revision, 4);
  } else assert.equal(f.attempts()[0].status, action === "reserve" ? "reserved" : "creation_unconfirmed");
  auditRecovery(f.store);
});

test("retained journal tampering is detected even if the current attempt still looks plausible", t => {
  const f = setup(t); f.apply(f.reserve()); f.apply(f.command("reply.dispatch"));
  const row = f.store.db.prepare("SELECT sequence,receipt_json FROM private_inbox_commands WHERE json_extract(request_json,'$.action')='reply.reserve'").get();
  const receipt = JSON.parse(row.receipt_json); receipt.attempt.plan.expected.body = "Altered history";
  f.store.db.exec("DROP TRIGGER private_inbox_commands_no_update");
  f.store.db.prepare("UPDATE private_inbox_commands SET receipt_json=? WHERE sequence=?").run(JSON.stringify(receipt), row.sequence);
  f.store.db.exec("CREATE TRIGGER private_inbox_commands_no_update BEFORE UPDATE ON private_inbox_commands BEGIN SELECT RAISE(ABORT,'inbox receipts are immutable'); END");
  assert.throws(() => auditRecovery(f.store), /reconciliation/);
});

test("pre-v21 reply namespace collisions are refused without upgrading the database", async t => {
  const root = mkdtempSync(join(tmpdir(), "room-reply-migration-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = fileURLToPath(new URL("../", import.meta.url)), destination = join(root, "old");
  createRuntimePackage({ repository, commit: v20ReplyJournalBaseline, destination });
  const f = (await frozenAcceptanceFixture(repository, destination, v20ReplyJournalBaseline))();
  try {
    const account = f.store.accountForMember("commons", "owner");
    f.store.db.prepare("INSERT INTO private_inbox_commands(account_id,request_id,fingerprint,request_json,receipt_json,auth_epoch,at) VALUES(?,?,?,?,?,?,?)")
      .run(account.id, "collision", "invalid", JSON.stringify({ action: "reply.reserve" }), "{}", 0, 1);
    const catalog = f.store.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all();
    assert.throws(() => new RoomStore(join(f.directory, "room.sqlite")), /Pre-v21 reply history/);
    assert.equal(f.store.db.prepare("PRAGMA user_version").get().user_version, 20);
    assert.deepEqual(f.store.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all(), catalog);
  } finally { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test("pre-v22 review namespace collisions are refused before retiring the v21 writer", async t => {
  const root = mkdtempSync(join(tmpdir(), "room-review-migration-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = fileURLToPath(new URL("../", import.meta.url)), destination = join(root, "old");
  createRuntimePackage({ repository, commit: v21ReplyReviewBaseline, destination });
  const f = (await frozenAcceptanceFixture(repository, destination, v21ReplyReviewBaseline))();
  try {
    const account = f.store.accountForMember("commons", "owner");
    f.store.db.prepare("INSERT INTO private_inbox_commands(account_id,request_id,fingerprint,request_json,receipt_json,auth_epoch,at) VALUES(?,?,?,?,?,?,?)")
      .run(account.id, "collision", "invalid", JSON.stringify({ action: "reply.review" }), "{}", 0, 1);
    const catalog = f.store.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all();
    assert.throws(() => new RoomStore(join(f.directory, "room.sqlite")), /Pre-v22 reply review history/);
    assert.equal(f.store.db.prepare("PRAGMA user_version").get().user_version, 21);
    assert.deepEqual(f.store.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all(), catalog);
  } finally { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test("observation and review are atomic and bounded; their retained receipts are replay-verified", t => {
  const f = setup(t); f.created(); f.observe(); const before = auditRecovery(f.store);
  f.store.db.exec("CREATE TRIGGER test_reply_failure BEFORE INSERT ON private_inbox_commands BEGIN SELECT RAISE(ABORT,'fixture reply journal failure'); END");
  assert.throws(() => f.apply(f.review()), /fixture reply journal failure/);
  assert.throws(() => f.observe(null), /fixture reply journal failure/);
  f.store.db.exec("DROP TRIGGER test_reply_failure"); assert.deepEqual(auditRecovery(f.store), before);
  const prepare = f.store.db.prepare.bind(f.store.db);
  f.store.db.prepare = sql => sql === "SELECT count(*) n FROM private_inbox_commands WHERE account_id=?"
    ? { get: () => ({ n: inboxLimits.commands }) } : prepare(sql);
  try {
    assert.throws(() => f.apply(f.review()), { code: "inbox_limit" });
    assert.throws(() => f.observe(), { code: "inbox_limit" });
  } finally { f.store.db.prepare = prepare; }
  assert.deepEqual(auditRecovery(f.store), before); f.apply(f.review());
  const row = f.store.db.prepare("SELECT sequence,receipt_json FROM private_inbox_commands WHERE json_extract(request_json,'$.action')='reply.review'").get();
  const receipt = JSON.parse(row.receipt_json); receipt.attempt.review.version = "0".repeat(64);
  f.store.db.exec("DROP TRIGGER private_inbox_commands_no_update");
  f.store.db.prepare("UPDATE private_inbox_commands SET receipt_json=? WHERE sequence=?").run(JSON.stringify(receipt), row.sequence);
  f.store.db.exec("CREATE TRIGGER private_inbox_commands_no_update BEFORE UPDATE ON private_inbox_commands BEGIN SELECT RAISE(ABORT,'inbox receipts are immutable'); END");
  assert.throws(() => auditRecovery(f.store), /reconciliation/);
});
