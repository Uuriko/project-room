// W4-57 M6: safe diagnostics — the support-export bundle is owner-only,
// carries bounded operation ids and error categories, and never contains
// credentials, hashes, request bodies, message text, or member details.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { supportExportBundle } from "../server/diagnostics.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-support-export-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.bindHumanAccount("commons", "owner", "account-owner");
  const ownerKey = store.issueAccessKey("commons", "owner");
  const accountKey = store.issueAccountAccessKey("account-owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, origin: `http://127.0.0.1:${server.address().port}`, ownerKey, accountKey };
}
// Signed-in owner session (account cookie + binding), mirroring a browser login.
async function ownerSession(origin, accountKey) {
  const bootstrap = await fetch(`${origin}/api/account-session`, { headers: { Origin: origin } });
  const cookie = bootstrap.headers.get("set-cookie").split(";", 1)[0];
  const { csrf, sessionRevision, sessionBinding } = await bootstrap.json();
  const login = await fetch(`${origin}/api/account-session`, { method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": csrf },
    body: JSON.stringify({ accountAccessKey: accountKey, expectedSessionRevision: sessionRevision }) });
  if (login.status !== 201) throw new Error(`account login failed: ${login.status}`);
  const session = await login.json();
  return { Cookie: cookie, Origin: origin, "X-Project-Room-Auth": "account",
    "X-Session-Binding": session.sessionBinding ?? sessionBinding };
}
const authGet = (origin, path, token) => fetch(`${origin}${path}`, { headers: { Origin: origin, Authorization: `Bearer ${token}` } })
  .then(async res => ({ status: res.status, json: await res.json().catch(() => null),
    disposition: res.headers.get("content-disposition") }));
const authPost = (origin, path, body, token) => fetch(`${origin}${path}`, { method: "POST",
  headers: { Origin: origin, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body) }).then(async res => ({ status: res.status, json: await res.json().catch(() => null) }));

function deepKeys(value, out = []) {
  if (Array.isArray(value)) value.forEach(item => deepKeys(item, out));
  else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) { out.push(key); deepKeys(item, out); }
  return out;
}

test("support export bundle carries only whitelisted scalars", () => {
  const bundle = supportExportBundle({ roomId: "commons", roomTitle: "T",
    service: { sourceRevision: "abc", buildId: "1", mode: "m" },
    diagnostics: [{ operationId: "op_x", at: "t", status: 422, code: "invalid_command", category: "input", route: "/api/rooms/:roomId/commands",
      // hostile extras must not survive
      token: "sekret", body: "private", nested: { hash: "deadbeef" } }] });
  assert.equal(bundle.format, "project-room-support-export-v1");
  const keys = deepKeys(bundle).map(k => k.toLowerCase());
  for (const banned of ["token", "hash", "secret", "password", "credential", "body", "authorization"]) {
    assert.ok(!keys.some(k => k.includes(banned)), `bundle must not contain a ${banned}-like key`);
  }
  assert.deepEqual(bundle.diagnostics[0], { operationId: "op_x", at: "t", status: 422, code: "invalid_command", category: "input", route: "/api/rooms/:roomId/commands" });
});

test("export endpoint is owner-only and leak-free", async t => {
  const { store, origin, ownerKey, accountKey } = await serve(t);
  const secretBody = `export-secret-${randomUUID()}`;
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: randomUUID(), body: secretBody } });
  const invite = store.invites.create(ownerKey, "commons", { permissions: ["steer"] });
  const otherKey = store.issueAccessKey("commons", "owner");
  // Trigger a diagnostic record: an authenticated but invalid command.
  await authPost(origin, "/api/rooms/commons/commands", { id: randomUUID(), type: "nope.invalid", data: {} }, ownerKey);

  const headers = await ownerSession(origin, accountKey);
  const raw = await fetch(`${origin}/api/rooms/commons/diagnostics-export`, { headers });
  const res = { status: raw.status, json: await raw.json().catch(() => null), disposition: raw.headers.get("content-disposition") };
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.match(res.disposition ?? "", /attachment/);
  const bundle = res.json;
  assert.equal(bundle.format, "project-room-support-export-v1");
  assert.equal(bundle.room.id, "commons");
  assert.ok(bundle.service.sourceRevision, "export carries the service revision");
  assert.ok(bundle.diagnostics.length >= 1, "the failed command was recorded");
  for (const entry of bundle.diagnostics) {
    assert.match(entry.operationId, /^op_/);
    assert.ok(["access", "not_found", "conflict", "rate_limited", "unavailable", "internal", "input"].includes(entry.category));
  }
  const serialized = JSON.stringify(bundle);
  for (const secret of [secretBody, invite.code, invite.codeHash, ownerKey, otherKey]) {
    assert.ok(!serialized.includes(secret), "export must not contain secrets, hashes, or message bodies");
  }
  const keys = deepKeys(bundle).map(k => k.toLowerCase());
  for (const banned of ["token", "hash", "secret", "password", "credential", "body"]) {
    assert.ok(!keys.some(k => k.includes(banned)), `export must not contain a ${banned}-like key`);
  }
});

test("non-owners cannot pull the support export", async t => {
  const { store, origin, ownerKey } = await serve(t);
  const invite = store.invites.create(ownerKey, "commons", { permissions: ["steer"] });
  const redeemed = await authPost(origin, "/api/agent-invites/redeem", { code: invite.code, displayName: "Export Snooper" });
  assert.equal(redeemed.status, 201);
  const agentToken = redeemed.json.secret;
  const res = await authGet(origin, "/api/rooms/commons/diagnostics-export", agentToken);
  assert.ok([401, 403].includes(res.status), `agent member must be refused, got ${res.status}`);
  const anon = await authGet(origin, "/api/rooms/commons/diagnostics-export", "bogus");
  assert.equal(anon.status, 401);
});

test("owner room bearer can pull the export (CLI path)", async t => {
  const { origin, ownerKey } = await serve(t);
  const res = await authGet(origin, "/api/rooms/commons/diagnostics-export", ownerKey);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.format, "project-room-support-export-v1");
});
