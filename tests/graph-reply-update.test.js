import test from "node:test";
import assert from "node:assert/strict";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { emailContractFixture } from "../scripts/email-contract-fixture.mjs";
import { seedRecordedReply } from "../scripts/reply-review-fixture.mjs";
import { normalizeGraphEmail } from "../server/graph-email.mjs";
import { emailDigest } from "../server/email-envelope.mjs";
import { prepareGraphReplyUpdate, buildGraphReplyUpdate, currentGraphReplyUpdate, inspectGraphReplyUpdate } from "../server/graph-reply-draft.mjs";
import { auditRecovery } from "../server/recovery.mjs";
import { candidateRuntimeFixture } from "../scripts/candidate-runtime-fixture.mjs";
import { createRuntimePackage } from "../scripts/runtime-package.mjs";

function setup(t) {
  const f = createAcceptanceFixture(), raw = emailContractFixture(), account = f.store.accountForMember("commons", "owner");
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  raw.connection.accountId = account.id;
  const slot = f.store.createAccountSessionSlot();
  const binding = f.store.loginAccountSession(slot.token, f.store.issueAccountAccessKey(account.id), 0).sessionBinding;
  const args = { store: f.store, token: slot.token, binding };
  f.store.email.apply(args.token, { action: "connection.configure", requestId: "connect", connectionId: raw.connection.id,
    expectedRevision: 0, profile: raw.connection }, binding);
  const envelope = normalizeGraphEmail(raw.connection, raw.message, raw.options); args.sourceId = envelope.sourceId;
  const page = { action: "page.apply", requestId: "import", connectionId: raw.connection.id, connectionRevision: 1,
    folderId: raw.message.parentFolderId, expectedRevision: 0, expectedCursor: null, cursor: "cursor", reset: true, complete: true,
    observations: [{ kind: "message", expectedSourceRevision: 0, envelope }] };
  f.store.email.apply(args.token, page, binding);
  const seed = seedRecordedReply(args);
  args.attemptId = seed.plan.requestId; args.requestId = "propose-update";
  const attempt = () => f.store.inbox.replyAttempts(args.token, args.sourceId, binding).attempts.find(a => a.id === args.attemptId);
  const save = body => {
    const { source, draft } = f.store.inbox.read(args.token, args.sourceId, binding);
    return f.store.inbox.apply(args.token, { action: "draft.save", requestId: crypto.randomUUID(), sourceId: args.sourceId,
      sourceRevision: source.revision, expectedRevision: draft.revision, body }, binding);
  };
  const prepare = (extra = {}) => prepareGraphReplyUpdate({ ...args, expectedRevision: attempt().revision, ...extra });
  const response = () => {
    const draft = attempt().observation.draft, address = value => ({ emailAddress: value });
    const message = { ...structuredClone(raw.message), id: seed.providerDraftId, changeKey: draft.revision,
      isDraft: true, hasAttachments: false, from: address(draft.from), sender: address(draft.sender),
      toRecipients: draft.to.map(address), ccRecipients: draft.cc.map(address), bccRecipients: draft.bcc.map(address),
      subject: draft.subject, replyTo: [], body: { contentType: "text", content: draft.body } };
    return { status: 200, connection: raw.connection, message, options: { idType: "immutable",
      attachmentObservation: { messageId: message.id, messageRevision: message.changeKey, complete: true, items: [] } } };
  };
  const record = response => f.store.inbox.recordReplyObservation(args.token, { sourceId: args.sourceId,
    attemptId: args.attemptId, requestId: crypto.randomUUID(), expectedRevision: attempt().revision, response }, binding);
  return { ...f, raw, account, args, page, seed, attempt, save, prepare, response, record,
    current: proposal => currentGraphReplyUpdate({ ...args, proposal }),
    inspect: (proposal, response) => inspectGraphReplyUpdate({ ...args, proposal, response }) };
}

