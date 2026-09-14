import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RoomStore, ServiceError, StorageUnavailableError, isStorageUnavailable } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const SQLITE_DEFAULT_MAX_PAGES = 1073741823;
// The diagnostics route is owner-only through a signed-in account session.
async function ownerDiagnostics(store, origin) {
  const accountAccessKey = store.issueAccountAccessKey("account-owner");
  const bootstrapResponse = await fetch(`${origin}/api/account-session`);
  const cookie = bootstrapResponse.headers.get("set-cookie").split(";", 1)[0];
  const bootstrap = await bootstrapResponse.json();
  const login = await fetch(`${origin}/api/account-session`, { method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, Origin: origin, "X-CSRF-Token": bootstrap.csrf },
    body: JSON.stringify({ accountAccessKey, expectedSessionRevision: bootstrap.sessionRevision }) });
  assert.equal(login.status, 201);
  const headers = { Cookie: cookie, "X-Project-Room-Auth": "account", "X-Session-Binding": (await login.json()).sessionBinding };
  return async () => {
    const response = await fetch(`${origin}/api/rooms/commons/diagnostics`, { headers });
    assert.equal(response.status, 200);
    return (await response.json()).diagnostics;
  };
}

const command = (type, data, id = crypto.randomUUID()) => ({ id, type, data });
const post = (body = "x".repeat(4000)) => command(T.MESSAGE_POSTED, { messageId: crypto.randomUUID(), body });

async function fixture(t, { storageFailureThreshold = 2 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-storage-failure-"));
  const store = new RoomStore(join(directory, "room.sqlite"), { storageFailureThreshold });
  store.initialize(initialRoom());
  store.bindHumanAccount("commons", "owner", "account-owner");
  const owner = store.issueAccessKey("commons", "owner");
  const warnings = [];
  t.mock.method(console, "warn", line => warnings.push(String(line)));
  const server = createRoomServer({ store, streamInterval: 15 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const request = (path, { method = "GET", data, token = owner } = {}) => fetch(`${origin}${path}`, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) })
  });
  // Pin the database at its current size: the next page allocation is a real SQLITE_FULL from the driver.
  const fill = () => { store.db.exec("VACUUM"); store.db.exec(`PRAGMA max_page_count=${store.db.prepare("PRAGMA page_count").get().page_count}`); };
  const free = () => store.db.exec(`PRAGMA max_page_count=${SQLITE_DEFAULT_MAX_PAGES}`);
  const snapshot = () => ({
    sequence: store.room("commons").sequence,
    projection: JSON.stringify(store.room("commons").state),
    events: store.db.prepare("SELECT count(*) AS n FROM events").get().n,
    commands: store.db.prepare("SELECT count(*) AS n FROM commands").get().n,
    checkpoint: JSON.stringify(store.db.prepare("SELECT sequence,projection FROM projection_checkpoints WHERE room_id='commons'").get() ?? null)
  });
  const diagnostics = await ownerDiagnostics(store, origin);
  return { store, owner, request, fill, free, snapshot, warnings, diagnostics };
}

