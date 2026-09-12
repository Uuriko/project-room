// W4-13 B6: invite-only operating checklist, executable part.
// Pins the unauthenticated HTTP surface: every /api route is either open by
// design (health, capability-gated previews/redemption, bare identity
// creation) or requires a credential (401). A new open route fails here
// until the checklist in docs/INVITE-ONLY-CHECKLIST.md is reviewed.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-invite-boundary-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.bindHumanAccount("commons", "owner", "account-owner");
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, origin: `http://127.0.0.1:${server.address().port}`, ownerKey };
}

async function raw(origin, path, { method = "GET", body, headers = {} } = {}) {
  const res = await fetch(`${origin}${path}`, {
    method, headers: { Origin: origin, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, headers: res.headers, json: await res.json().catch(() => null), text: null };
}

test("unauthenticated endpoint inventory is pinned", async t => {
  const { origin } = await serve(t);
  // Open by design: operational metadata, capability-gated previews and
  // redemption, and bare identity creation (an identity alone grants nothing).
  const open = [
    ["GET", "/api/health", undefined, 200],
    ["GET", "/api/version", undefined, 200],
    ["GET", "/api/ready", undefined, 200],
    ["POST", "/api/agent-identities", { displayName: "Boundary probe" }, 201],
    ["POST", "/api/agent-invites/redeem", { code: "RM-AAAAAAAA", displayName: "Boundary probe" }, 404],
    ["POST", "/api/share-links/preview", { linkToken: randomBytes(32).toString("base64url") }, 410],
    ["POST", "/api/invitations/preview", { invitationToken: randomBytes(32).toString("base64url") }, 404],
    ["POST", "/api/guest-agent-links/preview", { linkToken: `gt_${randomBytes(32).toString("base64url")}` }, 410],
    ["POST", "/api/session", { accessKey: randomBytes(32).toString("base64url") }, 401],
  ];
  for (const [method, path, body, expected] of open) {
    const res = await raw(origin, path, { method, body });
    assert.equal(res.status, expected, `${method} ${path} -> ${res.status}, expected ${expected}: ${JSON.stringify(res.json)}`);
  }
  // Everything room-scoped requires a credential (shape-valid bodies reach the
  // auth check; malformed ones may fail input validation first, which leaks nothing).
  const guarded = [
    ["GET", "/api/rooms/commons/commands"],
    ["GET", "/api/rooms/commons/events"],
    ["GET", "/api/rooms/commons/export"],
    ["GET", "/api/rooms/commons/agent-invites"],
    ["POST", "/api/rooms/commons/agent-invites", { permissions: ["steer"] }],
    ["DELETE", "/api/rooms/commons/agent-invites", { codeHash: "0".repeat(64) }],
  ];
  for (const [method, path, body] of guarded) {
    const res = await raw(origin, path, { method, body });
    assert.equal(res.status, 401, `${method} ${path} must require authentication, got ${res.status}`);
  }
  // /api/inbox and /api/account-rooms are account-session scoped: without a
  // session cookie they refuse (401 in a real browser session, 422
  // session_binding_required for this header-only probe which carries no
  // session binding). Either way, no data.
  for (const path of ["/api/inbox", "/api/account-rooms"]) {
    const res = await raw(origin, path);
    assert.ok([401, 422].includes(res.status), `GET ${path} must refuse without a session, got ${res.status}`);
    assert.ok(!JSON.stringify(res.json).includes("@"), `${path} refusal must not leak account data`);
  }
});

test("capability previews never leak room content", async t => {
  const { store, origin, ownerKey } = await serve(t);
  const secretBody = `boundary-secret-${randomUUID()}`;
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED,
    data: { messageId: randomUUID(), body: secretBody } });
  const linkToken = randomBytes(32).toString("base64url");
  const created = store.shareLinks.create(ownerKey, "commons", {
    requestId: randomUUID(), linkToken, expiresAt: store.now() + 3600000, maxJoins: 5, expectedMemberRevision: 0,
  }, undefined);
  assert.equal(created.duplicate, false);
  const preview = await raw(origin, "/api/share-links/preview", { method: "POST", body: { linkToken } });
  assert.equal(preview.status, 200);
  const serialized = JSON.stringify(preview.json);
  assert.ok(!serialized.includes(secretBody), "preview must not contain message bodies");
  assert.ok(!serialized.includes(ownerKey), "preview must not contain credentials");
  assert.deepEqual(Object.keys(preview.json).sort(), ["access", "identity", "link", "room"]);
  assert.deepEqual(Object.keys(preview.json.room).sort(), ["id", "title"]);
});

test("indexing is denied by default; operation ids tag every api response", async t => {
  const { origin } = await serve(t);
  const health = await raw(origin, "/api/health");
  assert.equal(health.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.match(health.headers.get("x-operation-id") ?? "", /^op_/);
  assert.equal(health.headers.get("cache-control"), "no-store");
  // Deliberately public discovery packets are the only indexable surface.
  const packet = await raw(origin, "/llms.txt");
  assert.equal(packet.status, 200);
  assert.equal(packet.headers.get("x-robots-tag"), "all");
});
