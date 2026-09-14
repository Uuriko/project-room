import test from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

// Re-audit 2026-09-14 Low findings L1 to L6: every room route shares one
// funnel, agent-invite methods honour the session fence, open routes rate
// limit before reading a body, the NDJSON import reader carries the same
// guards as body(), non-room 5xx leave an operator trace, and the invite
// audit never returns a stored code hash.

const sha256 = text => createHash("sha256").update(text).digest("hex");

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-route-hardening-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.bindHumanAccount("commons", "owner", "account-owner");
  const accountKey = store.issueAccountAccessKey("account-owner");
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { method = "GET", data, headers = {}, token, body, contentType } = {}) =>
    fetch(`${origin}${path}`, { method, headers: { Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(data !== undefined || body !== undefined ? { "Content-Type": contentType ?? "application/json" } : {}), ...headers },
    ...(data !== undefined ? { body: JSON.stringify(data) } : body !== undefined ? { body } : {}) });
  const post = (body, replyToId = null) => store.command(ownerKey, "commons",
    { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: randomUUID(), body, ...(replyToId ? { replyToId } : {}) } }).event.data.messageId;
  return { store, server, origin, request, ownerKey, accountKey, post };
}

async function loginAccount(request, accountKey) {
  const bootstrapResponse = await request("/api/account-session");
  assert.equal(bootstrapResponse.status, 200);
  const cookie = bootstrapResponse.headers.get("set-cookie").split(";", 1)[0];
  const bootstrap = await bootstrapResponse.json();
  const response = await request("/api/account-session", { method: "POST", headers: { Cookie: cookie, "X-CSRF-Token": bootstrap.csrf },
    data: { accountAccessKey: accountKey, expectedSessionRevision: bootstrap.sessionRevision } });
  assert.equal(response.status, 201);
  return { cookie, token: cookie.split("=")[1], session: await response.json() };
}

