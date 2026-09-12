import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { createReplyUpdateFixture } from "../scripts/reply-update-fixture.mjs";
import { RoomStore } from "../server/store.mjs";
import { auditRecovery } from "../server/recovery.mjs";
import { backupRoom } from "../server/backup.mjs";
import { createRoomServer } from "../server/http.mjs";
import { inboxLimits } from "../server/inbox.mjs";
import { transitionReplyAttempt } from "../server/graph-reply-journal.mjs";
import { buildUpdateReview } from "../server/graph-reply-update-review.mjs";
import { createRuntimePackage } from "../scripts/runtime-package.mjs";
import { candidateRuntimeFixture } from "../scripts/candidate-runtime-fixture.mjs";
import { frozenAcceptanceFixture, frozenRecoveryFixture, v22ReplyUpdateBaseline, v23ReplyAcknowledgmentBaseline, v24ReplyResolutionBaseline } from "../scripts/frozen-runtime-fixture.mjs";

function setup(t) {
  const f = createReplyUpdateFixture(t), { token, binding, sourceId, attemptId } = f.args;
  const apply = request => f.store.inbox.reply(token, request, binding);
  const updates = () => f.store.inbox.replyUpdates(token, sourceId, binding).updates;
  const reserve = () => {
    const proposal = f.prepare({ requestId: randomUUID() });
    return { action: "reply.update.reserve", requestId: proposal.requestId, sourceId, attemptId,
      expectedRevision: proposal.attemptRevision, updateVersion: proposal.updateVersion };
  };
  const command = (action, update = updates().at(-1)) => ({ action: "reply.update." + action,
    requestId: randomUUID(), sourceId, attemptId, updateId: update.id, expectedRevision: update.revision });
  const observe = (response = f.response(), request = command("observed")) => {
    const { action, ...rest } = request;
    return f.store.inbox.recordReplyUpdateObservation(token, { ...rest, response }, binding);
  };
  const ack = (dispatch, response = { ...f.response(), method: "PATCH", idType: "immutable" }, requestId = randomUUID()) =>
    f.store.inbox.recordReplyUpdateAcknowledgment(token, { sourceId, attemptId, updateId: dispatch.updateId,
      dispatchRequestId: dispatch.requestId, requestId, response }, binding);
  const inspection = () => f.store.inbox.prepareReplyUpdateInspection(token, sourceId, updates().at(-1).id, binding);
  const inspect = (response = f.response(), context = inspection(), requestId = randomUUID()) =>
    f.store.inbox.recordReplyUpdateInspection(token, { context, response, requestId }, binding);
  const reviewContext = () => f.store.readTransaction(() => buildUpdateReview(f.store.inbox.replyUpdateContext(token, sourceId, updates().at(-1).id, binding)));
  const review = () => apply({ ...command("review"), reviewVersion: reviewContext().reviewVersion });
  return { ...f, apply, updates, reserve, command, observe, ack, inspection, inspect, reviewContext, review, filename: join(f.directory, "room.sqlite") };
}

test("post-write inspection and review resolve an update without adopting text; the next proposal uses the actual read", t => {
  const f = setup(t); f.save("Proposed mailbox text"); const parent = f.attempt();
  f.apply(f.reserve()); const dispatch = f.command("dispatch"); f.apply(dispatch); f.ack(dispatch);
  assert.equal(f.reviewContext().canReview, false);
  const response = f.response(); response.message.body.content = "Proposed mailbox text";
  f.inspect(response); assert.equal(f.reviewContext().canReview, true);
  const before = f.store.inbox.read(f.args.token, f.args.sourceId, f.args.binding), result = f.review();
  assert.equal(result.receipt.update.status, "resolved"); assert.equal(result.receipt.update.canSend, false);
  assert.deepEqual(f.attempt(), parent); assert.deepEqual(f.store.inbox.read(f.args.token, f.args.sourceId, f.args.binding), before);
  assert.equal(f.prepare().status, "no_update");
  f.save("Another deliberate update"); const next = f.reserve(); f.apply(next);
  assert.equal(f.updates().length, 2); assert.equal(f.updates()[1].proposal.observed.body, "Proposed mailbox text");
  assert.equal(f.updates()[1].proposal.original.body, parent.plan.expected.body);
  assert.equal(f.updates()[1].proposal.proposed.body, "Another deliberate update");
  auditRecovery(f.store);
});

test("reads before acknowledgment and reads crossing it cannot become post-write review evidence", t => {
  const f = setup(t); f.save("Edited"); f.apply(f.reserve()); const dispatch = f.command("dispatch"); f.apply(dispatch);
  f.inspect(); const stale = f.inspection(); assert.equal(f.reviewContext().canReview, false);
  f.ack(dispatch); assert.equal(f.reviewContext().canReview, false);
  assert.throws(() => f.inspect(f.response(), stale), { code: "stale_reply_update" });
  f.inspect(); assert.equal(f.reviewContext().canReview, true);
  f.observe(); assert.equal(f.reviewContext().canReview, false, "a later legacy read invalidates the inspection");
  f.inspect(); f.seed.observe(); assert.equal(f.reviewContext().canReview, false, "a newer parent observation invalidates the inspected basis");
  f.inspect(); assert.equal(f.reviewContext().canReview, true); auditRecovery(f.store);
});

test("private updated-reply preview follows actual reads without rewriting or reviving its review", t => {
  const f = setup(t); f.save("Edited"); f.apply(f.reserve());
  const dispatch = f.command("dispatch"); f.apply(dispatch); f.ack(dispatch); f.inspect(); f.review();
  const view = () => f.store.inbox.replyReviewContext(f.args.token, f.args.sourceId, f.args.binding, { view: "reply-review-v4" });
  const child = f.updates().at(-1), local = f.store.inbox.read(f.args.token, f.args.sourceId, f.args.binding).draft;
  assert.equal(view().update.review.current, true);
  const response = f.response(); response.message.body.content = "Latest recorded mailbox text";
  response.message.changeKey = "opaque-different-version";
  response.options.attachmentObservation.messageRevision = response.message.changeKey;
  f.record(response);
  const updated = view();
  assert.equal(updated.update.observation.body, "Latest recorded mailbox text");
  assert.equal(updated.update.canReview, false); assert.equal(updated.update.review, null);
  assert.equal(updated.update.revision, child.revision); assert.equal(updated.update.versionMismatch, true);
  assert.deepEqual(f.updates().at(-1), child, "read projection never rewrites prior child evidence");
  f.record(null);
  assert.equal(view().update.observation, null, "unavailability must not fall back to an older successful read");
  assert.equal(view().update.canReview, false); assert.equal(view().update.review, null);
  response.message.body = { contentType: "html", content: "<b>Unsupported body</b>" };
  f.record(response);
  assert.equal(view().update.observation.format, "html"); assert.equal(view().update.observation.body, null);
  assert.equal(view().update.canReview, false);
  f.inspect(response); assert.equal(view().update.canReview, false, "an unsupported inspection remains read-only");
  assert.deepEqual(f.store.inbox.read(f.args.token, f.args.sourceId, f.args.binding).draft, local);
  auditRecovery(f.store);
});

