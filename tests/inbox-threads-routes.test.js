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
  f.threads = (opts) => f.store.inbox.threads(f.session.token, f.session.sessionBinding, opts);
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
  f.importEmail = ({ messageId, internetMessageId, conversationId, subject, body, inReplyTo = null }) => {
    f.configureEmail();
    const m = f.email.message;
    m.id = messageId; m.internetMessageId = internetMessageId; m.conversationId = conversationId;
    m.subject = subject; m.body.content = body;
    m.internetMessageHeaders = inReplyTo ? [{ name: "In-Reply-To", value: inReplyTo }] : [];
    f.email.options.attachmentObservation.messageId = messageId;
    f.email.options.attachmentObservation.messageRevision = m.changeKey;
    const envelope = normalizeGraphEmail(f.email.connection, m, f.email.options);
    const state = f.store.email.state(f.session.token, f.email.connection.id, m.parentFolderId, f.session.sessionBinding);
    f.store.email.apply(f.session.token, { action: "page.apply", requestId: randomUUID(), connectionId: f.email.connection.id,
      connectionRevision: f.email.connection.revision, folderId: m.parentFolderId,
      expectedRevision: state.folder?.revision ?? 0, expectedCursor: state.expectedCursor, cursor: randomUUID(),
      reset: state.needsReset, complete: true, observations: [{ kind: "message", expectedSourceRevision: 0, envelope }] }, f.session.sessionBinding);
    return envelope.sourceId;
  };
  return f;
}

test("groups emails by conversation and nests replies", t => {
  const f = fixture(t);
  const a = f.importEmail({ messageId: "m-a", internetMessageId: "<a@example.test>", conversationId: "conv-1",
    subject: "Kickoff", body: "Let us start." });
  const b = f.importEmail({ messageId: "m-b", internetMessageId: "<b@example.test>", conversationId: "conv-1",
    subject: "Re: Kickoff", body: "Agreed.", inReplyTo: "<a@example.test>" });
  f.importEmail({ messageId: "m-c", internetMessageId: "<c@example.test>", conversationId: "conv-2",
    subject: "Unrelated", body: "Other topic." });
  const result = f.threads({ includeChannels: true });
  assert.equal(result.contractVersion, 1);
  assert.equal(result.total, 2);
  const thread = result.threads.find(th => th.messageCount === 2);
  assert.ok(thread, "expected a two-message thread");
  assert.equal(thread.depth, 1);
  assert.equal(thread.entries.length, 2);
  assert.equal(thread.entries[0].depth, 0);
  assert.equal(thread.entries[0].source.id, a);
  assert.equal(thread.entries[1].depth, 1);
  assert.equal(thread.entries[1].source.id, b);
  assert.ok(thread.firstAt <= thread.lastAt);
});

test("dangling reply references become top-level instead of throwing", t => {
  const f = fixture(t);
  f.importEmail({ messageId: "m-d", internetMessageId: "<d@example.test>", conversationId: "conv-9",
    subject: "Orphan reply", body: "No parent here.", inReplyTo: "<ghost@example.test>" });
  const result = f.threads({ includeChannels: true });
  assert.equal(result.total, 1);
  assert.equal(result.threads[0].messageCount, 1);
  assert.equal(result.threads[0].depth, 0);
  assert.equal(result.threads[0].entries[0].depth, 0);
});

test("synthetic samples form singleton threads and emails stay hidden without a reading view", t => {
  const f = fixture(t);
  f.addSource("s-1", "Note one", "first");
  f.addSource("s-2", "Note two", "second");
  f.importEmail({ messageId: "m-e", internetMessageId: "<e@example.test>", conversationId: "conv-e",
    subject: "Hidden email", body: "not listed" });
  const plain = f.threads();
  assert.equal(plain.total, 2);
  assert.ok(plain.threads.every(th => th.messageCount === 1));
  const reading = f.threads({ includeChannels: true });
  assert.equal(reading.total, 3);
});

test("threads respect sourceId scope and per-account isolation", t => {
  const f = fixture(t);
  const a = f.importEmail({ messageId: "m-a", internetMessageId: "<a@example.test>", conversationId: "conv-1",
    subject: "Kickoff", body: "Let us start." });
  f.importEmail({ messageId: "m-b", internetMessageId: "<b@example.test>", conversationId: "conv-1",
    subject: "Re: Kickoff", body: "Agreed.", inReplyTo: "<a@example.test>" });
  const scoped = f.threads({ includeChannels: true, sourceId: a });
  assert.equal(scoped.total, 1);
  assert.equal(scoped.threads[0].messageCount, 1);
  assert.equal(scoped.threads[0].entries[0].source.id, a);
  const guest = f.store.accountForMember("commons", "guest"), key = f.store.issueAccountAccessKey(guest.id);
  const slot = f.store.createAccountSessionSlot(), session = { token: slot.token, ...f.store.loginAccountSession(slot.token, key, 0) };
  const isolated = f.store.inbox.threads(session.token, session.sessionBinding, { includeChannels: true });
  assert.equal(isolated.total, 0);
});

test("rejects invalid limits and caps the thread count", t => {
  const f = fixture(t);
  f.addSource("s-1", "Note one", "first");
  assert.throws(() => f.threads({ limit: 0 }), err => err.status === 422 && err.code === "invalid_limit");
  assert.throws(() => f.threads({ limit: 51 }), err => err.status === 422 && err.code === "invalid_limit");
  assert.throws(() => f.threads({ limit: "nope" }), err => err.status === 422 && err.code === "invalid_limit");
  const one = f.threads({ limit: 1 });
  assert.equal(one.threads.length, 1);
  assert.equal(one.total, 1);
});
