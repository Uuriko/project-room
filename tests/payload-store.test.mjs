// WAVE-300 payload store: content-addressed blob store with pin-set GC.
// Tests first — the implementation lives in server/payload-store.mjs and
// server/payload-schema.mjs. Run with TMPDIR=~/workspace/pr-wave300-payloads/.tmp.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { payloadLimits, ensurePayloadSchema } from "../server/payload-schema.mjs";
import {
  PayloadStore,
  BlobBackend,
  LocalBlobBackend,
  validPayloadData,
} from "../server/payload-store.mjs";

const shaOf = bytes => createHash("sha256").update(bytes).digest("hex");
const b64 = bytes => Buffer.from(bytes).toString("base64");

function makeStore(now = () => Date.now()) {
  const db = new DatabaseSync(":memory:");
  return { db, store: new PayloadStore(db, { now }) };
}

test("payloadLimits match the design doc and the schema is idempotent", () => {
  assert.equal(payloadLimits.inlineBytes, 65536);
  assert.equal(payloadLimits.maxBlobBytes, 25 * 1024 * 1024);
  assert.equal(payloadLimits.orphanLifetimeMs, 24 * 60 * 60 * 1000);
  assert.ok(Object.isFrozen(payloadLimits));
  const db = new DatabaseSync(":memory:");
  assert.equal(ensurePayloadSchema(db), ensurePayloadSchema(db));
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('payload_blobs','payload_pins')"
  ).all().map(row => row.name).sort();
  assert.deepEqual(tables, ["payload_blobs", "payload_pins"]);
  const index = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name='payload_pins_sha'"
  ).get();
  assert.equal(index.name, "payload_pins_sha");
});

test("put stores a blob and returns its server-derived sha256", async () => {
  const { store } = makeStore();
  const bytes = Buffer.from("hello payload");
  const result = await store.put({ mediaType: "text/plain", dataBase64: b64(bytes) });
  assert.deepEqual(result, {
    sha256: shaOf(bytes),
    byte_length: bytes.length,
    duplicate: false,
  });
});

test("put is idempotent: same bytes return duplicate:true with 200/201 semantics", async () => {
  const { db, store } = makeStore();
  const bytes = Buffer.from("dedupe me");
  const first = await store.put({ mediaType: "application/octet-stream", dataBase64: b64(bytes) });
  const second = await store.put({ mediaType: "application/octet-stream", dataBase64: b64(bytes) });
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.sha256, first.sha256);
  const count = db.prepare("SELECT COUNT(*) AS n FROM payload_blobs").get().n;
  assert.equal(count, 1);
});

test("get returns the stored blob with canonical base64", async () => {
  const { store } = makeStore();
  const bytes = Buffer.from([0, 1, 2, 250, 255, 13, 10]);
  const { sha256 } = await store.put({ mediaType: "application/octet-stream", dataBase64: b64(bytes) });
  const got = await store.get(sha256);
  assert.deepEqual(got, {
    sha256,
    byte_length: bytes.length,
    media_type: "application/octet-stream",
    dataBase64: b64(bytes),
  });
});

test("get rejects a malformed sha with 422 invalid_payload_ref", async () => {
  const { store } = makeStore();
  for (const bad of ["xyz", "0".repeat(63), "0".repeat(65), "Z".repeat(64), "", 42, null]) {
    await assert.rejects(() => store.get(bad), error => error.status === 422 && error.code === "invalid_payload_ref");
  }
});

test("get on a well-formed but unknown sha returns 404 payload_not_found", async () => {
  const { store } = makeStore();
  await assert.rejects(
    () => store.get("0".repeat(64)),
    error => error.status === 404 && error.code === "payload_not_found"
  );
});

test("put rejects non-canonical base64 with 422 invalid_payload", async () => {
  const { store } = makeStore();
  for (const bad of ["not base64!!", "a b c=", "abc", "====", "aGVsbG8", 42, null, undefined]) {
    await assert.rejects(
      () => store.put({ mediaType: "text/plain", dataBase64: bad }),
      error => error.status === 422 && error.code === "invalid_payload",
      `expected invalid_payload for ${JSON.stringify(bad)}`
    );
  }
});