test("review binds current local writing and exact inspection; changes stay available for a fresh comparison", t => {
  const f = setup(t); f.save("Edited"); f.apply(f.reserve()); const dispatch = f.command("dispatch"); f.apply(dispatch); f.ack(dispatch); f.inspect();
  const request = { ...f.command("review"), reviewVersion: f.reviewContext().reviewVersion };
  f.save("Keep my newer local writing");
  assert.throws(() => f.apply(request), { code: "stale_reply_update_review" });
  assert.equal(f.reviewContext().canReview, true);
  const reviewed = f.review(), original = reviewed.receipt.update.proposal.original;
  assert.equal(f.store.inbox.read(f.args.token, f.args.sourceId, f.args.binding).draft.body, "Keep my newer local writing");
  assert.deepEqual(reviewed.receipt.update.proposal.original, original);
  assert.equal(f.reviewContext().reviewVersion, reviewed.receipt.update.review.version);
  const context = f.inspection(), response = f.response(), requestId = randomUUID();
  const inspection = f.inspect(response, context, requestId);
  assert.equal(f.updates().at(-1).review, null); assert.equal(f.inspect(response, context, requestId).duplicate, true);
  assert.deepEqual(f.inspect(response, context, requestId).receipt, inspection.receipt);
  f.review(); f.save("Next"); f.apply(f.reserve());
  assert.equal(f.inspect(response, context, requestId).duplicate, true, "exact receipt survives a newer child");
  auditRecovery(f.store);
});

test("reauthorizing the same mailbox requires a fresh inspection and never revives an old review", t => {
  const f = setup(t); f.save("Edited"); f.apply(f.reserve()); const dispatch = f.command("dispatch"); f.apply(dispatch); f.ack(dispatch); f.inspect();
  const stale = f.inspection(), response = f.response(); f.review();
  f.store.changeAccountAccess(f.account.id, { expectedRevision: 0, active: false, reason: "Fixture suspension" });
  assert.throws(() => f.inspect(response, stale), { status: 401 });
  f.store.changeAccountAccess(f.account.id, { expectedRevision: 1, active: true, reason: "Fixture return" });
  const slot = f.store.createAccountSessionSlot(), session = f.store.loginAccountSession(slot.token, f.store.issueAccountAccessKey(f.account.id), 0);
  const view = () => f.store.inbox.replyReviewContext(slot.token, f.args.sourceId, session.sessionBinding, { view: "reply-review-v4" }).update;
  assert.equal(view().canReview, false);
  const profile = { ...f.raw.connection, revision: 2, identity: { ...f.raw.connection.identity, name: "Updated display name" } };
  f.store.email.apply(slot.token, { action: "connection.configure", requestId: "reconnect-for-review", connectionId: profile.id,
    expectedRevision: 1, profile }, session.sessionBinding);
  assert.equal(view().canReview, false);
  const context = f.store.inbox.prepareReplyUpdateInspection(slot.token, f.args.sourceId, dispatch.updateId, session.sessionBinding);
  response.connection = profile;
  f.store.inbox.recordReplyUpdateInspection(slot.token, { context, requestId: "reauthorized-inspection", response }, session.sessionBinding);
  assert.equal(view().canReview, true); assert.equal(view().review, null);
  const current = view();
  f.store.inbox.reviewReply(slot.token, { action: "reply.update.review", requestId: "reauthorized-review", sourceId: f.args.sourceId,
    attemptId: f.args.attemptId, updateId: current.id, expectedRevision: current.revision, reviewVersion: current.observation.version }, session.sessionBinding);
  assert.equal(view().review.current, true); auditRecovery(f.store);
});

test("unsupported or unavailable inspected content cannot be reviewed and evidence is bounded", t => {
  const f = setup(t); f.save("Edited"); f.apply(f.reserve()); const dispatch = f.command("dispatch"); f.apply(dispatch); f.ack(dispatch);
  for (const response of [null, { ...f.response(), message: { ...f.response().message, isDraft: false } },
    { ...f.response(), message: { ...f.response().message, body: { contentType: "html", content: "<p>Native HTML</p>" } } }]) {
    f.inspect(response); assert.equal(f.reviewContext().canReview, false);
    assert.throws(() => f.apply({ ...f.command("review"), reviewVersion: "f".repeat(64) }), { code: "stale_reply_update_review" });
  }
  const before = auditRecovery(f.store), response = f.response(); response.message.body.content = "x".repeat(33000);
  assert.throws(() => f.inspect(response), { code: "reply_observation_limit" }); assert.deepEqual(auditRecovery(f.store), before);
});