test("body-only update preserves original, observed and proposed versions with zero writes or execution authority", t => {
  const f = setup(t);
  f.seed.observe({ body: { format: "text", content: "An outside edit.\nKeep this version too." } });
  f.save("My revised reply.\nCafé 🪷");
  const original = structuredClone(f.attempt()), before = auditRecovery(f.store), proposal = f.prepare();
  assert.equal(proposal.original.body, f.seed.plan.expected.body);
  assert.equal(proposal.observed.body, "An outside edit.\nKeep this version too.");
  assert.equal(proposal.proposed.body, "My revised reply.\nCafé 🪷");
  assert.deepEqual(proposal.update.body, { body: { contentType: "text", content: proposal.proposed.body } });
  assert.equal(proposal.update.method, "PATCH");
  assert.equal(proposal.update.url, "https://graph.microsoft.com/v1.0/users/fixture-mailbox/messages/" + encodeURIComponent(f.seed.providerDraftId));
  assert.equal(proposal.update.headers.Prefer, 'IdType="ImmutableId"');
  assert.equal(proposal.update.headers.Authorization, undefined); assert.equal(proposal.update.headers["If-Match"], undefined);
  assert.equal(proposal.conditionalWrite, "unqualified");
  for (const key of ["canExecute", "canRetryUpdate", "canReview", "canSend"]) assert.equal(proposal[key], false);
  assert.deepEqual(proposal, f.prepare()); assert.deepEqual(f.current(proposal), proposal);
  assert.equal(proposal.connection.revision, 1);
  assert.deepEqual(f.current(JSON.parse(JSON.stringify(proposal))), proposal, "serialized proposals retain every compared field");
  assert.deepEqual(f.attempt(), original); assert.deepEqual(auditRecovery(f.store), before);
  assert.doesNotMatch(JSON.stringify(proposal), /4200|observer@example.test|internetMessageHeaders|brief.txt/);
  mkdirSync("test-results/reply-update-20260908", { recursive: true });
  writeFileSync("test-results/reply-update-20260908/three-versions.json", JSON.stringify(proposal, null, 2) + "\n");
});

test("matching text is an explicit no-op, including line endings, while changed local revisions invalidate a proposal", t => {
  const f = setup(t), first = f.prepare();
  assert.equal(first.status, "no_update"); assert.equal(first.update, null);
  f.save("Line one\nLine two.");
  f.seed.observe({ body: { format: "text", content: "Line one\r\nLine two." } });
  const same = f.prepare(); assert.equal(same.status, "no_update");
  f.save("Line one\nLine two.");
  assert.throws(() => f.current(same), { code: "stale_email_reply_update" });
  assert.notEqual(f.prepare().updateVersion, same.updateVersion);
});

test("outside recipient and subject edits stay visible and are never rewritten by the body-only proposal", t => {
  const f = setup(t);
  f.seed.observe({ message: { to: [{ name: "Chosen person", address: "chosen@example.test" }],
    cc: [{ name: "Copy", address: "copy@example.test" }], bcc: [{ name: "Private copy", address: "bcc@example.test" }],
    subject: "Outside subject" } });
  f.save("Only change the body.");
  const p = f.prepare();
  assert.deepEqual(p.contextDifferences, ["to", "cc", "bcc", "subject"]);
  for (const key of ["from", "sender", "to", "cc", "bcc", "subject", "attachmentState", "attachmentCount"])
    assert.deepEqual(p.proposed[key], p.observed[key]);
  assert.deepEqual(Object.keys(p.update.body), ["body"]);
  assert.notDeepEqual(p.original.to, p.proposed.to);
});

for (const [name, change] of [
  ["HTML", r => r.message.body = { contentType: "html", content: "<p>Unqualified HTML</p>" }],
  ["missing attachments", r => delete r.options.attachmentObservation],
  ["nonempty attachments", r => {
    r.message.hasAttachments = true;
    r.options.attachmentObservation.items = [{ "@odata.type": "#microsoft.graph.fileAttachment",
      id: "fixture-attachment", name: "notes.txt", contentType: "text/plain", size: 12, isInline: false, contentId: null }];
  }],
  ["not a draft", r => r.message.isDraft = false],
  ["wrong sender", r => r.message.sender.emailAddress.address = "delegate@example.test"],
  ["wrong from", r => r.message.from.emailAddress.address = "other@example.test"],
  ["wrong thread", r => r.message.conversationId = "different-thread"],
  ["no recipients", r => { r.message.toRecipients = []; r.message.ccRecipients = []; r.message.bccRecipients = []; }]
]) test(`unsupported update observation: ${name}`, t => {
  const f = setup(t), r = f.response(); change(r); f.record(r);
  const before = auditRecovery(f.store);
  assert.throws(() => f.prepare(), { code: "unsupported_reply_update" });
  assert.deepEqual(auditRecovery(f.store), before);
});

