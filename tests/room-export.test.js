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
  const directory = mkdtempSync(join(tmpdir(), "room-export-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "agent", displayName: "Test agent", kind: "agent", permissions: ["accept_work"] } });
  const agentKey = store.issueAccessKey("commons", "agent");
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
  const importNdjson = (token, body, contentType = "application/x-ndjson") =>
    fetch(origin + "/api/rooms/commons/import", {
      method: "POST",
      headers: { Origin: origin, Authorization: `Bearer ${token}`, "Content-Type": contentType },
      body
    });
  return { request, importNdjson, ownerKey, agentKey, store };
}

test("room export streams the full event log as JSONL", async t => {
  const { request, ownerKey, agentKey, store } = await serve(t);
  const res = await request("/api/rooms/commons/export", { token: ownerKey });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /application\/x-ndjson/);
  const ndjson = await res.text();
  const lines = ndjson.trim().split("\n");
  const events = lines.map(l => JSON.parse(l));
  // Sequences are dense and ordered.
  assert.deepEqual(events.map(e => e.sequence), events.map((_, i) => i + 1));
  assert.ok(events.every(e => e.event && e.event.type && e.event.actorId && e.event.at));
  // Matches what the events route reports.
  const { next } = store.eventsAfter(ownerKey, "commons", 0, 100);
  assert.equal(events.at(-1).sequence, next);
  // A non-member gets nothing.
  assert.equal((await request("/api/rooms/commons/export")).status, 401);
  // Members can export too (same visibility as the events route).
  assert.equal((await request("/api/rooms/commons/export", { token: agentKey })).status, 200);
  return ndjson;
});

test("room import round-trips an export (round-2 #107)", async t => {
  const { request, importNdjson, ownerKey, agentKey } = await serve(t);
  const ndjson = await (await request("/api/rooms/commons/export", { token: ownerKey })).text();
  const before = await (await request("/api/rooms/commons", { token: ownerKey })).json();
  const lineCount = ndjson.trim().split("\n").length;

  // Wrong content type rejected.
  assert.equal((await importNdjson(ownerKey, "{}", "application/json")).status, 415);
  // Corrupt line rejected before anything is written.
  assert.equal((await importNdjson(ownerKey, ndjson + "not json\n")).status, 422);
  // Non-owner rejected.
  assert.equal((await importNdjson(agentKey, ndjson)).status, 403);

  // Owner round-trip: restore of the same history.
  const ok = await importNdjson(ownerKey, ndjson);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { imported: lineCount, sequence: lineCount });
  const after = await (await request("/api/rooms/commons", { token: ownerKey })).json();
  assert.deepEqual(after.state.members, before.state.members);
  assert.equal(after.sequence, before.sequence);
});
