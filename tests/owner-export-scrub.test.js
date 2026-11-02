// Owner per-room export token scrub (F1W2-T2): the owner export route in
// server/http.mjs applies the same scrubEventTokens treatment
// (server/room-export.mjs) that the operator per-room export
// (server/operator-rooms.mjs, MF-7) already applies, after the existing
// redactEventRows tombstone redaction. Before this cure the owner path —
// the one a room owner actually uses — applied redaction only, so the
// three room token shapes (pri_…, rak_…, ga1.…) left verbatim in both the
// JSONL and HTML owner exports while the operator export of the same room
// replaced them with their sha256.
//
// Scope is parity, not parity-plus: scrubEventTokens covers exactly the
// three room shapes. Any other secret shape (e.g. a ghp_ token pasted into
// a message) passes BOTH exports verbatim; that residual is pinned by a
// test below so it stays a named, deliberate boundary, not a surprise.
//
// All fixtures are synthetic/fake. The store is in-memory, as in several
// sibling suites (RoomStore(":memory:")).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { RoomStore, ServiceError } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const sha256 = value => createHash("sha256").update(value).digest("hex");

// Synthetic room token shapes (fake values, shape classes only).
const PRI = "pri_" + "FakeOwnerExportPri0123456789";
const RAK = "rak_" + "FakeOwnerExportRak0123456789";
const GA1 = "ga1." + "FakeOwnerExportGa1Token0123456789";
const ROOM_SHAPES = [PRI, RAK, GA1];
// Non-room shape: outside TOKEN_SOURCE, so outside the scrub on both the
// operator and owner paths (the named residual).
const GHP = "ghp_" + "FakeOwnerExportControl0123456789abcd";

async function serve(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "agent", displayName: "Test agent", kind: "agent", permissions: ["accept_work"] } });
  const agentKey = store.issueAccessKey("commons", "agent");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { token } = {}) => fetch(origin + path, {
    headers: { Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}) }
  });
  const post = (body, messageId = `m-${randomUUID()}`) =>
    store.command(ownerKey, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId, body } });
  return { request, post, ownerKey, agentKey, store };
}

function assertScrubbed(text, format) {
  for (const shape of ROOM_SHAPES) {
    assert.ok(!text.includes(shape), `${format}: the raw room token shape must not leave in the owner export`);
    assert.ok(text.includes(sha256(shape)), `${format}: the room token shape is replaced by its sha256, as in the operator export`);
  }
}

