import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { SyntheticMailFixture } from "../scripts/synthetic-mail-fixture.mjs";
import { SyntheticInboxTransport } from "../server/inbox-transport.mjs";
import { RoomStore } from "../server/store.mjs";
import { auditRecovery } from "../server/recovery.mjs";
import { backupRoom } from "../server/backup.mjs";
import { createRoomServer } from "../server/http.mjs";

function setup(t) {
  const f = createAcceptanceFixture();
  f.filename = join(f.directory, "room.sqlite");
  f.providerFile = join(f.directory, "mail.sqlite");
  f.provider = new SyntheticMailFixture(f.providerFile);
  t.after(() => { f.provider.close(); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const key = f.store.issueAccountAccessKey(f.store.accountForMember("commons", "owner").id), slot = f.store.createAccountSessionSlot();
  f.token = slot.token; f.session = f.store.loginAccountSession(slot.token, key, 0);
  f.apply = request => f.store.inbox.apply(f.token, request, f.session.sessionBinding);
  f.transport = request => f.store.inbox.transport(f.token, request, f.session.sessionBinding);
  f.read = () => f.store.inbox.sends(f.token, "note", f.session.sessionBinding).sends;
  f.sourceData = { adapter: "synthetic", sender: "maya@example.test", recipient: "you@example.test", subject: "Launch",
    paragraphs: ["A quieter launch?", "Private detail"] };
  f.apply({ action: "source.save", requestId: "source", sourceId: "note", expectedRevision: 0, data: f.sourceData });
  f.apply({ action: "draft.save", requestId: "draft", sourceId: "note", expectedRevision: 0, sourceRevision: 1, body: "Sounds good. 🪷\n" });
  f.reserve = (extra = {}) => {
    const p = f.store.inbox.sendContext(f.token, "note", f.session.sessionBinding).preview;
    return { action: "send.reserve", requestId: randomUUID(), sourceId: "note",
      sourceRevision: p.sourceRevision, draftRevision: p.draftRevision, previewVersion: p.previewVersion, ...extra };
  };
  f.driver = () => new SyntheticInboxTransport(f.store.inbox, f.provider);
  f.run = id => f.driver().dispatch(f.token, "note", id, f.session.sessionBinding);
  f.check = id => f.driver().reconcile(f.token, "note", id, f.session.sessionBinding);
  f.command = (action, send, extra = {}) => ({ action, requestId: randomUUID(), sourceId: "note", sendId: send.id, expectedRevision: send.revision, ...extra });
  return f;
}
test("saved private reply reserves an exact envelope; admission does not dispatch or change the draft/room", t => {
  const f = setup(t), before = f.store.snapshot(f.keys.producer, "commons"), request = f.reserve();
  const reserved = f.apply(request);
  assert.equal(reserved.receipt.send.status, "queued");
  assert.equal(reserved.receipt.send.envelope.from, "you@example.test");
  assert.deepEqual(reserved.receipt.send.envelope.to, ["maya@example.test"]);
  assert.equal(reserved.receipt.send.envelope.body, "Sounds good. 🪷\n");
  assert.equal(f.provider.count(), 0);
  assert.deepEqual(f.store.snapshot(f.keys.producer, "commons"), before);
  assert.equal(f.store.inbox.read(f.token, "note", f.session.sessionBinding).draft.revision, 1);
  assert.equal(f.apply(request).duplicate, true);
  assert.throws(() => f.apply({ ...request, draftRevision: 2 }), { code: "idempotency_conflict" });
  assert.throws(() => f.apply(f.reserve()), { code: "inbox_send_unresolved" });
  assert.throws(() => f.store.inbox.sends(f.keys.producer, "note", f.session.sessionBinding), { status: 401 });
  assert.doesNotThrow(() => auditRecovery(f.store));
});
test("changed source, saved draft or authority prevents dispatch; queued cancellation survives those changes", async t => {
  for (const change of ["source", "draft", "authority"]) {
    await t.test(change, async t => {
      const f = setup(t), request = f.reserve(); f.apply(request);
      if (change === "source") f.apply({ action: "source.save", requestId: "new-source", sourceId: "note", expectedRevision: 1, data: { ...f.sourceData, sender: "other@example.test" } });
      if (change === "draft") f.apply({ action: "draft.save", requestId: "new-draft", sourceId: "note", expectedRevision: 1, sourceRevision: 1, body: "Different reply" });
      if (change === "authority") {
        const id = f.session.account.id;
        f.store.changeAccountAccess(id, { expectedRevision: 0, active: false, reason: "Synthetic revoke" });
        await assert.rejects(f.run(request.requestId), { status: 401 });
        f.store.changeAccountAccess(id, { expectedRevision: 1, active: true, reason: "Synthetic restore" });
        const key = f.store.issueAccountAccessKey(id), slot = f.store.createAccountSessionSlot();
        f.token = slot.token; f.session = f.store.loginAccountSession(slot.token, key, 0);
      }
      await assert.rejects(f.run(request.requestId), { code: "stale_inbox_reply" });
      assert.equal(f.provider.submits, 0);
      f.apply(f.command("send.cancel", f.read()[0]));
      assert.equal(f.read()[0].status, "cancelled");
      assert.doesNotThrow(() => auditRecovery(f.store));
    });
  }
});
test("one dispatch survives lost acknowledgement and both databases restarting; lookup never resends", async t => {
  const f = setup(t), request = f.reserve(); f.apply(request); f.provider.mode = "after";
  assert.equal((await f.run(request.requestId)).status, "unknown");
  assert.equal(f.provider.count(), 1);
  assert.equal((await f.run(request.requestId)).status, "unknown");
  assert.equal(f.provider.submits, 1);
  assert.throws(() => f.apply(f.command("send.cancel", f.read()[0])), { code: "inbox_send_started" });
  assert.throws(() => f.apply(f.reserve()), { code: "inbox_send_unresolved" });
  f.store.close(); f.provider.close();
  f.store = new RoomStore(f.filename); f.provider = new SyntheticMailFixture(f.providerFile);
  const accepted = await f.check(request.requestId);
  assert.equal(accepted.status, "accepted"); assert.equal(f.provider.submits, 0);
  f.provider.outcome(f.driver().correlation(accepted), "delivered");
  assert.equal((await f.check(request.requestId)).status, "delivered");
  assert.equal(f.provider.submits, 0); assert.equal(f.provider.count(), 1);
  assert.throws(() => f.apply(f.reserve()), { code: "inbox_reply_already_sent" });
  assert.equal(f.apply(request).receipt.send.status, "queued", "original receipt remains exact; status is a separate current read");
  const backup = await backupRoom(f.filename, f.directory);
  const restored = new RoomStore(backup.filename, { readOnly: true });
  try { assert.deepEqual(auditRecovery(restored), auditRecovery(f.store)); } finally { restored.close(); }
});
test("a crash before the provider call and an unavailable provider remain unknown, not definitely unsent", async t => {
  const f = setup(t), request = f.reserve(); f.apply(request);
  f.transport(f.command("send.dispatch", f.read()[0]));
  assert.equal((await f.check(request.requestId)).status, "unknown");
  assert.equal((await f.run(request.requestId)).status, "unknown");
  assert.equal(f.provider.submits, 0); assert.equal(f.provider.count(), 0);
  assert.doesNotThrow(() => auditRecovery(f.store));
});
test("provider unavailability does not cause repeated submit calls", async t => {
  const f = setup(t), request = f.reserve(); f.apply(request); f.provider.mode = "before";
  assert.equal((await f.run(request.requestId)).status, "unknown");
  assert.equal((await f.check(request.requestId)).status, "unknown");
  assert.equal((await f.run(request.requestId)).status, "unknown");
  assert.equal(f.provider.submits, 1); assert.equal(f.provider.count(), 0);
});
test("concurrent workers and observation ordering preserve one submission and monotonic delivery", async t => {
  const f = setup(t), request = f.reserve(); f.apply(request);
  const [a, b] = await Promise.all([f.run(request.requestId), f.run(request.requestId)]);
  assert.ok([a.status, b.status].includes("accepted")); assert.equal(f.provider.submits, 1);
  const accepted = f.read()[0];
  assert.throws(() => f.apply(f.command("send.observe", accepted, { outcome: "delivered", providerId: accepted.providerId })), { status: 403 });
  const delivered = f.transport(f.command("send.observe", accepted, { outcome: "delivered", providerId: accepted.providerId })).receipt.send;
  assert.throws(() => f.transport(f.command("send.observe", delivered, { outcome: "accepted", providerId: delivered.providerId })), { code: "conflicting_inbox_observation" });
  assert.throws(() => f.transport(f.command("send.observe", delivered, { outcome: "delivered", providerId: "different" })), { code: "conflicting_inbox_observation" });
  assert.equal(f.read()[0].status, "delivered");
  assert.doesNotThrow(() => auditRecovery(f.store));
});
test("rejection allows deliberate re-reservation; accepted then bounced is not labelled never submitted", async t => {
  const f = setup(t), request = f.reserve(); f.apply(request); f.provider.mode = "rejected";
  assert.equal((await f.run(request.requestId)).status, "rejected");
  const retry = f.reserve(); f.apply(retry); f.provider.mode = "accepted";
  const accepted = await f.run(retry.requestId);
  f.provider.outcome(f.driver().correlation(accepted), "bounced");
  assert.equal((await f.check(retry.requestId)).status, "bounced");
  assert.equal(f.provider.submits, 2);
  assert.throws(() => f.apply(f.reserve()), { code: "inbox_reply_already_sent" });
  assert.doesNotThrow(() => auditRecovery(f.store));
});
test("uncorrelated adapter evidence never marks an unknown attempt accepted", async t => {
  const f = setup(t), request = f.reserve(); f.apply(request);
  f.provider.submit = async () => ({ outcome: "accepted", operationId: "other", previewVersion: "wrong", providerId: "other" });
  assert.equal((await f.run(request.requestId)).status, "unknown");
  assert.doesNotThrow(() => auditRecovery(f.store));
});
test("HTTP callers may review, reserve and cancel but cannot forge dispatch or delivery", async t => {
  const f = setup(t), server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = "http://127.0.0.1:" + server.address().port;
  const headers = { Cookie: "account_session=" + f.token, "X-Session-Binding": f.session.sessionBinding };
  const write = (command, csrf = f.session.csrf) => fetch(origin + "/api/inbox/commands", { method: "POST",
    headers: { ...headers, Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify(command) });
  let response = await fetch(origin + "/api/inbox/sources/note/send-context", { headers });
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  const preview = (await response.json()).preview; assert.deepEqual(preview.to, ["maya@example.test"]);
  const request = f.reserve();
  assert.equal((await write(request, "wrong")).status, 403);
  response = await write(request); assert.equal(response.status, 201);
  const send = (await response.json()).receipt.send;
  assert.equal((await write(f.command("send.dispatch", send))).status, 403);
  assert.equal((await write(f.command("send.observe", send, { outcome: "delivered", providerId: "fake" }))).status, 403);
  response = await fetch(origin + "/api/inbox/sources/note/sends", { headers });
  assert.equal(response.status, 200); assert.equal((await response.json()).sends[0].status, "queued");
  assert.equal((await write(f.command("send.cancel", send))).status, 201);
  assert.equal(f.provider.count(), 0);
  const other = f.store.createAccountSessionSlot();
  const key = f.store.issueAccountAccessKey(f.store.accountForMember("commons", "guest").id);
  const guest = f.store.loginAccountSession(other.token, key, 0);
  response = await fetch(origin + "/api/inbox/sources/note/sends", { headers: { Cookie: "account_session=" + other.token, "X-Session-Binding": guest.sessionBinding } });
  assert.equal(response.status, 404);
});
test("unchanged provider acceptance does not grow the journal on every status check", async t => {
  const f = setup(t), request = f.reserve(); f.apply(request); await f.run(request.requestId);
  const before = f.store.db.prepare("SELECT count(*) n FROM private_inbox_commands").get().n;
  await f.check(request.requestId); await f.check(request.requestId);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM private_inbox_commands").get().n, before);
});
test("full pilot capacity never prevents settling an already reserved reply", async t => {
  const f = setup(t);
  for (let revision = 1; revision < 4998; revision++) f.apply({ action: "draft.save", requestId: "capacity-" + revision,
    sourceId: "note", sourceRevision: 1, expectedRevision: revision, body: "Final capacity reply" });
  const request = f.reserve(); f.apply(request);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM private_inbox_commands").get().n, 5000);
  assert.equal((await f.run(request.requestId)).status, "accepted");
  assert.doesNotThrow(() => auditRecovery(f.store));
});
test("late account revocation retains unknown status and a new authorized session reconciles without another submission", async t => {
  const f = setup(t), request = f.reserve(); f.apply(request);
  const original = f.provider.submit.bind(f.provider), accountId = f.session.account.id;
  f.provider.submit = async envelope => {
    const receipt = await original(envelope);
    f.store.changeAccountAccess(accountId, { expectedRevision: 0, active: false, reason: "Synthetic late revoke" });
    return receipt;
  };
  await assert.rejects(f.run(request.requestId), { status: 401 });
  assert.equal(f.provider.count(), 1);
  f.store.changeAccountAccess(accountId, { expectedRevision: 1, active: true, reason: "Synthetic restore" });
  const key = f.store.issueAccountAccessKey(accountId), slot = f.store.createAccountSessionSlot();
  f.token = slot.token; f.session = f.store.loginAccountSession(slot.token, key, 0);
  assert.equal(f.read()[0].status, "unknown");
  assert.equal((await f.check(request.requestId)).status, "accepted");
  assert.equal(f.provider.submits, 1);
  assert.doesNotThrow(() => auditRecovery(f.store));
});
test("optional loopback simulation endpoint uses the existing intent and never accepts claimed outcomes", async t => {
  const f = setup(t), driver = f.driver();
  assert.throws(() => createRoomServer({ store: f.store, origin: "https://example.test", trustedLocalProxy: true, syntheticInboxTransport: driver }), /loopback/);
  const server = createRoomServer({ store: f.store, syntheticInboxTransport: driver });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = "http://127.0.0.1:" + server.address().port;
  const request = f.reserve(); f.apply(request);
  const dispatch = { action: "dispatch", sourceId: "note", sendId: request.requestId };
  const call = (data, csrf = f.session.csrf) => fetch(origin + "/api/inbox/simulation", { method: "POST",
    headers: { Cookie: "account_session=" + f.token, "X-Session-Binding": f.session.sessionBinding, Origin: origin,
      "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify(data) });
  assert.equal((await call(dispatch, "wrong")).status, 403);
  assert.equal((await call({ ...dispatch, outcome: "delivered" })).status, 422);
  f.provider.mode = "after";
  let response = await call(dispatch); assert.equal(response.status, 200); assert.equal((await response.json()).send.status, "unknown");
  response = await call(dispatch); assert.equal(response.status, 200); assert.equal(f.provider.submits, 1);
  response = await call({ ...dispatch, action: "reconcile" }); assert.equal(response.status, 200); assert.equal((await response.json()).send.status, "accepted");
  assert.equal(f.provider.submits, 1);
});
