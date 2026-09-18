// Task 23 wiring: the handoff routes over a real store and a real HTTP
// server. POST /api/inbox/handoffs journals a context packet built from the
// recent thread view; GET lists the journaled handoffs (the "nothing closes
// unowned" sweep); POST /api/inbox/handoffs/transition moves the lifecycle.
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
  f.headers = (withCsrf = false) => ({ Cookie: "account_session=" + f.session.token,
    "X-Session-Binding": f.session.sessionBinding,
    ...(withCsrf ? { Origin: f.origin, "Content-Type": "application/json", "X-CSRF-Token": f.session.csrf } : {}) });
  f.email = emailContractFixture(); f.email.connection.accountId = account.id;
  f.importEmail = ({ messageId, internetMessageId, conversationId, subject, body }) => {
    f.store.email.apply(f.session.token, { action: "connection.configure", requestId: randomUUID(),
      connectionId: f.email.connection.id, expectedRevision: 0, profile: structuredClone(f.email.connection) }, f.session.sessionBinding);
    const m = f.email.message;
    m.id = messageId; m.internetMessageId = internetMessageId; m.conversationId = conversationId;
    m.subject = subject; m.body.content = body;
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
  f.origin = "http://127.0.0.1:" + server.address().port;
  return f.origin;
}
const post = (origin, path, body, headers) => fetch(origin + path,
  { method: "POST", body: JSON.stringify(body), headers });

test("POST /api/inbox/handoffs journals a context packet from the thread view", async t => {
  const f = fixture(t);
  f.importEmail({ messageId: "m-h1", internetMessageId: "<h1@example.test>", conversationId: "conv-h1",
    subject: "Needs a person", body: "Please look at this." });
  const origin = await serve(t, f);
  const threads = await (await fetch(origin + "/api/inbox/threads?view=email-text-v1", { headers: f.headers() })).json();
  const threadId = threads.threads[0].threadId;
  const response = await post(origin, "/api/inbox/handoffs?view=email-text-v1",
    { threadId, to: "claude", summary: "Uncertain intent; needs a person.",
      openQuestions: ["What do they actually want?"], pendingActions: ["Reply within the day"] },
    f.headers(true));
  assert.equal(response.status, 201);
  const { duplicate, handoff } = await response.json();
  assert.equal(duplicate, false);
  assert.equal(handoff.status, "open");
  assert.ok(typeof handoff.handoffId === "string");
  const packet = handoff.packet;
  assert.equal(packet.packetVersion, 1);
  assert.equal(packet.threadId, threadId);
  assert.equal(packet.channel, "email");
  assert.equal(packet.to, "claude");
  assert.equal(packet.from, "owner");
  assert.equal(packet.summary, "Uncertain intent; needs a person.");
  assert.deepEqual(packet.openQuestions, ["What do they actually want?"]);
  assert.ok(Array.isArray(packet.sourceIds) && packet.sourceIds.length >= 1);
  assert.equal(packet.triage.action, "needs_human");
  assert.ok(["on_track", "at_risk", "breached"].includes(packet.sla.status), "the SLA clock rides along");
  assert.equal(packet.constraints.channel, "email");
  assert.equal(handoff.history.length, 1);
  // A repeat create for the same thread returns the existing receipt, not a second row.
  const repeat = await post(origin, "/api/inbox/handoffs?view=email-text-v1", { threadId, to: "grokbot" }, f.headers(true));
  assert.equal(repeat.status, 200);
  const again = await repeat.json();
  assert.equal(again.duplicate, true);
  assert.equal(again.handoff.handoffId, handoff.handoffId);
  assert.equal(again.handoff.packet.to, "claude", "the first open handoff keeps the thread");
});