test("unavailable observations and stale attempt revisions cannot prepare or reuse an update", t => {
  const f = setup(t), p = f.prepare();
  f.seed.observe(null);
  assert.throws(() => f.prepare(), { code: "unsupported_reply_update" });
  assert.throws(() => f.current(p), { code: "stale_reply_attempt" });
  for (const expectedRevision of [-1, 0.5, null, "3", Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => f.prepare({ expectedRevision }), { code: "invalid_email_reply_update" });
  assert.throws(() => f.prepare({ attemptId: "missing" }), { code: "reply_attempt_not_found" });
});

test("local edits, tampered proposals and extra authority cannot pass full reconstruction", t => {
  const f = setup(t); f.save("Edited reply"); const p = f.prepare();
  for (const patch of [
    { canExecute: true }, { canReview: true }, { providerDraftId: "other" },
    { observed: { ...p.observed, body: "Altered observation" } },
    { proposed: { ...p.proposed, to: [] } }, { extra: "not in contract" },
    { update: { ...p.update, body: { subject: "silently change the subject" } } }
  ]) {
    const changed = { ...p, ...patch }; delete changed.updateVersion; changed.updateVersion = emailDigest(changed);
    assert.throws(() => f.current(changed), { code: "stale_email_reply_update" });
  }
  f.save("Another edited reply");
  assert.throws(() => f.current(p), { code: "stale_email_reply_update" });
});

test("new source context remains distinct even after the local draft is saved against it", t => {
  const f = setup(t), p = f.prepare();
  f.raw.message.body.content += "\nChanged request"; f.raw.message.changeKey = "source-v2";
  f.raw.options.attachmentObservation.messageRevision = f.raw.message.changeKey;
  const envelope = normalizeGraphEmail(f.raw.connection, f.raw.message, f.raw.options);
  f.store.email.apply(f.args.token, { ...f.page, requestId: "source-change", expectedRevision: 1,
    expectedCursor: "cursor", cursor: "next", reset: false, observations: [{ kind: "message", expectedSourceRevision: 1, envelope }] }, f.args.binding);
  assert.throws(() => f.current(p), { code: "stale_email_reply" });
  f.save("Reply to the changed source");
  assert.throws(() => f.prepare(), { code: "email_reply_context_changed" });
});

test("reconnecting even the same mailbox invalidates the old connection-bound proposal", t => {
  const f = setup(t), p = f.prepare();
  f.store.email.apply(f.args.token, { action: "connection.configure", requestId: "reconnect",
    connectionId: f.raw.connection.id, expectedRevision: 1, profile: { ...f.raw.connection, revision: 2 } }, f.args.binding);
  assert.throws(() => f.current(p), { code: "email_connection_changed" });
  assert.equal(f.attempt().plan.connection.revision, 1);
});

test("a newly recorded identical observation still invalidates an older attempt revision", t => {
  const f = setup(t), p = f.prepare();
  f.seed.observe();
  assert.equal(f.attempt().observation.reviewVersion, p.observationVersion);
  assert.throws(() => f.current(p), { code: "stale_reply_attempt" });
  assert.notEqual(f.prepare().updateVersion, p.updateVersion);
});

test("cancelled and unconfirmed creation attempts never yield an update proposal", t => {
  const f = setup(t);
  // The pure constructor receives trusted retained data; exercise the phase gate
  // without changing durable history merely to create impossible transitions.
  const { source, draft } = f.store.inbox.read(f.args.token, f.args.sourceId, f.args.binding);
  const auth = f.store.inbox.auth(f.args.token, f.args.binding), connection = f.store.email.connection(f.account.id, f.raw.connection.id);
  for (const status of ["reserved", "creation_unconfirmed", "cancelled"])
    assert.throws(() => buildGraphReplyUpdate({ auth, source, draft, connection, requestId: "update",
      attempt: { ...f.attempt(), status }, expectedRevision: f.attempt().revision }), { code: "reply_draft_unconfirmed" });
});

test("mailbox disconnect, room credentials, other accounts and account revocation retain their boundaries", t => {
  const f = setup(t), p = f.prepare(), before = auditRecovery(f.store);
  assert.throws(() => f.prepare({ token: f.keys.producer }), { status: 401 });
  const guest = f.store.accountForMember("commons", "guest"), slot = f.store.createAccountSessionSlot();
  const binding = f.store.loginAccountSession(slot.token, f.store.issueAccountAccessKey(guest.id), 0).sessionBinding;
  assert.throws(() => prepareGraphReplyUpdate({ ...f.args, token: slot.token, binding, expectedRevision: p.attemptRevision }), { status: 404 });
  f.store.email.apply(f.args.token, { action: "connection.disconnect", requestId: "disconnect",
    connectionId: f.raw.connection.id, expectedRevision: 1 }, f.args.binding);
  assert.throws(() => f.current(p), { code: "email_connection_changed" });
  assert.equal(f.attempt().plan.planVersion, f.seed.plan.planVersion);
  f.store.changeAccountAccess(f.account.id, { expectedRevision: 0, active: false, reason: "Fixture revoke" });
  assert.throws(() => f.current(p), { status: 401 });
  assert.ok(before.dataSha256);
});

test("readback distinguishes a matching proposal, unchanged observation and further edits without claiming causation", t => {
  const f = setup(t); f.save("New proposed text"); const p = f.prepare(), before = auditRecovery(f.store);
  assert.equal(f.inspect(p, f.response()).status, "observed_content_unchanged");
  const r = f.response(); r.message.body.content = p.proposed.body;
  const sameRevision = f.inspect(p, r);
  assert.equal(sameRevision.status, "proposal_content_matches"); assert.equal(sameRevision.providerRevisionChanged, false);
  assert.equal(sameRevision.updateOutcome, "unproven");
  r.message.changeKey = "A-opaque-not-ordered"; r.options.attachmentObservation.messageRevision = r.message.changeKey;
  const match = f.inspect(p, r);
  assert.equal(match.status, "proposal_content_matches"); assert.equal(match.providerRevisionChanged, true);
  for (const key of ["canExecute", "canRetryUpdate", "canReview", "canSend"]) assert.equal(match[key], false);
  assert.equal(match.updateOutcome, "unproven");
  r.message.body.content = "A third version";
  assert.equal(f.inspect(p, r).status, "needs_review");
  r.message.body.content = p.proposed.body; r.message.subject = "Later outside subject";
  assert.deepEqual(f.inspect(p, r).differences, ["subject"]);
  assert.equal(f.inspect(p, { status: 503 }).status, "draft_unavailable");
  assert.deepEqual(auditRecovery(f.store), before);
  f.save("Newer local edit");
  assert.throws(() => f.inspect(p, r), { code: "stale_email_reply_update" });
});

test("wrong readback identity or mailbox cannot be mistaken for the proposed update", t => {
  const f = setup(t), p = f.prepare(), wrong = f.response();
  wrong.message.id = "other"; wrong.options.attachmentObservation.messageId = "other";
  assert.throws(() => f.inspect(p, wrong), { code: "email_reply_identity_changed" });
  const foreign = f.response(); foreign.connection = { ...foreign.connection, mailboxId: "other" };
  assert.throws(() => f.inspect(p, foreign), { code: "email_reply_scope_changed" });
  assert.throws(() => f.inspect(p, { ...f.response(), options: { idType: "mutable" } }), { code: "email_immutable_ids_required" });
});

test("cold allowlisted runtime reconstructs and compares updates without changing retained history", async t => {
  const f = setup(t); f.save("Portable qualification"); const p = f.prepare(), before = auditRecovery(f.store);
  const destination = join(f.directory, "update-package");
  createRuntimePackage({ ...candidateRuntimeFixture(fileURLToPath(new URL("../", import.meta.url)), f.directory), destination });
  const { RoomStore } = await import(pathToFileURL(join(destination, "server/store.mjs")));
  const { currentGraphReplyUpdate: current, inspectGraphReplyUpdate: inspect } = await import(pathToFileURL(join(destination, "server/graph-reply-draft.mjs")));
  const store = new RoomStore(join(f.directory, "room.sqlite"));
  try {
    assert.deepEqual(current({ ...f.args, store, proposal: p }), p);
    assert.equal(inspect({ ...f.args, store, proposal: p, response: f.response() }).status, "observed_content_unchanged");
    assert.deepEqual(auditRecovery(store), before);
  } finally { store.close(); }
});
