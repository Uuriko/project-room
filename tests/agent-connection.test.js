import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, chmodSync, symlinkSync, linkSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RoomAgentClient, RoomClientError } from "../client/room-agent.mjs";
import { saveAgentConnection, readAgentConnection, agentConnectionFromEnvironment, connectionDiagnostic, ConnectionError } from "../client/agent-connection.mjs";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const config = { version: 1, origin: "https://room.example", roomId: "commons", memberId: "agent-one", token: "T".repeat(43) };
const session = () => ({ authMode: "room", roomId: "commons", member: { id: "agent-one", kind: "agent", active: true,
  revision: 0, permissions: [], displayName: "PRIVATE_NAME", accountableHumanId: "PRIVATE_SPONSOR" },
  account: null, csrf: null, sessionBinding: null, sessionRevision: null, expiresAt: Date.now() + 3600000, extra: "PRIVATE_EXTRA" });
const isCode = code => error => error.code === code;
function directory(t) {
  const path = mkdtempSync(join(tmpdir(), "room-agent-connection-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
function environment(values = {}) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith("ROOM_AGENT_") || name === "NODE_OPTIONS") delete env[name];
  return { ...env, ...values };
}
async function cli(args, env) {
  try { return { ...(await promisify(execFile)(process.execPath, ["scripts/agent-inbox.mjs", ...args], {
    env: environment(env), encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024
  })), status: 0 }; }
  catch (error) { return { stdout: error.stdout, stderr: error.stderr, status: error.code }; }
}

test("connection check is one bounded metadata read with an explicit safe projection", async () => {
  let count = 0;
  const client = new RoomAgentClient({ ...config, fetchImpl: async (url, options) => {
    count++; assert.equal(url, "https://room.example/api/session"); assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error"); assert.equal(options.credentials, "omit");
    assert.equal(options.headers.Authorization, `Bearer ${config.token}`); assert.equal(options.body, undefined);
    assert.ok(options.signal instanceof AbortSignal); return Response.json(session());
  } });
  const result = await client.checkConnection();
  assert.equal(count, 1); assert.equal(result.status, "credential_accepted"); assert.equal(result.memberId, "agent-one");
  assert.equal(result.externalExecution, false); assert.equal(result.scope, "room"); assert.deepEqual(result.permissions, []);
  assert.deepEqual(Object.keys(result).sort(), ["contractVersion", "type", "status", "origin", "roomId", "memberId", "kind", "permissions", "checkedAt", "expiresAt", "scope", "externalExecution"].sort());
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|token|online|working/);
});

test("connection metadata rejects another identity, human authority, invalid metadata and uncertain expiry", async () => {
  const cases = [
    [v => { v.roomId = "elsewhere"; }, "identity_mismatch"],
    [v => { v.member.id = "another-agent"; }, "identity_mismatch"],
    [v => { v.member.kind = "human"; }, "identity_mismatch"],
    [v => { v.member.active = false; }, "identity_mismatch"],
    ...["account", "csrf", "sessionBinding", "sessionRevision"].map(field => [v => { v[field] = "private"; }, "identity_mismatch"]),
    [v => { v.member.permissions = ["manage_members"]; }, "identity_mismatch"],
    [v => { v.member.permissions = ["decide"]; }, "identity_mismatch"],
    [v => { v.member.permissions = ["verify", "verify"]; }, "invalid_response"],
    [v => { v.member.permissions = ["unknown"]; }, "invalid_response"],
    [v => { v.member.permissions = null; }, "invalid_response"],
    [v => { v.member.revision = -1; }, "invalid_response"],
    [v => { v.expiresAt = "tomorrow"; }, "invalid_response"],
    [v => { v.expiresAt = Number.MAX_SAFE_INTEGER; }, "invalid_response"],
    [v => { v.expiresAt = Date.now() - 1; }, "expiry_unconfirmed"],
    [v => { delete v.authMode; }, "invalid_response"]
  ];
  for (const [change, code] of cases) {
    const value = session(); change(value);
    const client = new RoomAgentClient({ ...config, fetchImpl: async () => Response.json(value) });
    await assert.rejects(client.checkConnection(), isCode(code));
  }
  for (const value of [null, [], {}, { member: {} }]) {
    await assert.rejects(new RoomAgentClient({ ...config, fetchImpl: async () => Response.json(value) }).checkConnection(), isCode("invalid_response"));
  }
  await assert.rejects(new RoomAgentClient({ ...config, memberId: undefined, fetchImpl: () => assert.fail("No network") }).checkConnection(), isCode("member_required"));
});

