import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { emailContractFixture } from "../scripts/email-contract-fixture.mjs";
import { normalizeGraphEmail } from "../server/graph-email.mjs";

const data = { adapter: "synthetic", sender: "maya@example.test", recipient: "you@example.test", subject: "Subject", paragraphs: ["Body."] };
function fixture(t) {
  const f = createAcceptanceFixture(); f.filename = join(f.directory, "room.sqlite");
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const account = f.store.accountForMember("commons", "owner"), key = f.store.issueAccountAccessKey(account.id), slot = f.store.createAccountSessionSlot();
  f.session = { token: slot.token, ...f.store.loginAccountSession(slot.token, key, 0) };
  f.attachments = (sourceId, opts) => f.store.inbox.attachments(f.session.token, f.session.sessionBinding, { sourceId, ...opts });
  f.attachment = (sourceId, attachmentId, opts) => f.store.inbox.attachment(f.session.token, f.session.sessionBinding, { sourceId, attachmentId, ...opts });
  f.addSource = (id, subject, body) => f.store.inbox.apply(f.session.token,
    { action: "source.save", requestId: randomUUID(), sourceId: id, expectedRevision: 0, data: { ...data, subject, paragraphs: [body] } },
    f.session.sessionBinding);
  f.email = emailContractFixture(); f.email.connection.accountId = account.id;
  f.emailConfigured = false;
  f.configureEmail = () => {
    if (f.emailConfigured) return;
    f.store.email.apply(f.session.token, { action: "connection.configure", requestId: randomUUID(),
      connectionId: f.email.connection.id, expectedRevision: 0, profile: structuredClone(f.email.connection) }, f.session.sessionBinding);
    f.emailConfigured = true;
  };
  f.importEmail = (messageId) => {
    f.configureEmail();
    f.email.message.id = messageId;
    f.email.options.attachmentObservation.messageId = messageId;
    f.email.options.attachmentObservation.messageRevision = f.email.message.changeKey;
    const envelope = normalizeGraphEmail(f.email.connection, f.email.message, f.email.options);
    const state = f.store.email.state(f.session.token, f.email.connection.id, f.email.message.parentFolderId, f.session.sessionBinding);
    f.store.email.apply(f.session.token, { action: "page.apply", requestId: randomUUID(), connectionId: f.email.connection.id,
      connectionRevision: f.email.connection.revision, folderId: f.email.message.parentFolderId,
      expectedRevision: state.folder?.revision ?? 0, expectedCursor: state.expectedCursor, cursor: randomUUID(),
      reset: state.needsReset, complete: true, observations: [{ kind: "message", expectedSourceRevision: 0, envelope }] }, f.session.sessionBinding);
    return envelope.sourceId;
  };
  return f;
}

test("lists an email's attachment descriptors, metadata only", t => {
  const f = fixture(t);
  const sourceId = f.importEmail("m-a");
  const result = f.attachments(sourceId, { includeChannels: true });
  assert.equal(result.contractVersion, 1);
  assert.equal(result.sourceId, sourceId);
  assert.equal(result.attachments.length, 1);
  const [a] = result.attachments;
  assert.equal(a.id, "attachment-1=");
  assert.equal(a.kind, "file");
  assert.equal(a.name, "brief.txt");
  assert.equal(a.contentType, "text/plain");
  assert.equal(a.size, 128);
  assert.equal(a.inline, false);
  assert.ok(!("content" in a) && !("bytes" in a), "descriptors carry no bytes");
});

test("single attachment verifies membership and reports retrieval as unavailable", t => {
  const f = fixture(t);
  const sourceId = f.importEmail("m-a");
  const result = f.attachment(sourceId, "attachment-1=", { includeChannels: true });
  assert.equal(result.attachment.name, "brief.txt");
  assert.equal(result.retrieval.available, false);
  assert.equal(result.retrieval.reason, "attachment_bytes_not_retained");
  assert.throws(() => f.attachment(sourceId, "no-such-attachment", { includeChannels: true }),
    err => err.status === 404 && err.code === "inbox_attachment_not_found");
});

test("attachments are per-account and hidden without a reading view", t => {
  const f = fixture(t);
  const sourceId = f.importEmail("m-a");
  assert.throws(() => f.attachments(sourceId),
    err => err.status === 404 && err.code === "inbox_source_not_found", "channel source hidden without a reading view");
  const guest = f.store.accountForMember("commons", "guest"), key = f.store.issueAccountAccessKey(guest.id);
  const slot = f.store.createAccountSessionSlot(), gs = { token: slot.token, ...f.store.loginAccountSession(slot.token, key, 0) };
  assert.throws(() => f.store.inbox.attachments(gs.token, gs.sessionBinding, { sourceId, includeChannels: true }),
    err => err.status === 404 && err.code === "inbox_source_not_found", "another account's source is not visible");
  assert.throws(() => f.attachments("missing-source", { includeChannels: true }),
    err => err.status === 404 && err.code === "inbox_source_not_found");
});

test("synthetic samples expose an empty attachment list", t => {
  const f = fixture(t);
  f.addSource("s-1", "Note", "no attachments here");
  const result = f.attachments("s-1");
  assert.deepEqual(result.attachments, []);
  assert.throws(() => f.attachment("s-1", "attachment-1="),
    err => err.status === 404 && err.code === "inbox_attachment_not_found");
});
