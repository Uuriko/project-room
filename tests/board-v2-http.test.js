// Board-v2 HTTP wiring tests (RC-2026-09-27-2720).
//
// Contract: /api/rooms/:roomId/board/v2/* mounts the durable board-v2 state
// machine (server/board-v2-durable.mjs, a faithful port of BoardV2) over the
// standard room funnel — credential + 600/min read limit + protectWrite +
// 60/min write limit; lanes bound to auth.member.id; guest writes refused;
// idempotency replay. Validation grammar and error codes are the prototype's
// verbatim (server/board-v2.mjs).
//
// Authoring gate:
// 1. Protects: the HTTP mount boundary — authenticated claim → heartbeat →
//    release lifecycle, receipt attachment, durable persistence across server
//    reopen, lane binding (impersonation), guest write denial, unauthenticated
//    rejection, typed 422s, idempotency replay, events pagination/watermark,
//    notes/findings/decisions/mirror round-trips.
// 2. Regression: an unwired route 404s; a mount that misses the durable
//    registry silently drops state on restart; a missing lane check lets one
//    lane heartbeat another's claim; a missing guest check lets guests claim
//    files; an unauthenticated route leaks the board.
// 3. Existing coverage: tests/board-v2.test.js covers the in-memory
//    prototype; tests/board-v2-sqlite.test.js covers the registry;
//    tests/recovery.test.js covers the recovery routes. None drive the HTTP
//    funnel into the durable board.
// 4. No production seam: real RoomStore + createRoomServer, the production
//    path; GX guest redemption is the real guest flow.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { generateKeyPair, signCard } from "../server/agent-card-signing.mjs";

const B = "/api/rooms/commons/board/v2";
let taskSeq = 91000;
const taskId = () => `RC-2026-09-27-${taskSeq++}`;

