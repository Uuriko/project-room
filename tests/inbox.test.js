import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { auditRecovery } from "../server/recovery.mjs";
import { backupRoom } from "../server/backup.mjs";

const data = { adapter: "synthetic", sender: "maya@example.test", recipient: "you@example.test", subject: "Private launch",
  paragraphs: ["Please draft a friendly launch note.", "Private budget: 4200."] };
function fixture(t) {
  const f = createAcceptanceFixture(); f.filename = join(f.directory, "room.sqlite");
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  f.sessions = {};
  for (const role of ["owner", "guest"]) {
    const account = f.store.accountForMember("commons", role), key = f.store.issueAccountAccessKey(account.id), slot = f.store.createAccountSessionSlot();
    f.sessions[role] = { token: slot.token, ...f.store.loginAccountSession(slot.token, key, 0), key };
  }
  f.save = (request, role = "owner") => f.store.inbox.apply(f.sessions[role].token, request, f.sessions[role].sessionBinding);
  f.read = (role = "owner", id = "source") => f.store.inbox.read(f.sessions[role].token, id, f.sessions[role].sessionBinding);
  f.source = (extra = {}) => ({ action: "source.save", requestId: randomUUID(), sourceId: "source", expectedRevision: 0, data: structuredClone(data), ...extra });
  f.context = () => f.store.inbox.shareContext(f.sessions.owner.token, "source", "commons", f.sessions.owner.sessionBinding);
  f.share = (extra = {}) => { const c = f.context(); return { action: "source.share", requestId: randomUUID(), sourceId: "source", sourceRevision: c.sourceRevision, roomId: "commons", audienceVersion: c.audienceVersion, paragraphs: [0], ...extra }; };
  f.command = (type, payload) => f.store.command(f.keys.owner, "commons", { id: randomUUID(), type, data: payload });
  return f;
}
test("private inbox belongs to accounts, not room membership or agent credentials", t => {
  const f = fixture(t), before = f.store.snapshot(f.keys.owner, "commons");
  f.save(f.source());
  assert.throws(() => f.read("guest"), { status: 404, code: "inbox_source_not_found" });
  assert.equal(f.store.inbox.list(f.sessions.guest.token, f.sessions.guest.sessionBinding).sources.length, 0);
  for (const role of ["owner", "guest", "producer", "reviewer"]) {
    assert.throws(() => f.store.inbox.list(f.keys[role], f.sessions.owner.sessionBinding), { status: 401 });
  }
  f.save(f.source({ data: { ...data, subject: "Guest's separate source" } }), "guest");
  assert.equal(f.read("guest").source.subject, "Guest's separate source");
  assert.equal(f.read().source.subject, "Private launch");
  assert.deepEqual(f.store.snapshot(f.keys.owner, "commons"), before);
  assert.equal(f.store.inbox.verify().sources, 2);
});
test("private drafts pin source and draft revisions; exact retries survive replacement and restart", t => {
  const f = fixture(t), first = f.source(); f.save(first);
  const draft = { action: "draft.save", requestId: "draft", sourceId: "source", sourceRevision: 1, expectedRevision: 0, body: "Private reply\n" };
  const saved = f.save(draft);
  const second = new RoomStore(f.filename);
  try {
    assert.throws(() => second.inbox.apply(f.sessions.owner.token, { ...draft, requestId: "racing", body: "Different" }, f.sessions.owner.sessionBinding), { code: "stale_inbox_draft" });
  } finally { second.close(); }
  f.save(f.source({ expectedRevision: 1, data: { ...data, paragraphs: ["Changed request", "Still private"] } }));
  assert.equal(f.read().draft.sourceRevision, 1); assert.equal(f.read().draft.body, "Private reply\n");
  assert.throws(() => f.save({ ...draft, requestId: "stale", expectedRevision: 1 }), { code: "stale_inbox_source" });
  assert.throws(() => f.save({ ...draft, body: "Different" }), { code: "idempotency_conflict" });
  f.store.close(); f.store = new RoomStore(f.filename);
  assert.equal(f.save(draft).duplicate, true); assert.deepEqual(f.save(draft).receipt, saved.receipt);
  assert.equal(f.save(first).duplicate, true); assert.equal(f.read().source.revision, 2);
  f.save({ ...draft, requestId: "reviewed", sourceRevision: 2, expectedRevision: 1, body: "" });
  assert.equal(f.read().draft.revision, 2); assert.equal(f.read().draft.body, "");
  assert.equal(auditRecovery(f.store).schemaVersion, 22);
});
test("sharing posts only selected text through the existing room command, with one durable receipt", t => {
  const f = fixture(t); f.save(f.source()); const before = f.store.room("commons"), request = f.share();
  const result = f.save(request), message = f.store.room("commons").state.messages.find(m => m.id === result.receipt.messageId);
  assert.equal(message.body, "Shared sample excerpt\n\n" + data.paragraphs[0]);
  assert.equal(message.authorId, "owner"); assert.equal(message.workItemId, null);
  assert.equal(f.store.room("commons").sequence, before.sequence + 1);
  const publicView = JSON.stringify(f.store.snapshot(f.keys.producer, "commons"));
  for (const privateText of ["4200", "maya@example.test", "Private launch"]) assert.equal(publicView.includes(privateText), false);
  f.save(f.source({ expectedRevision: 1, data: { ...data, paragraphs: ["New private follow-up"] } }));
  const retry = f.save(request); assert.equal(retry.duplicate, true); assert.deepEqual(retry.receipt, result.receipt);
  assert.equal(f.store.room("commons").sequence, before.sequence + 1);
  assert.equal(f.store.inbox.verify().versions, 2);
});
test("sharing refuses changed audience and source without posting or consuming a request", t => {
  const f = fixture(t); f.save(f.source()); const request = f.share();
  f.command("member.added", { memberId: "new-person", displayName: "New person", kind: "human", permissions: [] });
  const before = f.store.room("commons");
  assert.throws(() => f.save(request), { code: "stale_inbox_audience" }); assert.deepEqual(f.store.room("commons"), before);
  const updated = f.share({ requestId: request.requestId });
  f.save(f.source({ expectedRevision: 1 }));
  assert.throws(() => f.save(updated), { code: "stale_inbox_source" });
  const ready = f.share({ requestId: request.requestId });
  assert.equal(f.save(ready).duplicate, false);
});
test("private-share journal failure rolls back the canonical room post as well", t => {
  const f = fixture(t); f.save(f.source()); const before = f.store.room("commons"), request = f.share();
  f.store.db.exec("CREATE TRIGGER inbox_test_failure BEFORE INSERT ON private_inbox_commands BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END");
  assert.throws(() => f.save(request), /synthetic receipt failure/);
  assert.deepEqual(f.store.room("commons"), before);
  f.store.db.exec("DROP TRIGGER inbox_test_failure");
  assert.equal(f.save(request).duplicate, false); assert.equal(f.save(request).duplicate, true);
});
test("session changes and account revocation stop private access, including exact retries", t => {
  const f = fixture(t), request = f.source(); f.save(request);
  const old = f.sessions.owner;
  f.store.logoutAccountSession(old.token, old.sessionRevision);
  assert.throws(() => f.read(), { status: 401 });
  const logged = f.store.loginAccountSession(old.token, old.key, old.sessionRevision + 1);
  assert.throws(() => f.read(), { code: "session_binding_changed" });
  f.sessions.owner = { ...old, ...logged };
  assert.equal(f.save(request).duplicate, true);
  f.store.changeAccountAccess(old.account.id, { expectedRevision: 0, active: false, reason: "End access" });
  assert.throws(() => f.save(request), { status: 401 });
});
test("private inbox validation is bounded and provider configuration is not accepted", t => {
  const f = fixture(t);
  for (const change of [{ accountId: "guest" }, { data: { ...data, adapter: "gmail" } }, { data: { ...data, paragraphs: ["x".repeat(4001)] } },
    { data: { ...data, paragraphs: ["\ud800"] } }, { expectedRevision: -1 }]) assert.throws(() => f.save(f.source(change)), { status: 422 });
  f.save(f.source());
  for (const indexes of [[], [0, 0], [20], [1, 2], [-1]]) assert.throws(() => f.save(f.share({ paragraphs: indexes })), { status: 422 });
  assert.equal(f.store.inbox.verify().sources, 1);
});
test("private source and draft recovery preserves exact content and shared-message references", async t => {
  const f = fixture(t); f.save(f.source());
  f.save({ action: "draft.save", requestId: "draft", sourceId: "source", sourceRevision: 1, expectedRevision: 0, body: "Keep this private" });
  const shared = f.save(f.share()), backup = await backupRoom(f.filename, f.directory);
  const copy = new RoomStore(backup.filename, { readOnly: true });
  try {
    assert.deepEqual(copy.inbox.read(f.sessions.owner.token, "source", f.sessions.owner.sessionBinding), f.read());
    assert.ok(copy.room("commons").state.messages.some(m => m.id === shared.receipt.messageId));
    assert.equal(copy.inbox.verify().drafts, 1);
  } finally { copy.close(); }
  f.store.db.prepare("UPDATE private_inbox_drafts SET body=? WHERE source_id=?").run("Unjournaled change", "source");
  assert.throws(() => f.store.inbox.verify(), /reconciliation/);
  f.store.close(); assert.throws(() => new RoomStore(f.filename), /reconciliation/);
  // The deliberate test corruption leaves this handle closed; teardown is idempotent.
  f.store = { close() {} };
});
test("HTTP inbox reads and writes require the current account cookie, binding and write confirmation", async t => {
  const f = fixture(t), server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = "http://127.0.0.1:" + server.address().port, owner = f.sessions.owner, guest = f.sessions.guest;
  const headers = auth => ({ Cookie: "account_session=" + auth.token, "X-Session-Binding": auth.sessionBinding });
  let response = await fetch(origin + "/api/inbox", { headers: { Authorization: "Bearer " + f.keys.owner } });
  assert.equal(response.status, 401);
  response = await fetch(origin + "/api/inbox/commands", { method: "POST", headers: { ...headers(owner), Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(f.source()) });
  assert.equal(response.status, 403);
  const command = f.source();
  response = await fetch(origin + "/api/inbox/commands", { method: "POST", headers: { ...headers(owner), Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": owner.csrf }, body: JSON.stringify(command) });
  assert.equal(response.status, 201, await response.text());
  response = await fetch(origin + "/api/inbox/sources/source", { headers: headers(guest) }); assert.equal(response.status, 404);
  response = await fetch(origin + "/api/inbox/sources/source", { headers: headers(owner) });
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json()).source.paragraphs[1], data.paragraphs[1]);
  response = await fetch(origin + "/api/inbox/sources/source/share-context?roomId=commons", { headers: headers(owner) });
  assert.equal(response.status, 200); assert.deepEqual((await response.json()).audience, f.context().audience);
});
