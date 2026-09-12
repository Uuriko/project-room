import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-audit-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  const add = (memberId, displayName) => store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId, displayName, kind: "agent", permissions: ["accept_work", "complete_work"] } });
  add("agent", "Test agent");
  add("agent2", "Second agent");
  const agentKey = store.issueAccessKey("commons", "agent");
  const agent2Key = store.issueAccessKey("commons", "agent2");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { method = "GET", data, token } = {}) => fetch(origin + path, {
    method, headers: {
      Origin: origin,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(data === undefined ? {} : { "Content-Type": "application/json" })
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) })
  });
  return { request, ownerKey, agentKey, agent2Key };
}

const cmd = (request, token, type, data) => request("/api/rooms/commons/commands", {
  method: "POST", token, data: { id: randomUUID(), type, data }
});

const events = (request, token, query = "") =>
  request(`/api/rooms/commons/events${query}`, { token }).then(r => r.json());

test("audit: events filter by actor", async t => {
  const { request, agentKey, agent2Key } = await serve(t);
  await cmd(request, agentKey, T.MEMBER_STATUS_UPDATED, { message: "a1" });
  await cmd(request, agent2Key, T.MEMBER_STATUS_UPDATED, { message: "a2" });

  const mine = await events(request, agentKey, "?actor=agent");
  assert.ok(mine.events.length > 0);
  assert.ok(mine.events.every(e => e.event.actorId === "agent"));

  const theirs = await events(request, agentKey, "?actor=agent2");
  assert.ok(theirs.events.every(e => e.event.actorId === "agent2"));
  assert.ok(!theirs.events.some(e => e.event.actorId === "agent"));
});

test("audit: events filter by time range", async t => {
  const { request, agentKey } = await serve(t);
  await cmd(request, agentKey, T.MEMBER_STATUS_UPDATED, { message: "before" });
  const split = new Date().toISOString();
  await new Promise(r => setTimeout(r, 5));
  await cmd(request, agentKey, T.MEMBER_STATUS_UPDATED, { message: "after" });

  const older = await events(request, agentKey, `?until=${encodeURIComponent(split)}`);
  assert.ok(older.events.length > 0);
  assert.ok(older.events.every(e => e.event.at <= split));

  const newer = await events(request, agentKey, `?since=${encodeURIComponent(split)}`);
  assert.ok(newer.events.length > 0);
  assert.ok(newer.events.every(e => e.event.at >= split));
});

test("audit: invalid filters are rejected", async t => {
  const { request, agentKey } = await serve(t);
  assert.equal((await request("/api/rooms/commons/events?since=not-a-date", { token: agentKey })).status, 422);
  assert.equal((await request("/api/rooms/commons/events?actor=", { token: agentKey })).status, 422);
});
