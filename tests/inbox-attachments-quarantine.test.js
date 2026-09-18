// Attachment descriptors must honor the spam quarantine (residual gap from
// PR #564, which enforced held/dismissed visibility on list/read/search/
// threads but not on the attachment listing and single-attachment paths).
// Held and dismissed messages expose no attachment metadata through either
// path; released rows return. The review surface remains the only view of
// held/dismissed rows.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { emailContractFixture } from "../scripts/email-contract-fixture.mjs";
import { normalizeGraphEmail } from "../server/graph-email.mjs";
import { ServiceError } from "../server/store.mjs";

const throwsCode = (fn, status, code) => assert.throws(fn,
  error => error instanceof ServiceError && error.status === status && error.code === code);
const flag = (score = 85, key = "test_signal") => ({
  score, quarantine: score >= 60, signals: [{ key, weight: score, detail: `Test signal ${key} fired` }] });

function fixture(t) {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const account = f.store.accountForMember("commons", "owner");
  const key = f.store.issueAccountAccessKey(account.id);
  const slot = f.store.createAccountSessionSlot();
  const session = { token: slot.token, ...f.store.loginAccountSession(slot.token, key, 0) };
  const token = session.token, binding = session.sessionBinding;
  const email = emailContractFixture();
  email.connection.accountId = account.id;
  f.store.email.apply(token, { action: "connection.configure", requestId: randomUUID(),
    connectionId: email.connection.id, expectedRevision: 0, profile: structuredClone(email.connection) }, binding);
  const importEmail = (messageId) => {
    email.message.id = messageId;
    email.options.attachmentObservation.messageId = messageId;
    email.options.attachmentObservation.messageRevision = email.message.changeKey;
    const envelope = normalizeGraphEmail(email.connection, email.message, email.options);
    const state = f.store.email.state(token, email.connection.id, email.message.parentFolderId, binding);
    f.store.email.apply(token, { action: "page.apply", requestId: randomUUID(), connectionId: email.connection.id,
      connectionRevision: email.connection.revision, folderId: email.message.parentFolderId,
      expectedRevision: state.folder?.revision ?? 0, expectedCursor: state.expectedCursor, cursor: randomUUID(),
      reset: state.needsReset, complete: true, observations: [{ kind: "message", expectedSourceRevision: 0, envelope }] },
      binding);
    return envelope.sourceId;
  };
  const sourceId = importEmail("m-attach-1");
  const hold = (overrides = {}) => f.store.spamQuarantine.quarantine({
    messageId: "m-attach-1", channel: "email", connectionId: email.connection.id,
    accountId: account.id, sourceId, flag: flag(85, "malicious_attachment"), ...overrides });
  return { f, account, token, binding, email, sourceId, hold };
}

test("held message's attachment descriptors are hidden", t => {
  const { f, token, binding, sourceId, hold } = fixture(t);
  // Baseline: the email has one descriptor and a working membership check.
  const before = f.store.inbox.attachments(token, binding, { sourceId, includeChannels: true });
  assert.equal(before.attachments.length, 1, "fixture email has one attachment descriptor");
  const [a] = before.attachments;
  assert.equal(a.id, "attachment-1=");
  assert.ok(f.store.inbox.attachment(token, binding, { sourceId, attachmentId: "attachment-1=", includeChannels: true }),
    "single attachment resolves before the hold");
  hold();
  throwsCode(() => f.store.inbox.attachments(token, binding, { sourceId, includeChannels: true }),
    404, "inbox_source_not_found", "held: attachment listing reads as not-found");
  throwsCode(() => f.store.inbox.attachment(token, binding, { sourceId, attachmentId: "attachment-1=", includeChannels: true }),
    404, "inbox_source_not_found", "held: single attachment reads as not-found (id cannot be confirmed)");
  throwsCode(() => f.store.inbox.attachment(token, binding, { sourceId, attachmentId: "no-such-attachment", includeChannels: true }),
    404, "inbox_source_not_found", "held: unknown ids do not leak a different code");
});

test("dismissed message's attachment descriptors stay hidden", t => {
  const { f, token, binding, sourceId, hold } = fixture(t);
  const row = hold();
  f.store.inbox.quarantineDismiss(token, binding, { quarantineId: row.id });
  throwsCode(() => f.store.inbox.attachments(token, binding, { sourceId, includeChannels: true }),
    404, "inbox_source_not_found", "dismissed: attachment listing still hidden");
  throwsCode(() => f.store.inbox.attachment(token, binding, { sourceId, attachmentId: "attachment-1=", includeChannels: true }),
    404, "inbox_source_not_found", "dismissed: single attachment still hidden");
});

test("releasing a hold returns the attachment descriptors", t => {
  const { f, token, binding, sourceId, hold } = fixture(t);
  const row = hold();
  throwsCode(() => f.store.inbox.attachments(token, binding, { sourceId, includeChannels: true }),
    404, "inbox_source_not_found");
  f.store.inbox.quarantineRelease(token, binding, { quarantineId: row.id });
  const after = f.store.inbox.attachments(token, binding, { sourceId, includeChannels: true });
  assert.equal(after.attachments.length, 1, "released: descriptors return");
  assert.equal(after.attachments[0].name, "brief.txt", "released: metadata intact");
  const single = f.store.inbox.attachment(token, binding, { sourceId, attachmentId: "attachment-1=", includeChannels: true });
  assert.equal(single.attachment.id, "attachment-1=", "released: single attachment resolves again");
  assert.equal(single.retrieval.available, false, "released: still metadata only");
});

test("a hold scoped to another account hides nothing", t => {
  const { f, account, token, binding, sourceId, hold } = fixture(t);
  const other = f.store.createAccount("other-acct-1");
  hold({ accountId: other.id });
  assert.notEqual(other.id, account.id, "precondition: distinct accounts");
  const result = f.store.inbox.attachments(token, binding, { sourceId, includeChannels: true });
  assert.equal(result.attachments.length, 1, "another account's hold does not hide this account's descriptors");
});
