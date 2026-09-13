import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";

function setup(t) {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const account = f.store.accountForMember("commons", "owner"), slot = f.store.createAccountSessionSlot();
  f.session = { token: slot.token, ...f.store.loginAccountSession(slot.token, f.store.issueAccountAccessKey(account.id), 0) };
  f.apply = r => f.store.inbox.apply(f.session.token, r, f.session.sessionBinding);
  f.apply({ action: "source.save", requestId: "source", sourceId: "source", expectedRevision: 0,
    data: { adapter: "synthetic", sender: "secret@example.test", recipient: "owner@example.test", subject: "Private subject", paragraphs: ["Selected private context", "Unselected secret"] } });
  f.request = () => ({ action: "source.grant", requestId: randomUUID(), sourceId: "source", sourceRevision: 1,
    roomId: "commons", audienceVersion: f.store.inbox.shareContext(f.session.token, "source", "commons", f.session.sessionBinding).audienceVersion,
    paragraphs: [0], memberIds: ["producer"] });
  f.read = (id, role = "producer") => f.store.inbox.readGrant(f.keys[role], "commons", id);
  return f;
}
test("private grants give only selected members the selected text, never a room event", t => {
  const f = setup(t), before = f.store.room("commons"), request = f.request(), granted = f.apply(request);
  const id = granted.receipt.grantId;
  assert.deepEqual(f.store.room("commons"), before);
  const value = f.read(id);
  assert.equal(value.body, "Shared sample excerpt\n\nSelected private context");
  assert.deepEqual(value.permissions, ["read"]);
  assert.doesNotMatch(JSON.stringify(value), /Unselected secret|secret@example|Private subject|sourceId/);
  assert.throws(() => f.read(id, "reviewer"), { status: 404 });
  assert.throws(() => f.read(id, "guest"), { status: 404 });
  assert.throws(() => f.read("missing"), { status: 404 });
  assert.equal(f.store.inbox.readGrant(f.session.token, "commons", id, f.session.sessionBinding).body, value.body);
  assert.equal(f.apply(request).duplicate, true);
  assert.throws(() => f.apply({ ...request, memberIds: ["reviewer"] }), { code: "idempotency_conflict" });
  assert.equal(f.store.inbox.verify().sources, 1);
  f.store.close(); f.store = new RoomStore(join(f.directory, "room.sqlite"));
  assert.equal(f.read(id).body, value.body);
  assert.equal(f.apply(request).duplicate, true);
});
test("private grants revoke durably; old create retries do not revive access", t => {
  const f = setup(t), request = f.request(), id = f.apply(request).receipt.grantId;
  const revoke = { action: "grant.revoke", requestId: randomUUID(), sourceId: "source", grantId: id };
  assert.equal(f.apply(revoke).receipt.revoked, true);
  assert.equal(f.apply(revoke).duplicate, true);
  assert.throws(() => f.read(id), { status: 404 });
  assert.equal(f.apply(request).duplicate, true);
  assert.throws(() => f.read(id), { status: 404 });
  assert.throws(() => f.apply({ ...revoke, requestId: randomUUID() }), { code: "inbox_grant_revoked" });
  assert.equal(f.store.inbox.verify().sources, 1);
  f.store.close(); f.store = new RoomStore(join(f.directory, "room.sqlite"));
  assert.throws(() => f.read(id), { status: 404 });
});
test("membership changes, new members and expired grants cannot inherit private context", t => {
  const f = setup(t), id = f.apply(f.request()).receipt.grantId;
  f.store.command(f.keys.owner, "commons", { id: randomUUID(), type: "member.added", data: { memberId: "later", displayName: "Later", kind: "agent", permissions: [] } });
  const later = f.store.issueAccessKey("commons", "later");
  assert.throws(() => f.store.inbox.readGrant(later, "commons", id), { status: 404 });
  f.store.command(f.keys.owner, "commons", { id: randomUUID(), type: "member.access_changed", data: {
    memberId: "producer", expectedMemberRevision: 0, active: true, permissions: [] } });
  assert.throws(() => f.read(id), { status: 404 });
  const fresh = f.apply(f.request()).receipt;
  assert.ok(f.read(fresh.grantId));
  const now = f.store.now; f.store.now = () => fresh.expiresAt;
  try {
    const currentKey = f.store.issueAccessKey("commons", "producer");
    assert.throws(() => f.store.inbox.readGrant(currentKey, "commons", fresh.grantId), { status: 404 });
  }
  finally { f.store.now = now; }
  assert.equal(f.store.inbox.verify().sources, 1);
});
test("private grant validation rejects stale source, audience and invalid selections", t => {
  const f = setup(t), request = f.request(), before = f.store.room("commons");
  for (const override of [{ memberIds: [] }, { memberIds: ["producer", "producer"] }, { memberIds: Array(21).fill("producer") }, { paragraphs: [1, 9] }, { body: "injected" }])
    assert.throws(() => f.apply({ ...request, ...override }), { status: 422 });
  assert.throws(() => f.apply({ ...request, sourceRevision: 2 }), { code: "stale_inbox_source" });
  assert.throws(() => f.apply({ ...request, audienceVersion: "0".repeat(64) }), { code: "stale_inbox_audience" });
  assert.throws(() => f.apply({ ...request, memberIds: ["missing"] }), { code: "stale_inbox_audience" });
  assert.deepEqual(f.store.room("commons"), before);
});
test("HTTP private context is recipient-only, no-store and revoked immediately", async t => {
  const f = setup(t), server = createRoomServer({ store: f.store });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const origin = "http://127.0.0.1:" + server.address().port;
  const headers = { Cookie: "account_session=" + f.session.token, "X-Session-Binding": f.session.sessionBinding,
    "X-CSRF-Token": f.session.csrf, Origin: origin, "Content-Type": "application/json" };
  const request = f.request();
  let response = await fetch(origin + "/api/inbox/commands", { method: "POST", headers, body: JSON.stringify(request) });
  assert.equal(response.status, 201); const id = (await response.json()).receipt.grantId;
  const url = origin + "/api/rooms/commons/private-context/" + id;
  response = await fetch(url, { headers: { Authorization: "Bearer " + f.keys.producer } });
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json()).permissions[0], "read");
  response = await fetch(url, { headers: { Authorization: "Bearer " + f.keys.reviewer } }); assert.equal(response.status, 404);
  response = await fetch(origin + "/api/inbox/commands", { method: "POST", headers, body: JSON.stringify({ action: "grant.revoke", requestId: randomUUID(), sourceId: "source", grantId: id }) });
  assert.equal(response.status, 201);
  response = await fetch(url, { headers: { Authorization: "Bearer " + f.keys.producer } }); assert.equal(response.status, 404);
});
test("a selected human can read but cannot revoke the owner's grant", t => {
  const f = setup(t), id = f.apply({ ...f.request(), memberIds: ["guest"] }).receipt.grantId;
  const account = f.store.accountForMember("commons", "guest"), slot = f.store.createAccountSessionSlot();
  const session = f.store.loginAccountSession(slot.token, f.store.issueAccountAccessKey(account.id), 0);
  assert.ok(f.store.inbox.readGrant(slot.token, "commons", id, session.sessionBinding));
  assert.throws(() => f.store.inbox.apply(slot.token, { action: "grant.revoke", requestId: randomUUID(), sourceId: "source", grantId: id }, session.sessionBinding), { status: 404 });
  assert.throws(() => f.read(id), { status: 404 });
  f.store.changeAccountAccess(f.session.account.id, { expectedRevision: 0, active: false, reason: "Revoke owner" });
  assert.throws(() => f.store.inbox.readGrant(slot.token, "commons", id, session.sessionBinding), { status: 404 });
  f.store.changeAccountAccess(f.session.account.id, { expectedRevision: 1, active: true, reason: "Restore owner" });
  assert.throws(() => f.store.inbox.readGrant(slot.token, "commons", id, session.sessionBinding), { status: 404 });
});
test("failed private grant journaling rolls back and never publishes the excerpt", t => {
  const f = setup(t), before = f.store.room("commons"), request = f.request();
  f.store.db.exec("CREATE TRIGGER reject_grant BEFORE INSERT ON private_inbox_commands WHEN json_extract(NEW.request_json,'$.action')='source.grant' BEGIN SELECT RAISE(ABORT,'injected failure'); END");
  assert.throws(() => f.apply(request), /injected failure/);
  assert.deepEqual(f.store.room("commons"), before);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM private_inbox_commands WHERE request_id=?").get(request.requestId).n, 0);
  f.store.db.exec("DROP TRIGGER reject_grant");
  assert.equal(f.apply(request).duplicate, false);
});