test("validPayloadData mirrors the canonical-base64 rules at the 25 MiB cap", () => {
  assert.equal(validPayloadData(b64(Buffer.from("ok"))), true);
  assert.equal(validPayloadData(""), true);
  assert.equal(validPayloadData("a b"), false);
  assert.equal(validPayloadData("abc"), false); // length % 4 !== 0
  assert.equal(validPayloadData("aGVsbG8"), false); // missing canonical padding
  const tooLong = "a".repeat(4 * Math.ceil(payloadLimits.maxBlobBytes / 3) + 4);
  assert.equal(validPayloadData(tooLong), false);
});

test("put rejects payloads over 25 MiB with 413 payload_too_large", async () => {
  const { store } = makeStore();
  const bytes = Buffer.alloc(payloadLimits.maxBlobBytes + 1, 7);
  await assert.rejects(
    () => store.put({ mediaType: "application/octet-stream", dataBase64: bytes.toString("base64") }),
    error => error.status === 413 && error.code === "payload_too_large"
  );
});

test("put stores media_type normalized lowercase", async () => {
  const { store } = makeStore();
  const { sha256 } = await store.put({ mediaType: "Image/PNG", dataBase64: b64(Buffer.from("png-bytes")) });
  assert.equal((await store.get(sha256)).media_type, "image/png");
});

test("put rejects blocked media types with 422 blocked_media_type", async () => {
  const { store } = makeStore();
  for (const blocked of ["application/x-msdownload", "application/x-dosexec", "text/x-shellscript"]) {
    await assert.rejects(
      () => store.put({ mediaType: blocked, dataBase64: b64(Buffer.from("x")) }),
      error => error.status === 422 && error.code === "blocked_media_type",
      `expected blocked_media_type for ${blocked}`
    );
  }
});

test("put rejects malformed media types with 422 invalid_payload", async () => {
  const { store } = makeStore();
  for (const bad of ["not-a-type", "", "text/", "/plain", 42, null]) {
    await assert.rejects(
      () => store.put({ mediaType: bad, dataBase64: b64(Buffer.from("x")) }),
      error => error.status === 422 && error.code === "invalid_payload",
      `expected invalid_payload for ${JSON.stringify(bad)}`
    );
  }
});

test("pin / unpin manage the pin set idempotently", async () => {
  const { db, store } = makeStore();
  const { sha256 } = await store.put({ mediaType: "text/plain", dataBase64: b64(Buffer.from("pinned")) });
  const pinned = await store.pin({ sha256, kind: "event", roomId: "room-1", refId: "event-1" });
  assert.equal(pinned.duplicate, false);
  const repinned = await store.pin({ sha256, kind: "event", roomId: "room-1", refId: "event-1" });
  assert.equal(repinned.duplicate, true);
  const count = db.prepare("SELECT COUNT(*) AS n FROM payload_pins").get().n;
  assert.equal(count, 1);
  // Same blob pinned under a different reference is a second pin row.
  await store.pin({ sha256, kind: "claim", roomId: "room-1", refId: "claim-9" });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM payload_pins").get().n, 2);
  const removed = await store.unpin({ sha256, kind: "event", roomId: "room-1", refId: "event-1" });
  assert.equal(removed.removed, true);
  const removedAgain = await store.unpin({ sha256, kind: "event", roomId: "room-1", refId: "event-1" });
  assert.equal(removedAgain.removed, false);
});

test("pin rejects unknown kinds and malformed shas", async () => {
  const { store } = makeStore();
  await assert.rejects(
    () => store.pin({ sha256: "0".repeat(64), kind: "bogus", roomId: "r", refId: "e" }),
    error => error.status === 422 && error.code === "invalid_pin"
  );
  await assert.rejects(
    () => store.pin({ sha256: "nope", kind: "event", roomId: "r", refId: "e" }),
    error => error.status === 422 && error.code === "invalid_payload_ref"
  );
});