test("write acknowledgment binds the exact dispatch and preserves later reads, parent and local writing", t => {
  const f = setup(t); f.save("Proposed update"); f.apply(f.reserve()); const dispatch = f.command("dispatch"); f.apply(dispatch);
  const response = { ...f.response(), method: "PATCH", idType: "immutable" }; response.message.changeKey = "write-version";
  response.headers = { Authorization: "fictional-private-header-not-for-journal" };
  response.message.body.content = "untrusted-write-response-body-not-for-preview";
  f.observe(); const observation = f.updates()[0].observation;
  f.save("Even newer local writing"); const parent = f.attempt(), requestId = randomUUID();
  const result = f.ack(dispatch, response, requestId), update = result.receipt.update;
  assert.equal(result.recorded, true); assert.equal(update.status, "update_acknowledged"); assert.equal(update.revision, 3);
  assert.deepEqual(update.observation, observation);
  assert.equal(update.acknowledgment.dispatchRequestId, dispatch.requestId);
  assert.equal(update.acknowledgment.providerRevision, "write-version");
  const row = f.store.db.prepare("SELECT request_json,receipt_json FROM private_inbox_commands WHERE request_id=?").get(requestId);
  assert.doesNotMatch(JSON.stringify(row), /fictional-private-header-not-for-journal|untrusted-write-response-body-not-for-preview/);
  assert.deepEqual(f.attempt(), parent);
  assert.equal(f.store.inbox.read(f.args.token, f.args.sourceId, f.args.binding).draft.body, "Even newer local writing");
  for (const key of ["canExecute", "canRetryUpdate", "canReview", "canSend"]) assert.equal(update[key], false);
  const before = auditRecovery(f.store);
  assert.equal(f.ack(dispatch, response, requestId).duplicate, true);
  assert.deepEqual(f.ack(dispatch, response, requestId).receipt, result.receipt);
  assert.deepEqual(auditRecovery(f.store), before);
  assert.throws(() => f.ack(dispatch, response), { code: "conflicting_reply_update_acknowledgment" });
  f.observe(); assert.deepEqual(f.updates()[0].acknowledgment, update.acknowledgment);
  assert.equal(f.updates()[0].observation.updateOutcome, "unproven", "readback never claims causation");
  assert.equal(f.updates()[0].revision, 4);
  assert.equal(f.ack(dispatch, response, requestId).receipt.update.revision, 3, "exact replay returns the original receipt");
  auditRecovery(f.store);
});

test("unknown responses and GET matches never manufacture a write acknowledgment", t => {
  const f = setup(t); f.save("Edited"); f.apply(f.reserve()); const dispatch = f.command("dispatch"); f.apply(dispatch);
  const before = auditRecovery(f.store), response = { ...f.response(), method: "PATCH", idType: "immutable" };
  for (const value of [null, f.response(), { ...response, method: "GET" }, ...[201, 204, 429, 503].map(status => ({ ...response, status }))]) {
    const result = f.ack(dispatch, value); assert.equal(result.recorded, false); assert.equal(result.canRetryUpdate, false);
    assert.equal(result.update.status, "update_unconfirmed");
  }
  for (const [value, code] of [
    [{ ...response, connection: { ...response.connection, accountId: "different-account" } }, "email_reply_scope_changed"],
    [{ ...response, idType: "mutable" }, "email_reply_scope_changed"],
    [{ ...response, message: { ...response.message, id: "different-draft" } }, "email_reply_identity_changed"]
  ]) assert.throws(() => f.ack(dispatch, value), { code });
  assert.throws(() => f.ack(dispatch, { ...response, message: { ...response.message, changeKey: "" } }));
  assert.deepEqual(auditRecovery(f.store), before);
});

test("only the trusted driver can bind acknowledgment to an earlier dispatch in this account", t => {
  const f = setup(t); f.save("Edited"); f.apply(f.reserve()); const dispatch = f.command("dispatch");
  assert.throws(() => f.ack(dispatch), { code: "conflicting_reply_update_acknowledgment" });
  f.apply(dispatch); const before = auditRecovery(f.store);
  assert.throws(() => f.ack({ ...dispatch, requestId: "missing-dispatch" }), { code: "conflicting_reply_update_acknowledgment" });
  assert.throws(() => f.ack({ ...dispatch, requestId: dispatch.updateId }), { code: "conflicting_reply_update_acknowledgment" });
  const p = f.updates()[0].proposal, request = { action: "reply.update.acknowledged", requestId: randomUUID(),
    sourceId: f.args.sourceId, attemptId: f.args.attemptId, updateId: dispatch.updateId, dispatchRequestId: dispatch.requestId,
    updateVersion: p.updateVersion, providerDraftId: p.providerDraftId, providerRevision: "write-version" };
  assert.throws(() => f.store.inbox.apply(f.args.token, request, f.args.binding), { code: "reply_driver_required" });
  assert.throws(() => f.apply({ ...request, expectedRevision: 1 }), { code: "invalid_reply_update" });
  assert.throws(() => f.apply({ ...request, updateVersion: "f".repeat(64) }), { code: "conflicting_reply_update_acknowledgment" });
  assert.throws(() => f.store.readTransaction(() => f.apply(request)), /read-only/);
  assert.deepEqual(auditRecovery(f.store), before);
});

test("acknowledgment remains recordable at capacity after disconnection, but never after session revocation", t => {
  const f = setup(t); f.save("Edited"); f.apply(f.reserve()); const dispatch = f.command("dispatch"); f.apply(dispatch);
  f.store.email.apply(f.args.token, { action: "connection.disconnect", requestId: "disconnect-for-ack",
    connectionId: f.raw.connection.id, expectedRevision: 1 }, f.args.binding);
  const prepare = f.store.db.prepare.bind(f.store.db);
  f.store.db.prepare = sql => sql === "SELECT count(*) n FROM private_inbox_commands WHERE account_id=?"
    ? { get: () => ({ n: inboxLimits.commands }) } : prepare(sql);
  assert.equal(f.ack(dispatch).recorded, true); f.store.db.prepare = prepare;
  auditRecovery(f.store);
  f.store.logoutAccountSession(f.args.token, f.store.authenticateAccountSession(f.args.token, null, f.args.binding).sessionRevision);
  assert.throws(() => f.ack(dispatch));
});

test("negotiated acknowledgment stays read-only and preserves the legacy comparison vocabulary", t => {
  const f = setup(t); f.save("Edited"); f.apply(f.reserve()); const dispatch = f.command("dispatch"); f.apply(dispatch); f.ack(dispatch);
  const read = view => f.store.inbox.replyReviewContext(f.args.token, f.args.sourceId, f.args.binding, { view });
  const v1 = read("reply-review-v1"), v2 = read("reply-review-v2"), v3 = read("reply-review-v3");
  assert.equal(v1.comparison, undefined); assert.equal(v2.comparison.updateStatus, "update_unconfirmed");
  assert.equal(v3.comparison.updateStatus, "update_acknowledged"); assert.equal(v3.attempt.canReview, false);
  assert.doesNotMatch(JSON.stringify(v3), /dispatchRequestId|providerRevision|providerDraftId|updateVersion/);
  assert.throws(() => f.apply(f.command("cancel")), { code: "reply_update_started" });
  assert.throws(() => f.apply(f.reserve()), { code: "reply_update_unresolved" });
  auditRecovery(f.store);
});