// Raw HTTP over a socket, for requests fetch() cannot shape (a Content-Length
// with no body, or a body that stops half way).
function rawRequest(origin, { method, path, headers, body = "", contentLength = Buffer.byteLength(body), destroyAfterBody = false, waitMs = 4000 }) {
  const { hostname, port } = new URL(origin);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port), hostname);
    let response = "";
    const timer = setTimeout(() => { socket.destroy(); resolve({ timedOut: true, response }); }, waitMs);
    timer.unref();
    socket.on("connect", () => {
      const head = [`${method} ${path} HTTP/1.1`, `Host: ${new URL(origin).host}`, `Origin: ${origin}`, `Content-Length: ${contentLength}`,
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`), "", ""].join("\r\n");
      socket.write(head + body);
      if (destroyAfterBody) setTimeout(() => { clearTimeout(timer); socket.destroy(); resolve({ destroyed: true, response }); }, 50);
    });
    socket.on("data", chunk => { response += chunk.toString(); if (/\r\n\r\n/.test(response)) { clearTimeout(timer); socket.destroy(); resolve({ response }); } });
    socket.on("error", error => { clearTimeout(timer); resolve({ error, response }); });
  });
}

const status = raw => Number(/^HTTP\/1\.1 (\d{3})/.exec(raw.response ?? "")?.[1]);

test("L1: the thread route runs through the shared room funnel", async t => {
  const { origin, request, ownerKey, accountKey, post } = await serve(t);
  const root = post("root");
  post("reply", root);
  const ok = await request(`/api/rooms/commons/messages/${root}/thread`, { token: ownerKey });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).thread.replies.length, 1);
  // Malformed ids are decoded and refused by pathId like every sibling route.
  for (const path of ["/api/rooms/%ZZ/messages/x/thread", `/api/rooms/commons/messages/%ZZ/thread`, "/api/rooms/commons/messages/__proto__/thread"]) {
    const res = await request(path, { token: ownerKey });
    assert.equal(res.status, 404, path);
    assert.equal((await res.json()).error.code, "not_found");
  }
  // A bearer account session is refused here exactly as on the sibling events
  // route (the funnel authenticates with allowAccountSession: false).
  const account = await loginAccount(request, accountKey);
  const bearerAccount = await request(`/api/rooms/commons/messages/${root}/thread`, { token: account.token });
  const bearerSibling = await request("/api/rooms/commons/events", { token: account.token });
  assert.equal(bearerAccount.status, 401);
  assert.equal(bearerSibling.status, bearerAccount.status);
  assert.equal((await bearerAccount.json()).error.code, "unauthenticated");
  await bearerSibling.text();
  // The same account as a browser session (cookie plus binding) still reads the thread.
  const cookieAccount = await request(`/api/rooms/commons/messages/${root}/thread`, { headers: { Cookie: account.cookie,
    "X-Project-Room-Auth": "account", "X-Session-Binding": account.session.sessionBinding } });
  assert.equal(cookieAccount.status, 200);
  const staleFence = await request(`/api/rooms/commons/messages/${root}/thread`, { headers: { Cookie: account.cookie,
    "X-Project-Room-Auth": "account", "X-Session-Binding": "f".repeat(64) } });
  assert.equal(staleFence.status, 409);
  assert.equal((await staleFence.json()).error.code, "session_binding_changed");
  // Non-GET methods fall through to the funnel's 405, not a 404.
  assert.equal((await request(`/api/rooms/commons/messages/${root}/thread`, { method: "POST", token: ownerKey, data: {} })).status, 405);
});

test("L1: thread reads share the per-credential read rate limit", async t => {
  const { origin, request, ownerKey, post } = await serve(t);
  const root = post("root");
  let limited = null;
  for (let index = 0; index < 601 && limited === null; index += 1) {
    const res = await request(`/api/rooms/commons/messages/${root}/thread`, { token: ownerKey });
    if (res.status === 429) limited = { index, retryAfter: res.headers.get("retry-after"), body: await res.json() };
    else { assert.equal(res.status, 200); await res.text().catch(() => {}); }
  }
  assert.ok(limited, "the 601st thread read within a minute is rate limited");
  assert.equal(limited.index, 600);
  assert.equal(limited.body.error.code, "rate_limited");
  assert.equal(limited.retryAfter, "60");
});

test("L2: agent-invite list, create and revoke honour the session-binding fence", async t => {
  const { store, ownerKey } = await serve(t);
  const staleFence = "f".repeat(64);
  const fenced = error => error.status === 409 && error.code === "session_binding_changed";
  // A room access key has no session binding, so any expected fence is a mismatch.
  assert.throws(() => store.invites.list(ownerKey, "commons", staleFence), fenced);
  assert.throws(() => store.invites.create(ownerKey, "commons", { permissions: ["accept_work"] }, staleFence), fenced);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM agent_invite_codes").get().n, 0, "a fenced create writes nothing");
  const minted = store.invites.create(ownerKey, "commons", { permissions: ["accept_work"] });
  assert.throws(() => store.invites.revoke(ownerKey, "commons", minted.inviteId, staleFence), fenced);
  assert.equal(store.db.prepare("SELECT revoked_at FROM agent_invite_codes").get().revoked_at, null, "a fenced revoke writes nothing");
  // The default (no fence) keeps working.
  assert.ok(store.invites.list(ownerKey, "commons").some(row => row.inviteId === minted.inviteId));
  assert.equal(store.invites.revoke(ownerKey, "commons", minted.inviteId).revoked, true);
});

test("L2: the router passes the request's session fence to every agent-invite method", async t => {
  const { store, request, accountKey } = await serve(t);
  const account = await loginAccount(request, accountKey);
  const headers = { Cookie: account.cookie, "X-Project-Room-Auth": "account", "X-Session-Binding": account.session.sessionBinding, "X-CSRF-Token": account.session.csrf };
  const seen = {};
  for (const name of ["list", "create", "revoke"]) {
    const original = store.invites[name].bind(store.invites);
    t.mock.method(store.invites, name, (...args) => { seen[name] = args.at(-1); return original(...args); });
  }
  const created = await request("/api/rooms/commons/agent-invites", { method: "POST", headers, data: { permissions: ["accept_work"] } });
  assert.equal(created.status, 201);
  const { inviteId } = await created.json();
  assert.equal((await request("/api/rooms/commons/agent-invites", { headers })).status, 200);
  assert.equal((await request("/api/rooms/commons/agent-invites", { method: "DELETE", headers, data: { inviteId } })).status, 200);
  assert.deepEqual(seen, { list: account.session.sessionBinding, create: account.session.sessionBinding, revoke: account.session.sessionBinding });
});

test("L3: identity creation and invite redemption rate limit before reading the body", async t => {
  const { request } = await serve(t);
  // A request the body reader would refuse (wrong media type) still counts
  // toward the per-address allowance, so the limiter is what answers first
  // once the allowance is spent.
  for (const [path, allowance] of [["/api/agent-identities", 30], ["/api/agent-invites/redeem", 20]]) {
    for (let index = 0; index < allowance; index += 1) {
      const res = await request(path, { method: "POST", body: "displayName=x", contentType: "text/plain" });
      assert.equal(res.status, 415, `${path} request ${index + 1}`);
      await res.text();
    }
    const limited = await request(path, { method: "POST", body: "displayName=x", contentType: "text/plain" });
    assert.equal(limited.status, 429, path);
    assert.equal((await limited.json()).error.code, "rate_limited");
  }
});

test("L4: the NDJSON import refuses an oversized Content-Length before reading", async t => {
  const { origin, ownerKey } = await serve(t);
  const headers = { Authorization: `Bearer ${ownerKey}`, "Content-Type": "application/x-ndjson" };
  const oversized = await rawRequest(origin, { method: "POST", path: "/api/rooms/commons/import", headers, contentLength: 8 * 1024 * 1024 + 1 });
  assert.equal(oversized.timedOut, undefined, "the refusal arrives without waiting for the body");
  assert.equal(status(oversized), 413);
  assert.match(oversized.response, /"code":"too_large"/);
  // Streamed bytes past the cap are refused too, and a well-formed small import still works.
  const chunked = await fetch(`${origin}/api/rooms/commons/import`, { method: "POST", headers: { Origin: origin, ...headers },
    body: Buffer.alloc(8 * 1024 * 1024 + 16, 0x20) });
  assert.equal(chunked.status, 413);
  assert.equal((await chunked.json()).error.code, "too_large");
  const wrongType = await fetch(`${origin}/api/rooms/commons/import`, { method: "POST", headers: { Origin: origin, Authorization: headers.Authorization, "Content-Type": "application/json" }, body: "{}\n" });
  assert.equal(wrongType.status, 415);
});

test("L4: an import whose client stops sending fails at once with 400 aborted", async t => {
  const { origin, ownerKey, request, accountKey } = await serve(t);
  const account = await loginAccount(request, accountKey);
  const ownerHeaders = { Cookie: account.cookie, "X-Project-Room-Auth": "account", "X-Session-Binding": account.session.sessionBinding };
  const headers = { Authorization: `Bearer ${ownerKey}`, "Content-Type": "application/x-ndjson" };
  const partial = await rawRequest(origin, { method: "POST", path: "/api/rooms/commons/import", headers, body: '{"sequence":1', contentLength: 4096, destroyAfterBody: true });
  assert.equal(partial.destroyed, true);
  // The failed request is recorded in the room diagnostics as an aborted
  // input, which only happens when the reader rejects instead of waiting
  // for the 15 s server request timeout.
  let record;
  for (let attempt = 0; attempt < 40 && !record; attempt += 1) {
    const res = await request("/api/rooms/commons/diagnostics", { headers: ownerHeaders });
    assert.equal(res.status, 200);
    record = (await res.json()).diagnostics.find(item => item.route === "/api/rooms/:roomId/import");
    if (!record) await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(record, "the aborted import is recorded within two seconds");
  assert.equal(record.status, 400);
  assert.equal(record.code, "aborted");
  assert.equal(record.category, "input");
});

test("L5: a 5xx on a non-room route is logged with the operation id and static route only", async t => {
  const { store, request } = await serve(t);
  const warn = t.mock.method(console, "warn", () => {});
  const marker = `boom-${randomUUID()}`;
  store.createAccountSessionSlot = () => { throw new Error(`database exploded ${marker}`); };
  const res = await request(`/api/account-session?note=${marker}`, { headers: { Cookie: `account_session=${"Q".repeat(43)}`, "X-Debug": marker } });
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.error.code, "internal_error");
  assert.equal(body.error.message.includes(marker), false, "the client never sees the error message");
  const lines = warn.mock.calls.map(call => call.arguments.join(" "));
  const line = lines.find(text => text.startsWith("service diagnostic "));
  assert.ok(line, `expected a service diagnostic line, saw ${JSON.stringify(lines)}`);
  assert.equal(line, `service diagnostic ${body.operationId} 500 internal_error internal /api/account-session`);
  assert.equal(line.includes(marker), false, "no query string, header or error message reaches the log");
  assert.equal(line.includes("Q".repeat(43)), false, "no cookie reaches the log");
  // Path ids are templated out, and 4xx outside a room scope stay quiet.
  const before = warn.mock.calls.length;
  store.accountSessionSlot = () => { throw new Error(`slot exploded ${marker}`); };
  const share = await request(`/api/share-links/join`, { method: "POST", headers: { Cookie: `account_session=${"Q".repeat(43)}` }, data: {} });
  assert.equal(share.status, 500);
  const shareLine = warn.mock.calls.slice(before).map(call => call.arguments.join(" ")).find(text => text.startsWith("service diagnostic "));
  assert.equal(shareLine, `service diagnostic ${(await share.json()).operationId} 500 internal_error internal /api/share-links/join`);
  const quietBefore = warn.mock.calls.length;
  assert.equal((await request(`/api/inbox/sources/${randomUUID()}/reply-review?view=reply-review-v1`)).status, 422);
  assert.equal((await request("/api/definitely-not-here")).status, 404);
  assert.equal(warn.mock.calls.length, quietBefore, "4xx outside a room scope is not logged");
});

test("L5: non-room 5xx route templates replace ids with :item", async t => {
  const { store, request, accountKey } = await serve(t);
  const warn = t.mock.method(console, "warn", () => {});
  const account = await loginAccount(request, accountKey);
  store.inbox.replyReviewContext = () => { throw new Error("projection exploded"); };
  const sourceId = `src-${randomUUID()}`;
  const res = await request(`/api/inbox/sources/${sourceId}/reply-review?view=reply-review-v1`, { headers: { Cookie: account.cookie, "X-Session-Binding": account.session.sessionBinding } });
  assert.equal(res.status, 500);
  const lines = warn.mock.calls.map(call => call.arguments.join(" ")).filter(text => text.startsWith("service diagnostic "));
  assert.equal(lines.length, 1);
  assert.equal(lines[0], `service diagnostic ${(await res.json()).operationId} 500 internal_error internal /api/inbox/sources/:item/reply-review`);
  assert.equal(lines[0].includes(sourceId), false);
  assert.equal(lines[0].includes(account.session.sessionBinding), false);
});

test("L6: the agent-invite audit and revoke handle never carry a stored code hash", async t => {
  const { store, request, ownerKey } = await serve(t);
  // A legacy 8-symbol code stored as bare sha256 sits next to a v2 code.
  const legacy = "RM-7K2P9QXZ";
  const now = Date.now();
  store.db.prepare(`INSERT INTO agent_invite_codes(code_hash,room_id,created_by,permissions_json,display_name,created_at,expires_at)
    VALUES(?,?,?,?,?,?,?)`).run(sha256(legacy), "commons", "owner", JSON.stringify(["accept_work"]), "Legacy Bot", now, now + 3600000);
  const minted = await request("/api/rooms/commons/agent-invites", { method: "POST", token: ownerKey, data: { permissions: ["accept_work"] } });
  assert.equal(minted.status, 201);
  const created = await minted.json();
  assert.match(created.inviteId, /^[a-f0-9]{8}$/);
  assert.equal(Object.keys(created).some(key => /hash/i.test(key)), false);
  const hashes = store.db.prepare("SELECT code_hash FROM agent_invite_codes").all().map(row => row.code_hash);
  assert.equal(hashes.length, 2);
  const listed = await request("/api/rooms/commons/agent-invites", { token: ownerKey });
  assert.equal(listed.status, 200);
  const audit = await listed.json();
  const serialized = JSON.stringify(audit);
  for (const hash of hashes) assert.equal(serialized.includes(hash), false, "a stored hash appears in the listing");
  assert.equal(/[a-f0-9]{64}/.test(serialized), false, "no 64-hex value in the listing");
  assert.equal(serialized.includes(sha256(legacy)), false);
  assert.deepEqual(audit.invites.map(row => row.inviteId).sort(), hashes.map(hash => hash.slice(0, 8)).sort());
  for (const row of audit.invites) assert.equal(Object.keys(row).some(key => /hash/i.test(key)), false, JSON.stringify(Object.keys(row)));
  // The handle revokes exactly its row; the full hash is not accepted as a handle.
  const legacyId = sha256(legacy).slice(0, 8);
  const revoked = await request("/api/rooms/commons/agent-invites", { method: "DELETE", token: ownerKey, data: { inviteId: legacyId } });
  assert.equal(revoked.status, 200);
  assert.deepEqual(await revoked.json(), { inviteId: legacyId, revoked: true });
  assert.equal(store.db.prepare("SELECT revoked_at FROM agent_invite_codes WHERE code_hash=?").get(sha256(legacy)).revoked_at > 0, true);
  assert.equal(store.db.prepare("SELECT revoked_at FROM agent_invite_codes WHERE code_hash<>?").get(sha256(legacy)).revoked_at, null);
  const byHash = await request("/api/rooms/commons/agent-invites", { method: "DELETE", token: ownerKey, data: { inviteId: sha256(legacy) } });
  assert.equal(byHash.status, 422);
  assert.equal((await request("/api/rooms/commons/agent-invites", { method: "DELETE", token: ownerKey, data: { codeHash: sha256(legacy) } })).status, 422);
});

test("L6: a handle shared by two active rows revokes neither", async t => {
  const { store, ownerKey } = await serve(t);
  const now = Date.now();
  const insert = store.db.prepare(`INSERT INTO agent_invite_codes(code_hash,room_id,created_by,permissions_json,display_name,created_at,expires_at)
    VALUES(?,?,?,?,?,?,?)`);
  insert.run("ab".repeat(4) + "0".repeat(56), "commons", "owner", JSON.stringify(["accept_work"]), null, now, now + 3600000);
  insert.run("ab".repeat(4) + "1".repeat(56), "commons", "owner", JSON.stringify(["accept_work"]), null, now, now + 3600000);
  assert.throws(() => store.invites.revoke(ownerKey, "commons", "ab".repeat(4)), error => error.status === 409 && error.code === "invite_ambiguous");
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM agent_invite_codes WHERE revoked_at IS NOT NULL").get().n, 0);
});
