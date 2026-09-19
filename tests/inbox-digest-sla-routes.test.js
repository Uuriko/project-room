// Per-thread SLA field in the thread list, exercised through a real store.
// (The morning-digest route was removed as dead; the SLA field is an
// additive addition to the thread shape.)
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
  const account = f.store.accountForMember("commons", "owner");
  const key = f.store.issueAccountAccessKey(account.id), slot = f.store.createAccountSessionSlot();
  f.session = { account, token: slot.token, ...f.store.loginAccountSession(slot.token, key, 0) };
  f.sessionHeaders = () => ({ Cookie: "account_session=" + f.session.token, "X-Session-Binding": f.session.sessionBinding });
  f.email = emailContractFixture(); f.email.connection.accountId = account.id;
  f.configureEmail = () => {
    f.store.email.apply(f.session.token, { action: "connection.configure", requestId: randomUUID(),
      connectionId: f.email.connection.id, expectedRevision: 0, profile: structuredClone(f.email.connection) }, f.session.sessionBinding);
  };
  f.importEmail = ({ messageId, internetMessageId, conversationId, subject, body }) => {
    f.configureEmail();
    const m = f.email.message;
    m.id = messageId; m.internetMessageId = internetMessageId; m.conversationId = conversationId;
    m.subject = subject; m.body.content = body;
    // Stamp the arrival as now so the SLA clock measures a fresh message.
    const nowIso = new Date().toISOString();
    m.sentDateTime = nowIso; m.receivedDateTime = nowIso;
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

test("thread list carries a per-channel SLA clock inline", t => {
  const f = fixture(t);
  f.importEmail({ messageId: "m-a", internetMessageId: "<a@example.test>", conversationId: "conv-a",
    subject: "Kickoff", body: "Let us start." });
  const result = f.store.inbox.threads(f.session.token, f.session.sessionBinding, { includeChannels: true });
  assert.equal(result.threads.length, 1);
  const [thread] = result.threads;
  assert.ok(thread.sla, "the SLA field is present on every thread");
  assert.equal(thread.sla.channel, "email");
  assert.equal(thread.sla.status, "on_track", "a fresh inbound email is inside its 24h target");
  assert.equal(thread.sla.targetMs, 24 * 3600 * 1000);
  assert.ok(thread.sla.elapsedMs >= 0 && thread.sla.elapsedMs < 3600 * 1000);
  assert.ok(typeof thread.sla.deadlineAt === "string");
});
