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
  f.guestHeaders = () => {
    const guest = f.store.accountForMember("commons", "guest");
    const gkey = f.store.issueAccountAccessKey(guest.id), gslot = f.store.createAccountSessionSlot();
    const s = { token: gslot.token, ...f.store.loginAccountSession(gslot.token, gkey, 0) };
    return { Cookie: "account_session=" + s.token, "X-Session-Binding": s.sessionBinding };
  };
  f.email = emailContractFixture(); f.email.connection.accountId = account.id;
  f.configureEmail = () => {
    f.store.email.apply(f.session.token, { action: "connection.configure", requestId: randomUUID(),
      connectionId: f.email.connection.id, expectedRevision: 0, profile: structuredClone(f.email.connection) }, f.session.sessionBinding);
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

async function serve(t, f) {
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return "http://127.0.0.1:" + server.address().port;
}

test("attachment metadata over HTTP: metadata only, retrieval honestly unavailable", async t => {
  const f = fixture(t);
  const sourceId = f.importEmail("m-a");
  const origin = await serve(t, f), headers = f.sessionHeaders();
  const base = origin + "/api/inbox/sources/" + encodeURIComponent(sourceId) + "/attachments";
  let result = await fetch(base + "?view=email-text-v1", { headers });
  assert.equal(result.status, 200);
  let body = await result.json();
  assert.equal(body.contractVersion, 1);
  assert.equal(body.sourceId, sourceId);
  assert.equal(body.attachments.length, 1);
  const [a] = body.attachments;
  assert.equal(a.id, "attachment-1=");
  assert.equal(a.name, "brief.txt");
  assert.equal(a.contentType, "text/plain");
  assert.equal(a.size, 128);
  assert.equal(a.inline, false);
  assert.ok(!("content" in a) && !("bytes" in a), "descriptors carry no bytes over HTTP either");
  result = await fetch(base + "/" + encodeURIComponent(a.id) + "?view=email-text-v1", { headers });
  assert.equal(result.status, 200);
  body = await result.json();
  assert.equal(body.attachment.name, "brief.txt");
  assert.equal(body.retrieval.available, false);
  assert.equal(body.retrieval.reason, "attachment_bytes_not_retained");
  assert.ok(String(body.retrieval.detail).length > 0, "the reason stays human-readable");
  result = await fetch(base + "/no-such-attachment?view=email-text-v1", { headers });
  assert.equal(result.status, 404);
  body = await result.json();
  assert.equal(body.error.code, "inbox_attachment_not_found");
});

test("attachment metadata over HTTP: view, ownership, and auth boundaries", async t => {
  const f = fixture(t);
  const sourceId = f.importEmail("m-a");
  const origin = await serve(t, f), headers = f.sessionHeaders(), guest = f.guestHeaders();
  const base = origin + "/api/inbox/sources/" + encodeURIComponent(sourceId) + "/attachments";
  let result = await fetch(base, { headers });
  assert.equal(result.status, 404);
  let body = await result.json();
  assert.equal(body.error.code, "inbox_source_not_found", "channel attachments stay hidden without a reading view");
  result = await fetch(base + "?view=email-text-v1", { headers: guest });
  assert.equal(result.status, 404);
  body = await result.json();
  assert.equal(body.error.code, "inbox_source_not_found", "another account cannot enumerate the owner's attachments");
  result = await fetch(base + "/attachment-1%3D?view=email-text-v1", { headers: guest });
  assert.equal(result.status, 404);
  body = await result.json();
  assert.equal(body.error.code, "inbox_source_not_found", "another account cannot probe individual attachments either");
  result = await fetch(base + "?view=email-text-v1", {});
  assert.equal(result.status, 422);
  body = await result.json();
  assert.equal(body.error.code, "session_binding_required", "no session at all is rejected before any read");
  result = await fetch(base + "?view=email-text-v1",
    { headers: { ...headers, Cookie: "account_session=bogus-token" } });
  assert.equal(result.status, 401, "a forged session token gets no attachment metadata");
  result = await fetch(base + "?view=email-text-v1",
    { headers: { ...headers, Authorization: "Bearer room-key" } });
  assert.equal(result.status, 401);
  body = await result.json();
  assert.equal(body.error.code, "account_session_required");
  result = await fetch(base + "?view=email-text-v1", { headers: { Cookie: headers.Cookie } });
  assert.equal(result.status, 422);
  body = await result.json();
  assert.equal(body.error.code, "session_binding_required");
});
