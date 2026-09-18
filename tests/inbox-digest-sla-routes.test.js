// Task 21 + 24 wiring: the morning digest route and the per-thread SLA field
// in the thread list, exercised through a real store and a real HTTP server.
// The digest is an on-demand in-app read (never a push); the SLA field is an
// additive addition to the thread shape.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
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
async function serve(t, f) {
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return "http://127.0.0.1:" + server.address().port;
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

test("GET /api/inbox/digest returns the overnight brief in-app", async t => {
  const f = fixture(t);
  f.importEmail({ messageId: "m-b", internetMessageId: "<b@example.test>", conversationId: "conv-b",
    subject: "Overnight note", body: "Arrived overnight." });
  const origin = await serve(t, f), headers = f.sessionHeaders();
  const result = await fetch(origin + "/api/inbox/digest?view=email-text-v1", { headers });
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.contractVersion, 1);
  const { digest } = body;
  assert.match(digest.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(typeof digest.since, "string");
  assert.ok(digest.totalArrivals >= 1);
  const email = digest.channels.find(c => c.channel === "email");
  assert.ok(email, "the email channel is grouped");
  assert.ok(email.newThreads >= 1);
  const thread = email.senderGroups.flatMap(g => g.threads)[0];
  assert.ok(Array.isArray(thread.actions) && thread.actions.length > 0, "one-tap actions are present");
  assert.deepEqual(thread.actions[0].type, "reply");
  assert.ok(["on_track", "at_risk", "breached"].includes(thread.sla.status), "the digest annotates SLA state");
  assert.ok(Array.isArray(digest.needsHuman) && Array.isArray(digest.breached) && Array.isArray(digest.atRisk));
});

test("the digest honors an explicit since window", async t => {
  const f = fixture(t);
  f.importEmail({ messageId: "m-c", internetMessageId: "<c@example.test>", conversationId: "conv-c",
    subject: "Old news", body: "Before the window." });
  const origin = await serve(t, f), headers = f.sessionHeaders();
  const future = new Date(Date.now() + 3600 * 1000).toISOString();
  const result = await fetch(origin + "/api/inbox/digest?view=email-text-v1&since=" + encodeURIComponent(future), { headers });
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.digest.totalArrivals, 0, "nothing arrived after the window start");
  const bad = await fetch(origin + "/api/inbox/digest?since=not-a-date", { headers });
  assert.equal(bad.status, 422);
  assert.equal((await bad.json()).error.code, "invalid_digest_since");
});
