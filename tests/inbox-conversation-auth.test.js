import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { emailContractFixture } from "../scripts/email-contract-fixture.mjs";
import { normalizeGraphEmail } from "../server/graph-email.mjs";

const data = { adapter: "synthetic", sender: "maya@example.test", recipient: "you@example.test", subject: "Subject", paragraphs: ["Body."] };

function fixture(t) {
  const f = createAcceptanceFixture(); f.filename = join(f.directory, "room.sqlite");
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const account = f.store.accountForMember("commons", "owner");
  const key = f.store.issueAccountAccessKey(account.id), slot = f.store.createAccountSessionSlot();
  f.session = { account, token: slot.token, ...f.store.loginAccountSession(slot.token, key, 0) };
  f.sessionHeaders = () => ({ Cookie: "account_session=" + f.session.token, "X-Session-Binding": f.session.sessionBinding });
  f.guestSession = () => {
    const guest = f.store.accountForMember("commons", "guest");
    const gkey = f.store.issueAccountAccessKey(guest.id), gslot = f.store.createAccountSessionSlot();
    const s = { account: guest, token: gslot.token, ...f.store.loginAccountSession(gslot.token, gkey, 0) };
    return { Cookie: "account_session=" + s.token, "X-Session-Binding": s.sessionBinding };
  };
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

async function serve(t, f) {
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return "http://127.0.0.1:" + server.address().port;
}

test("threads over HTTP: channel mail hidden without a reading view, grouped with one", async t => {
  const f = fixture(t);
  f.addSource("local-note", "Local note", "A synthetic source, visible in every view.");
  const a = f.importEmail({ messageId: "m-a", internetMessageId: "<a@example.test>", conversationId: "conv-1",
    subject: "Kickoff", body: "Let us start." });
  f.importEmail({ messageId: "m-b", internetMessageId: "<b@example.test>", conversationId: "conv-1",
    subject: "Re: Kickoff", body: "Agreed.", inReplyTo: "<a@example.test>" });
  const origin = await serve(t, f), headers = f.sessionHeaders();
  let result = await fetch(origin + "/api/inbox/threads", { headers });
  assert.equal(result.status, 200);
  let body = await result.json();
  assert.equal(body.contractVersion, 1);
  assert.equal(body.viewer.accountId, f.session.account.id);
  assert.equal(body.threads.length, 1, "only the synthetic source is visible without a reading view");
  assert.equal(body.threads[0].messageCount, 1);
  result = await fetch(origin + "/api/inbox/threads?view=email-text-v1", { headers });
  assert.equal(result.status, 200);
  body = await result.json();
  assert.equal(body.threads.length, 2, "the email thread joins the synthetic source under a reading view");
  const thread = body.threads.find(th => th.messageCount === 2);
  assert.ok(thread, "expected the two-message conversation");
  assert.equal(thread.depth, 1);
  result = await fetch(origin + "/api/inbox/threads?view=email-text-v1&sourceId=" + encodeURIComponent(a), { headers });
  assert.equal(result.status, 200);
  body = await result.json();
  assert.equal(body.threads.length, 1, "a scoped lookup returns the full conversation containing the source");
  assert.equal(body.threads[0].messageCount, 2);
});

test("threads over HTTP: scoped channel source without a reading view matches nothing", async t => {
  const f = fixture(t);
  const a = f.importEmail({ messageId: "m-a", internetMessageId: "<a2@example.test>", conversationId: "conv-2",
    subject: "Private", body: "Mail." });
  const origin = await serve(t, f), headers = f.sessionHeaders();
  const result = await fetch(origin + "/api/inbox/threads?sourceId=" + encodeURIComponent(a), { headers });
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.deepEqual(body.threads, [], "the source exists for this account but is not visible in this view");
});

test("threads over HTTP: cross-account and auth boundaries", async t => {
  const f = fixture(t);
  const a = f.importEmail({ messageId: "m-a", internetMessageId: "<a3@example.test>", conversationId: "conv-3",
    subject: "Owner mail", body: "Mail." });
  const origin = await serve(t, f), headers = f.sessionHeaders(), guest = f.guestSession();
  let result = await fetch(origin + "/api/inbox/threads?view=email-text-v1", { headers: guest });
  assert.equal(result.status, 200);
  let body = await result.json();
  assert.deepEqual(body.threads, [], "a guest sees none of the owner's mail");
  result = await fetch(origin + "/api/inbox/threads?view=email-text-v1&sourceId=" + encodeURIComponent(a), { headers: guest });
  assert.equal(result.status, 404);
  body = await result.json();
  assert.equal(body.error.code, "inbox_source_not_found", "another account's source id is not a lookup handle");
  result = await fetch(origin + "/api/inbox/threads?view=email-text-v1", {});
  assert.equal(result.status, 422);
  body = await result.json();
  assert.equal(body.error.code, "session_binding_required", "no session at all is rejected before any read");
  result = await fetch(origin + "/api/inbox/threads?view=email-text-v1",
    { headers: { ...headers, Cookie: "account_session=bogus-token" } });
  assert.equal(result.status, 401, "a forged session token gets no conversation view");
  result = await fetch(origin + "/api/inbox/threads?view=email-text-v1",
    { headers: { ...headers, Authorization: "Bearer room-key" } });
  assert.equal(result.status, 401);
  body = await result.json();
  assert.equal(body.error.code, "account_session_required", "room/agent bearer keys are never inbox authority");
  result = await fetch(origin + "/api/inbox/threads?view=email-text-v1", { headers: { Cookie: headers.Cookie } });
  assert.equal(result.status, 422);
  body = await result.json();
  assert.equal(body.error.code, "session_binding_required");
  result = await fetch(origin + "/api/inbox/threads?view=raw-html-v9", { headers });
  assert.equal(result.status, 422);
  body = await result.json();
  assert.equal(body.error.code, "unsupported_inbox_view");
  result = await fetch(origin + "/api/inbox/threads?sourceId=" + encodeURIComponent("../nope"), { headers });
  assert.equal(result.status, 422, "malformed scoped ids stay rejected over HTTP");
});