test("isStorageUnavailable recognizes real driver and file-system exhaustion and nothing else", t => {
  const directory = mkdtempSync(join(tmpdir(), "project-room-storage-classify-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const full = new DatabaseSync(":memory:");
  full.exec("CREATE TABLE t(x); PRAGMA max_page_count=2");
  assert.throws(() => full.prepare("INSERT INTO t VALUES(?)").run("x".repeat(20000)), error => {
    assert.equal(error.errcode, 13); assert.ok(isStorageUnavailable(error)); return true;
  });
  const filename = join(directory, "readonly.sqlite");
  new DatabaseSync(filename).exec("CREATE TABLE t(x)");
  chmodSync(filename, 0o444);
  const readonly = new DatabaseSync(filename, { readOnly: true });
  assert.throws(() => readonly.exec("INSERT INTO t VALUES(1)"), error => { assert.ok(isStorageUnavailable(error)); return true; });
  readonly.close();
  for (const code of ["ENOSPC", "EROFS", "EDQUOT"]) assert.ok(isStorageUnavailable(Object.assign(new Error(code), { code })));
  assert.ok(isStorageUnavailable(new StorageUnavailableError()));
  for (const other of [null, "text", new Error("boom"), new ServiceError(409, "stale_revision", "Stale"),
    Object.assign(new Error("constraint"), { code: "ERR_SQLITE_ERROR", errcode: 19 }), Object.assign(new Error("ENOENT"), { code: "ENOENT" })]) {
    assert.equal(isStorageUnavailable(other), false);
  }
  const typed = new StorageUnavailableError(new Error("database or disk is full"));
  assert.equal(typed.status, 503); assert.equal(typed.code, "storage_unavailable");
  assert.deepEqual(typed.headers, { "Retry-After": "30" });
  assert.doesNotMatch(typed.message, /disk|full/i);
});

test("an injected SQLITE_FULL rolls the command back, returns 503 storage_unavailable and leaks no driver text", async t => {
  const { store, request, fill, free, snapshot, warnings, diagnostics } = await fixture(t);
  const written = await request("/api/rooms/commons/commands", { method: "POST", data: post() });
  assert.equal(written.status, 201);
  fill();
  let refused = null, before = null;
  for (let attempt = 0; attempt < 12 && !refused; attempt++) {
    before = snapshot();
    const response = await request("/api/rooms/commons/commands", { method: "POST", data: post() });
    if (response.status === 503) refused = response; else assert.equal(response.status, 201, "only a full disk may refuse the write");
  }
  assert.ok(refused, "the pinned database never reported SQLITE_FULL");
  const text = await refused.text();
  const body = JSON.parse(text);
  assert.equal(body.error.code, "storage_unavailable");
  assert.equal(body.category, "unavailable");
  assert.equal(refused.headers.get("retry-after"), "30");
  assert.match(body.operationId, /^op_/);
  assert.doesNotMatch(text, /SQLITE|disk|full|readonly|ERR_/i, "driver text must not reach the client");
  assert.deepEqual(snapshot(), before, "no partial write: event log, command journal, projection and checkpoint are unchanged");
  assert.deepEqual(store.storageStatus(), { failures: 1, threshold: 2, unavailable: false });
  const record = (await diagnostics()).find(entry => entry.code === "storage_unavailable");
  assert.ok(record, "the refusal is visible in the room diagnostics");
  assert.deepEqual(Object.keys(record).sort(), ["at", "category", "code", "operationId", "route", "status"]);
  assert.equal(record.route, "/api/rooms/:roomId/commands"); assert.equal(record.status, 503); assert.equal(record.category, "unavailable");
  assert.ok(warnings.some(line => /storage_unavailable/.test(line)));
  assert.ok(!warnings.some(line => /disk|SQLITE/i.test(line)), "safe diagnostics never quote the driver");
  free();
  const recovered = await request("/api/rooms/commons/commands", { method: "POST", data: post() });
  assert.equal(recovered.status, 201);
  assert.equal(store.room("commons").sequence, before.sequence + 1);
  assert.deepEqual(store.storageStatus(), { failures: 0, threshold: 2, unavailable: false });
});

test("readiness turns 503 after consecutive storage failures and recovers on the next committed write", async t => {
  const { store, owner, request, fill, free, warnings } = await fixture(t, { storageFailureThreshold: 2 });
  assert.equal((await request("/api/ready", { token: null })).status, 200);
  fill();
  const refusals = [];
  for (let attempt = 0; attempt < 24 && refusals.length < 2; attempt++) {
    try { store.command(owner, "commons", post()); }
    catch (error) { assert.ok(error instanceof StorageUnavailableError, error.message); refusals.push(error); }
  }
  assert.equal(refusals.length, 2);
  assert.equal(refusals[0].cause?.errcode, 13, "the driver error stays server-side as the cause");
  assert.deepEqual(store.storageStatus(), { failures: 2, threshold: 2, unavailable: true });
  const unavailable = await request("/api/ready", { token: null });
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { status: "unavailable", reason: "storage_unavailable" });
  const head = await request("/api/ready", { token: null, method: "HEAD" });
  assert.equal(head.status, 503); assert.equal(await head.text(), "");
  assert.equal((await request("/api/health", { token: null })).status, 200, "liveness stays up while storage is unavailable");
  assert.equal((await request("/api/rooms/commons")).status, 200, "reads keep working");
  assert.equal(warnings.filter(line => /readiness now 503/.test(line)).length, 1, "one flip line, not one per failure");
  free();
  const recovered = await request("/api/rooms/commons/commands", { method: "POST", data: post("recovered") });
  assert.equal(recovered.status, 201);
  assert.deepEqual(store.storageStatus(), { failures: 0, threshold: 2, unavailable: false });
  assert.equal((await request("/api/ready", { token: null })).status, 200);
  assert.equal(warnings.filter(line => /readiness now 200/.test(line)).length, 1);
});

test("nested and read-only transactions count one refusal each and the store stays usable", async t => {
  const { store, owner, fill, free } = await fixture(t, { storageFailureThreshold: 3 });
  fill();
  let failures = 0;
  for (let attempt = 0; attempt < 24 && failures < 1; attempt++) {
    try { store.transaction(() => { store.command(owner, "commons", post()); }); }
    catch (error) { assert.ok(error instanceof StorageUnavailableError); failures++; }
  }
  assert.equal(store.storageStatus().failures, 1, "a failure inside a nested transaction is counted once");
  assert.equal(store.db.isTransaction, false, "no transaction is left open");
  assert.equal(store.room("commons").state.members.owner.displayName, "Room owner", "reads continue");
  free();
  store.command(owner, "commons", post());
  assert.equal(store.storageStatus().failures, 0);
});