test("acknowledgment rollback and exact replay reject rewritten receipt history", t => {
  const f = setup(t); f.save("Edited"); f.apply(f.reserve()); const dispatch = f.command("dispatch"); f.apply(dispatch);
  const before = auditRecovery(f.store);
  f.store.db.exec("CREATE TRIGGER test_ack_failure BEFORE INSERT ON private_inbox_commands BEGIN SELECT RAISE(ABORT,'fixture ack failure'); END");
  assert.throws(() => f.ack(dispatch), /fixture ack failure/);
  f.store.db.exec("DROP TRIGGER test_ack_failure"); assert.deepEqual(auditRecovery(f.store), before);
  const result = f.ack(dispatch), row = f.store.db.prepare("SELECT sequence,receipt_json FROM private_inbox_commands WHERE request_id=?").get(result.receipt.requestId);
  const receipt = JSON.parse(row.receipt_json); receipt.update.acknowledgment.dispatchRequestId = "rewritten-dispatch";
  f.store.db.exec("DROP TRIGGER private_inbox_commands_no_update");
  f.store.db.prepare("UPDATE private_inbox_commands SET receipt_json=? WHERE sequence=?").run(JSON.stringify(receipt), row.sequence);
  f.store.db.exec("CREATE TRIGGER private_inbox_commands_no_update BEFORE UPDATE ON private_inbox_commands BEGIN SELECT RAISE(ABORT,'inbox receipts are immutable'); END");
  assert.throws(() => auditRecovery(f.store), /reconciliation/);
});

test("durable child preserves all three versions and exact retry without changing the parent or local writing", async t => {
  const f = setup(t); f.save("My edited reply 🪷");
  const parent = f.attempt(), request = f.reserve(), before = f.store.inbox.read(f.args.token, f.args.sourceId, f.args.binding);
  const saved = f.apply(request), update = saved.receipt.update, audit = auditRecovery(f.store);
  assert.equal(update.status, "reserved"); assert.equal(update.revision, 0);
  assert.equal(update.proposal.original.body, parent.plan.expected.body);
  assert.equal(update.proposal.proposed.body, before.draft.body);
  assert.equal(f.apply(request).duplicate, true);
  assert.deepEqual(f.apply(request).receipt, saved.receipt); assert.deepEqual(auditRecovery(f.store), audit);
  assert.deepEqual(f.attempt(), parent); assert.deepEqual(f.store.inbox.read(f.args.token, f.args.sourceId, f.args.binding), before);
  assert.throws(() => f.apply({ ...request, updateVersion: "f".repeat(64) }), { code: "idempotency_conflict" });
  assert.throws(() => f.apply(f.reserve()), { code: "reply_update_unresolved" });
  for (const key of ["canExecute", "canRetryUpdate", "canReview", "canSend"]) assert.equal(update[key], false);
  const backup = await backupRoom(f.filename, f.directory), restored = new RoomStore(backup.filename, { readOnly: true });
  try { assert.deepEqual(auditRecovery(restored), audit); } finally { restored.close(); }
});

test("no-op proposals never reserve; current local/source/observation versions bind reservation and dispatch", t => {
  const f = setup(t);
  assert.throws(() => f.apply(f.reserve()), { code: "reply_update_not_needed" });
  f.save("First edit"); const stale = f.reserve(); f.save("New edit");
  assert.throws(() => f.apply(stale), { code: "stale_email_reply_update" });
  f.apply(f.reserve()); const dispatch = f.command("dispatch"); f.save("Yet another edit");
  assert.throws(() => f.apply(dispatch), { code: "stale_email_reply_update" });
  assert.equal(f.updates()[0].status, "reserved"); f.apply(f.command("cancel"));
  f.apply(f.reserve()); const late = f.command("dispatch"); f.seed.observe();
  assert.throws(() => f.apply(late), { code: "stale_reply_attempt" });
  assert.equal(f.updates().at(-1).status, "reserved"); auditRecovery(f.store);
});

test("cancellation stays available after disconnection, including at capacity, and releases only a never-dispatched child", t => {
  const f = setup(t); f.save("Edited"); f.apply(f.reserve());
  f.store.email.apply(f.args.token, { action: "connection.disconnect", requestId: "disconnect", connectionId: f.raw.connection.id,
    expectedRevision: 1 }, f.args.binding);
  assert.throws(() => f.apply(f.command("dispatch")), { code: "email_connection_changed" });
  const prepare = f.store.db.prepare.bind(f.store.db);
  f.store.db.prepare = sql => sql === "SELECT count(*) n FROM private_inbox_commands WHERE account_id=?"
    ? { get: () => ({ n: inboxLimits.commands }) } : prepare(sql);
  try { assert.equal(f.apply(f.command("cancel")).receipt.update.status, "cancelled"); }
  finally { f.store.db.prepare = prepare; }
  assert.throws(() => f.apply(f.command("observed")), { code: "invalid_reply_update" });
  auditRecovery(f.store);
});

test("cancel and recompare make a new child without overwriting earlier cancelled intent", t => {
  const f = setup(t); f.save("First"); f.apply(f.reserve()); const first = structuredClone(f.updates()[0]);
  f.apply(f.command("cancel")); f.save("Second"); f.apply(f.reserve());
  assert.equal(f.updates().length, 2); assert.equal(f.updates()[0].proposal.proposed.body, first.proposal.proposed.body);
  assert.equal(f.updates()[0].status, "cancelled"); assert.equal(f.updates()[1].proposal.proposed.body, "Second"); auditRecovery(f.store);
});

