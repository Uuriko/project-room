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
import { makeTestSigner } from "../scripts/helpers/signed-evidence.mjs";

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
  let at = Date.now();
  store.now = () => at;
  for (let i = 0; i < 1500; i++) {
    at += 2000;
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

// BUILD-01 F2: the human-readable export.
import { renderRoomExportHtml, safeEvidenceHref, EXPORT_HTML_CSP } from "../server/room-export-html.mjs";

async function seedReadableRoom(store, ownerKey) {
  const cmd = (type, data) => store.command(ownerKey, "commons", { id: randomUUID(), type, data });
  const signEvidence = makeTestSigner(store);
  cmd(T.MESSAGE_POSTED, { messageId: "script", body: "<script>alert(1)</script> stays text" });
  cmd(T.MESSAGE_POSTED, { messageId: "breakout", body: "\" onmouseover=\"alert(2)\" data-x=\"' onfocus='alert(3)" });
  cmd(T.MESSAGE_POSTED, { messageId: "gone", body: "original secret wording" });
  cmd(T.MESSAGE_EDITED, { messageId: "gone", body: "revised secret wording", expectedMessageRevision: 0 });
  cmd(T.MESSAGE_DELETED, { messageId: "gone", expectedMessageRevision: 1, reason: "Posted in error" });
  cmd(T.WORK_PROPOSED, { workItemId: "w1", title: "Ship <the> thing", definitionOfDone: "Done when \"quoted\" & shipped", accountableMemberId: "owner" });
  cmd(T.WORK_ACCEPTED, { workItemId: "w1", expectedRevision: 0 });
  cmd(T.WORK_STARTED, { workItemId: "w1", expectedRevision: 1 });
  cmd(T.WORK_COMPLETED, { workItemId: "w1", expectedRevision: 2, summary: "Merged the <fix>", nextAction: "Review",
    evidenceUrl: "https://example.com/pr/1?q=<a>&r=\"b\"", evidenceVersion: "abc123", signedEvidence: signEvidence() });
}

test("HTML export renders the same event walk for people: escaped, tombstoned, framed and sandboxed", async t => {
  const { request, ownerKey, agentKey, store } = await serve(t);
  await seedReadableRoom(store, ownerKey);
  const res = await request("/api/rooms/commons/export?format=html", { token: ownerKey });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^text\/html; charset=utf-8$/);
  assert.match(res.headers.get("content-disposition"), /attachment; filename="room-commons-export\.html"/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  const html = await res.text();
  // Materialised before the headers go out: the declared length is the body's.
  assert.equal(Number(res.headers.get("content-length")), Buffer.byteLength(html, "utf8"));
  assert.match(html, /End of export: \d+ events rendered, through sequence \d+\./, "a whole file ends with its closing marker");
  // The policy is fit for a static document: nothing loads, nothing runs.
  const csp = res.headers.get("content-security-policy");
  assert.equal(csp, EXPORT_HTML_CSP);
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /style-src 'sha256-[A-Za-z0-9+/=]+'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /sandbox/);
  assert.doesNotMatch(csp, /script-src/);
  assert.doesNotMatch(csp, /unsafe-inline/);
  // No script and no inline handler anywhere in the document; the bodies
  // that tried are plain escaped text.
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /\son[a-z]+\s*=\s*["']/i, "no attribute-breakout reached an attribute");
  assert.doesNotMatch(html, / style=/i);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; stays text/);
  assert.match(html, /&quot; onmouseover=&quot;alert\(2\)&quot; data-x=&quot;&#39; onfocus=&#39;alert\(3\)/);
  assert.match(html, /Ship &lt;the&gt; thing/);
  assert.match(html, /Done when &quot;quoted&quot; &amp; shipped/);
  assert.match(html, /Merged the &lt;fix&gt;/);
  // The evidence link is the only user-controlled attribute and it is an
  // escaped, re-validated https URL.
  assert.match(html, /<a href="https:\/\/example\.com\/pr\/1\?q=%3Ca%3E&amp;r=%22b%22" rel="noopener noreferrer nofollow">/);
  assert.match(html, /version abc123/);
  // Tombstoned content is hidden: neither the original nor the edited text,
  // and no edit history; the slot reads "deleted".
  assert.doesNotMatch(html, /secret wording/);
  assert.match(html, /Message deleted/);
  assert.doesNotMatch(html, /Posted in error/, "the deletion reason is room-internal, not part of the readable copy");
  // Members and the work item's state are drawn from the walk.
  assert.match(html, /Room owner/);
  assert.match(html, /Test agent/);
  assert.match(html, /<span class="flag">completed<\/span>/);
  // Same auth as the JSONL format: any member, no one else.
  assert.equal((await request("/api/rooms/commons/export?format=html", { token: agentKey })).status, 200);
  assert.equal((await request("/api/rooms/commons/export?format=html")).status, 401);
  // Unknown or repeated formats are refused as input, not guessed.
  const bad = await request("/api/rooms/commons/export?format=pdf", { token: ownerKey });
  assert.equal(bad.status, 422);
  assert.equal((await bad.json()).error.code, "invalid_format");
  assert.equal((await request("/api/rooms/commons/export?format=html&format=jsonl", { token: ownerKey })).status, 422);
});

test("HTML export respects current membership: a removed member gets nothing, the room shows access ended", async t => {
  const { request, ownerKey, agentKey, store } = await serve(t);
  await seedReadableRoom(store, ownerKey);
  assert.equal((await request("/api/rooms/commons/export?format=html", { token: agentKey })).status, 200);
  assert.equal((await request("/api/rooms/commons/export", { token: agentKey })).status, 200);
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ACCESS_CHANGED,
    data: { memberId: "agent", expectedMemberRevision: 0, permissions: ["accept_work"], active: false } });
  for (const path of ["/api/rooms/commons/export?format=html", "/api/rooms/commons/export"]) {
    const denied = await request(path, { token: agentKey });
    assert.ok([401, 403].includes(denied.status), `${path}: expected 401/403 after removal, got ${denied.status}`);
    assert.match(denied.headers.get("content-type"), /application\/json/);
  }
  const html = await (await request("/api/rooms/commons/export?format=html", { token: ownerKey })).text();
  assert.match(html, /Test agent <span class="flag">agent<\/span> <span class="flag">access ended<\/span>/);
});

