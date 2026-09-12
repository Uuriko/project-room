import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { deploymentConfig, clientAddress } from "../server/deployment.mjs";
import { backupRoom } from "../server/backup.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const production = { NODE_ENV: "production", ROOM_DEPLOYMENT: "invite-only", ROOM_ORIGIN: "https://room.example.com", ROOM_DB: "/var/lib/project-room/room.sqlite" };
test("production is an explicit, persistent, HTTPS, same-host deployment", () => {
  assert.equal(deploymentConfig({}).production, false);
  assert.equal(deploymentConfig(production).production, true);
  for (const change of [{ ROOM_DEPLOYMENT: "" }, { NODE_ENV: "development" }, { ROOM_DB: "relative.sqlite" }, { ROOM_DB: "" }, { ROOM_ORIGIN: "http://localhost" }, { ROOM_ORIGIN: "https://room.example.com/path" }, { HOST: "0.0.0.0" }, { PORT: "NaN" }]) {
    assert.throws(() => deploymentConfig({ ...production, ...change }));
  }
});

test("client address comes only from an explicitly trusted loopback proxy", () => {
  const req = { socket: { remoteAddress: "127.0.0.1" }, headers: { "x-real-ip": "192.0.2.10" } };
  assert.equal(clientAddress(req), "127.0.0.1");
  assert.equal(clientAddress(req, true), "192.0.2.10");
  assert.throws(() => clientAddress({ ...req, socket: { remoteAddress: "192.0.2.11" } }, true));
  for (const value of [undefined, "", "192.0.2.10, 192.0.2.11", ["192.0.2.10"], "unknown"]) {
    assert.throws(() => clientAddress({ ...req, headers: { "x-real-ip": value } }, true));
  }
  assert.equal(clientAddress({ ...req, headers: { "x-real-ip": "2001:0db8:0:0:0:0:0:1" } }, true), "[2001:db8::1]");
});

test("deployed HTTP checks proxy identity, separate visitor limits, secure cookies and readiness", async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-deploy-test-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const server = createRoomServer({ store, origin: production.ROOM_ORIGIN, trustedLocalProxy: true });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const get = (path, headers = {}) => new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: server.address().port, path, headers: { host: "room.example.com", "x-real-ip": "192.0.2.10", ...headers } }, res => {
      let body = ""; res.on("data", chunk => body += chunk); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }); req.on("error", reject); req.end();
  });
  assert.equal((await get("/api/ready")).status, 200);
  assert.equal((await get("/api/health")).status, 200);
  const healthHead = await new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: server.address().port, path: "/api/health", method: "HEAD", headers: { host: "room.example.com", "x-real-ip": "192.0.2.10" } }, res => {
      let body = ""; res.on("data", chunk => body += chunk); res.on("end", () => resolve({ status: res.statusCode, body }));
    }); req.on("error", reject); req.end();
  });
  assert.equal(healthHead.status, 200);
  assert.equal(healthHead.body, "");
  assert.equal((await get("/api/ready", { "x-real-ip": "bad" })).status, 403);
  assert.equal((await get("/api/ready", { host: "elsewhere.example" })).status, 403);
  const first = await get("/api/account-session");
  assert.match(first.headers["set-cookie"][0], /^__Host-account_session=/);
  assert.match(first.headers["set-cookie"][0], /; Secure$/);
  assert.equal(first.headers["x-robots-tag"], "noindex, nofollow");
  for (let i = 0; i < 19; i++) assert.equal((await get("/api/account-session")).status, 200);
  const limited = await get("/api/account-session");
  assert.equal(limited.status, 429);
  assert.equal(limited.headers["retry-after"], "60");
  assert.equal(limited.headers["x-ratelimit-limit"], "20");
  assert.equal(limited.headers["x-ratelimit-remaining"], "0");
  assert.ok(Number(limited.headers["x-ratelimit-reset"]) > 0);
  assert.equal((await get("/api/account-session", { "x-real-ip": "192.0.2.11" })).status, 200);
  assert.equal((await get("/api/rooms/commons")).status, 401);
});

test("online backup restores durable messages without replacing source or earlier backups", async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-backup-test-"));
  const filename = join(directory, "live.sqlite");
  const store = new RoomStore(filename);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom());
  const key = store.issueAccessKey("commons", "owner");
  store.command(key, "commons", { id: crypto.randomUUID(), type: T.MESSAGE_POSTED, data: { body: "Saved before backup" } });
  const receipt = await backupRoom(filename, directory);
  assert.equal(receipt.verified, true);
  assert.equal(statSync(receipt.filename).mode & 0o777, 0o600);
  const restored = new RoomStore(receipt.filename);
  try { assert.deepEqual(restored.room("commons"), store.room("commons")); } finally { restored.close(); }
  store.command(key, "commons", { id: crypto.randomUUID(), type: T.MESSAGE_POSTED, data: { body: "Saved after backup" } });
  const second = await backupRoom(filename, directory);
  assert.notEqual(second.filename, receipt.filename);
  const earlier = new RoomStore(receipt.filename, { readOnly: true });
  try { assert.notDeepEqual(earlier.room("commons"), store.room("commons")); } finally { earlier.close(); }
});