test("dispatch intent survives restart; lost acknowledgment, matching readback and unknown readback never permit replay", t => {
  const f = setup(t); f.save("Updated body"); f.apply(f.reserve()); const dispatch = f.command("dispatch"), saved = f.apply(dispatch);
  const parent = structuredClone(f.attempt()), before = auditRecovery(f.store), resumed = new RoomStore(f.filename);
  try {
    assert.equal(resumed.inbox.reply(f.args.token, dispatch, f.args.binding).duplicate, true);
    assert.deepEqual(auditRecovery(resumed), before);
    assert.deepEqual(resumed.inbox.replyUpdates(f.args.token, f.args.sourceId, f.args.binding).updates[0], saved.receipt.update);
  } finally { resumed.close(); }
  const response = f.response(); response.message.body.content = "Updated body";
  const input = f.command("observed"); const recorded = f.observe(response, input);
  assert.equal(recorded.receipt.update.observation.status, "proposal_content_matches");
  assert.equal(recorded.receipt.update.observation.updateOutcome, "unproven");
  assert.equal(recorded.receipt.update.status, "update_unconfirmed");
  assert.equal(f.observe(response, input).duplicate, true);
  assert.throws(() => f.apply(f.command("cancel")), { code: "reply_update_started" });
  assert.throws(() => f.apply(f.command("dispatch")), { code: "reply_update_started" });
  assert.throws(() => f.apply(f.reserve()), { code: "reply_update_unresolved" });
  f.observe({ status: 503 });
  assert.equal(f.updates()[0].observation.status, "draft_unavailable"); assert.equal(f.updates()[0].status, "update_unconfirmed");
  assert.deepEqual(f.attempt(), parent); auditRecovery(f.store);
});

test("late child evidence belongs to its old intent, never replaces newer local or parent observations, and refuses stale child revisions", t => {
  const f = setup(t); f.save("Proposed"); f.apply(f.reserve()); f.apply(f.command("dispatch"));
  const late = f.command("observed"), r = f.response(); r.message.body.content = "Proposed";
  f.save("More recent local writing"); f.seed.observe({ body: { format: "text", content: "More recent parent preview" } });
  const parent = f.attempt(), local = f.store.inbox.read(f.args.token, f.args.sourceId, f.args.binding);
  f.observe(r, late); const audit = auditRecovery(f.store);
  assert.equal(f.updates()[0].observation.status, "proposal_content_matches");
  assert.deepEqual(f.attempt(), parent); assert.deepEqual(f.store.inbox.read(f.args.token, f.args.sourceId, f.args.binding), local);
  assert.throws(() => f.observe({ status: 503 }, { ...late, requestId: randomUUID() }), { code: "stale_reply_update" });
  assert.deepEqual(auditRecovery(f.store), audit);
});

test("pending updates invalidate old review affordances even if the user restores the original local body", t => {
  const f = setup(t), parent = f.attempt();
  f.apply({ action: "reply.review", requestId: randomUUID(), sourceId: f.args.sourceId, attemptId: parent.id,
    expectedRevision: parent.revision, reviewVersion: parent.observation.reviewVersion });
  assert.equal(f.attempt().reviewCurrent, true);
  f.save("Edited"); f.apply(f.reserve()); f.save(parent.plan.expected.body);
  assert.equal(f.attempt().reviewCurrent, false);
  const context = f.store.inbox.replyReviewContext(f.args.token, f.args.sourceId, f.args.binding);
  assert.equal(context.attempt.canReview, false); assert.equal(context.attempt.review.current, false);
  assert.throws(() => f.apply({ action: "reply.review", requestId: randomUUID(), sourceId: f.args.sourceId, attemptId: parent.id,
    expectedRevision: f.attempt().revision, reviewVersion: parent.observation.reviewVersion }), { code: "reply_update_unresolved" });
  f.apply(f.command("cancel"));
  // Local draft revisions still invalidate the old creation review even after cancellation.
  assert.equal(f.attempt().reviewCurrent, false); auditRecovery(f.store);
});

test("child evidence requires current private authority but tolerates a disconnected original connection", t => {
  const f = setup(t); f.save("Edited"); const reserve = f.reserve(); f.apply(reserve); f.apply(f.command("dispatch"));
  assert.throws(() => f.store.inbox.apply(f.args.token, reserve, f.args.binding), { code: "reply_driver_required" });
  assert.throws(() => f.store.inbox.reply(f.keys.producer, reserve, f.args.binding), { status: 401 });
  const guest = f.store.accountForMember("commons", "guest"), slot = f.store.createAccountSessionSlot();
  const binding = f.store.loginAccountSession(slot.token, f.store.issueAccountAccessKey(guest.id), 0).sessionBinding;
  assert.throws(() => f.store.inbox.replyUpdates(slot.token, f.args.sourceId, binding), { status: 404 });
  f.store.email.apply(f.args.token, { action: "connection.disconnect", requestId: "disconnect", connectionId: f.raw.connection.id, expectedRevision: 1 }, f.args.binding);
  assert.doesNotThrow(() => f.observe());
  const retainedResponse = f.response(), retainedRequest = f.command("observed");
  f.store.changeAccountAccess(f.account.id, { expectedRevision: 0, active: false, reason: "Fixture revocation" });
  assert.throws(() => f.observe(retainedResponse, retainedRequest), { status: 401 });
  f.store.changeAccountAccess(f.account.id, { expectedRevision: 1, active: true, reason: "Fixture return" });
  const ownerSlot = f.store.createAccountSessionSlot(), owner = f.store.loginAccountSession(ownerSlot.token, f.store.issueAccountAccessKey(f.account.id), 0);
  const update = f.store.inbox.replyUpdates(ownerSlot.token, f.args.sourceId, owner.sessionBinding).updates[0];
  const { action, ...request } = f.command("observed", update);
  f.store.inbox.recordReplyUpdateObservation(ownerSlot.token, { ...request, response: retainedResponse }, owner.sessionBinding);
  auditRecovery(f.store);
});

test("wrong mailbox/draft, caller authority fields and oversized evidence are refused without writes", t => {
  const f = setup(t); f.save("Edited"); const reserve = f.reserve(), before = auditRecovery(f.store);
  assert.throws(() => transitionReplyAttempt(new Map(), reserve, { at: 1 }), { code: "invalid_reply_attempt" });
  for (const extra of [{ canExecute: true }, { proposal: f.prepare() }, { updateId: "other" }])
    assert.throws(() => f.apply({ ...reserve, ...extra }), { code: "invalid_reply_update" });
  assert.deepEqual(auditRecovery(f.store), before); f.apply(reserve); f.apply(f.command("dispatch"));
  const r = f.response(); r.message.id = "wrong"; r.options.attachmentObservation.messageId = "wrong";
  const after = auditRecovery(f.store);
  assert.throws(() => f.observe(r), { code: "email_reply_identity_changed" });
  const foreign = f.response(); foreign.connection.mailboxId = "other";
  assert.throws(() => f.observe(foreign), { code: "email_reply_scope_changed" });
  assert.throws(() => f.apply({ ...f.command("observed"), observation: "x".repeat(33000) }), { code: "reply_observation_limit" });
  assert.deepEqual(auditRecovery(f.store), after);
});

