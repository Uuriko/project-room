import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore, ServiceError } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { createServer } from "node:http";
import { RoomAgentClient } from "../client/room-agent.mjs";

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
  return { request, importNdjson, ownerKey, agentKey, store, origin };
}

test("room export returns the full event log as JSONL, framed by Content-Length", async t => {
  const { request, ownerKey, agentKey, store } = await serve(t);
  const res = await request("/api/rooms/commons/export", { token: ownerKey });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /application\/x-ndjson/);
  const ndjson = await res.text();
  // The body is materialised before the headers go out, so its exact byte
  // length is declared: fewer bytes than this is an incomplete download,
  // never a plausible shorter export.
  assert.equal(Number(res.headers.get("content-length")), Buffer.byteLength(ndjson, "utf8"));
  assert.ok(ndjson.endsWith("\n"), "a complete export ends with a newline");
  const lines = ndjson.trim().split("\n");
  const events = lines.map(l => JSON.parse(l));
  // Sequences are dense and ordered.
  assert.deepEqual(events.map(e => e.sequence), events.map((_, i) => i + 1));
  assert.ok(events.every(e => e.event && e.event.type && e.event.actorId && e.event.at));
  // Matches what the events route reports: every event, not a prefix.
  const { next } = store.eventsAfter(ownerKey, "commons", 0, 100);
  assert.equal(events.at(-1).sequence, next);
  assert.equal(events.length, store.room("commons").sequence);
  // A non-member gets nothing.
  assert.equal((await request("/api/rooms/commons/export")).status, 401);
  // Members can export too (same visibility as the events route).
  assert.equal((await request("/api/rooms/commons/export", { token: agentKey })).status, 200);
  return ndjson;
});

test("an export that fails part-way is a JSON error, never a clean-looking partial file", async t => {
  const { request, ownerKey, store } = await serve(t);
  const real = store.exportEvents.bind(store);
  const full = await (await request("/api/rooms/commons/export", { token: ownerKey })).text();
  assert.ok(full.split("\n").length > 3, "fixture has enough events to fail part-way through");
  // Storage gives up after two rows: a plain Error, as a driver would throw.
  store.exportEvents = function* (...args) {
    let rows = 0;
    for (const line of real(...args)) { if (++rows > 2) throw new Error("storage read failed"); yield line; }
  };
  const failed = await request("/api/rooms/commons/export", { token: ownerKey });
  assert.equal(failed.status, 500);
  assert.match(failed.headers.get("content-type"), /application\/json/);
  const body = await failed.json();
  assert.equal(body.error.code, "internal_error");
  assert.doesNotMatch(JSON.stringify(body), /"sequence":\s*1\b/, "no exported rows leak into the error body");
  // A service error part-way through keeps its own status and code.
  store.exportEvents = function* (...args) {
    for (const line of real(...args)) { yield line; throw new ServiceError(503, "storage_unavailable", "Storage is unavailable"); }
  };
  const unavailable = await request("/api/rooms/commons/export", { token: ownerKey });
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error.code, "storage_unavailable");
  // Once storage recovers the export is whole again, byte-exact.
  store.exportEvents = real;
  const recovered = await request("/api/rooms/commons/export", { token: ownerKey });
  assert.equal(recovered.status, 200);
  assert.equal(await recovered.text(), full);
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

test("room import resets cursors and refreshes the projection checkpoint", async t => {
  const { request, importNdjson, ownerKey, agentKey, store } = await serve(t);
  const before = await (await request("/api/rooms/commons", { token: ownerKey })).json();
  const seq = before.sequence;
  // Agent reads and marks caught-up: cursor + a stale checkpoint exist.
  store.markCaughtUp(agentKey, "commons", seq);
  store.db.exec("CREATE TABLE IF NOT EXISTS projection_checkpoints (room_id TEXT PRIMARY KEY REFERENCES rooms(id), sequence INTEGER NOT NULL, projection TEXT NOT NULL)");
  store.db.prepare("INSERT OR REPLACE INTO projection_checkpoints(room_id,sequence,projection) VALUES(?,?,?)").run("commons", seq, JSON.stringify({ stale: true }));
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM cursors WHERE room_id='commons'").get().n, 1);

  const ndjson = await (await request("/api/rooms/commons/export", { token: ownerKey })).text();
  const ok = await importNdjson(ownerKey, ndjson);
  assert.equal(ok.status, 200);

  // Cursors reset; checkpoint replaced with the imported state.
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM cursors WHERE room_id='commons'").get().n, 0);
  const checkpoint = store.db.prepare("SELECT sequence,projection FROM projection_checkpoints WHERE room_id='commons'").get();
  assert.equal(checkpoint.sequence, seq);
  assert.deepEqual(JSON.parse(checkpoint.projection).members, before.state.members);
  // rebuildProjection still works off the fresh checkpoint.
  assert.equal(store.rebuildProjection("commons").sequence, seq);
});

test("room import rejects duplicate event ids cleanly", async t => {
  const { request, importNdjson, ownerKey, store } = await serve(t);
  const ndjson = await (await request("/api/rooms/commons/export", { token: ownerKey })).text();
  const lines = ndjson.trim().split("\n");
  // Duplicate the first event but renumber sequences so they stay dense —
  // this isolates the duplicate-id check from the sequence check.
  const dup = lines.concat(JSON.stringify({ ...JSON.parse(lines[0]), sequence: lines.length + 1 }));
  const before = store.room("commons").sequence;
  const res = await importNdjson(ownerKey, dup.join("\n") + "\n");
  assert.equal(res.status, 422);
  assert.match(await res.text(), /duplicate event ids/);
  // Failed import writes nothing: room untouched.
  assert.equal(store.room("commons").sequence, before);
});

test("room import round-trips a large (1500-event) export", async t => {
  const { request, importNdjson, ownerKey, store } = await serve(t);
  for (let i = 0; i < 1500; i++) {
    store.command(ownerKey, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED,
      data: { messageId: `bulk-${i}`, body: `bulk message ${i}` } });
  }
  const ndjson = await (await request("/api/rooms/commons/export", { token: ownerKey })).text();
  const lineCount = ndjson.trim().split("\n").length;
  assert.ok(lineCount > 1500, `expected >1500 lines, got ${lineCount}`);
  const before = await (await request("/api/rooms/commons", { token: ownerKey })).json();
  const ok = await importNdjson(ownerKey, ndjson);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { imported: lineCount, sequence: lineCount });
  const after = await (await request("/api/rooms/commons", { token: ownerKey })).json();
  assert.deepEqual(after.state.members, before.state.members);
  assert.equal(after.sequence, before.sequence);
});