test("the handoff list is the nothing-closes-unowned sweep, with lifecycle transitions", async t => {
  const f = fixture(t);
  f.importEmail({ messageId: "m-h2", internetMessageId: "<h2@example.test>", conversationId: "conv-h2",
    subject: "Sweep me", body: "Open handoff." });
  const origin = await serve(t, f);
  const threads = await (await fetch(origin + "/api/inbox/threads?view=email-text-v1", { headers: f.headers() })).json();
  const { handoff } = await (await post(origin, "/api/inbox/handoffs?view=email-text-v1",
    { threadId: threads.threads[0].threadId, to: "instinct" }, f.headers(true))).json();
  const listed = await (await fetch(origin + "/api/inbox/handoffs", { headers: f.headers() })).json();
  assert.deepEqual(listed.statuses, ["open", "accepted", "completed", "released"]);
  assert.equal(listed.handoffs.length, 1);
  assert.equal(listed.handoffs[0].handoffId, handoff.handoffId);
  const openOnly = await (await fetch(origin + "/api/inbox/handoffs?status=open", { headers: f.headers() })).json();
  assert.equal(openOnly.handoffs.length, 1);
  const badStatus = await fetch(origin + "/api/inbox/handoffs?status=napping", { headers: f.headers() });
  assert.equal(badStatus.status, 422);
  assert.equal((await badStatus.json()).error.code, "invalid_handoff_status");
  const accepted = await (await post(origin, "/api/inbox/handoffs/transition",
    { handoffId: handoff.handoffId, status: "accepted", note: "On it" }, f.headers(true))).json();
  assert.equal(accepted.handoff.status, "accepted");
  assert.equal(accepted.handoff.history.length, 2);
  const done = await (await post(origin, "/api/inbox/handoffs/transition",
    { handoffId: handoff.handoffId, status: "completed" }, f.headers(true))).json();
  assert.equal(done.handoff.status, "completed");
  const illegal = await post(origin, "/api/inbox/handoffs/transition",
    { handoffId: handoff.handoffId, status: "accepted" }, f.headers(true));
  assert.equal(illegal.status, 409);
  assert.equal((await illegal.json()).error.code, "invalid_handoff_transition");
  const missing = await post(origin, "/api/inbox/handoffs/transition",
    { handoffId: "nope", status: "accepted" }, f.headers(true));
  assert.equal(missing.status, 404);
  const openAfter = await (await fetch(origin + "/api/inbox/handoffs?status=open", { headers: f.headers() })).json();
  assert.equal(openAfter.handoffs.length, 0, "nothing open remains unowned");
});

test("handoff creation validates its inputs", async t => {
  const f = fixture(t);
  f.importEmail({ messageId: "m-h3", internetMessageId: "<h3@example.test>", conversationId: "conv-h3",
    subject: "Validate me", body: "Check the guards." });
  const origin = await serve(t, f);
  const threads = await (await fetch(origin + "/api/inbox/threads?view=email-text-v1", { headers: f.headers() })).json();
  const threadId = threads.threads[0].threadId;
  const noTo = await post(origin, "/api/inbox/handoffs?view=email-text-v1", { threadId }, f.headers(true));
  assert.equal(noTo.status, 422);
  assert.equal((await noTo.json()).error.code, "invalid_handoff_packet");
  const noThread = await post(origin, "/api/inbox/handoffs?view=email-text-v1",
    { threadId: "thread:does-not-exist", to: "claude" }, f.headers(true));
  assert.equal(noThread.status, 404);
  assert.equal((await noThread.json()).error.code, "handoff_thread_not_found");
  const noBody = await post(origin, "/api/inbox/handoffs?view=email-text-v1", null, f.headers(true));
  assert.equal(noBody.status, 400, "a JSON null is not an object");
  assert.equal((await noBody.json()).error.code, "invalid_json");
  const noCsrf = await post(origin, "/api/inbox/handoffs?view=email-text-v1",
    { threadId, to: "claude" }, f.headers(false));
  assert.equal(noCsrf.status, 403, "writes need the CSRF token");
});
