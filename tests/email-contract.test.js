import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { emailContractFixture } from "../scripts/email-contract-fixture.mjs";
import { emailLimits, readEmailEnvelope, previewEmailReply, EmailContractError } from "../server/email-envelope.mjs";
import { normalizeGraphEmail, graphFolderChanges } from "../server/graph-email.mjs";

const normalize = f => normalizeGraphEmail(f.connection, f.message, f.options);
const recipient = (address, name = "Person") => ({ emailAddress: { address, name } });
test("email import preserves distinct sender, from, reply-to, recipients, body and attachment metadata", () => {
  const f = emailContractFixture(), before = structuredClone(f), s = normalize(f);
  assert.equal(s.message.from.address, "avery@example.test");
  assert.equal(s.message.sender.address, "assistant@example.test");
  assert.equal(s.message.replyTo[0].address, "replies@example.test");
  assert.equal(s.message.bcc[0].address, "observer@example.test");
  assert.equal(s.body.content, f.message.body.content);
  assert.deepEqual(s.replyHeaders.references, ["<start@example.test> <earlier@example.test>"]);
  assert.equal(s.attachments.items[0].name, "brief.txt");
  assert.equal(s.attachments.state, "complete");
  assert.equal(s.message.receivedAt, f.message.receivedDateTime);
  assert.equal(s.message.id, f.message.id);
  assert.deepEqual(readEmailEnvelope(s), s);
  assert.deepEqual(f, before);
  assert.doesNotMatch(JSON.stringify(s), /do not project this header|Not authoritative body content|outlook\.example/);
});
test("review reply uses reply-to, deliberate sending identity, no Bcc or automatic attachment forwarding", () => {
  const f = emailContractFixture(), source = normalize(f), reply = previewEmailReply(source, f.connection, { body: "Happy to help." });
  assert.equal(reply.purpose, "review-only");
  assert.deepEqual(reply.from, f.connection.identity);
  assert.deepEqual(reply.to.map(v => v.address), ["replies@example.test"]);
  assert.deepEqual(reply.cc, []); assert.deepEqual(reply.bcc, []); assert.deepEqual(reply.attachments, []);
  assert.equal(reply.replyContext.messageId, f.message.id);
  assert.equal(reply.replyContext.internetMessageId, f.message.internetMessageId);
  assert.equal(reply.sourceVersion, source.sourceVersion);
  assert.equal(reply.subject, f.message.subject);
  assert.equal(reply.needs.includes("explicit-send-approval"), true);
  assert.doesNotMatch(JSON.stringify(reply), /observer@example|assistant@example|avery@example|Private budget/);
});
test("reply all excludes known own aliases and deduplicates To before Cc without leaking Bcc", () => {
  const f = emailContractFixture();
  f.message.ccRecipients.push(recipient("lee@EXAMPLE.TEST"), recipient("replies@example.test"));
  const source = normalize(f), reply = previewEmailReply(source, f.connection, { mode: "replyAll" });
  assert.deepEqual(reply.to.map(v => v.address), ["replies@example.test", "lee@example.test"]);
  assert.deepEqual(reply.cc.map(v => v.address), ["sam@example.test"]);
  assert.deepEqual(reply.bcc, []);
  // Local parts remain exact. An alias is never guessed from a display name.
  f.message.ccRecipients.push(recipient("Morgan@example.test", "Morgan"));
  assert.equal(previewEmailReply(normalize(f), f.connection, { mode: "replyAll" }).cc.at(-1).address, "Morgan@example.test");
});
test("missing reply-to falls back to From, not delegate Sender; self-only replies require a recipient", () => {
  const f = emailContractFixture(); f.message.replyTo = [];
  assert.equal(previewEmailReply(normalize(f), f.connection).to[0].address, "avery@example.test");
  f.message.from = recipient(f.connection.identity.address);
  assert.throws(() => previewEmailReply(normalize(f), f.connection), { code: "email_reply_needs_recipient" });
  f.message.isDraft = true;
  assert.throws(() => previewEmailReply(normalize(f), f.connection), { code: "email_reply_unavailable" });
});
test("source identity is scoped to account and mailbox, stable across folders, case-sensitive and not subject-based", () => {
  const f = emailContractFixture(), original = normalize(f);
  f.message.parentFolderId = "another-folder";
  f.message.subject = "Renamed";
  assert.equal(normalize(f).sourceId, original.sourceId);
  assert.notEqual(normalize(f).sourceVersion, original.sourceVersion);
  f.connection.revision++;
  assert.equal(normalize(f).sourceId, original.sourceId);
  f.connection.mailboxId = "another-mailbox";
  assert.notEqual(normalize(f).sourceId, original.sourceId);
  f.connection.mailboxId = "fixture-mailbox"; f.connection.accountId = "other-account";
  assert.notEqual(normalize(f).sourceId, original.sourceId);
  const other = emailContractFixture(); other.message.id = other.message.id.toLowerCase();
  other.options.attachmentObservation.messageId = other.message.id;
  assert.notEqual(normalize(other).sourceId, original.sourceId);
});
test("reply preview binds current connection revision, mailbox, identity and exact source content", () => {
  const f = emailContractFixture(), s = normalize(f), p = previewEmailReply(s, f.connection);
  for (const connection of [{ ...f.connection, revision: 2 }, { ...f.connection, accountId: "other" },
    { ...f.connection, mailboxId: "other" }, { ...f.connection, identity: { name: "Other", address: "other@example.test" } }]) {
    assert.throws(() => previewEmailReply(s, connection), { code: "email_connection_changed" });
  }
  const changed = structuredClone(s); changed.body.content = "Different";
  assert.throws(() => readEmailEnvelope(changed), { code: "email_version_mismatch" });
  assert.notEqual(previewEmailReply(s, f.connection, { body: "Changed reply" }).previewVersion, p.previewVersion);
  assert.notEqual(previewEmailReply(s, f.connection, { mode: "replyAll" }).previewVersion, p.previewVersion);
});
test("HTML is preserved as inert data, never replaced by a snippet or flattened into fake paragraphs", () => {
  const f = emailContractFixture(); f.message.body = { contentType: "HTML", content: '<p>Hello <b>Morgan</b></p><img src="https://tracking.example.test/pixel">' };
  const s = normalize(f);
  assert.equal(s.body.format, "html"); assert.equal(s.body.content, f.message.body.content);
  assert.equal(Object.hasOwn(s, "paragraphs"), false);
  assert.equal(previewEmailReply(s, f.connection).body, "");
});
test("absent attachment data is unknown even when hasAttachments is false; inline items remain visible", () => {
  const f = emailContractFixture(); f.message.hasAttachments = false; delete f.options.attachmentObservation;
  assert.equal(normalize(f).attachments.state, "not_loaded");
  const complete = emailContractFixture().options.attachmentObservation;
  complete.items[0].isInline = true; complete.items[0].contentId = "inline-1";
  f.options.attachmentObservation = complete;
  const s = normalize(f); assert.equal(s.attachments.state, "complete"); assert.equal(s.attachments.items[0].inline, true);
  complete.complete = false; assert.equal(normalize(f).attachments.state, "partial");
  complete.complete = true; complete.items[0].isInline = false;
  assert.throws(() => normalize(f), { code: "email_attachment_observation_conflict" });
});
test("attachment observations must match the exact parent version; bytes and URLs are not projected", () => {
  const f = emailContractFixture();
  f.options.attachmentObservation.messageRevision = "old";
  assert.throws(() => normalize(f), { code: "email_attachment_version_changed" });
  f.options.attachmentObservation.messageRevision = f.message.changeKey;
  Object.assign(f.options.attachmentObservation.items[0], { contentBytes: "private bytes", sourceUrl: "https://files.example.test/private" });
  assert.doesNotMatch(JSON.stringify(normalize(f)), /private bytes|files\.example/);
  f.options.attachmentObservation.items.push(structuredClone(f.options.attachmentObservation.items[0]));
  assert.throws(() => normalize(f), { code: "duplicate_email_attachment" });
});
test("message and reference attachment kinds remain explicit and unsupported kinds are refused", () => {
  const f = emailContractFixture(), item = f.options.attachmentObservation.items[0];
  for (const [provider, kind] of [["itemAttachment", "item"], ["referenceAttachment", "reference"]]) {
    item["@odata.type"] = "#microsoft.graph." + provider;
    assert.equal(normalize(f).attachments.items[0].kind, kind);
  }
  item["@odata.type"] = "#microsoft.graph.unknown";
  assert.throws(() => normalize(f), { code: "unsupported_email_attachment" });
});
test("unknown headers are distinct from loaded empty headers and legal folded references survive", () => {
  const f = emailContractFixture(); delete f.message.internetMessageHeaders;
  assert.equal(normalize(f).replyHeaders.state, "not_loaded");
  f.message.internetMessageHeaders = [{ name: "Bcc", value: "" }];
  assert.deepEqual(normalize(f).replyHeaders, { state: "complete", inReplyTo: [], references: [] });
});
test("partial delta bodies and mutable IDs cannot impersonate hydrated immutable email", () => {
  const f = emailContractFixture();
  assert.throws(() => normalizeGraphEmail(f.connection, f.message), { code: "email_immutable_ids_required" });
  assert.throws(() => normalizeGraphEmail(f.connection, { id: f.message.id, isRead: true }, f.options), { code: "email_hydration_required" });
  const removed = { ...f.message, "@removed": { reason: "deleted" } };
  assert.throws(() => normalizeGraphEmail(f.connection, removed, f.options), { code: "email_hydration_required" });
});
test("invalid, unsupported, excessive and malformed text never silently truncates", () => {
  for (const modify of [f => { f.message.subject = "bad\r\nheader"; }, f => { f.message.body.content = "\ud800"; },
    f => { f.message.from.emailAddress.address = '"quoted local"@example.test'; },
    f => { f.message.body.content = "😀".repeat(emailLimits.bodyBytes / 4 + 1); },
    f => { f.message.receivedDateTime = "2026-02-30T01:00:00Z"; },
    f => { f.message.toRecipients = Array.from({ length: emailLimits.recipients + 1 }, () => recipient("a@example.test")); },
    f => { f.connection.token = "must not enter this contract"; },
    f => { f.options.attachmentObservation.items[0].size = -1; }]) {
    const f = emailContractFixture(); modify(f); assert.throws(() => normalize(f), EmailContractError);
  }
  const f = emailContractFixture(); f.message.subject = ""; f.message.body.content = "";
  assert.equal(normalize(f).message.subject, ""); assert.equal(normalize(f).body.content, "");
});
test("folder delta preserves opaque continuation and hydrates partial observations without deleting mail", () => {
  const { connection } = emailContractFixture(), page = { value: [{ id: "move-id", "@removed": { reason: "deleted" } },
    { id: "changed-id", isRead: true }, { id: "changed-id", isRead: false }],
    "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/mailFolders/f/messages/delta?$skiptoken=a%2B%2F%3D" };
  const next = graphFolderChanges(connection, "folder", page, { idType: "immutable" });
  assert.equal(next.complete, false); assert.equal(next.cursor, page["@odata.nextLink"]);
  assert.deepEqual(next.changes, [{ messageId: "move-id", action: "absent-from-folder" },
    { messageId: "changed-id", action: "hydrate" }, { messageId: "changed-id", action: "hydrate" }]);
  const end = graphFolderChanges(connection, "folder", { value: [], "@odata.deltaLink": "opaque-final-cursor" }, { idType: "immutable" });
  assert.equal(end.complete, true); assert.deepEqual(end.changes, []);
});
test("folder delta refuses ambiguous cursors, unknown removal reasons and invalid identifiers", () => {
  const { connection } = emailContractFixture();
  for (const page of [{ value: [] }, { value: [], "@odata.nextLink": "next", "@odata.deltaLink": "delta" },
    { value: [], "@odata.nextLink": "next", "@odata.deltaLink": null },
    { value: [{ id: "one", "@removed": { reason: "unknown" } }], "@odata.deltaLink": "last" },
    { value: [{ id: "" }], "@odata.deltaLink": "last" }, { value: new Array(2), "@odata.deltaLink": "last" }]) {
    assert.throws(() => graphFolderChanges(connection, "folder", page, { idType: "immutable" }), EmailContractError);
  }
});
test("unsupported reply options cannot silently drop an attempted attachment or recipient override", () => {
  const f = emailContractFixture(), source = normalize(f);
  for (const options of [{ attachments: [] }, { to: ["other@example.test"] }, { send: true }, null]) {
    assert.throws(() => previewEmailReply(source, f.connection, options), { code: "unsupported_email_reply_options" });
  }
});
test("equivalent JSON key ordering preserves content identity; caller mutation does not change a normalized copy", () => {
  const f = emailContractFixture(), source = normalize(f);
  f.message = Object.fromEntries(Object.entries(f.message).reverse());
  assert.equal(normalize(f).sourceVersion, source.sourceVersion);
  f.message.replyTo[0].emailAddress.address = "changed@example.test";
  f.options.attachmentObservation.items[0].name = "changed.txt";
  assert.equal(source.message.replyTo[0].address, "replies@example.test");
  assert.equal(source.attachments.items[0].name, "brief.txt");
  assert.notEqual(normalize(f).sourceVersion, source.sourceVersion);
});
test("sparse recipient data, oversized ignored fields and ambiguous attachment completeness are rejected", () => {
  const f = emailContractFixture(); f.message.toRecipients = new Array(2);
  assert.throws(() => normalize(f), EmailContractError);
  const large = emailContractFixture(); large.message.ignored = "x".repeat(emailLimits.inputBytes);
  assert.throws(() => normalize(large), { code: "email_input_limit" });
  const ambiguous = emailContractFixture(); ambiguous.options.attachmentObservation.nextLink = "more-items";
  assert.throws(() => normalize(ambiguous), { code: "invalid_email_attachment_observation" });
});
test("real-shaped envelopes cannot enter the existing synthetic Inbox or enable its transport", t => {
  const fixture = createAcceptanceFixture();
  t.after(() => { fixture.store.close(); rmSync(fixture.directory, { recursive: true, force: true }); });
  const account = fixture.store.accountForMember("commons", "owner"), key = fixture.store.issueAccountAccessKey(account.id);
  const slot = fixture.store.createAccountSessionSlot(), session = fixture.store.loginAccountSession(slot.token, key, 0);
  const f = emailContractFixture(), before = fixture.store.room("commons");
  assert.throws(() => fixture.store.inbox.apply(slot.token, { action: "source.save", requestId: "email-import", sourceId: "email-source",
    expectedRevision: 0, data: normalize(f) }, session.sessionBinding), { code: "invalid_inbox_source" });
  assert.equal(fixture.store.inbox.list(slot.token, session.sessionBinding).sources.length, 0);
  assert.deepEqual(fixture.store.room("commons"), before);
});