test("update transitions are atomic, read-only calls cannot write, and historical receipt tampering fails replay", t => {
  const f = setup(t); f.save("Edited"); f.apply(f.reserve()); const before = auditRecovery(f.store);
  assert.throws(() => f.store.readTransaction(() => f.apply(f.command("dispatch"))), /read-only/);
  f.store.db.exec("CREATE TRIGGER test_update_failure BEFORE INSERT ON private_inbox_commands BEGIN SELECT RAISE(ABORT,'fixture update failure'); END");
  assert.throws(() => f.apply(f.command("dispatch")), /fixture update failure/);
  f.store.db.exec("DROP TRIGGER test_update_failure"); assert.deepEqual(auditRecovery(f.store), before);
  f.apply(f.command("dispatch")); f.observe();
  const row = f.store.db.prepare("SELECT sequence,receipt_json FROM private_inbox_commands WHERE json_extract(request_json,'$.action')='reply.update.reserve'").get();
  const receipt = JSON.parse(row.receipt_json); receipt.update.proposal.proposed.body = "Rewritten history";
  f.store.db.exec("DROP TRIGGER private_inbox_commands_no_update");
  f.store.db.prepare("UPDATE private_inbox_commands SET receipt_json=? WHERE sequence=?").run(JSON.stringify(receipt), row.sequence);
  f.store.db.exec("CREATE TRIGGER private_inbox_commands_no_update BEFORE UPDATE ON private_inbox_commands BEGIN SELECT RAISE(ABORT,'inbox receipts are immutable'); END");
  assert.throws(() => auditRecovery(f.store), /reconciliation/);
});

for (const action of ["reserve", "dispatch", "observed", "acknowledged", "inspected", "review"]) test(`independent connections admit one competing child ${action}`, { timeout: 15000 }, async t => {
  const f = setup(t); f.save("Edited");
  if (action !== "reserve") f.apply(f.reserve());
  let dispatch;
  if (["observed", "acknowledged", "inspected", "review"].includes(action)) { dispatch = f.command("dispatch"); f.apply(dispatch); }
  if (action === "review") { f.ack(dispatch); f.inspect(); }
  const commands = [0, 1].map(() => {
    if (action === "reserve") return f.reserve();
    if (action === "observed") return { ...f.command(action), observation: null };
    if (action === "inspected") { const c = f.inspection(); return { ...f.command(action), inspectionVersion: c.inspectionVersion, connectionRevision: c.connection.revision, observation: null }; }
    if (action === "review") return { ...f.command(action), reviewVersion: f.reviewContext().reviewVersion };
    if (action !== "acknowledged") return f.command(action);
    const { expectedRevision, ...request } = f.command(action), p = f.updates()[0].proposal;
    return { ...request, dispatchRequestId: dispatch.requestId, updateVersion: p.updateVersion,
      providerDraftId: p.providerDraftId, providerRevision: "competing-ack-version" };
  });
  const barrier = new SharedArrayBuffer(4), workers = commands.map(command => new Worker(`
    const {parentPort,workerData:d}=require('node:worker_threads');
    import(d.module).then(({RoomStore})=>{ const store=new RoomStore(d.filename);
      parentPort.postMessage({ready:true}); Atomics.wait(new Int32Array(d.barrier),0,0);
      try { parentPort.postMessage({result:store.inbox.reply(d.token,d.command,d.binding)}); }
      catch(e) { parentPort.postMessage({error:e.code}); } finally { store.close(); }
    });`, { eval: true, workerData: { module: new URL("../server/store.mjs", import.meta.url).href,
      filename: f.filename, token: f.args.token, binding: f.args.binding, command, barrier } }));
  t.after(async () => { await Promise.all(workers.map(w => w.terminate())); });
  const ready = [], results = workers.map(w => new Promise((resolve, reject) => {
    ready.push(new Promise(r => w.on("message", m => { if (m.ready) r(); })));
    w.on("message", m => { if (!m.ready) resolve(m); }); w.once("error", reject);
  }));
  await Promise.all(ready); Atomics.store(new Int32Array(barrier), 0, 1); Atomics.notify(new Int32Array(barrier), 0, 2);
  const outcomes = await Promise.all(results);
  assert.equal(outcomes.filter(o => o.result && !o.result.duplicate).length, 1); assert.equal(outcomes.filter(o => o.error).length, 1);
  assert.equal(f.updates().length, 1); auditRecovery(f.store);
});

test("cold allowlisted runtime recovers child dispatch, acknowledgment and evidence without resubmitting", async t => {
  const f = setup(t); f.save("Cold reply"); f.apply(f.reserve()); const dispatch = f.command("dispatch"); f.apply(dispatch); f.observe();
  f.ack(dispatch); f.inspect(); f.review();
  const before = auditRecovery(f.store), destination = join(f.directory, "update-package");
  createRuntimePackage({ ...candidateRuntimeFixture(fileURLToPath(new URL("../", import.meta.url)), f.directory), destination });
  const { RoomStore: ColdStore } = await import(pathToFileURL(join(destination, "server/store.mjs")));
  const store = new ColdStore(f.filename);
  try {
    assert.deepEqual(store.inbox.replyUpdates(f.args.token, f.args.sourceId, f.args.binding).updates, f.updates());
    assert.equal(store.inbox.reply(f.args.token, dispatch, f.args.binding).duplicate, true);
    assert.deepEqual(auditRecovery(store), before);
  } finally { store.close(); }
});