test("database failures during import surface as clean invalid_import, not raw errors", async t => {
  const { importNdjson, ownerKey } = await serve(t);
  const brokenSequence = JSON.stringify({ sequence: 99, event: { id: "x", roomId: "commons", type: "MESSAGE_POSTED", actorId: "a", at: 1 } });
  let res = await importNdjson(ownerKey, brokenSequence);
  assert.equal(res.status, 422);
  assert.equal((await res.json()).error.code, "invalid_import");
  const malformed = JSON.stringify({ sequence: 1, event: { id: "y", roomId: "commons" } });
  res = await importNdjson(ownerKey, malformed);
  assert.equal(res.status, 422);
  assert.equal((await res.json()).error.code, "invalid_import");
  // Duplicate ids across lines: clean invalid_import, no partial writes.
  const dup = [1, 2].map(i => JSON.stringify({ sequence: i, event: { id: "same", roomId: "commons", type: "MESSAGE_POSTED", actorId: "a", at: 1 } })).join("\n");
  res = await importNdjson(ownerKey, dup);
  assert.equal(res.status, 422);
  assert.equal((await res.json()).error.code, "invalid_import");
});

test("export never answers a 200 with an empty body when the lazy authenticate fails", async t => {
  const { request, ownerKey, store, origin } = await serve(t);
  // A stale fence is rejected as a JSON error, not as an empty NDJSON 200.
  const fenced = await fetch(`${origin}/api/rooms/commons/export`, {
    headers: { Origin: origin, Authorization: `Bearer ${ownerKey}`, "X-Session-Binding": "f".repeat(64) }
  });
  assert.equal(fenced.status, 409);
  assert.match(fenced.headers.get("content-type"), /application\/json/);
  assert.equal((await fenced.json()).error.code, "session_binding_changed");
  // exportEvents authenticates when first iterated. Simulate the key being
  // rotated between the route's pre-check and that lazy check: the route
  // must not have committed to a 200 yet.
  const original = store.exportEvents.bind(store);
  store.exportEvents = function* rotatedMidRequest(token, roomId, fence) {
    store.issueAccessKey("commons", "owner"); // revokes ownerKey
    yield* original(token, roomId, fence);
  };
  const stale = await request("/api/rooms/commons/export", { token: ownerKey });
  assert.equal(stale.status, 401);
  assert.match(stale.headers.get("content-type"), /application\/json/);
  assert.equal((await stale.json()).error.code, "unauthenticated");
});

test("import reports the line number of a corrupt line as it appears in the file, blanks included", async t => {
  const { request, importNdjson, ownerKey } = await serve(t);
  const lines = (await (await request("/api/rooms/commons/export", { token: ownerKey })).text()).trim().split("\n");
  // Line 1 valid, line 2 blank, line 3 whitespace, line 4 valid, line 5 corrupt.
  const body = [lines[0], "", "   ", lines[1], "not json", ...lines.slice(2)].join("\n") + "\n";
  const res = await importNdjson(ownerKey, body);
  assert.equal(res.status, 422);
  const error = (await res.json()).error;
  assert.equal(error.code, "invalid_import");
  assert.match(error.message, /Line 5 /);
  // Blank lines alone are tolerated: the import still round-trips.
  const ok = await importNdjson(ownerKey, [lines[0], "", ...lines.slice(1)].join("\n") + "\n\n");
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).imported, lines.length);
});

