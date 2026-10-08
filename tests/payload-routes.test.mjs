// WAVE-300 payload store: HTTP routes + message-post wire-in.
// Tests first — run with TMPDIR=~/workspace/pr-wave300-payloads/.tmp.
//
// Covers: upload→download roundtrip, dedup (same bytes twice →
// duplicate:true), oversize → 413, bad base64 → 422, unknown hash → 404,
// malformed sha → 422, api-key scope denial → 403, guest denial → 403,
// HEAD support, the message.posted externalize+pin wire-in, the >64KiB
// inline guard, opportunistic GC, and the payload-refs helper contract.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { PayloadStore } from "../server/payload-store.mjs";
import { payloadLimits } from "../server/payload-schema.mjs";
import { API_KEY_PREFIX } from "../server/agent-api-keys.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import {
  isPayloadRef,
  validatePayloadRef,
  externalizePayload,
  resolvePayload,
  pinPayloadRefs,
  collectPayloadRefs,
} from "../server/payload-refs.mjs";

const ROOM = "commons";
const b64 = bytes => Buffer.alloc(bytes, 7).toString("base64");
const shaOf = bytes => createHash("sha256").update(Buffer.alloc(bytes, 7)).digest("hex");

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-payload-routes-"));
  let clock = Date.parse("2026-10-08T12:00:00Z");
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock });
  store.initialize(initialRoom(ROOM));
  const keys = { owner: store.issueAccessKey(ROOM, "owner") };
  const send = (actor, type, data, id = randomUUID()) => store.command(keys[actor], ROOM, { id, type, data });
  send("owner", T.MEMBER_ADDED, { memberId: "agent", displayName: "Test agent", kind: "agent", permissions: [], accountableHumanId: "owner" });
  send("owner", T.MEMBER_ADDED, { memberId: "guest-agent-pl-01", displayName: "Guest visit", kind: "agent", permissions: [], accountableHumanId: "owner" });
  keys.agent = store.issueAccessKey(ROOM, "agent");
  keys.guest = store.issueAccessKey(ROOM, "guest-agent-pl-01");
  // The routes attach store.payloads lazily; the tests attach it eagerly so
  // helper-level assertions can run against the same instance.
  store.payloads = new PayloadStore(store.db, { now: () => clock });
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { method = "GET", data, token } = {}) => fetch(origin + path, {
    method,
    headers: {
      Origin: origin,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(data === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const postMessage = (token, data, id = randomUUID()) =>
    request(`/api/rooms/${ROOM}/commands`, { method: "POST", token, data: { id, type: "message.posted", data } });
  const lastEvent = () => JSON.parse(store.db.prepare(
    "SELECT id, body FROM events WHERE room_id=? ORDER BY sequence DESC LIMIT 1").get(ROOM).body);
  const pins = sha => store.db.prepare("SELECT kind, room_id, ref_id FROM payload_pins WHERE sha256=?").all(sha)
    .map(row => ({ kind: row.kind, room_id: row.room_id, ref_id: row.ref_id }));
  return { store, request, keys, send, postMessage, lastEvent, pins,
    advance: ms => { clock += ms; }, now: () => clock };
}

async function scopedKey(f, scopes) {
  const tag = randomUUID().slice(0, 8);
  const identity = f.store.identities.create(`Payload Key ${tag}`);
  f.store.identities.link(f.keys.owner, ROOM, { identityId: identity.identityId, displayName: `Payload key ${tag}`, permissions: [] });
  const issued = f.store.agentPlugin.apiKeys.issue({ identityId: identity.identityId, scopes });
  return API_KEY_PREFIX + issued.secret;
}

// Error envelope: HTTP status is the real status; the AX layer nests the
// machine code at body.error.code (see guest-token-expiry.test.mjs).
const errorOf = async res => {
  const body = await res.json();
  return { httpStatus: res.status, code: body?.error?.code, message: body?.error?.message };
};

// ---- payload-refs helpers ----

test("isPayloadRef accepts exactly the ref shape", () => {
  assert.equal(isPayloadRef({ sha256: "a".repeat(64), byte_length: 10, media_type: "image/png" }), true);
  assert.equal(isPayloadRef({ sha256: "a".repeat(64), byte_length: 10, media_type: "image/png", extra: 1 }), false);
  assert.equal(isPayloadRef({ sha256: "zzz", byte_length: 10, media_type: "image/png" }), false);
  assert.equal(isPayloadRef({ sha256: "a".repeat(64), byte_length: -1, media_type: "image/png" }), false);
  assert.equal(isPayloadRef({ sha256: "a".repeat(64), byte_length: 1.5, media_type: "image/png" }), false);
  assert.equal(isPayloadRef(null), false);
  assert.equal(isPayloadRef("payload_ref"), false);
  assert.equal(isPayloadRef({ mediaType: "image/png", data: b64(4) }), false);
});

test("validatePayloadRef throws 422 invalid_payload_ref on bad shapes", () => {
  assert.doesNotThrow(() => validatePayloadRef({ sha256: "b".repeat(64), byte_length: 0, media_type: "text/plain" }));
  for (const bad of [null, {}, { sha256: "x".repeat(64), byte_length: 1, media_type: "text/plain" },
      { sha256: "c".repeat(64), byte_length: -2, media_type: "text/plain" },
      { sha256: "c".repeat(64), byte_length: 1, media_type: "NOT A TYPE" }]) {
    assert.throws(() => validatePayloadRef(bad), error => error.status === 422 && error.code === "invalid_payload_ref");
  }
});

test("externalizePayload keeps <=64KiB inline and externalizes >64KiB", async t => {
  const f = await serve(t);
  const inline = await externalizePayload({ mediaType: "image/PNG", dataBase64: b64(payloadLimits.inlineBytes) }, f.store);
  assert.deepEqual(inline, { mediaType: "image/png", data: b64(payloadLimits.inlineBytes) });
  const big = await externalizePayload({ mediaType: "image/png", dataBase64: b64(payloadLimits.inlineBytes + 1) }, f.store);
  assert.deepEqual(Object.keys(big), ["payload_ref"]);
  assert.equal(big.payload_ref.sha256, shaOf(payloadLimits.inlineBytes + 1));
  assert.equal(big.payload_ref.byte_length, payloadLimits.inlineBytes + 1);
  assert.equal(big.payload_ref.media_type, "image/png");
  assert.equal(isPayloadRef(big.payload_ref), true);
  // Re-externalizing the same bytes dedups to the same sha.
  const again = await externalizePayload({ mediaType: "image/png", dataBase64: b64(payloadLimits.inlineBytes + 1) }, f.store);
  assert.equal(again.payload_ref.sha256, big.payload_ref.sha256);
});

test("externalizePayload rejects bad media types and oversize data", async t => {
  const f = await serve(t);
  await assert.rejects(externalizePayload({ mediaType: "nope", dataBase64: b64(4) }, f.store),
    error => error.status === 422 && error.code === "invalid_payload");
  await assert.rejects(externalizePayload({ mediaType: "application/x-msdownload", dataBase64: b64(payloadLimits.inlineBytes + 1) }, f.store),
    error => error.status === 422 && error.code === "blocked_media_type");
  await assert.rejects(externalizePayload({ mediaType: "image/png", dataBase64: "not base64!!" }, f.store),
    error => error.status === 422 && error.code === "invalid_payload");
});

test("resolvePayload resolves refs and passes inline payloads through", async t => {
  const f = await serve(t);
  const stored = await f.store.payloads.put({ mediaType: "text/plain", dataBase64: b64(70000) });
  const via = await resolvePayload({ payload_ref: { sha256: stored.sha256, byte_length: 70000, media_type: "text/plain" } }, f.store);
  assert.equal(via.mediaType, "text/plain");
  assert.deepEqual(via.bytes, Buffer.alloc(70000, 7));
  const inline = await resolvePayload({ mediaType: "text/plain", data: b64(10) }, f.store);
  assert.deepEqual(inline.bytes, Buffer.alloc(10, 7));
  await assert.rejects(
    resolvePayload({ payload_ref: { sha256: "0".repeat(64), byte_length: 1, media_type: "text/plain" } }, f.store),
    error => error.status === 404 && error.code === "payload_not_found");
  await assert.rejects(resolvePayload({ nope: true }, f.store),
    error => error.status === 422 && error.code === "invalid_payload_ref");
  // byte_length mismatch against the stored blob fails closed.
  await assert.rejects(
    resolvePayload({ payload_ref: { sha256: stored.sha256, byte_length: 1, media_type: "text/plain" } }, f.store),
    error => error.status === 422 && error.code === "invalid_payload_ref");
});

test("pinPayloadRefs scans nested bodies and pins each ref idempotently", async t => {
  const f = await serve(t);
  const stored = await f.store.payloads.put({ mediaType: "image/png", dataBase64: b64(70000) });
  const ref = { sha256: stored.sha256, byte_length: 70000, media_type: "image/png" };
  const body = { messageId: "m1", poll: { options: [{ attachment: { payload_ref: ref } }] } };
  assert.deepEqual(collectPayloadRefs(body), [ref]);
  const pinned = await pinPayloadRefs(body, { kind: "event", roomId: ROOM, refId: "evt-1" }, f.store);
  assert.deepEqual(pinned, [ref]);
  assert.deepEqual(f.pins(stored.sha256), [{ kind: "event", room_id: ROOM, ref_id: "evt-1" }]);
  // Idempotent re-pin.
  await pinPayloadRefs(body, { kind: "event", roomId: ROOM, refId: "evt-1" }, f.store);
  assert.equal(f.pins(stored.sha256).length, 1);
  // A malformed ref fails before any pin lands.
  await assert.rejects(
    pinPayloadRefs({ payload_ref: { sha256: "short", byte_length: 1, media_type: "text/plain" } }, { kind: "event", roomId: ROOM, refId: "evt-2" }, f.store),
    error => error.status === 422 && error.code === "invalid_payload_ref");
  assert.equal(f.pins("short").length, 0);
});

// ---- HTTP routes ----

test("upload → download roundtrip, with HEAD", async t => {
  const f = await serve(t);
  const data = b64(100);
  const up = await f.request(`/api/rooms/${ROOM}/payloads`, { method: "POST", token: f.keys.owner, data: { mediaType: "image/png", data } });
  assert.equal(up.status, 201);
  const stored = await up.json();
  assert.equal(stored.status, "stored");
  assert.equal(stored.duplicate, false);
  assert.equal(stored.roomId, ROOM);
  assert.deepEqual(stored.payload, { sha256: shaOf(100), byte_length: 100, media_type: "image/png" });
  const down = await f.request(`/api/rooms/${ROOM}/payloads/${shaOf(100)}`, { token: f.keys.owner });
  assert.equal(down.status, 200);
  const got = await down.json();
  assert.equal(got.roomId, ROOM);
  assert.equal(got.payload.sha256, shaOf(100));
  assert.equal(got.payload.byte_length, 100);
  assert.equal(got.payload.media_type, "image/png");
  assert.equal(got.payload.encoding, "base64");
  assert.equal(got.payload.data, data);
  const head = await f.request(`/api/rooms/${ROOM}/payloads/${shaOf(100)}`, { method: "HEAD", token: f.keys.owner });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});

test("uploading the same bytes twice dedups (200 duplicate:true)", async t => {
  const f = await serve(t);
  const payload = { mediaType: "text/plain", data: b64(70000) };
  const first = await f.request(`/api/rooms/${ROOM}/payloads`, { method: "POST", token: f.keys.owner, data: payload });
  assert.equal(first.status, 201);
  const second = await f.request(`/api/rooms/${ROOM}/payloads`, { method: "POST", token: f.keys.owner, data: payload });
  assert.equal(second.status, 200);
  const body = await second.json();
  assert.equal(body.duplicate, true);
  assert.equal(body.payload.sha256, shaOf(70000));
});

test("oversize upload → 413 payload_too_large", async t => {
  const f = await serve(t);
  const res = await f.request(`/api/rooms/${ROOM}/payloads`, {
    method: "POST", token: f.keys.owner,
    data: { mediaType: "application/octet-stream", data: Buffer.alloc(payloadLimits.maxBlobBytes + 1, 9).toString("base64") },
  });
  assert.deepEqual(await errorOf(res), { httpStatus: 413, code: "payload_too_large", message: "Payload exceeds the 25 MiB payload size limit" });
});

test("bad base64 and bad shapes → 422 invalid_payload; blocked type → 422", async t => {
  const f = await serve(t);
  for (const data of [
    { mediaType: "image/png", data: "!!! not base64 !!!" },
    { mediaType: "image/png", data: "aGVsbG8gd29ybGQ= with whitespace" },
    { mediaType: "image/png", data: b64(4), extra: true },
    { mediaType: "image/png" },
    { data: b64(4) },
  ]) {
    const res = await f.request(`/api/rooms/${ROOM}/payloads`, { method: "POST", token: f.keys.owner, data });
    const err = await errorOf(res);
    assert.equal(err.httpStatus, 422, JSON.stringify(data));
    assert.equal(err.code, "invalid_payload", JSON.stringify(data));
  }
  const blocked = await f.request(`/api/rooms/${ROOM}/payloads`, {
    method: "POST", token: f.keys.owner, data: { mediaType: "application/x-msdownload", data: b64(70000) } });
  assert.deepEqual((await errorOf(blocked)).code, "blocked_media_type");
});

test("unknown hash → 404; malformed sha → 422", async t => {
  const f = await serve(t);
  const missing = await f.request(`/api/rooms/${ROOM}/payloads/${"0".repeat(64)}`, { token: f.keys.owner });
  assert.deepEqual(await errorOf(missing), { httpStatus: 404, code: "payload_not_found", message: "Payload not found" });
  for (const bad of ["zzz", "A".repeat(64), "a".repeat(63)]) {
    const res = await f.request(`/api/rooms/${ROOM}/payloads/${bad}`, { token: f.keys.owner });
    const err = await errorOf(res);
    assert.equal(err.httpStatus, 422, bad);
    assert.equal(err.code, "invalid_payload_ref", bad);
  }
});

test("api-key without the scope → 403 insufficient_scope", async t => {
  const f = await serve(t);
  const readKey = await scopedKey(f, ["rooms:read"]);
  const denied = await f.request(`/api/rooms/${ROOM}/payloads`, {
    method: "POST", token: readKey, data: { mediaType: "text/plain", data: b64(70000) } });
  assert.deepEqual(await errorOf(denied), { httpStatus: 403, code: "insufficient_scope", message: "API key lacks the rooms:write scope" });
  // A read-scoped key CAN download after an owner upload.
  const up = await f.request(`/api/rooms/${ROOM}/payloads`, { method: "POST", token: f.keys.owner, data: { mediaType: "text/plain", data: b64(70000) } });
  assert.equal(up.status, 201);
  const down = await f.request(`/api/rooms/${ROOM}/payloads/${shaOf(70000)}`, { token: readKey });
  assert.equal(down.status, 200);
  const otherKey = await scopedKey(f, ["directory:publish"]);
  const deniedRead = await f.request(`/api/rooms/${ROOM}/payloads/${shaOf(70000)}`, { token: otherKey });
  assert.deepEqual((await errorOf(deniedRead)).code, "insufficient_scope");
});

test("guest members are denied upload and download", async t => {
  const f = await serve(t);
  const up = await f.request(`/api/rooms/${ROOM}/payloads`, {
    method: "POST", token: f.keys.guest, data: { mediaType: "text/plain", data: b64(70000) } });
  assert.deepEqual(await errorOf(up), { httpStatus: 403, code: "guest_scope_denied", message: "Guest members cannot use the payload store" });
  const stored = await f.request(`/api/rooms/${ROOM}/payloads`, {
    method: "POST", token: f.keys.owner, data: { mediaType: "text/plain", data: b64(70000) } });
  assert.equal(stored.status, 201);
  const down = await f.request(`/api/rooms/${ROOM}/payloads/${shaOf(70000)}`, { token: f.keys.guest });
  assert.deepEqual((await errorOf(down)).code, "guest_scope_denied");
});

// ---- message.posted wire-in ----

test("message.posted externalizes a >64KiB inline payload and pins the ref", async t => {
  const f = await serve(t);
  const bytes = payloadLimits.inlineBytes + 123;
  const messageId = randomUUID();
  const res = await f.postMessage(f.keys.owner, {
    messageId, body: "here is a big attachment",
    poll: { question: "q", attachment: { mediaType: "image/png", data: b64(bytes) } },
  });
  assert.equal(res.status, 201);
  const event = f.lastEvent();
  assert.equal(event.data.messageId, messageId);
  const attachment = event.data.poll.attachment;
  assert.deepEqual(Object.keys(attachment), ["payload_ref"]);
  assert.equal(attachment.payload_ref.sha256, shaOf(bytes));
  assert.equal(attachment.payload_ref.byte_length, bytes);
  assert.equal(attachment.payload_ref.media_type, "image/png");
  const pinRows = f.pins(shaOf(bytes));
  assert.equal(pinRows.length, 1);
  assert.equal(pinRows[0].kind, "event");
  assert.equal(pinRows[0].room_id, ROOM);
  assert.equal(pinRows[0].ref_id, event.id);
  // The pinned bytes download through the route.
  const down = await f.request(`/api/rooms/${ROOM}/payloads/${shaOf(bytes)}`, { token: f.keys.owner });
  assert.equal(down.status, 200);
  assert.equal((await down.json()).payload.data, b64(bytes));
});

test("message.posted keeps small inline payloads untouched and pins nothing", async t => {
  const f = await serve(t);
  const messageId = randomUUID();
  const res = await f.postMessage(f.keys.owner, {
    messageId, body: "tiny attachment",
    poll: { question: "q", attachment: { mediaType: "text/plain", data: b64(100) } },
  });
  assert.equal(res.status, 201);
  const event = f.lastEvent();
  assert.deepEqual(event.data.poll.attachment, { mediaType: "text/plain", data: b64(100) });
  assert.equal(f.pins(shaOf(100)).length, 0);
});

test("message.posted rejects a bare >64KiB base64 data field with 413", async t => {
  const f = await serve(t);
  const res = await f.postMessage(f.keys.owner, {
    messageId: randomUUID(), body: "oversize inline",
    poll: { question: "q", data: b64(payloadLimits.inlineBytes + 1) },
  });
  const err = await errorOf(res);
  assert.equal(err.httpStatus, 413);
  assert.equal(err.code, "payload_too_large");
});

test("opportunistic GC collects aged orphans but spares pinned blobs", async t => {
  const f = await serve(t);
  const orphan = await f.request(`/api/rooms/${ROOM}/payloads`, {
    method: "POST", token: f.keys.owner, data: { mediaType: "text/plain", data: b64(70000) } });
  assert.equal(orphan.status, 201);
  const orphanSha = (await orphan.json()).payload.sha256;
  // Age the orphan past the 24h lifetime, then trigger another upload: the
  // opportunistic gc() on the upload path must collect it.
  f.store.db.prepare("UPDATE payload_blobs SET created_at=? WHERE sha256=?").run(f.now() - payloadLimits.orphanLifetimeMs - 1, orphanSha);
  f.advance(payloadLimits.orphanLifetimeMs + 60000);
  const second = await f.request(`/api/rooms/${ROOM}/payloads`, {
    method: "POST", token: f.keys.owner, data: { mediaType: "text/plain", data: b64(70001) } });
  assert.equal(second.status, 201);
  const gone = await f.request(`/api/rooms/${ROOM}/payloads/${orphanSha}`, { token: f.keys.owner });
  assert.equal(gone.status, 404);
  // A pinned blob of the same age survives the sweep.
  const pinnedBytes = 70002;
  const messageId = randomUUID();
  const posted = await f.postMessage(f.keys.owner, {
    messageId, body: "pinned big",
    poll: { question: "q", attachment: { mediaType: "image/png", data: b64(pinnedBytes) } },
  });
  assert.equal(posted.status, 201);
  const pinnedSha = shaOf(pinnedBytes);
  f.store.db.prepare("UPDATE payload_blobs SET created_at=? WHERE sha256=?").run(f.now() - payloadLimits.orphanLifetimeMs - 1, pinnedSha);
  f.advance(payloadLimits.orphanLifetimeMs + 60000);
  const third = await f.request(`/api/rooms/${ROOM}/payloads`, {
    method: "POST", token: f.keys.owner, data: { mediaType: "text/plain", data: b64(70003) } });
  assert.equal(third.status, 201);
  const stillThere = await f.request(`/api/rooms/${ROOM}/payloads/${pinnedSha}`, { token: f.keys.owner });
  assert.equal(stillThere.status, 200);
});
