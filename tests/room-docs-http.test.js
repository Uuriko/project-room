import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { writeDoc } from "../server/room-docs.mjs";

async function fixture(t) {
  const old = process.env.ROOM_DOCS;
  process.env.ROOM_DOCS = "1";
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store, roomDocsEnabled: true });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); f.store.close();
    if (old === undefined) delete process.env.ROOM_DOCS; else process.env.ROOM_DOCS = old;
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, secret, body) => {
    const res = await fetch(origin + path, { method: body === undefined ? "GET" : "POST",
      headers: { ...(secret ? { authorization: `Bearer ${secret}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, data: await res.json() };
  };
  const owner = f.store.identities.create("Docs owner");
  const stranger = f.store.identities.create("Docs stranger");
  for (const roomId of ["docs-a", "docs-b"]) {
    const made = await call("/api/agent-rooms", owner.secret, { roomId, title: roomId, purpose: "Docs test", kind: "personal", displayName: "Owner" });
    assert.equal(made.status, 201);
  }
  return { ...f, call, owner, stranger };
}

test("real HTTP document access, room isolation, scopes and stale write protection", async t => {
  const { store, call, owner, stranger } = await fixture(t);
  const path = "/api/rooms/docs-a/docs/spec";
  assert.equal((await call(path)).status, 401);
  assert.equal((await call(path, stranger.secret)).status, 403);
  assert.equal((await call(path, owner.secret, { title: "A", body: "private A", baseRev: 0 })).status, 201);
  assert.equal((await call("/api/rooms/docs-b/docs/spec", owner.secret)).status, 404);
  assert.equal((await call("/api/rooms/docs-b/docs/spec?rev=1", owner.secret)).status, 404);
  assert.deepEqual((await call("/api/rooms/docs-b/docs", owner.secret)).data.docs, []);
  const denied = await call(path, stranger.secret);
  assert.equal(denied.status, 403); assert.equal(denied.data.error.code, "no_access"); assert.ok(!JSON.stringify(denied.data).includes("private A"));
  const key = await call("/api/agent-keys", owner.secret, { scopes: ["rooms:read"] });
  assert.equal(key.status, 201);
  const token = key.data.credential;
  assert.ok(token);
  assert.equal((await call(path, token)).status, 200);
  assert.equal((await call(path, token, { title: "Bad", body: "clobber", baseRev: 1 })).status, 403);
  assert.equal((await call("/api/access-requests", stranger.secret, { roomId: "docs-a", identityId: stranger.identityId, displayName: "Reader", requestedPermissions: ["accept_work"], note: null, requestId: "docs-reader" })).status, 201);
  assert.equal((await call("/api/rooms/docs-a/access-requests/docs-reader/decide", owner.secret, { decision: "approve", permissions: ["accept_work"], note: null })).status, 200);
  assert.equal((await call(path, stranger.secret)).status, 200);
  store.identities.unlink(owner.secret, "docs-a", stranger.identityId);
  for (const selected of [path, path + "?rev=1", "/api/rooms/docs-a/docs"]) {
    const revoked = await call(selected, stranger.secret);
    assert.equal(revoked.status, 403); assert.equal(revoked.data.error.code, "no_access");
    assert.ok(!JSON.stringify(revoked.data).includes("private A"));
  }
  const results = await Promise.all(["first", "second"].map(body => call(path, owner.secret, { title: "A", body, baseRev: 1 })));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  const current = await call(path, owner.secret);
  assert.equal(current.data.doc.rev, 2);
  assert.equal((await call(path + "?rev=1", owner.secret)).data.doc.body, "private A");
  assert.equal((await call(path + "?rev=3", owner.secret)).status, 404);
});

test("real HTTP traverses 501 documents without silent truncation or update reordering", async t => {
  const { store, call, owner } = await fixture(t);
  for (let i = 0; i < 501; i++) writeDoc(store, { roomId: "docs-a", docId: `doc-${String(i).padStart(4, "0")}`, title: "Doc", body: "not in list", baseRev: 0, author: "fixture", now: i });
  const first = await call("/api/rooms/docs-a/docs?limit=500", owner.secret);
  assert.equal(first.status, 200); assert.equal(first.data.docs.length, 500); assert.equal(first.data.hasMore, true);
  assert.equal(first.data.nextAfter, "doc-0499"); assert.ok(first.data.docs.every(d => !Object.hasOwn(d, "body")));
  writeDoc(store, { roomId: "docs-a", docId: "doc-0000", title: "Edited", body: "edit", baseRev: 1, author: "fixture" });
  const last = await call(`/api/rooms/docs-a/docs?limit=500&after=${first.data.nextAfter}`, owner.secret);
  assert.deepEqual(last.data.docs.map(d => d.docId), ["doc-0500"]); assert.equal(last.data.hasMore, false); assert.equal(last.data.nextAfter, null);
  const other = await call(`/api/rooms/docs-b/docs?after=${first.data.nextAfter}`, owner.secret);
  assert.deepEqual(other.data.docs, []);
  for (const query of ["limit=0", "limit=501", "limit=no", "after=BAD", "limit=1&limit=2", "unknown=x"]) assert.equal((await call(`/api/rooms/docs-a/docs?${query}`, owner.secret)).status, 422, query);
});

test("archived room documents remain readable but create and update are refused", async t => {
  const { store, call, owner } = await fixture(t);
  const path = "/api/rooms/docs-a/docs/spec";
  assert.equal((await call(path, owner.secret, { title: "Spec", body: "retained", baseRev: 0 })).status, 201);
  const archived = await call("/api/rooms/docs-a/commands", owner.secret, { id: "archive-docs-room", type: "room.archived", data: {} });
  assert.equal(archived.status, 201);
  for (const [selected, baseRev] of [[path, 1], ["/api/rooms/docs-a/docs/new", 0]]) {
    const denied = await call(selected, owner.secret, { title: "Bad", body: "no", baseRev });
    assert.equal(denied.status, 409); assert.equal(denied.data.error.code, "room_archived");
  }
  assert.equal((await call(path, owner.secret)).data.doc.rev, 1);
  assert.equal(store.db.prepare("SELECT count(*) n FROM room_doc_revisions WHERE room_id=?").get("docs-a").n, 1);
});
