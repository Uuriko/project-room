// WORKER 49 (WAVE-2000 guild-02) — fail-first test.
// Finding: `?auth=<invalid>` is silently accepted when a Bearer credential is
// present, contradicting the route's own 422 invalid_auth_mode contract.
//
// server/http.mjs roomCredentials():
//   const bearerToken = bearer(req);
//   if (bearerToken) return { token: bearerToken, bearer: true, mode: "room" };  // <-- early return
//   const requested = req.headers["x-project-room-auth"] ?? url.searchParams.get("auth") ?? "room";
//   if (!["room", "account"].includes(requested)) reject(422, "invalid_auth_mode", ...);  // never reached with bearer
//
// Repro (shard route: POST /api/rooms/{roomId}/squads/{squadId}/disband):
//   POST /api/rooms/commons/squads/<id>/disband?auth=bogus
//   Authorization: Bearer <room access key>
//   -> 200 today; the invalid auth mode should be 422 like the no-bearer path.
import test from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

function fixture(t) {
  const directory = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "w49-authmode-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const m1 = store.command(ownerKey, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: randomUUID(), body: "root" } }).event.data.messageId;
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, ownerKey, m1 };
}

async function serve(t) {
  const f = fixture(t);
  const server = createRoomServer({ store: f.store });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = (method, path, headers = {}, body) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const h = { Origin: origin, Connection: "close", ...headers };
    if (data !== null) h["Content-Length"] = Buffer.byteLength(data);
    const req = httpRequest(origin + path, { method, headers: h }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString() || "{}") }));
    });
    req.on("error", reject);
    if (data !== null) req.write(data);
    req.end();
  });
  return { ...f, origin, call };
}

test("disband: ?auth=bogus with a Bearer credential is 422 invalid_auth_mode", async t => {
  const f = await serve(t);
  const created = await f.call("POST", "/api/rooms/commons/squads",
    { "Content-Type": "application/json", Authorization: `Bearer ${f.ownerKey}` },
    { name: "authmode", channelMessageId: f.m1 });
  assert.equal(created.status, 201);
  const squadId = created.json.squad.id;
  const bad = await f.call("POST", `/api/rooms/commons/squads/${squadId}/disband?auth=bogus`,
    { Authorization: `Bearer ${f.ownerKey}` });
  assert.equal(bad.status, 422, `invalid auth mode must be rejected even with bearer, got ${bad.status}: ${JSON.stringify(bad.json).slice(0, 160)}`);
  assert.equal(bad.json.error.code, "invalid_auth_mode");
});
