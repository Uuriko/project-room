import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { errorCategory } from "../src/agent-error.mjs";
import { DiagnosticsLog } from "../server/diagnostics.mjs";

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-diagnostics-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  store.bindHumanAccount("commons", "owner", "account-owner");
  store.createAccount("account-other");
  const accountKeys = {
    owner: store.issueAccountAccessKey("account-owner"),
    other: store.issueAccountAccessKey("account-other")
  };
  const server = createRoomServer({ store, streamInterval: 15 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const request = (path, { method = "GET", data, headers = {} } = {}) =>
    fetch(`${origin}${path}`, { method, headers: { ...(data === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  return { store, origin, request, accountKeys };
}

function accountCookie(response) {
  const value = response.headers.get("set-cookie");
  assert.match(value, /^account_session=[A-Za-z0-9_-]{43};/);
  return value.split(";", 1)[0];
}

async function loginAccount(request, origin, accountAccessKey) {
  const bootstrapResponse = await request("/api/account-session");
  assert.equal(bootstrapResponse.status, 200);
  const cookie = accountCookie(bootstrapResponse);
  const bootstrap = await bootstrapResponse.json();
  const response = await request("/api/account-session", {
    method: "POST",
    headers: { Cookie: cookie, Origin: origin, "X-CSRF-Token": bootstrap.csrf },
    data: { accountAccessKey, expectedSessionRevision: bootstrap.sessionRevision }
  });
  assert.equal(response.status, 201);
  return { cookie, session: await response.json() };
}

function accountRoomHeaders(account) {
  return { Cookie: account.cookie, "X-Project-Room-Auth": "account", "X-Session-Binding": account.session.sessionBinding };
}

test("errorCategory maps status and code to the documented taxonomy", () => {
  assert.equal(errorCategory(401, "unauthenticated"), "access");
  assert.equal(errorCategory(403, "origin_denied"), "access");
  assert.equal(errorCategory(404, "not_found"), "not_found");
  assert.equal(errorCategory(404, "work_not_found"), "not_found");
  assert.equal(errorCategory(422, "work_not_found"), "not_found");
  assert.equal(errorCategory(409, "session_binding_changed"), "conflict");
  assert.equal(errorCategory(422, "command_rejected"), "conflict");
  assert.equal(errorCategory(422, "idempotency_conflict"), "conflict");
  assert.equal(errorCategory(422, "stale_revision"), "conflict");
  assert.equal(errorCategory(429, "rate_limited"), "rate_limited");
  assert.equal(errorCategory(503, "maintenance"), "unavailable");
  assert.equal(errorCategory(500, "internal_error"), "internal");
  assert.equal(errorCategory(422, "invalid_work_context"), "input");
  assert.equal(errorCategory(400, "invalid_json"), "input");
  assert.equal(errorCategory(413, "too_large"), "input");
  assert.equal(errorCategory(415, "json_required"), "input");
});

test("DiagnosticsLog retains a bounded FIFO window per room", () => {
  const log = new DiagnosticsLog(3);
  for (let index = 0; index < 5; index += 1) {
    log.record({ operationId: `op_case${index}`, at: `2026-09-10T00:00:0${index}Z`, status: 422, code: "invalid_json",
      category: "input", route: "/api/rooms/:roomId/commands", roomId: "commons" });
  }
  assert.deepEqual(log.list("commons").map(record => record.operationId), ["op_case2", "op_case3", "op_case4"]);
  log.record({ operationId: "op_other", at: "2026-09-10T00:00:05Z", status: 404, code: "not_found",
    category: "not_found", route: "/api/rooms/:roomId", roomId: "second" });
  assert.deepEqual(log.list("second").map(record => record.operationId), ["op_other"]);
  assert.deepEqual(log.list("commons").map(record => record.operationId), ["op_case2", "op_case3", "op_case4"]);
  assert.deepEqual(log.list("unknown"), []);
  for (const record of log.list("commons")) assert.equal("roomId" in record, false, "exported records omit the room id");
});

test("API errors carry a bounded operation ID and category; the header matches the body", async t => {
  const { request } = await fixture(t);
  const response = await request("/api/definitely-not-here");
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.match(body.operationId, /^op_[A-Za-z0-9_-]{8}$/);
  assert.equal(response.headers.get("x-operation-id"), body.operationId);
  assert.equal(body.category, "not_found");
  assert.equal(body.error.code, "not_found");
  assert.equal(body.status, "action_required");
  assert.ok(Array.isArray(body.next), "AX next steps preserved");
});

test("success responses carry the operation header only, unique per request", async t => {
  const { request } = await fixture(t);
  const first = await request("/api/health");
  assert.equal(first.status, 200);
  assert.match(first.headers.get("x-operation-id"), /^op_[A-Za-z0-9_-]{8}$/);
  assert.equal((await first.json()).operationId, undefined);
  const second = await request("/api/health");
  assert.notEqual(second.headers.get("x-operation-id"), first.headers.get("x-operation-id"));
});

test("owner support export returns bounded room diagnostics without credentials or room ids", async t => {
  const { request, origin, accountKeys } = await fixture(t);
  const denied = await request("/api/rooms/commons/events");
  assert.equal(denied.status, 401);
  const operationId = denied.headers.get("x-operation-id");
  assert.match(operationId, /^op_[A-Za-z0-9_-]{8}$/);
  const owner = await loginAccount(request, origin, accountKeys.owner);
  const exportResponse = await request("/api/rooms/commons/diagnostics", { headers: accountRoomHeaders(owner) });
  assert.equal(exportResponse.status, 200);
  const { diagnostics } = await exportResponse.json();
  const record = diagnostics.find(item => item.operationId === operationId);
  assert.ok(record, "export includes the failed operation");
  assert.equal(record.route, "/api/rooms/:roomId/events");
  assert.equal(record.code, "unauthenticated");
  assert.equal(record.category, "access");
  assert.equal(record.status, 401);
  assert.match(record.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.deepEqual(Object.keys(record).sort(), ["at", "category", "code", "operationId", "route", "status"]);
  const raw = JSON.stringify(diagnostics);
  for (const secret of [accountKeys.owner, owner.cookie, owner.session.sessionBinding, owner.session.csrf, "commons"]) {
    assert.equal(raw.includes(secret), false, `export must not contain ${secret.slice(0, 12)}`);
  }
});

test("support export requires a signed-in owner session", async t => {
  const { request, origin, accountKeys } = await fixture(t);
  assert.equal((await request("/api/rooms/commons/diagnostics")).status, 401);
  const other = await loginAccount(request, origin, accountKeys.other);
  const response = await request("/api/rooms/commons/diagnostics", { headers: accountRoomHeaders(other) });
  assert.notEqual(response.status, 200, "a non-owner account never receives diagnostics");
  assert.ok([401, 403].includes(response.status));
  const owner = await loginAccount(request, origin, accountKeys.owner);
  assert.equal((await request("/api/rooms/commons/diagnostics", { headers: accountRoomHeaders(owner) })).status, 200);
});
