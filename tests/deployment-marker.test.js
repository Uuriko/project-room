import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

async function originFor(t, options) {
  const directory = mkdtempSync(join(tmpdir(), "room-deployment-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const server = createRoomServer({ store, ...options });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function read(origin, path) {
  const response = await fetch(origin + path);
  assert.equal(response.status, 200);
  return response.json();
}

test("health and version stay unmarked unless a deployment is configured", async t => {
  const origin = await originFor(t);
  const health = await read(origin, "/api/health");
  const version = await read(origin, "/api/version");
  assert.equal(health.status, "ok");
  assert.equal(Object.hasOwn(health, "deployment"), false);
  assert.equal(Object.hasOwn(version, "deployment"), false);
  assert.equal(version.mode, health.mode);
});

test("a production marker is visible on health and version without renaming mode", async t => {
  const origin = await originFor(t, { serviceMode: "cloudflare-staging", deployment: "production" });
  const health = await read(origin, "/api/health");
  const version = await read(origin, "/api/version");
  assert.equal(health.mode, "cloudflare-staging");
  assert.equal(health.deployment, "production");
  assert.equal(version.mode, "cloudflare-staging");
  assert.equal(version.deployment, "production");
});

test("a staging marker is distinct from production", async t => {
  const origin = await originFor(t, { deployment: "staging" });
  assert.equal((await read(origin, "/api/health")).deployment, "staging");
  assert.equal((await read(origin, "/api/version")).deployment, "staging");
});

test("an unknown deployment is refused before the server listens", () => {
  assert.throws(() => createRoomServer({ store: { db: { isTransaction: false } }, deployment: "prod" }), /deployment must be production or staging/);
});
