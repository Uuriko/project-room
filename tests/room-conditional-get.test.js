import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { ensureRoomReadVersionSchema, readSnapshotHead, snapshotValidator } from "../server/conditional-get.mjs";

// RR-D5 conditional GET for GET /api/rooms/{roomId}.
// Failing-first property: a repeat read whose room has not changed must be
// answerable from a cheap validator head — the second request carries the
// ETag back as If-None-Match and gets a 304 with no payload, and the
// validator check must never load the room projection.

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-conditional-get-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: randomUUID(), type: "member.added",
    data: { memberId: "alice", displayName: "Alice", kind: "agent", permissions: ["steer", "accept_work"] } });
  const aliceKey = store.issueAccessKey("commons", "alice");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, origin: `http://127.0.0.1:${server.address().port}`, ownerKey, aliceKey };
}

async function get(origin, path, token, headers = {}) {
  const res = await fetch(`${origin}${path}`, {
    headers: { Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }
  });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

const postMessage = (origin, token, body) => fetch(`${origin}/api/rooms/commons/commands`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: origin, Authorization: `Bearer ${token}` },
  body: JSON.stringify({ id: randomUUID(), type: "message.posted", data: { body } })
});

test("repeat snapshot read with an unchanged room answers 304 with no payload", async t => {
  const { origin, aliceKey } = await serve(t);
  const first = await get(origin, "/api/rooms/commons", aliceKey);
  assert.equal(first.status, 200);
  const etag = first.headers.get("etag");
  assert.match(etag ?? "", /^"[0-9a-f]{32}"$/, "the 200 carries a strong ETag");
  assert.equal(first.headers.get("cache-control"), "private, no-cache");
  assert.ok(first.text.length > 0);

  const repeat = await get(origin, "/api/rooms/commons", aliceKey, { "If-None-Match": etag });
  assert.equal(repeat.status, 304, "unchanged room + If-None-Match is a 304");
  assert.equal(repeat.text, "", "a 304 carries no payload");
  assert.equal(repeat.headers.get("etag"), etag);

  // Weak form and "*" are valid If-None-Match presentations of the same tag.
  assert.equal((await get(origin, "/api/rooms/commons", aliceKey, { "If-None-Match": `W/${etag}` })).status, 304);
  assert.equal((await get(origin, "/api/rooms/commons", aliceKey, { "If-None-Match": "*" })).status, 304);
  // A stale tag gets the full payload again.
  const stale = await get(origin, "/api/rooms/commons", aliceKey, { "If-None-Match": "\"00000000000000000000000000000000\"" });
  assert.equal(stale.status, 200);
  assert.equal(stale.text, first.text, "unchanged room serves byte-identical payload");
});

test("any room write — sequenced or projection-only — moves the ETag", async t => {
  const { origin, store, ownerKey, aliceKey } = await serve(t);
  const before = await get(origin, "/api/rooms/commons", aliceKey);
  const etagBefore = before.headers.get("etag");

  await postMessage(origin, ownerKey, "hello");
  const afterPost = await get(origin, "/api/rooms/commons", aliceKey, { "If-None-Match": etagBefore });
  assert.equal(afterPost.status, 200, "a sequenced append invalidates the tag");
  assert.notEqual(afterPost.headers.get("etag"), etagBefore);

  // The archive/restore class: projection replaced at the SAME sequence.
  // rooms.sequence does not move, so a sequence-only validator would 304
  // here — the read-version trigger must catch it.
  const etagAfterPost = afterPost.headers.get("etag");
  const sequence = store.headSequence("commons");
  store.db.prepare("UPDATE rooms SET projection=? WHERE id=?").run(
    store.db.prepare("SELECT projection FROM rooms WHERE id=?").get("commons").projection, "commons");
  assert.equal(store.headSequence("commons"), sequence, "projection-only write keeps the sequence");
  const afterRewrite = await get(origin, "/api/rooms/commons", aliceKey, { "If-None-Match": etagAfterPost });
  assert.equal(afterRewrite.status, 200, "a projection-only rooms write invalidates the tag");
  assert.notEqual(afterRewrite.headers.get("etag"), etagAfterPost);
});

test("validator is per-viewer and per-variant; help context is never cacheable", async t => {
  const { origin, store, ownerKey, aliceKey } = await serve(t);
  const alice = await get(origin, "/api/rooms/commons", aliceKey);
  const owner = await get(origin, "/api/rooms/commons", ownerKey);
  assert.notEqual(alice.headers.get("etag"), owner.headers.get("etag"), "different viewers, different tags");

  const work = await get(origin, "/api/rooms/commons?view=work", aliceKey);
  assert.equal(work.status, 200);
  assert.ok(work.headers.get("etag"), "work view carries a tag");
  assert.notEqual(work.headers.get("etag"), alice.headers.get("etag"), "different variants, different tags");
  assert.equal((await get(origin, "/api/rooms/commons?view=work", aliceKey, { "If-None-Match": work.headers.get("etag") })).status, 304);

  // Help context stamps evaluatedAt (now) into the payload: no ETag, no 304.
  const help = await fetch(`${origin}/api/rooms/commons?view=work`, {
    headers: { Origin: origin, Authorization: `Bearer ${aliceKey}`, "x-project-room-help-context": "1" }
  });
  assert.equal(help.status, 200);
  assert.equal(help.headers.get("etag"), null, "help-context variant is an explicit no-op");
  assert.equal(snapshotValidator(store, aliceKey, "commons", null, { view: "work", helpContext: true }), null);
});

test("the validator head never loads the projection", async t => {
  const { store, aliceKey } = await serve(t);
  const statements = [];
  const prepare = store.db.prepare.bind(store.db);
  store.db.prepare = sql => { statements.push(sql); return prepare(sql); };
  try {
    const head = snapshotValidator(store, aliceKey, "commons", null, { view: "full", windowed: true });
    assert.ok(head?.etag);
  } finally {
    store.db.prepare = prepare;
  }
  const offenders = statements.filter(sql => /projection/i.test(sql) && !/roomAuthority|substr\(projection/i.test(sql));
  assert.deepEqual(offenders, [], `validator path must not select the projection column: ${offenders.join(" | ")}`);
  const head = readSnapshotHead(store.db, "commons", "alice");
  assert.equal(typeof head.sequence, "number");
  assert.equal(typeof head.readVersion, "number");
});

test("read-version schema is idempotent and bumps only the written room", async t => {
  const { store } = await serve(t);
  ensureRoomReadVersionSchema(store.db);
  ensureRoomReadVersionSchema(store.db);
  const v0 = readSnapshotHead(store.db, "commons", "owner").readVersion;
  store.db.prepare("UPDATE rooms SET archived_at=archived_at WHERE id=?").run("commons");
  assert.equal(readSnapshotHead(store.db, "commons", "owner").readVersion, v0 + 1);
});