test("pinned operations recheck access and reject a mismatched selected response", async () => {
  const requests = [];
  const client = new RoomAgentClient({ ...config, fetchImpl: async (url, options) => {
    requests.push({ path: new URL(url).pathname, method: options.method });
    return Response.json(url.endsWith("/api/session") ? session() : { roomId: "commons", viewerId: "wrong-member" });
  } });
  await assert.rejects(client.snapshot(), isCode("identity_mismatch"));
  await assert.rejects(client.workContext("task"), isCode("identity_mismatch"));
  assert.deepEqual(requests.map(request => request.path), ["/api/session", "/api/rooms/commons", "/api/session", "/api/rooms/commons/work-context"]);
  assert.ok(requests.every(request => request.method === "GET"));
  let requestsAfterFailure = 0;
  const denied = new RoomAgentClient({ ...config, fetchImpl: async () => { requestsAfterFailure++; return Response.json({ error: { code: "unauthenticated" } }, { status: 401 }); } });
  await assert.rejects(denied.command({ id: "never-sent" }), error => error.status === 401);
  assert.equal(requestsAfterFailure, 1, "no write follows failed access check");
});

test("transport failures, cancellation, malformed JSON and rate limits have fixed bounded diagnostics", async () => {
  const privateText = `PRIVATE_DETAIL ${config.token}`;
  for (const [status, code] of [[401, "access_ended"], [403, "access_ended"], [404, "unavailable_route"], [429, "rate_limited"], [503, "service_unavailable"]]) {
    const client = new RoomAgentClient({ ...config, fetchImpl: async () => Response.json({ error: { code: privateText, message: privateText } }, { status, headers: { "retry-after": "2" } }) });
    try { await client.checkConnection(); assert.fail("must reject"); } catch (error) {
      const output = connectionDiagnostic(error); assert.equal(output.code, code);
      assert.ok(!JSON.stringify(output).includes(privateText));
      if (status === 429) assert.equal(output.retryAfterMs, 2000);
    }
  }
  for (const [error, code] of [[new TypeError(privateText), "service_unavailable"],
    [new DOMException(privateText, "TimeoutError"), "request_timeout"], [new DOMException(privateText, "AbortError"), "cancelled"]]) {
    assert.equal(connectionDiagnostic(error).code, code); assert.ok(!JSON.stringify(connectionDiagnostic(error)).includes(config.token));
  }
  const malformed = new RoomAgentClient({ ...config, fetchImpl: async () => new Response("<html>PRIVATE_DETAIL</html>") });
  await assert.rejects(malformed.checkConnection(), isCode("invalid_response"));
  const controller = new AbortController(); controller.abort();
  const cancelled = new RoomAgentClient({ ...config, fetchImpl: async (_, options) => { options.signal.throwIfAborted(); } });
  await assert.rejects(cancelled.checkConnection({ signal: controller.signal }), error => error.name === "AbortError");
  assert.equal(connectionDiagnostic(new RoomClientError(429, "limited", privateText, 300001)).retryAfterMs, undefined);
  for (const code of ["host_denied", "origin_denied", "proxy_denied"]) assert.equal(connectionDiagnostic(new RoomClientError(403, code, privateText)).code, "invalid_config");
});

test("private connection persistence is exclusive, strict, bounded and unambiguous", t => {
  const root = directory(t), path = join(root, "agent");
  saveAgentConnection(path, config);
  assert.equal(statSync(path).mode & 0o777, 0o700);
  assert.equal(statSync(join(path, "connection.json")).mode & 0o777, 0o600);
  assert.deepEqual(readAgentConnection(path), config);
  assert.deepEqual(agentConnectionFromEnvironment({ ROOM_AGENT_CONFIG: path }), config);
  const before = readFileSync(join(path, "connection.json"));
  assert.throws(() => saveAgentConnection(path, { ...config, token: "X".repeat(43) }), isCode("config_exists"));
  assert.deepEqual(readFileSync(join(path, "connection.json")), before);
  for (const name of ["ROOM_AGENT_ORIGIN", "ROOM_AGENT_ROOM", "ROOM_AGENT_MEMBER", "ROOM_AGENT_TOKEN"]) {
    assert.throws(() => agentConnectionFromEnvironment({ ROOM_AGENT_CONFIG: path, [name]: "" }), isCode("ambiguous_config"));
  }
  for (const value of [{ ...config, extra: true }, { ...config, version: 2 }, { ...config, memberId: undefined },
    ...["http://external.example", "https://room.example/", "https://room.example/#join/private", "https://user:password@room.example", "https://" + "a".repeat(4096) + ".example"].map(origin => ({ ...config, origin }))]) {
    const destination = join(root, "not-created");
    assert.throws(() => saveAgentConnection(destination, value), isCode("invalid_config")); assert.equal(existsSync(destination), false);
  }
  assert.deepEqual(agentConnectionFromEnvironment({ ROOM_AGENT_ORIGIN: config.origin, ROOM_AGENT_ROOM: config.roomId, ROOM_AGENT_TOKEN: config.token }),
    { origin: config.origin, roomId: config.roomId, token: config.token });
});