test("HTML export keeps the JSONL export byte-for-byte and shares its integrity rule", async t => {
  const { request, ownerKey, store } = await serve(t);
  await seedReadableRoom(store, ownerKey);
  const expected = [...store.exportEvents(ownerKey, "commons")].map(line => JSON.stringify(line) + "\n").join("");
  const plain = await (await request("/api/rooms/commons/export", { token: ownerKey })).text();
  const explicit = await (await request("/api/rooms/commons/export?format=jsonl", { token: ownerKey })).text();
  assert.equal(plain, expected);
  assert.equal(explicit, expected);
  // A failure part-way through the walk is a JSON error, never a clean-looking partial page.
  const real = store.exportEvents.bind(store);
  store.exportEvents = function* (...args) {
    let rows = 0;
    for (const line of real(...args)) { if (++rows > 2) throw new Error("storage read failed"); yield line; }
  };
  const failed = await request("/api/rooms/commons/export?format=html", { token: ownerKey });
  assert.equal(failed.status, 500);
  assert.match(failed.headers.get("content-type"), /application\/json/);
  assert.equal((await failed.json()).error.code, "internal_error");
  store.exportEvents = function* (...args) {
    for (const line of real(...args)) { yield line; throw new ServiceError(503, "storage_unavailable", "Storage is unavailable"); }
  };
  const unavailable = await request("/api/rooms/commons/export?format=html", { token: ownerKey });
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error.code, "storage_unavailable");
  store.exportEvents = real;
  assert.equal((await request("/api/rooms/commons/export?format=html", { token: ownerKey })).status, 200);
});

test("HTML renderer never links anything but a credential-free https URL and never fails on unknown events", () => {
  assert.equal(safeEvidenceHref("https://example.com/x"), "https://example.com/x");
  for (const bad of ["javascript:alert(1)", "data:text/html,hi", "http://example.com/", "https://user:pw@example.com/", "not a url", 42, null]) {
    assert.equal(safeEvidenceHref(bad), null, String(bad));
  }
  const at = "2026-09-14T10:00:00.000Z";
  const row = (sequence, type, data, actorId = "owner") => ({ sequence, event: { id: `e${sequence}`, roomId: "r", type, actorId, at, data } });
  const html = renderRoomExportHtml([
    row(1, T.ROOM_CREATED, { roomId: "r", ownerId: "owner", title: "<Title>", purpose: "Purpose \"quoted\"" }),
    row(2, T.MEMBER_ADDED, { memberId: "owner", displayName: "Owner <b>", kind: "human", permissions: [] }),
    row(3, T.WORK_PROPOSED, { workItemId: "w", title: "t", definitionOfDone: "d", accountableMemberId: "owner" }),
    row(4, T.WORK_COMPLETED, { workItemId: "w", expectedRevision: 0, summary: "s", nextAction: "n", evidenceUrl: "javascript:alert(1)", evidenceVersion: "v" }),
    row(5, T.WORK_HANDOFF_RECORDED, { workItemId: "w", expectedRevision: 1, doneSummary: "h", nextAction: "n", limitReason: "l", evidenceUrl: "https://example.com/h\" onclick=\"x", evidenceVersion: "v2" }),
    row(6, "future.event_type", { anything: "<goes>" }),
    row(7, T.MESSAGE_DELETED, { messageId: "never-posted" }),
    row(8, T.WORK_BLOCKED, { reason: "no work item id", nextAction: "n" }),
  ], { roomId: "r", generatedAt: at });
  assert.match(html, /Work items \(1\)/, "a work event without an id invents no item");
  assert.match(html, /<title>&lt;Title&gt; — room export<\/title>/);
  assert.match(html, /Owner &lt;b&gt;/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.match(html, /<code>javascript:alert\(1\)<\/code>/);
  assert.match(html, /<a href="https:\/\/example\.com\/h%22%20onclick=%22x" rel="noopener noreferrer nofollow">/);
  assert.doesNotMatch(html, /<goes>/);
  assert.match(html, /End of export: 8 events rendered, through sequence 8\./);
  assert.match(html, new RegExp(`<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; style-src &#39;sha256-`));
});
