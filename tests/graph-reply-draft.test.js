import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { emailContractFixture } from "../scripts/email-contract-fixture.mjs";
import { normalizeGraphEmail } from "../server/graph-email.mjs";
import { prepareGraphReplyDraft, currentGraphReplyDraft, observeGraphReplyCreation, inspectGraphReplyDraft } from "../server/graph-reply-draft.mjs";
import { auditRecovery } from "../server/recovery.mjs";
import { candidateRuntimeFixture } from "../scripts/candidate-runtime-fixture.mjs";
import { createRuntimePackage } from "../scripts/runtime-package.mjs";

function fixture(t) {
  const f = createAcceptanceFixture(); t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const raw = emailContractFixture(), account = f.store.accountForMember("commons", "owner"); raw.connection.accountId = account.id;
  const slot = f.store.createAccountSessionSlot(), session = f.store.loginAccountSession(slot.token, f.store.issueAccountAccessKey(account.id), 0);
  const args = { store: f.store, token: slot.token, binding: session.sessionBinding, requestId: "prepare-reply" };
  f.store.email.apply(slot.token, { action: "connection.configure", requestId: "connect", connectionId: raw.connection.id,
    expectedRevision: 0, profile: raw.connection }, args.binding);
  const envelope = normalizeGraphEmail(raw.connection, raw.message, raw.options); args.sourceId = envelope.sourceId;
  const page = { action: "page.apply", requestId: "import", connectionId: raw.connection.id, connectionRevision: 1,
    folderId: raw.message.parentFolderId, expectedRevision: 0, expectedCursor: null, cursor: "cursor", reset: true, complete: true,
    observations: [{ kind: "message", expectedSourceRevision: 0, envelope }] };
  f.store.email.apply(args.token, page, args.binding);
  const save = (body, expectedRevision = 0) => f.store.inbox.apply(args.token, { action: "draft.save", requestId: "draft-" + expectedRevision,
    sourceId: envelope.sourceId, sourceRevision: 1, expectedRevision, body }, args.binding);
  save("Thanks for reaching out.\nLet’s choose a next step. 🪷");
  const plan = prepareGraphReplyDraft(args);
  const response = () => {
    const message = structuredClone(raw.message), address = v => ({ emailAddress: structuredClone(v) });
    Object.assign(message, { id: "immutable-draft+/=", changeKey: "draft-change", isDraft: true, hasAttachments: false,
      from: address(plan.expected.from), sender: address(plan.expected.from), replyTo: [],
      toRecipients: plan.expected.to.map(address), ccRecipients: plan.expected.cc.map(address), bccRecipients: [],
      body: { contentType: "text", content: plan.expected.body } });
    return { status: 200, connection: raw.connection, message,
      options: { idType: "immutable", attachmentObservation: { messageId: message.id, messageRevision: message.changeKey, complete: true, items: [] } } };
  };
  return { ...f, raw, args, plan, page, save, response, inspect: response => inspectGraphReplyDraft({ ...args, plan, providerDraftId: "immutable-draft+/=", response }) };
}
test("draft preparation uses the saved reply, Reply-To and an encoded immutable-ID route without credentials or private source text", t => {
  const f = fixture(t), before = auditRecovery(f.store), plan = prepareGraphReplyDraft(f.args);
  assert.equal(plan.create.url, "https://graph.microsoft.com/v1.0/users/fixture-mailbox/messages/AQMkFixtureMessage%2B1%2F%3D/createReply");
  assert.deepEqual(plan.expected.to.map(a => a.address), ["replies@example.test"]);
  assert.equal(plan.create.headers.Prefer, 'IdType="ImmutableId"'); assert.equal(plan.requiredPermission, "Mail.ReadWrite");
  assert.deepEqual(plan.create.body, { message: { body: { contentType: "text", content: plan.expected.body } } });
  assert.doesNotMatch(JSON.stringify(plan), /4200|observer@example.test|do not project this header|brief.txt/);
  assert.equal(plan.create.headers.Authorization, undefined); assert.equal(plan.canExecute, false); assert.equal(plan.canSend, false);
  assert.deepEqual(prepareGraphReplyDraft(f.args), plan); assert.deepEqual(auditRecovery(f.store), before);
  const all = prepareGraphReplyDraft({ ...f.args, mode: "replyAll" });
  assert.ok(all.create.url.endsWith("/createReplyAll")); assert.deepEqual(all.expected.to.map(a => a.address), ["replies@example.test", "lee@example.test"]);
  assert.deepEqual(all.expected.cc.map(a => a.address), ["sam@example.test"]); assert.deepEqual(all.expected.bcc, []);
});
test("a plan is not authority: changed draft, tampered content, room credentials and disconnected connection are refused", t => {
  const f = fixture(t), before = auditRecovery(f.store);
  assert.throws(() => currentGraphReplyDraft({ ...f.args, plan: { ...f.plan, canSend: true } }), { code: "stale_email_reply_plan" });
  assert.throws(() => prepareGraphReplyDraft({ ...f.args, token: f.keys.producer }), { status: 401 });
  assert.deepEqual(auditRecovery(f.store), before);
  f.save("An edited reply", 1);
  assert.throws(() => currentGraphReplyDraft({ ...f.args, plan: f.plan }), { code: "stale_email_reply_plan" });
  f.store.email.apply(f.args.token, { action: "connection.disconnect", requestId: "disconnect", connectionId: f.raw.connection.id, expectedRevision: 1 }, f.args.binding);
  assert.throws(() => prepareGraphReplyDraft(f.args), { code: "email_connection_changed" });
});
test("another signed-in account cannot prepare or observe the private reply", t => {
  const f = fixture(t), guest = f.store.accountForMember("commons", "guest"), slot = f.store.createAccountSessionSlot();
  const session = f.store.loginAccountSession(slot.token, f.store.issueAccountAccessKey(guest.id), 0);
  const args = { ...f.args, token: slot.token, binding: session.sessionBinding }, before = auditRecovery(f.store);
  assert.throws(() => prepareGraphReplyDraft(args), { status: 404 });
  assert.throws(() => observeGraphReplyCreation({ ...args, plan: f.plan, response: null }), { status: 404 });
  assert.throws(() => inspectGraphReplyDraft({ ...args, plan: f.plan, providerDraftId: "immutable-draft+/=", response: f.response() }), { status: 404 });
  assert.deepEqual(auditRecovery(f.store), before);
});
test("source changes refuse an old draft and do not silently prepare a new provider action", t => {
  const f = fixture(t); f.raw.message.body.content = "Updated request";
  const envelope = normalizeGraphEmail(f.raw.connection, f.raw.message, f.raw.options);
  f.store.email.apply(f.args.token, { ...f.page, requestId: "changed-source", expectedRevision: 1, expectedCursor: "cursor", cursor: "next",
    reset: false, observations: [{ kind: "message", expectedSourceRevision: 1, envelope }] }, f.args.binding);
  assert.throws(() => prepareGraphReplyDraft(f.args), { code: "stale_email_reply" });
});
test("creation observations preserve uncertainty and never authorize repeating a create or sending", t => {
  const f = fixture(t);
  for (const response of [null, { status: 503 }, { status: 202 }, { status: 404 }, { status: 201 },
    { status: 200, idType: "immutable", connection: f.raw.connection, message: { id: "immutable-draft+/=" } },
    { status: 201, idType: "immutable", connection: f.raw.connection, message: { id: "" } },
    { status: 201, idType: "immutable", connection: f.raw.connection, message: { id: f.raw.message.id } }]) {
    const result = observeGraphReplyCreation({ ...f.args, plan: f.plan, response });
    assert.equal(result.status, "creation_unconfirmed"); assert.equal(result.canRetryCreate, false); assert.equal(result.canSend, false);
  }
  const response = { status: 201, idType: "immutable", connection: f.raw.connection, message: { id: "immutable-draft+/=" } };
  assert.equal(observeGraphReplyCreation({ ...f.args, plan: f.plan, response }).status, "created_unverified");
  assert.equal(f.inspect({ status: 404 }).status, "draft_unavailable");
});
test("a fully observed matching draft still requires independent authorization; changed provider revision changes its review", t => {
  const f = fixture(t), response = f.response(), before = auditRecovery(f.store), result = f.inspect(response);
  assert.equal(result.status, "content_matches"); assert.deepEqual(result.differences, []); assert.equal(result.canSend, false);
  response.message.changeKey = "next-draft-revision"; response.options.attachmentObservation.messageRevision = response.message.changeKey;
  assert.notEqual(f.inspect(response).reviewVersion, result.reviewVersion);
  response.message.body.content = response.message.body.content.replace(/\n/g, "\r\n");
  assert.equal(f.inspect(response).status, "content_matches"); assert.deepEqual(auditRecovery(f.store), before);
});
for (const [name, change] of [
  ["body", r => r.message.body.content += "\nQuoted private history"],
  ["subject", r => r.message.subject = "Re: " + r.message.subject],
  ["to", r => r.message.toRecipients[0].emailAddress.address = "other@example.test"],
  ["bcc", r => r.message.bccRecipients = [{ emailAddress: { name: "Hidden", address: "hidden@example.test" } }]],
  ["from", r => r.message.from.emailAddress.address = "other@example.test"],
  ["sender", r => r.message.sender.emailAddress.address = "delegate@example.test"],
  ["thread", r => r.message.conversationId = "another-thread"],
  ["draft_state", r => r.message.isDraft = false],
  ["attachments", r => delete r.options.attachmentObservation],
  ["body", r => r.message.body = { contentType: "html", content: '<img src="https://example.invalid/track">' }]
]) test(`provider ${name} differences require review rather than silent repair`, t => {
  const f = fixture(t), response = f.response(); change(response); const result = f.inspect(response);
  assert.equal(result.status, "needs_review"); assert.ok(result.differences.includes(name)); assert.equal(result.canSend, false);
  if (response.message.body.contentType === "html") { assert.equal(result.draft.body, null); assert.doesNotMatch(JSON.stringify(result), /example.invalid/); }
});
test("wrong provider identity and mailbox observations cannot establish draft equivalence", t => {
  const f = fixture(t), wrong = f.response(); wrong.message.id = "another-draft"; wrong.options.attachmentObservation.messageId = wrong.message.id;
  assert.throws(() => f.inspect(wrong), { code: "email_reply_identity_changed" });
  const foreign = f.response(); foreign.connection = { ...foreign.connection, mailboxId: "other" };
  assert.throws(() => f.inspect(foreign), { code: "email_reply_scope_changed" });
});
test("the cold allowlisted package can prepare and inspect the same saved local reply without altering data", async t => {
  const f = fixture(t), before = auditRecovery(f.store), destination = join(f.directory, "reply-package");
  createRuntimePackage({ ...candidateRuntimeFixture(fileURLToPath(new URL("../", import.meta.url)), f.directory), destination });
  const { RoomStore } = await import(pathToFileURL(join(destination, "server/store.mjs")));
  const { prepareGraphReplyDraft: prepare, inspectGraphReplyDraft: inspect } = await import(pathToFileURL(join(destination, "server/graph-reply-draft.mjs")));
  const store = new RoomStore(join(f.directory, "room.sqlite"));
  try {
    assert.deepEqual(prepare({ ...f.args, store }), f.plan);
    assert.equal(inspect({ ...f.args, store, plan: f.plan, providerDraftId: "immutable-draft+/=", response: f.response() }).status, "content_matches");
    assert.deepEqual(auditRecovery(store), before);
  } finally { store.close(); }
});