test("pre-v23 child namespace collisions refuse migration before touching old rows or fences", async t => {
  const root = mkdtempSync(join(tmpdir(), "room-update-migration-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = fileURLToPath(new URL("../", import.meta.url)), destination = join(root, "v22");
  createRuntimePackage({ repository, commit: v22ReplyUpdateBaseline, destination });
  const f = (await frozenAcceptanceFixture(repository, destination, v22ReplyUpdateBaseline))();
  try {
    const account = f.store.accountForMember("commons", "owner");
    f.store.db.prepare("INSERT INTO private_inbox_commands(account_id,request_id,fingerprint,request_json,receipt_json,auth_epoch,at) VALUES(?,?,?,?,?,?,?)")
      .run(account.id, "collision", "invalid", JSON.stringify({ action: "reply.update.reserve" }), "{}", 0, 1);
    const catalog = f.store.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all();
    assert.throws(() => new RoomStore(join(f.directory, "room.sqlite")), /Pre-v23 reply update history/);
    assert.equal(f.store.db.prepare("PRAGMA user_version").get().user_version, 22);
    assert.deepEqual(f.store.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all(), catalog);
  } finally { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

for (const [version, baseline] of [[23, v23ReplyAcknowledgmentBaseline], [24, v24ReplyResolutionBaseline]]) test(`genuine v${version} in-flight child migrates unchanged through acknowledgment, inspection and review`, async t => {
  const root = mkdtempSync(join(tmpdir(), "room-ack-migration-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = fileURLToPath(new URL("../", import.meta.url)), destination = join(root, "v" + version);
  createRuntimePackage({ repository, commit: baseline, destination });
  const create = await frozenRecoveryFixture(repository, destination, baseline), f = create(join(root, "room.sqlite"));
  t.after(() => f.store.close());
  const { prepareGraphReplyUpdate: prepare } = await import(pathToFileURL(join(destination, "server/graph-reply-draft.mjs")));
  const token = f.owner.token, binding = f.owner.session.sessionBinding, sourceId = f.emailEnvelope.sourceId;
  const { source, draft } = f.store.inbox.read(token, sourceId, binding), parent = f.store.inbox.replyAttempts(token, sourceId, binding).attempts[0];
  f.store.inbox.apply(token, { action: "draft.save", requestId: "legacy-update-text", sourceId,
    sourceRevision: source.revision, expectedRevision: draft.revision, body: "Legacy update in flight" }, binding);
  const proposal = prepare({ store: f.store, token, binding, sourceId, attemptId: parent.id,
    expectedRevision: parent.revision, requestId: "legacy-update" });
  const apply = request => f.store.inbox.reply(token, { sourceId, attemptId: parent.id, ...request }, binding);
  apply({ action: "reply.update.reserve", requestId: proposal.requestId, expectedRevision: parent.revision, updateVersion: proposal.updateVersion });
  const dispatch = apply({ action: "reply.update.dispatch", requestId: "legacy-dispatch", updateId: proposal.requestId, expectedRevision: 0 });
  const acknowledgment = { sourceId, attemptId: parent.id, updateId: proposal.requestId,
    dispatchRequestId: dispatch.receipt.requestId, requestId: "legacy-late-ack",
    response: { status: 200, method: "PATCH", idType: "immutable", connection: proposal.connection,
      message: { id: proposal.providerDraftId, changeKey: "legacy-write-version" } } };
  if (version === 24) f.store.inbox.recordReplyUpdateAcknowledgment(token, acknowledgment, binding);
  const history = f.store.db.prepare("SELECT * FROM private_inbox_commands ORDER BY sequence").all();
  const cached = f.store.db.prepare("UPDATE accounts SET revision=revision WHERE id=?");
  const current = new RoomStore(f.filename, { now: f.now }); t.after(() => current.close());
  assert.deepEqual(current.db.prepare("SELECT * FROM private_inbox_commands ORDER BY sequence").all(), history);
  assert.throws(() => cached.run(f.owner.session.account.id), /project_room_writer_v27|unsupported database writer/);
  const result = current.inbox.recordReplyUpdateAcknowledgment(token, acknowledgment, binding);
  assert.equal(result.duplicate, version === 24); assert.equal(result.receipt.update.status, "update_acknowledged");
  const c = current.inbox.prepareReplyUpdateInspection(token, sourceId, proposal.requestId, binding);
  current.inbox.reply(token, { action: "reply.update.inspected", sourceId, attemptId: parent.id, updateId: proposal.requestId,
    expectedRevision: c.expectedRevision, requestId: "migrated-inspection", inspectionVersion: c.inspectionVersion,
    connectionRevision: c.connection.revision, observation: f.replyRequests.find(r => r.action === "reply.observed").observation }, binding);
  const u = current.inbox.replyReviewContext(token, sourceId, binding, { view: "reply-review-v4" }).update;
  current.inbox.reviewReply(token, { action: "reply.update.review", requestId: "migrated-review", sourceId,
    attemptId: parent.id, updateId: u.id, expectedRevision: u.revision, reviewVersion: u.observation.version }, binding);
  assert.equal(current.inbox.replyUpdates(token, sourceId, binding).updates[0].status, "resolved"); auditRecovery(current);
});

test("pre-v25 resolution markers refuse migration before touching old data or fences", async t => {
  const root = mkdtempSync(join(tmpdir(), "room-review-collision-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = fileURLToPath(new URL("../", import.meta.url)), destination = join(root, "v24");
  createRuntimePackage({ repository, commit: v24ReplyResolutionBaseline, destination });
  for (const [request, receipt] of [
    [{ action: "reply.update.inspected" }, {}], [{ action: "reply.update.review" }, {}],
    [{ action: "draft.save" }, { update: { inspection: null } }], [{ action: "draft.save" }, { update: { review: null } }],
    [{ action: "draft.save" }, { update: { resolvedAt: 1 } }], [{ action: "draft.save" }, { update: { status: "resolved" } }]
  ]) {
    const f = (await frozenAcceptanceFixture(repository, destination, v24ReplyResolutionBaseline))();
    try {
      const account = f.store.accountForMember("commons", "owner");
      f.store.db.prepare("INSERT INTO private_inbox_commands(account_id,request_id,fingerprint,request_json,receipt_json,auth_epoch,at) VALUES(?,?,?,?,?,?,?)")
        .run(account.id, "collision", "invalid", JSON.stringify(request), JSON.stringify(receipt), 0, 1);
      const catalog = f.store.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all();
      assert.throws(() => new RoomStore(join(f.directory, "room.sqlite")), /Pre-v25 reply resolution history/);
      assert.equal(f.store.db.prepare("PRAGMA user_version").get().user_version, 24);
      assert.deepEqual(f.store.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all(), catalog);
    } finally { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); }
  }
});

test("pre-v24 acknowledgment namespace collisions roll back without installing new fences", async t => {
  const root = mkdtempSync(join(tmpdir(), "room-ack-collision-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = fileURLToPath(new URL("../", import.meta.url)), destination = join(root, "v23");
  createRuntimePackage({ repository, commit: v23ReplyAcknowledgmentBaseline, destination });
  for (const [request, receipt] of [
    [{ action: "reply.update.acknowledged" }, {}],
    [{ action: "draft.save" }, { update: { acknowledgment: null } }],
    [{ action: "draft.save" }, { update: { status: "update_acknowledged" } }]
  ]) {
    const f = (await frozenAcceptanceFixture(repository, destination, v23ReplyAcknowledgmentBaseline))();
    try {
      const account = f.store.accountForMember("commons", "owner");
      f.store.db.prepare("INSERT INTO private_inbox_commands(account_id,request_id,fingerprint,request_json,receipt_json,auth_epoch,at) VALUES(?,?,?,?,?,?,?)")
        .run(account.id, "collision", "invalid", JSON.stringify(request), JSON.stringify(receipt), 0, 1);
      const catalog = f.store.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all();
      assert.throws(() => new RoomStore(join(f.directory, "room.sqlite")), /Pre-v24 reply acknowledgment history/);
      assert.equal(f.store.db.prepare("PRAGMA user_version").get().user_version, 23);
      assert.deepEqual(f.store.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all(), catalog);
    } finally { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); }
  }
});

test("HTTP exposes neither update dispatch nor child plans through the existing review projection", async t => {
  const f = setup(t); f.save("Edited"); const request = f.reserve();
  const server = createRoomServer({ store: f.store }); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = "http://127.0.0.1:" + server.address().port, session = f.store.authenticateAccountSession(f.args.token, null, f.args.binding);
  const headers = { Cookie: "account_session=" + f.args.token, "X-Session-Binding": f.args.binding,
    "X-CSRF-Token": session.csrf, Origin: origin, "Content-Type": "application/json" };
  const before = auditRecovery(f.store);
  for (const [path, status] of [["/api/inbox/commands", 403], ["/api/inbox/review", 422]]) {
    const response = await fetch(origin + path, { method: "POST", headers, body: JSON.stringify(request) });
    assert.equal(response.status, status);
  }
  assert.deepEqual(auditRecovery(f.store), before); f.apply(request);
  const response = await fetch(origin + "/api/inbox/sources/" + f.args.sourceId + "/reply-review?view=reply-review-v1", { headers });
  const context = await response.json(); assert.equal(response.status, 200); assert.equal(context.attempt.canReview, false);
  assert.doesNotMatch(JSON.stringify(context), /updateVersion|providerDraftId|conditionalWrite|https:\/\/graph/);
  assert.equal(context.comparison, undefined, "v1 never acquires additional history");
  const compare = await fetch(origin + "/api/inbox/sources/" + f.args.sourceId + "/reply-review?view=reply-review-v2", { headers });
  const v2 = await compare.json(); assert.equal(compare.status, 200); assert.equal(compare.headers.get("cache-control"), "no-store");
  assert.deepEqual(v2.comparison, { originalBody: f.seed.plan.expected.body, updateStatus: "reserved" });
  assert.doesNotMatch(JSON.stringify(v2), /updateVersion|providerDraftId|conditionalWrite|https:\/\/graph/);
  f.apply(f.command("dispatch"));
  const beforeRead = auditRecovery(f.store);
  assert.equal(f.store.inbox.replyReviewContext(f.args.token, f.args.sourceId, f.args.binding, { view: "reply-review-v2" }).comparison.updateStatus, "update_unconfirmed");
  assert.deepEqual(auditRecovery(f.store), beforeRead);
  const dispatch = f.store.db.prepare("SELECT request_id FROM private_inbox_commands WHERE json_extract(request_json,'$.action')='reply.update.dispatch'").get();
  f.ack({ requestId: dispatch.request_id, updateId: request.requestId });
  const latest = await fetch(origin + "/api/inbox/sources/" + f.args.sourceId + "/reply-review?view=reply-review-v3", { headers });
  const v3 = await latest.json(); assert.equal(latest.status, 200);
  assert.equal(v3.comparison.updateStatus, "update_acknowledged"); assert.equal(v3.attempt.canReview, false);
  assert.doesNotMatch(JSON.stringify(v3), /dispatchRequestId|providerRevision|providerDraftId|updateVersion/);
  const ackRequest = JSON.parse(f.store.db.prepare("SELECT request_json FROM private_inbox_commands WHERE json_extract(request_json,'$.action')='reply.update.acknowledged'").get().request_json);
  const denied = await fetch(origin + "/api/inbox/commands", { method: "POST", headers, body: JSON.stringify(ackRequest) });
  assert.equal(denied.status, 403);
  f.inspect();
  const checked = await fetch(origin + "/api/inbox/sources/" + f.args.sourceId + "/reply-review?view=reply-review-v4", { headers });
  const v4 = await checked.json(); assert.equal(checked.status, 200); assert.equal(v4.update.canReview, true);
  assert.equal(v4.attempt.canReview, false); assert.equal(v4.update.canSend, false);
  assert.doesNotMatch(JSON.stringify(v4), /dispatchRequestId|providerRevision|providerDraftId|updateVersion|inspectionVersion/);
  const inspectionRequest = JSON.parse(f.store.db.prepare("SELECT request_json FROM private_inbox_commands WHERE json_extract(request_json,'$.action')='reply.update.inspected'").get().request_json);
  const inspectionDenied = await fetch(origin + "/api/inbox/review", { method: "POST", headers, body: JSON.stringify(inspectionRequest) });
  assert.equal(inspectionDenied.status, 422);
  const review = { ...f.command("review"), reviewVersion: v4.update.observation.version };
  const accepted = await fetch(origin + "/api/inbox/review", { method: "POST", headers, body: JSON.stringify(review) });
  const result = await accepted.json(); assert.equal(accepted.status, 201);
  assert.equal(result.receipt.updateId, v4.update.id);
  assert.doesNotMatch(JSON.stringify(result), /proposal|providerDraftId|dispatchRequestId|originalBody/);
  const retried = await fetch(origin + "/api/inbox/review", { method: "POST", headers, body: JSON.stringify(review) });
  const duplicate = await retried.json(); assert.equal(retried.status, 200); assert.equal(duplicate.duplicate, true);
  assert.deepEqual(duplicate.receipt, result.receipt); assert.equal(f.updates().at(-1).status, "resolved");
  auditRecovery(f.store);
});
