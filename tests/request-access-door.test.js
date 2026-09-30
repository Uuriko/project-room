// RC-2026-09-30-3611 (human-door P0-2): the general request-access door.
// Contracts guarded here:
//  1. The door builds a valid POST /api/access-requests body: non-empty
//     roomId (default muse-room comes from the HTML), validated display
//     name, ar_-shaped idempotency key, minimal accept_work ask.
//  2. The submit orchestration reuses the browser-stashed identity per room
//     instead of minting a fresh identity per click (the mint endpoint is
//     rate-limited; a per-click mint burns it).
// Neither is covered elsewhere: server tests own the POST route, join-p2s
// owns the invite-context helpers, and the dead-invite flow in app.js is
// DOM-wired without unit coverage at this boundary.
import test from "node:test";
import assert from "node:assert/strict";
import {
  GENERAL_REQUEST_DEFAULT_ROOM_ID,
  buildGeneralAccessRequest,
  submitGeneralAccessRequest,
} from "../src/request-access.js";
import { FALLBACK_REQUEST_PERMISSIONS, readAccessRequest } from "../src/invite-context.js";

function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
  };
}

function fakeClient({ identityId = "ai_test123", calls = [] } = {}) {
  let mints = 0;
  return {
    calls,
    mintCount: () => mints,
    mintAccessIdentity: async (displayName) => {
      mints += 1;
      assert.ok(typeof displayName === "string" && displayName.length > 0);
      return identityId ? { identityId, secret: "pri_test" } : {};
    },
    submitAccessRequest: async (body) => { calls.push(body); return { ok: true }; },
  };
}

test("general door defaults to the open community room", () => {
  assert.equal(GENERAL_REQUEST_DEFAULT_ROOM_ID, "muse-room");
});

test("build: valid fields produce a submittable body", () => {
  const body = buildGeneralAccessRequest({
    roomId: "muse-room",
    displayName: "  Ada  ",
    note: "hello",
    referredBy: "",
  });
  assert.equal(body.roomId, "muse-room");
  assert.equal(body.displayName, "Ada");
  assert.equal(body.note, "hello");
  assert.equal(body.referredBy, null);
  assert.deepEqual(body.requestedPermissions, [...FALLBACK_REQUEST_PERMISSIONS]);
  assert.match(body.requestId, /^ar_[0-9a-f]{16}$/);
  assert.equal(body.identityId, null);
});

test("build: empty room id and blank name throw user-facing errors", () => {
  assert.throws(() => buildGeneralAccessRequest({ roomId: "  ", displayName: "Ada" }), /room ID/i);
  assert.throws(() => buildGeneralAccessRequest({ roomId: "muse-room", displayName: "   " }), /display name/i);
  assert.throws(() => buildGeneralAccessRequest({ roomId: "muse-room", displayName: "x".repeat(81) }), /80/);
});

test("submit: mints once, submits with the minted identity, stashes the record", async () => {
  const client = fakeClient();
  const storage = memStorage();
  const result = await submitGeneralAccessRequest({
    client, storage, roomId: "muse-room", displayName: "Ada", note: null, referredBy: null,
  });
  assert.equal(client.mintCount(), 1);
  assert.equal(client.calls.length, 1);
  const sent = client.calls[0];
  assert.equal(sent.roomId, "muse-room");
  assert.equal(sent.identityId, "ai_test123");
  assert.equal(sent.displayName, "Ada");
  assert.match(sent.requestId, /^ar_[0-9a-f]{16}$/);
  assert.equal(result.requestId, sent.requestId);
  assert.equal(result.roomId, "muse-room");
});

test("submit: retry reuses the stashed identity instead of minting again", async () => {
  const client = fakeClient();
  const storage = memStorage();
  await submitGeneralAccessRequest({ client, storage, roomId: "muse-room", displayName: "Ada" });
  await submitGeneralAccessRequest({ client, storage, roomId: "muse-room", displayName: "Ada" });
  assert.equal(client.mintCount(), 1);
  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[0].identityId, client.calls[1].identityId);
  assert.notEqual(client.calls[0].requestId, client.calls[1].requestId);
});

test("submit: a different room mints its own identity", async () => {
  const client = fakeClient();
  const storage = memStorage();
  await submitGeneralAccessRequest({ client, storage, roomId: "muse-room", displayName: "Ada" });
  await submitGeneralAccessRequest({ client, storage, roomId: "other-room", displayName: "Ada" });
  assert.equal(client.mintCount(), 2);
});

test("submit: mint returning no identity fails closed", async () => {
  const client = fakeClient({ identityId: null });
  await assert.rejects(
    () => submitGeneralAccessRequest({ client, storage: memStorage(), roomId: "muse-room", displayName: "Ada" }),
    /identity service/i,
  );
});

test("submit: a failed submit keeps the minted identity stashed for the retry (M-37)", async () => {
  let failSubmit = true;
  const client = fakeClient();
  const submit = client.submitAccessRequest;
  client.submitAccessRequest = async (body) => {
    if (failSubmit) throw new Error("network down");
    return submit(body);
  };
  const storage = memStorage();
  await assert.rejects(
    () => submitGeneralAccessRequest({ client, storage, roomId: "muse-room", displayName: "Ada" }),
    /network down/,
  );
  const stashed = readAccessRequest(storage, "muse-room");
  assert.ok(stashed?.identityId, "the minted identity stays stashed even though the submit failed");

  failSubmit = false;
  const result = await submitGeneralAccessRequest({ client, storage, roomId: "muse-room", displayName: "Ada" });
  assert.equal(client.mintCount(), 1, "the retry reuses the stashed identity instead of minting again");
  assert.equal(result.identityId, stashed.identityId);
});