test("client exportRoom/importRoom use the hardened fetch posture and keep the service error code", async t => {
  const config = { origin: "https://room.example", roomId: "commons", token: "T".repeat(43) };
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/export")) return new Response("{\"sequence\":1}\n", { status: 200, headers: { "content-type": "application/x-ndjson" } });
    return Response.json({ imported: 1, sequence: 1 });
  };
  const client = new RoomAgentClient({ ...config, fetchImpl });
  const caller = new AbortController();
  assert.equal(await client.exportRoom({ signal: caller.signal }), "{\"sequence\":1}\n");
  await client.importRoom("{\"sequence\":1}\n", { signal: caller.signal });
  assert.equal(calls.length, 2);
  for (const { options } of calls) {
    assert.equal(options.redirect, "error");
    assert.equal(options.credentials, "omit");
    assert.equal(options.headers.Authorization, `Bearer ${config.token}`);
    // The caller's signal is combined with the 15s deadline, not substituted for it.
    assert.ok(options.signal instanceof AbortSignal);
    assert.notEqual(options.signal, caller.signal);
    assert.equal(options.signal.aborted, false);
  }
  assert.equal(calls[1].options.method, "POST");
  assert.equal(calls[1].options.headers["Content-Type"], "application/x-ndjson");
  caller.abort();
  assert.ok(calls.every(({ options }) => options.signal.aborted === true), "combined signal follows the caller's abort");
  // The service's own error code and message survive, for export as for import.
  const failing = new RoomAgentClient({ ...config, fetchImpl: async () =>
    Response.json({ error: { code: "session_binding_changed", message: "Session changed" } }, { status: 409, headers: { "retry-after": "3" } }) });
  await assert.rejects(failing.exportRoom(), error => error.status === 409 && error.code === "session_binding_changed" && error.message === "Session changed" && error.retryAfterMs === 3000);
  await assert.rejects(failing.importRoom("{}\n"), error => error.status === 409 && error.code === "session_binding_changed");
  // A redirect is an error with the real fetch: the bearer never follows a Location header.
  const leaked = createServer((req, res) => {
    if (req.url.endsWith("/export") || req.url.endsWith("/import")) { res.writeHead(302, { Location: "/elsewhere" }); return res.end(); }
    res.writeHead(200, { "Content-Type": "application/json" }); res.end("{\"leaked\":true}");
  });
  await new Promise(resolve => leaked.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => leaked.close(resolve)));
  const redirected = new RoomAgentClient({ ...config, origin: `http://127.0.0.1:${leaked.address().port}` });
  await assert.rejects(redirected.exportRoom());
  await assert.rejects(redirected.importRoom("{}\n"));
});

test("F8 semantics: export retains deleted-message history; projection and search hide it", async t => {
  const { request, ownerKey, store } = await serve(t);
  const cmd = (type, data) => store.command(ownerKey, "commons", { id: randomUUID(), type, data });
  cmd(T.MESSAGE_POSTED, { messageId: "m1", body: "original secret wording" });
  cmd(T.MESSAGE_EDITED, { messageId: "m1", body: "revised wording", expectedMessageRevision: 0 });
  cmd(T.MESSAGE_DELETED, { messageId: "m1", expectedMessageRevision: 1, reason: "Posted in error" });
  // Projection: tombstone only, edit history purged.
  const projection = store.room("commons").state.messages.find(m => m.id === "m1");
  assert.equal(projection.body, null);
  assert.deepEqual(projection.editHistory, []);
  assert.ok(projection.deletedAt && projection.deletedBy);
  // Search never returns tombstoned messages, on either the old or new wording.
  assert.equal(store.search(ownerKey, "commons", "secret", "messages").messages.length, 0);
  assert.equal(store.search(ownerKey, "commons", "revised", "messages").messages.length, 0);
  // Export is the complete history: original post, edit and tombstone event are all present.
  const ndjson = await (await request("/api/rooms/commons/export", { token: ownerKey })).text();
  const events = ndjson.trim().split("\n").map(l => JSON.parse(l).event);
  assert.equal(events.find(e => e.type === T.MESSAGE_POSTED && e.data.messageId === "m1").data.body, "original secret wording");
  assert.equal(events.find(e => e.type === T.MESSAGE_EDITED && e.data.messageId === "m1").data.body, "revised wording");
  assert.equal(events.find(e => e.type === T.MESSAGE_DELETED && e.data.messageId === "m1").data.reason, "Posted in error");
});