test("gc collects aged orphans but spares pinned blobs and young orphans", async () => {
  const now = Date.now();
  const { db, store } = makeStore(() => now);
  const agedOrphan = await store.put({ mediaType: "text/plain", dataBase64: b64(Buffer.from("aged orphan")) });
  const pinned = await store.put({ mediaType: "text/plain", dataBase64: b64(Buffer.from("pinned blob")) });
  const young = await store.put({ mediaType: "text/plain", dataBase64: b64(Buffer.from("young orphan")) });
  await store.pin({ sha256: pinned.sha256, kind: "event", roomId: "room-1", refId: "event-1" });
  const old = now - payloadLimits.orphanLifetimeMs - 1000;
  db.prepare("UPDATE payload_blobs SET created_at=? WHERE sha256=?").run(old, agedOrphan.sha256);
  db.prepare("UPDATE payload_blobs SET created_at=? WHERE sha256=?").run(old, pinned.sha256);
  const result = await store.gc({ now });
  assert.deepEqual(result, { deleted: 1, bytesFreed: Buffer.from("aged orphan").length });
  await assert.rejects(() => store.get(agedOrphan.sha256), error => error.code === "payload_not_found");
  // Pinned blob survives even though it is old; the young orphan is not yet collectible.
  assert.ok(await store.get(pinned.sha256));
  assert.ok(await store.get(young.sha256));
});

test("gc never deletes a referenced blob: the safety invariant holds", async () => {
  const now = Date.now();
  const { db, store } = makeStore(() => now);
  const { sha256 } = await store.put({ mediaType: "text/plain", dataBase64: b64(Buffer.from("referenced")) });
  await store.pin({ sha256, kind: "attachment", roomId: "room-2", refId: "att-3" });
  db.prepare("UPDATE payload_blobs SET created_at=?").run(now - payloadLimits.orphanLifetimeMs - 1);
  const result = await store.gc({ now });
  assert.deepEqual(result, { deleted: 0, bytesFreed: 0 });
  assert.ok(await store.get(sha256));
});

test("gc batches with a limit", async () => {
  const now = Date.now();
  const { db, store } = makeStore(() => now);
  for (let i = 0; i < 3; i++) {
    await store.put({ mediaType: "text/plain", dataBase64: b64(Buffer.from(`orphan-${i}`)) });
  }
  db.prepare("UPDATE payload_blobs SET created_at=?").run(now - payloadLimits.orphanLifetimeMs - 1);
  const first = await store.gc({ now, limit: 2 });
  assert.equal(first.deleted, 2);
  const second = await store.gc({ now, limit: 2 });
  assert.equal(second.deleted, 1);
});

test("LocalBlobBackend implements the BlobBackend interface over the payload_blobs table", async () => {
  const db = new DatabaseSync(":memory:");
  ensurePayloadSchema(db);
  const backend = new LocalBlobBackend(db);
  assert.ok(backend instanceof BlobBackend);
  const bytes = Buffer.from("backend bytes");
  const sha = shaOf(bytes);
  assert.equal(await backend.exists(sha), false);
  assert.equal(await backend.get(sha), null);
  const first = await backend.put(sha, { bytes, mediaType: "text/plain", byteLength: bytes.length });
  assert.equal(first.duplicate, false);
  assert.equal(await backend.exists(sha), true);
  const got = await backend.get(sha);
  assert.deepEqual({ mediaType: got.mediaType, byteLength: got.byteLength }, { mediaType: "text/plain", byteLength: bytes.length });
  assert.deepEqual(Buffer.from(got.bytes), bytes);
  const second = await backend.put(sha, { bytes, mediaType: "text/plain", byteLength: bytes.length });
  assert.equal(second.duplicate, true);
  assert.equal(await backend.del(sha), true);
  assert.equal(await backend.exists(sha), false);
  assert.equal(await backend.del(sha), false);
});

test("the base BlobBackend surface is unimplemented", async () => {
  const backend = new BlobBackend();
  await assert.rejects(() => backend.put("x", {}), /unimplemented/);
  await assert.rejects(() => backend.get("x"), /unimplemented/);
  await assert.rejects(() => backend.del("x"), /unimplemented/);
  await assert.rejects(() => backend.exists("x"), /unimplemented/);
});