test("private configuration rejects permissive files/directories, links, extra fields and oversized content", t => {
  const root = directory(t);
  for (const fault of ["file-mode", "directory-mode", "directory-link", "file-link", "hard-link", "file-directory", "oversized", "extra", "partial"]) {
    const path = join(root, fault); saveAgentConnection(path, config);
    const file = join(path, "connection.json");
    if (fault === "file-mode") chmodSync(file, 0o644);
    else if (fault === "directory-mode") chmodSync(path, 0o755);
    else if (fault === "directory-link") { symlinkSync(path, path + "-link"); assert.throws(() => readAgentConnection(path + "-link"), isCode("config_not_private")); continue; }
    else if (fault === "file-link") { rmSync(file); symlinkSync(join(root, "file-mode", "connection.json"), file); }
    else if (fault === "hard-link") linkSync(file, join(root, "extra-link"));
    else if (fault === "file-directory") { rmSync(file); mkdirSync(file, { mode: 0o700 }); }
    else writeFileSync(file, fault === "oversized" ? " ".repeat(4097) : fault === "extra" ? JSON.stringify({ ...config, extra: "no" }) : "{");
    assert.throws(() => readAgentConnection(path), error => error instanceof ConnectionError);
  }
});

test("real connection, CLI save/check/task/watch and revocation preserve room authority and state", async t => {
  const path = directory(t), store = new RoomStore(join(path, "fixture.sqlite"));
  store.initialize(initialRoom()); const owner = store.issueAccessKey("commons", "owner");
  store.command(owner, "commons", { id: "add-agent", type: T.MEMBER_ADDED, data: {
    memberId: "agent-one", displayName: "Scripted connection fixture", kind: "agent", permissions: [], accountableHumanId: "owner"
  } });
  const token = store.issueAccessKey("commons", "agent-one");
  store.command(owner, "commons", { id: "task", type: T.WORK_PROPOSED, data: {
    workItemId: "one-task", title: "Read only", definitionOfDone: "Check one task without starting work.", accountableMemberId: "owner", mode: "read"
  } });
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const rows = () => JSON.stringify(Object.fromEntries(["rooms", "events", "commands", "credentials", "cursors", "member_accounts"].map(name => [name, store.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()])));
  const before = rows(), client = new RoomAgentClient({ ...config, origin, token });
  assert.equal((await client.checkConnection()).memberId, "agent-one");
  assert.equal((await client.workContext("one-task")).context.source.status, "not_requested");
  assert.equal((await client.snapshot()).viewerId, "agent-one");
  const saved = join(path, "saved connection");
  const vars = { ROOM_AGENT_ORIGIN: origin, ROOM_AGENT_ROOM: "commons", ROOM_AGENT_MEMBER: "agent-one", ROOM_AGENT_TOKEN: token };
  const connected = await cli(["connect", saved], vars);
  assert.equal(connected.status, 0, connected.stderr); assert.equal(JSON.parse(connected.stdout).configurationSaved, true);
  for (const args of [["check"], ["work", "one-task"], ["brief"]]) {
    const result = await cli(args, { ROOM_AGENT_CONFIG: saved });
    assert.equal(result.status, 0, result.stderr); assert.ok(!result.stdout.includes(token));
  }
  const watch = await cli(["watch", "start", join(path, "watch"), "--once"], { ROOM_AGENT_CONFIG: saved });
  assert.equal(watch.status, 0, watch.stderr); assert.equal(watch.stdout, "");
  assert.equal(rows(), before, "checks and reads do not modify Room data, credentials or caught-up markers");
  const wrong = await cli(["connect", join(path, "wrong")], { ...vars, ROOM_AGENT_MEMBER: "another-agent" });
  assert.equal(wrong.status, 1); assert.equal(JSON.parse(wrong.stderr).code, "identity_mismatch"); assert.equal(existsSync(join(path, "wrong")), false);
  await assert.rejects(new RoomAgentClient({ ...config, origin, token: owner, memberId: "owner" }).checkConnection(), isCode("identity_mismatch"));
  const rotated = store.issueAccessKey("commons", "agent-one");
  await assert.rejects(client.checkConnection(), error => error.status === 401);
  const renewedPath = join(path, "renewed"); saveAgentConnection(renewedPath, { ...config, origin, token: rotated });
  const resumed = await cli(["watch", "start", join(path, "watch"), "--once"], { ROOM_AGENT_CONFIG: renewedPath });
  assert.equal(resumed.status, 0, resumed.stderr); assert.equal(resumed.stdout, "", "same-member rotation preserves watcher history binding");
  store.revoke(rotated);
  const denied = await cli(["watch", "start", join(path, "denied-watch"), "--once"], { ROOM_AGENT_CONFIG: renewedPath });
  assert.equal(denied.status, 1); assert.equal(existsSync(join(path, "denied-watch")), false, "failed preflight creates no watcher state");
  assert.deepEqual(readAgentConnection(saved), { ...config, origin, token }, "failed access never rewrites the secret");
});

test("CLI help and invalid syntax are credential-free and expose no input text", async () => {
  const help = await cli(["--help"], {}); assert.equal(help.status, 0); assert.match(help.stdout, /connect NEW_PRIVATE_DIRECTORY/);
  for (const args of [["check", config.token], ["connect"], ["changes"], ["changes", "-1"], ["work", "one", "--wrong"], ["unknown"]]) {
    const result = await cli(args, {}); assert.equal(result.status, 1); assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).code, "usage_error"); assert.ok(!result.stderr.includes(config.token));
  }
});
