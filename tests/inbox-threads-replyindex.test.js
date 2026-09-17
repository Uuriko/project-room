import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { emailContractFixture } from "../scripts/email-contract-fixture.mjs";
import { normalizeGraphEmail } from "../server/graph-email.mjs";

function fixture(t) {
  const f = createAcceptanceFixture(); f.filename = join(f.directory, "room.sqlite");
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const account = f.store.accountForMember("commons", "owner"), key = f.store.issueAccountAccessKey(account.id), slot = f.store.createAccountSessionSlot();
  f.session = { token: slot.token, ...f.store.loginAccountSession(slot.token, key, 0) };
  f.threads = (opts) => f.store.inbox.threads(f.session.token, f.session.sessionBinding, opts);
  f.connections = new Map();
  f.connection = (connectionId) => {
    if (!f.connections.has(connectionId)) {
      const fx = emailContractFixture();
      fx.connection = { ...fx.connection, id: connectionId, accountId: account.id, mailboxId: "mailbox-" + connectionId };
      f.store.email.apply(f.session.token, { action: "connection.configure", requestId: randomUUID(),
        connectionId, expectedRevision: 0, profile: structuredClone(fx.connection) }, f.session.sessionBinding);
      f.connections.set(connectionId, fx);
    }
    return f.connections.get(connectionId);
  };
  f.importEmail = ({ connectionId = "mail-a", messageId, internetMessageId, conversationId, subject, body, inReplyTo = null }) => {
    const fx = f.connection(connectionId), m = fx.message;
    m.id = messageId; m.internetMessageId = internetMessageId; m.conversationId = conversationId;
    m.subject = subject; m.body.content = body;
    m.internetMessageHeaders = inReplyTo ? [{ name: "In-Reply-To", value: inReplyTo }] : [];
    fx.options.attachmentObservation.messageId = messageId;
    fx.options.attachmentObservation.messageRevision = m.changeKey;
    const envelope = normalizeGraphEmail(fx.connection, m, fx.options);
    const state = f.store.email.state(f.session.token, connectionId, m.parentFolderId, f.session.sessionBinding);
    f.store.email.apply(f.session.token, { action: "page.apply", requestId: randomUUID(), connectionId,
      connectionRevision: fx.connection.revision, folderId: m.parentFolderId,
      expectedRevision: state.folder?.revision ?? 0, expectedCursor: state.expectedCursor, cursor: randomUUID(),
      reset: state.needsReset, complete: true, observations: [{ kind: "message", expectedSourceRevision: 0, envelope }] }, f.session.sessionBinding);
    return envelope.sourceId;
  };
  return f;
}

test("the same internetMessageId on two connections never cross-parents threads", t => {
  const f = fixture(t);
  f.importEmail({ connectionId: "mail-a", messageId: "a-1", internetMessageId: "<dup@example.test>",
    conversationId: "conv-a", subject: "Alpha", body: "First mailbox's thread." });
  f.importEmail({ connectionId: "mail-b", messageId: "b-1", internetMessageId: "<dup@example.test>",
    conversationId: "conv-b", subject: "Beta", body: "Unrelated mailbox, same provider message id." });
  f.importEmail({ connectionId: "mail-b", messageId: "b-2", internetMessageId: "<dup-reply@example.test>",
    conversationId: "conv-b", subject: "Re: Beta", body: "A reply on the second connection.",
    inReplyTo: "<dup@example.test>" });
  const result = f.threads({ includeChannels: true });
  assert.equal(result.total, 2, "the reply nests under its own connection's message, not the other connection's duplicate");
  const beta = result.threads.find(th => th.messageCount === 2);
  assert.ok(beta, "expected one two-message thread on mail-b");
  assert.ok(result.threads.some(th => th.messageCount === 1), "mail-a's message stays its own thread root");
});

test("replies still nest correctly within a single connection", t => {
  const f = fixture(t);
  f.importEmail({ connectionId: "mail-a", messageId: "a-1", internetMessageId: "<a@example.test>",
    conversationId: "conv-1", subject: "Kickoff", body: "Let us start." });
  f.importEmail({ connectionId: "mail-a", messageId: "a-2", internetMessageId: "<b@example.test>",
    conversationId: "conv-1", subject: "Re: Kickoff", body: "Agreed.", inReplyTo: "<a@example.test>" });
  const result = f.threads({ includeChannels: true });
  assert.equal(result.total, 1);
  assert.equal(result.threads[0].messageCount, 2);
  assert.equal(result.threads[0].depth, 1);
});

test("a reply whose parent lives on another connection stays its own thread root", t => {
  const f = fixture(t);
  f.importEmail({ connectionId: "mail-a", messageId: "a-1", internetMessageId: "<only-on-a@example.test>",
    conversationId: "conv-a", subject: "Alpha", body: "Only on the first connection." });
  f.importEmail({ connectionId: "mail-b", messageId: "b-1", internetMessageId: "<orphan@example.test>",
    conversationId: "conv-b", subject: "Orphan reply", body: "Claims a parent it cannot see on its own connection.",
    inReplyTo: "<only-on-a@example.test>" });
  const result = f.threads({ includeChannels: true });
  assert.equal(result.total, 2, "no silent cross-connection nesting: two separate roots");
  assert.ok(result.threads.every(th => th.messageCount === 1));
});