describe("owner per-room export token scrub", () => {
  test("the JSONL owner export scrubs room token shapes to their sha256", async t => {
    const f = await serve(t);
    f.post(`first token ${PRI} end`);
    f.post(`second token ${RAK} end`);
    f.post(`third token ${GA1} end`);
    f.post("a clean message with nothing to hide");
    const res = await f.request("/api/rooms/commons/export", { token: f.ownerKey });
    assert.equal(res.status, 200, await res.clone().text().catch(() => ""));
    const text = await res.text();
    assertScrubbed(text, "jsonl");
    assert.ok(text.includes("a clean message with nothing to hide"), "clean bodies pass verbatim");
    const lines = text.trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(lines.map(line => line.sequence), lines.map((_, i) => i + 1), "sequences stay dense after the scrub");
    assert.ok(lines.every(line => line.event && typeof line.event === "object"));
  });

  test("the HTML owner export scrubs room token shapes to their sha256", async t => {
    const f = await serve(t);
    f.post(`first token ${PRI} end`);
    f.post(`second token ${RAK} end`);
    f.post(`third token ${GA1} end`);
    const res = await f.request("/api/rooms/commons/export?format=html", { token: f.ownerKey });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/html/);
    assertScrubbed(await res.text(), "html");
  });

  test("the scrub reaches nested event values, not only message bodies", async t => {
    const f = await serve(t);
    f.store.command(f.ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
      data: { memberId: "nestedagent", displayName: `agent ${RAK}`, kind: "agent", permissions: [] } });
    const text = await (await f.request("/api/rooms/commons/export", { token: f.ownerKey })).text();
    assert.ok(!text.includes(RAK), "a room token shape in a nested event value must not leave");
    assert.ok(text.includes(sha256(RAK)), "the nested value is replaced by its sha256");
  });

  test("tombstone redaction is preserved exactly alongside the scrub", async t => {
    const f = await serve(t);
    const cmd = (type, data) => f.store.command(f.ownerKey, "commons", { id: randomUUID(), type, data });
    cmd(T.MESSAGE_POSTED, { messageId: "gone", body: `old ${PRI} end` });
    cmd(T.MESSAGE_EDITED, { messageId: "gone", body: `revised ${PRI} end`, expectedMessageRevision: 0 });
    cmd(T.MESSAGE_DELETED, { messageId: "gone", expectedMessageRevision: 1, reason: "Posted in error" });
    const ndjson = await (await f.request("/api/rooms/commons/export", { token: f.ownerKey })).text();
    const events = ndjson.trim().split("\n").map(line => JSON.parse(line).event);
    assert.equal(events.find(e => e.type === T.MESSAGE_POSTED && e.data.messageId === "gone").data.body, null,
      "the deleted message's posted body stays the null tombstone");
    assert.equal(events.find(e => e.type === T.MESSAGE_EDITED && e.data.messageId === "gone").data.body, null,
      "the deleted message's edited body stays the null tombstone");
    assert.ok(!ndjson.includes(PRI), "no earlier body of a deleted message leaves via the scrub path either");
    const html = await (await f.request("/api/rooms/commons/export?format=html", { token: f.ownerKey })).text();
    assert.match(html, /Message deleted/);
    assert.ok(!html.includes(PRI));
  });

  test("named residual: non-room secret shapes pass both exports verbatim (parity, not parity-plus)", async t => {
    const f = await serve(t);
    f.post(`control token ${GHP} end`);
    const ndjson = await (await f.request("/api/rooms/commons/export", { token: f.ownerKey })).text();
    assert.ok(ndjson.includes(GHP), "ghp_ is outside TOKEN_SOURCE: it passes the owner export, exactly as it passes the operator export");
    const html = await (await f.request("/api/rooms/commons/export?format=html", { token: f.ownerKey })).text();
    assert.ok(html.includes(GHP), "the residual is the same in the HTML rendering");
  });

  test("the export stays owner-only after the scrub", async t => {
    const f = await serve(t);
    f.post(`token ${PRI} end`);
    assert.equal((await f.request("/api/rooms/commons/export")).status, 401);
    const refused = await f.request("/api/rooms/commons/export", { token: f.agentKey });
    assert.equal(refused.status, 403);
    assert.equal((await refused.json()).error.code, "owner_required");
    assert.equal((await f.request("/api/rooms/commons/export?format=html", { token: f.agentKey })).status, 403);
  });

  test("a storage failure part-way through the walk is a JSON error, never a partial export", async t => {
    const f = await serve(t);
    f.post(`token ${PRI} end`);
    f.post(`token ${RAK} end`);
    f.post(`token ${GA1} end`);
    const real = f.store.exportEvents.bind(f.store);
    f.store.exportEvents = function* (...args) {
      let rows = 0;
      for (const line of real(...args)) { if (++rows > 2) throw new Error("storage read failed"); yield line; }
    };
    for (const path of ["/api/rooms/commons/export", "/api/rooms/commons/export?format=html"]) {
      const failed = await f.request(path, { token: f.ownerKey });
      assert.equal(failed.status, 500, path);
      assert.match(failed.headers.get("content-type"), /application\/json/);
      const body = await failed.json();
      assert.equal(body.error.code, "internal_error");
      assert.doesNotMatch(JSON.stringify(body), /"sequence":\s*1\b/, "no exported rows leak into the error body");
    }
    f.store.exportEvents = function* (...args) {
      for (const line of real(...args)) { yield line; throw new ServiceError(503, "storage_unavailable", "Storage is unavailable"); }
    };
    const unavailable = await f.request("/api/rooms/commons/export", { token: f.ownerKey });
    assert.equal(unavailable.status, 503);
    assert.equal((await unavailable.json()).error.code, "storage_unavailable");
    f.store.exportEvents = real;
    assert.equal((await f.request("/api/rooms/commons/export", { token: f.ownerKey })).status, 200);
  });
});