async function serveFixture(t) {
  const fixture = createAcceptanceFixture();
  const server = createRoomServer({ store: fixture.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fixture.store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { method = "GET", data, token, idempotencyKey } = {}) => fetch(origin + path, {
    method,
    headers: {
      Origin: origin,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      ...(data === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  return { store: fixture.store, request, keys: fixture.keys };
}

async function redeemGuest(request, ownerKey, store, name = "BoardGuest") {
  const mint = await request("/api/rooms/commons/guest-invites", {
    method: "POST", token: ownerKey,
    data: { requestId: randomUUID(), guestLabel: `${name} visit`, expectedOwnerRevision: 0 },
  });
  assert.equal(mint.status, 201);
  const minted = await mint.json();
  const identity = store.identities.create(name);
  const keys = generateKeyPair();
  const cardBody = { name, description: "visiting agent", capabilities: ["chat"] };
  const card = { ...cardBody, publicKey: keys.publicKey,
    signature: signCard({ agentId: identity.identityId, card: cardBody, privateKey: keys.privateKey }) };
  const redeemed = await request("/api/guest-invites/redeem", {
    method: "POST", token: identity.secret, data: { inviteCode: minted.code, card },
  });
  assert.equal(redeemed.status, 201);
  const value = await redeemed.json();
  assert.ok(value.token.startsWith("ga1."));
  assert.ok(value.member.id.startsWith("guest-agent-"));
  return value;
}

const codeOf = async res => (await res.json()).error?.code;

test("claim -> heartbeat -> release lifecycle over HTTP binds the authenticated lane", async t => {
  const { request, keys } = await serveFixture(t);
  const tid = taskId();

  const created = await request(`${B}/claims`, { method: "POST", token: keys.owner,
    data: { task_id: tid, files: ["server/http.mjs"], lease: "lease=8h", reason: "http wiring" } });
  assert.equal(created.status, 201);
  const createdBody = await created.json();
  assert.equal(createdBody.claim.task_id, tid);
  assert.equal(createdBody.claim.lane, "owner");
  assert.equal(createdBody.claim.state, "submitted");
  assert.deepEqual(createdBody.claim.files, ["server/http.mjs"]);
  assert.equal(createdBody.claim.lease_h, 8);
  assert.ok(createdBody.seq >= 1 && createdBody.watermark >= 1);

  const beat = await request(`${B}/claims/${tid}/heartbeat`, { method: "POST", token: keys.owner,
    data: { note: "wiring in progress" } });
  assert.equal(beat.status, 200);
  const beatBody = await beat.json();
  assert.equal(beatBody.claim.state, "working");
  assert.ok(beatBody.seq > createdBody.seq);

  const released = await request(`${B}/claims/${tid}/release`, { method: "POST", token: keys.owner,
    data: { reason: "done with the HTTP check" } });
  assert.equal(released.status, 200);
  assert.equal((await released.json()).claim.state, "released");

  // Released claims are no longer live: the next heartbeat is 404 unknown_task.
  const after = await request(`${B}/claims/${tid}/heartbeat`, { method: "POST", token: keys.owner, data: {} });
  assert.equal(after.status, 404);
  assert.equal(await codeOf(after), "unknown_task");
});

test("receipts attach sha/pr evidence to a live claim without closing it", async t => {
  const { request, keys } = await serveFixture(t);
  const tid = taskId();
  const created = await request(`${B}/claims`, { method: "POST", token: keys.owner,
    data: { task_id: tid, files: ["server/http.mjs"], lease: "lease=8h", reason: "receipt check" } });
  assert.equal(created.status, 201);

  const receipt = await request(`${B}/claims/${tid}/receipts`, { method: "POST", token: keys.owner,
    data: { sha: "abc1234", pr: 1148 } });
  assert.equal(receipt.status, 201);
  const receiptBody = await receipt.json();
  assert.equal(receiptBody.receipt.sha, "abc1234");
  assert.equal(receiptBody.receipt.pr, 1148);

  // The claim is still live: heartbeats keep working and the receipt is attached.
  const beat = await request(`${B}/claims/${tid}/heartbeat`, { method: "POST", token: keys.owner, data: {} });
  assert.equal(beat.status, 200);
  assert.deepEqual((await beat.json()).claim.receipts.map(r => r.sha), ["abc1234"]);

  const badSha = await request(`${B}/claims/${tid}/receipts`, { method: "POST", token: keys.owner,
    data: { sha: "not-a-sha" } });
  assert.equal(badSha.status, 422);
  assert.equal(await codeOf(badSha), "invalid_sha");
});

test("lane binding: body lane mismatch and cross-lane writes are refused", async t => {
  const { request, keys } = await serveFixture(t);
  const tid = taskId();

  const forged = await request(`${B}/claims`, { method: "POST", token: keys.owner,
    data: { task_id: tid, lease: "lease=8h", reason: "x", lane: "producer" } });
  assert.equal(forged.status, 403);
  assert.equal(await codeOf(forged), "lane_mismatch");

  const created = await request(`${B}/claims`, { method: "POST", token: keys.owner,
    data: { task_id: tid, files: ["server/http.mjs"], lease: "lease=8h", reason: "x" } });
  assert.equal(created.status, 201);

  // Producer heartbeats the owner's claim: lane mismatch even without a body lane.
  const cross = await request(`${B}/claims/${tid}/heartbeat`, { method: "POST", token: keys.producer, data: {} });
  assert.equal(cross.status, 403);
  assert.equal(await codeOf(cross), "lane_mismatch");

  // A duplicate task-id from another lane is 409 duplicate_task, not a hijack.
  const dup = await request(`${B}/claims`, { method: "POST", token: keys.producer,
    data: { task_id: tid, lease: "lease=8h", reason: "x" } });
  assert.equal(dup.status, 409);
  assert.equal(await codeOf(dup), "duplicate_task");
});

test("unauthenticated board-v2 requests are rejected", async t => {
  const { request } = await serveFixture(t);
  for (const [method, path, data] of [
    ["GET", `${B}/claims`], ["GET", `${B}/board`], ["GET", `${B}/events`],
    ["GET", `${B}/health`], ["GET", `${B}/notes`], ["GET", `${B}/mirror-map`],
    ["POST", `${B}/claims`, { task_id: taskId(), lease: "lease=8h", reason: "x" }],
    ["POST", `${B}/notes`, { body: "hello" }],
  ]) {
    const res = await request(path, { method, data });
    assert.equal(res.status, 401, `${method} ${path}: expected 401, got ${res.status}`);
    await res.text().catch(() => {});
  }
});

test("malformed writes are typed 422s with the prototype's codes", async t => {
  const { request, keys } = await serveFixture(t);

  const unknown = await request(`${B}/claims`, { method: "POST", token: keys.owner,
    data: { task_id: taskId(), lease: "lease=8h", reason: "x", bogus: 1 } });
  assert.equal(unknown.status, 422);
  assert.equal(await codeOf(unknown), "unknown_field");

  const lease = await request(`${B}/claims`, { method: "POST", token: keys.owner,
    data: { task_id: taskId(), files: ["server/http.mjs"], lease: "8h", reason: "x" } });
  assert.equal(lease.status, 422);
  assert.equal(await codeOf(lease), "invalid_lease");

  const missing = await request(`${B}/claims`, { method: "POST", token: keys.owner,
    data: { lease: "lease=8h", reason: "x" } });
  assert.equal(missing.status, 422);
  assert.equal(await codeOf(missing), "invalid_task_id");

  const note = await request(`${B}/notes`, { method: "POST", token: keys.owner, data: { body: "" } });
  assert.equal(note.status, 422);
  assert.equal(await codeOf(note), "invalid_body");

  const missingNote = await request(`${B}/notes`, { method: "POST", token: keys.owner, data: {} });
  assert.equal(missingNote.status, 422);
  assert.equal(await codeOf(missingNote), "invalid_body");

  const beat = await request(`${B}/claims/${taskId()}/heartbeat`, { method: "POST", token: keys.owner, data: {} });
  assert.equal(beat.status, 404);
  assert.equal(await codeOf(beat), "unknown_task");

  const noReason = await request(`${B}/claims/${taskId()}/release`, { method: "POST", token: keys.owner, data: {} });
  assert.equal(noReason.status, 422);
  assert.equal(await codeOf(noReason), "invalid_reason");
});

test("Idempotency-Key replays the first response; a differing body mismatches", async t => {
  const { request, keys } = await serveFixture(t);
  const tid = taskId();
  const key = `idem-${randomUUID()}`;
  const payload = { task_id: tid, files: ["server/http.mjs"], lease: "lease=8h", reason: "first" };

  const first = await request(`${B}/claims`, { method: "POST", token: keys.owner, data: payload, idempotencyKey: key });
  assert.equal(first.status, 201);
  const firstBody = await first.json();

  const replay = await request(`${B}/claims`, { method: "POST", token: keys.owner, data: payload, idempotencyKey: key });
  assert.equal(replay.status, 201);
  assert.deepEqual(await replay.json(), firstBody);

  const mismatch = await request(`${B}/claims`, { method: "POST", token: keys.owner,
    data: { ...payload, reason: "different" }, idempotencyKey: key });
  assert.equal(mismatch.status, 422);
  assert.equal(await codeOf(mismatch), "idempotency_key_mismatch");
});

test("guest members may read the board but never write to it", async t => {
  const { store, request, keys } = await serveFixture(t);
  const guest = await redeemGuest(request, keys.owner, store);

  const write = await request(`${B}/claims`, { method: "POST", token: guest.token,
    data: { task_id: taskId(), lease: "lease=8h", reason: "x" } });
  assert.equal(write.status, 403);
  assert.equal(await codeOf(write), "guest_scope_denied");

  const note = await request(`${B}/notes`, { method: "POST", token: guest.token, data: { body: "guest note" } });
  assert.equal(note.status, 403);
  assert.equal(await codeOf(note), "guest_scope_denied");

  const read = await request(`${B}/board`, { token: guest.token });
  assert.equal(read.status, 200);
  assert.ok(typeof (await read.json()).watermark === "number");
});

test("board state survives a full server reopen", async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-boardv2-durable-"));
  const dbPath = join(directory, "room.sqlite");
  const tid = taskId();

  const boot = async (fresh) => {
    const store = new RoomStore(dbPath, { now: () => Date.now() });
    if (fresh) store.initialize(initialRoom());
    const ownerKey = store.issueAccessKey("commons", "owner");
    const server = createRoomServer({ store });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const request = (path, { method = "GET", data } = {}) => fetch(origin + path, {
      method,
      headers: { Origin: origin, Authorization: `Bearer ${ownerKey}`, ...(data === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return { store, server, request };
  };
  const shutdown = async ({ store, server }) => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); store.close();
  };

  const first = await boot(true);
  const created = await first.request(`${B}/claims`, { method: "POST",
    data: { task_id: tid, files: ["server/http.mjs"], lease: "lease=8h", reason: "durable check" } });
  assert.equal(created.status, 201);
  const note = await first.request(`${B}/notes`, { method: "POST", data: { body: "survives reopen" } });
  assert.equal(note.status, 201);
  await shutdown(first);

  const second = await boot(false);
  try {
    const board = await second.request(`${B}/board`);
    assert.equal(board.status, 200);
    const snapshot = await board.json();
    assert.ok(snapshot.claims.some(c => c.task_id === tid && c.lane === "owner"), "claim survived reopen");
    const notes = await second.request(`${B}/notes`);
    assert.equal(notes.status, 200);
    assert.ok((await notes.json()).notes.some(n => n.body === "survives reopen"), "note survived reopen");
    const events = await second.request(`${B}/events?kind=claim`);
    assert.equal(events.status, 200);
    assert.ok((await events.json()).events.some(e => e.task_id === tid));
  } finally {
    await shutdown(second);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("events paginate on the seq watermark and filter by kind and lane", async t => {
  const { request, keys } = await serveFixture(t);
  const stamp = taskSeq;
  for (let i = 0; i < 3; i++) {
    const created = await request(`${B}/claims`, { method: "POST", token: keys.owner,
      data: { task_id: taskId(), files: ["server/http.mjs"], lease: "lease=8h", reason: "page" } });
    assert.equal(created.status, 201);
  }
  const page1 = await request(`${B}/events?limit=2`, { token: keys.owner });
  assert.equal(page1.status, 200);
  const p1 = await page1.json();
  assert.equal(p1.events.length, 2);
  assert.equal(p1.has_more, true);
  const cursor = p1.events[1].seq;

  const page2 = await request(`${B}/events?since_seq=${cursor}`, { token: keys.owner });
  assert.equal(page2.status, 200);
  const p2 = await page2.json();
  assert.ok(p2.events.every(e => e.seq > cursor));
  assert.ok(p2.events.some(e => e.kind === "claim"));

  const filtered = await request(`${B}/events?kind=note`, { token: keys.owner });
  assert.equal(filtered.status, 200);
  assert.ok((await filtered.json()).events.every(e => e.kind === "note"));

  const byLane = await request(`${B}/events?lane=owner`, { token: keys.owner });
  assert.equal(byLane.status, 200);
  assert.ok((await byLane.json()).events.every(e => e.lane === "owner"));
  assert.ok(stamp > 0);
});

test("notes, findings, decisions and the mirror map round-trip over HTTP", async t => {
  const { request, keys } = await serveFixture(t);
  const stamp = randomUUID().slice(0, 6);

  const noted = await request(`${B}/notes`, { method: "POST", token: keys.owner,
    data: { body: `note ${stamp}`, severity: "info" } });
  assert.equal(noted.status, 201);
  assert.equal((await noted.json()).note.body, `note ${stamp}`);
  const notes = await request(`${B}/notes?severity=info`, { token: keys.owner });
  assert.equal(notes.status, 200);
  assert.ok((await notes.json()).notes.some(n => n.body === `note ${stamp}`));

  const found = await request(`${B}/findings`, { method: "POST", token: keys.owner,
    data: { severity: "high", title: `finding ${stamp}`, recommendation: "fix it" } });
  assert.equal(found.status, 201);
  assert.equal((await found.json()).finding.title, `finding ${stamp}`);
  const findings = await request(`${B}/findings`, { token: keys.owner });
  assert.equal(findings.status, 200);
  assert.ok((await findings.json()).findings.some(f => f.title === `finding ${stamp}`));

  const decided = await request(`${B}/decisions`, { method: "POST", token: keys.owner,
    data: { scope: "board", statement: `decision ${stamp}` } });
  assert.equal(decided.status, 201);
  const decisionBody = await decided.json();
  assert.equal(decisionBody.decision.statement, `decision ${stamp}`);
  const decisions = await request(`${B}/decisions`, { token: keys.owner });
  assert.equal(decisions.status, 200);
  assert.ok((await decisions.json()).decisions.some(d => d.statement === `decision ${stamp}`));

  // Mirror map: record a (seq, issue, comment) mapping, then resolve it back.
  const mapped = await request(`${B}/mirror-map`, { method: "POST", token: keys.owner,
    data: { seq: decisionBody.seq, issue: 266, comment_id: 5859322518 } });
  assert.equal(mapped.status, 201);
  const resolved = await request(`${B}/mirror-map?issue=266&comment_id=5859322518`, { token: keys.owner });
  assert.equal(resolved.status, 200);
  assert.equal((await resolved.json()).seq, decisionBody.seq);
  const listed = await request(`${B}/mirror-map`, { token: keys.owner });
  assert.equal(listed.status, 200);
  assert.ok((await listed.json()).entries.some(e => e.issue === 266 && e.comment_id === 5859322518));
});

test("board snapshot carries the watermark, claims, file-claims and health counts", async t => {
  const { request, keys } = await serveFixture(t);
  const tid = taskId();
  const created = await request(`${B}/claims`, { method: "POST", token: keys.owner,
    data: { task_id: tid, files: ["server/http.mjs"], lease: "lease=8h", reason: "snapshot" } });
  assert.equal(created.status, 201);

  const board = await request(`${B}/board`, { token: keys.owner });
  assert.equal(board.status, 200);
  const snapshot = await board.json();
  assert.ok(snapshot.watermark >= 1);
  assert.ok(snapshot.claims.some(c => c.task_id === tid));
  assert.ok(snapshot.file_claims.some(fc => fc.file === "server/http.mjs"));

  const claims = await request(`${B}/claims?state=submitted`, { token: keys.owner });
  assert.equal(claims.status, 200);
  assert.ok((await claims.json()).claims.some(c => c.task_id === tid));

  const health = await request(`${B}/health`, { token: keys.owner });
  assert.equal(health.status, 200);
  const h = await health.json();
  assert.ok(h.seq >= snapshot.watermark);
  assert.ok(h.live_claims >= 1);
});
