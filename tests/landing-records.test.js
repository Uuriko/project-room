// Landing records (RECORD-PRIM): the room-native Record primitive from
// mig-primitives.md Primitive 3 — one typed object per qualified PR head,
// collapsing the LAND-READY message and the LAND_RECORD message into a
// single lifecycle (land-ready -> landed | revoked | superseded), with
// evidence and priced flags as data instead of prose.
//
// Specimens guard the charter's behaviours:
//   1. a record written through one door reads back byte-faithful through
//      the other (HTTP route <-> MCP tool share one serializer over one
//      stored item);
//   2. a verdict evidence ref round-trips unresolved-but-typed (stored and
//      returned verbatim, never looked up);
//   3. a record carrying priced flags cannot be created without naming
//      its accepting authority;
//   4. head-binding is structural: a replacement record at a new head, the
//      supersede verb, and the room land queue's observed head each move a
//      land-ready record to superseded, on both doors;
//   5. state changes are fenced to the creator, the room owner, or a
//      decide member, and terminal records refuse further transitions.
// Tests drive the public HTTP, MCP, and store boundaries only.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createHostedRoomMcp } from "../server/mcp-room-profile.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { ROUTES } from "../server/routes/table.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { DatabaseSync } from "node:sqlite";
import { LANDING_RECORD_STATES, EVIDENCE_KINDS, landingRecordEnv, createLandingRecord, getLandingRecord, landLandingRecord } from "../server/landing-records.mjs";
import { createDurableLandingRecordRegistry, landingRecordSchema } from "../server/landing-record-sqlite.mjs";
import { createLandingRecordRoute } from "../server/routes/landing-records.mjs";

const sha = ch => ch.repeat(40);
const HEAD_A = sha("a"), HEAD_B = sha("b"), BASE = sha("c"), MERGED = sha("d"), TREE = sha("e");

// --- module units ---------------------------------------------------------------

test("registry round-trips an envelope row on a bare database", () => {
  assert.equal(typeof createLandingRecordRoute, "function");
  assert.deepEqual([...LANDING_RECORD_STATES], ["land-ready", "landed", "revoked", "superseded"]);
  assert.deepEqual([...EVIDENCE_KINDS], ["suite", "ci", "verdict", "link"]);
  const db = new DatabaseSync(":memory:");
  db.exec(landingRecordSchema);
  const registry = createDurableLandingRecordRegistry(db);
  assert.equal(registry.get("room-a", "lr_x"), null);
  registry.set("room-a", { id: "lr_x", pr: 1, headSha: HEAD_A, state: "land-ready" });
  assert.equal(registry.get("room-a", "lr_x").headSha, HEAD_A);
  assert.equal(registry.list("room-a").length, 1);
  assert.equal(registry.list("room-b").length, 0);
  db.close();
});

// --- route table ---------------------------------------------------------------

test("route table registers the six landing-record rows with MCP parity notes", () => {
  const rows = new Map(ROUTES.map(row => [`${row.method} ${row.path}`, row]));
  for (const [key, tool] of [
    ["POST /api/rooms/{roomId}/landing-records", "room_create_landing_record"],
    ["GET /api/rooms/{roomId}/landing-records", "room_list_landing_records"],
    ["GET /api/rooms/{roomId}/landing-records/{recordId}", "room_list_landing_records"],
    ["POST /api/rooms/{roomId}/landing-records/{recordId}/land", "room_land_record"],
    ["POST /api/rooms/{roomId}/landing-records/{recordId}/revoke", "room_revoke_landing_record"],
    ["POST /api/rooms/{roomId}/landing-records/{recordId}/supersede", "room_supersede_landing_record"],
  ]) {
    const row = rows.get(key);
    assert.ok(row, `${key} is a route-table row`);
    assert.equal(row.auth, "room");
    assert.equal(row.scope, "room");
    assert.equal(typeof row.handler, "function");
    assert.ok(String(row.parity).includes(tool), `${key} parity names ${tool}`);
  }
});

// --- fixtures ------------------------------------------------------------------

function storeFixture(t, startAt = Date.parse("2026-10-22T12:00:00Z")) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-landing-records-"));
  let at = startAt;
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => at });
  store.initialize(initialRoom("commons"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const ownerKey = store.issueAccessKey("commons", "owner");
  const cmd = (token, type, data) => store.command(token, "commons", { id: randomUUID(), type, data });
  cmd(ownerKey, T.MEMBER_ADDED, { memberId: "helper", displayName: "Helper", kind: "agent", permissions: ["accept_work"], accountableHumanId: "owner" });
  cmd(ownerKey, T.MEMBER_ADDED, { memberId: "decider", displayName: "Decider", kind: "human", permissions: ["decide"] });
  cmd(ownerKey, T.MEMBER_ADDED, { memberId: "outsider", displayName: "Outsider", kind: "human", permissions: [] });
  const helperKey = store.issueAccessKey("commons", "helper");
  const deciderKey = store.issueAccessKey("commons", "decider");
  const outsiderKey = store.issueAccessKey("commons", "outsider");
  // the outsider's membership is deactivated after its key was issued: the
  // key still authenticates a credential, but the member check must
  // refuse the read
  const outsiderRevision = store.roomAuthority("commons").members["outsider"].revision;
  cmd(ownerKey, T.MEMBER_ACCESS_CHANGED, { memberId: "outsider", expectedMemberRevision: outsiderRevision, permissions: [], active: false });
  return { directory, store, ownerKey, helperKey, deciderKey, outsiderKey, now: () => at, advance: ms => { at += ms; } };
}

async function serve(t) {
  const f = storeFixture(t);
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, token, body, path) => {
    const res = await fetch(`${origin}${path}`, {
      method, headers: { Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  const records = (method, token, body, suffix = "") => call(method, token, body, `/api/rooms/commons/landing-records${suffix}`);
  return { ...f, origin, records };
}

const createBody = (over = {}) => ({ pr: 4496, headSha: HEAD_A, baseSha: BASE, ...over });

// --- HTTP: create / read / filters ----------------------------------------------

test("http: create a record; read it back; list filters by pr, state, mine", async t => {
  const { records, ownerKey, helperKey } = await serve(t);
  const created = await records("POST", ownerKey, createBody({ note: "CLEAN at head" }));
  assert.equal(created.status, 201);
  assert.equal(created.json.record.state, "land-ready");
  assert.equal(created.json.record.pr, 4496);
  assert.equal(created.json.record.createdBySeat.memberId, "owner");
  assert.deepEqual(created.json.record.evidence, []);
  assert.equal(created.json.record.landedAt, null);

  const read = await records("GET", helperKey, undefined, `/${created.json.record.id}`);
  assert.equal(read.status, 200);
  assert.deepEqual(read.json.record, created.json.record);

  const byPr = await records("GET", ownerKey, undefined, `?pr=4496`);
  assert.equal(byPr.json.records.length, 1);
  const byOtherPr = await records("GET", ownerKey, undefined, `?pr=1234`);
  assert.equal(byOtherPr.json.records.length, 0);
  const mine = await records("GET", helperKey, undefined, `?mine=1`);
  assert.equal(mine.json.records.length, 0);
  const badState = await records("GET", ownerKey, undefined, `?state=bogus`);
  assert.equal(badState.status, 422);
  assert.equal(badState.json.error.code, "invalid_landing_record");
});

test("http: validation — bad sha, unknown field, bad evidence kind are 422", async t => {
  const { records, ownerKey } = await serve(t);
  const badSha = await records("POST", ownerKey, createBody({ headSha: "abc" }));
  assert.equal(badSha.status, 422);
  assert.equal(badSha.json.error.code, "invalid_landing_record");
  const unknown = await records("POST", ownerKey, createBody({ wat: 1 }));
  assert.equal(unknown.status, 422);
  const badKind = await records("POST", ownerKey, createBody({ evidence: [{ kind: "vibe", ref: "x" }] }));
  assert.equal(badKind.status, 422);
  const missing = await records("GET", ownerKey, undefined, `/lr_nope`);
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, "landing_record_not_found");
});

test("http: a deactivated member's read refuses at the auth door", async t => {
  const { records, outsiderKey } = await serve(t);
  const read = await records("GET", outsiderKey, undefined, "");
  assert.equal(read.status, 401);
  assert.equal(read.json.error.code, "unauthenticated");
});

test("fence: the state machine refuses non-member reads and writes with 403 not_member", async t => {
  const f = storeFixture(t);
  const env = landingRecordEnv(f.store);
  const created = createLandingRecord(env, "commons", "owner", createBody());
  assert.throws(() => getLandingRecord(env, "commons", "ghost", created.record.id),
    error => error.status === 403 && error.code === "not_member");
  assert.throws(() => createLandingRecord(env, "commons", "ghost", createBody({ pr: 5 })),
    error => error.status === 403 && error.code === "not_member");
  assert.throws(() => landLandingRecord(env, "commons", "ghost", created.record.id, { mergedSha: MERGED }),
    error => error.status === 403 && error.code === "not_member");
});

// --- HTTP: evidence + flags -------------------------------------------------------

test("http: a verdict evidence ref round-trips unresolved-but-typed", async t => {
  const { records, ownerKey } = await serve(t);
  const evidence = [
    { kind: "suite", ref: "verify:affected run 2026-10-22T10:00Z", headSha: HEAD_A },
    { kind: "ci", ref: "https://example.invalid/runs/1", label: "hosted CI at head", headSha: HEAD_A },
    { kind: "verdict", ref: "vd_0123456789abcdef", label: "REV specimen" },
  ];
  const created = await records("POST", ownerKey, createBody({ evidence }));
  assert.equal(created.status, 201);
  assert.deepEqual(created.json.record.evidence, evidence);
  const read = await records("GET", ownerKey, undefined, `/${created.json.record.id}`);
  assert.deepEqual(read.json.record.evidence, evidence, "the verdict ref is stored and returned verbatim, never resolved");
});

test("http: priced flags require an accepting authority; per-flag authority defaults to the record's", async t => {
  const { records, ownerKey } = await serve(t);
  const unpriced = await records("POST", ownerKey, createBody({ flags: [{ flag: "eval EADDRINUSE, priced" }] }));
  assert.equal(unpriced.status, 422);
  assert.equal(unpriced.json.error.code, "invalid_landing_record");
  const priced = await records("POST", ownerKey, createBody({
    acceptingAuthority: "Jill (fleet coordinator)",
    flags: [{ flag: "eval EADDRINUSE, priced" }, { flag: "bench flag", acceptingAuthority: "John" }],
  }));
  assert.equal(priced.status, 201);
  assert.equal(priced.json.record.acceptingAuthority, "Jill (fleet coordinator)");
  assert.deepEqual(priced.json.record.flags, [
    { flag: "eval EADDRINUSE, priced", acceptingAuthority: "Jill (fleet coordinator)" },
    { flag: "bench flag", acceptingAuthority: "John" },
  ]);
});

// --- HTTP: lifecycle --------------------------------------------------------------

test("http: same-head duplicate is 409 with the existing record; a replacement head supersedes", async t => {
  const { records, ownerKey } = await serve(t);
  const first = await records("POST", ownerKey, createBody());
  assert.equal(first.status, 201);
  const dup = await records("POST", ownerKey, createBody({ note: "re-issue" }));
  assert.equal(dup.status, 409);
  assert.equal(dup.json.error.code, "landing_record_exists");
  assert.equal(dup.json.existing.id, first.json.record.id);

  const second = await records("POST", ownerKey, createBody({ headSha: HEAD_B }));
  assert.equal(second.status, 201);
  assert.deepEqual(second.json.record.supersedes, [first.json.record.id]);
  const oldRead = await records("GET", ownerKey, undefined, `/${first.json.record.id}`);
  assert.equal(oldRead.json.record.state, "superseded");
  assert.equal(oldRead.json.record.supersededBy, second.json.record.id);
  assert.equal(oldRead.json.record.supersededByHeadSha, HEAD_B);
});

test("http: land carries mergedSha/treeSha; terminal records refuse further transitions", async t => {
  const { records, ownerKey } = await serve(t);
  const created = await records("POST", ownerKey, createBody());
  const id = created.json.record.id;
  const landed = await records("POST", ownerKey, { mergedSha: MERGED, treeSha: TREE }, `/${id}/land`);
  assert.equal(landed.status, 200);
  assert.equal(landed.json.record.state, "landed");
  assert.equal(landed.json.record.mergedSha, MERGED);
  assert.equal(landed.json.record.treeSha, TREE);
  assert.ok(landed.json.record.landedAt);
  assert.equal(landed.json.record.landedBy, "owner");
  const again = await records("POST", ownerKey, { mergedSha: MERGED }, `/${id}/land`);
  assert.equal(again.status, 409);
  assert.equal(again.json.error.code, "landing_record_closed");
  const revokeLanded = await records("POST", ownerKey, { reason: "too late" }, `/${id}/revoke`);
  assert.equal(revokeLanded.status, 409);
});

test("http: authority — a plain member cannot land another's record; a decide member can", async t => {
  const { records, ownerKey, helperKey, deciderKey } = await serve(t);
  const created = await records("POST", ownerKey, createBody());
  const id = created.json.record.id;
  const refused = await records("POST", helperKey, { mergedSha: MERGED }, `/${id}/land`);
  assert.equal(refused.status, 403);
  assert.equal(refused.json.error.code, "landing_record_not_authority");
  const landed = await records("POST", deciderKey, { mergedSha: MERGED }, `/${id}/land`);
  assert.equal(landed.status, 200);
  assert.equal(landed.json.record.landedBy, "decider");
});

test("http: revoke with reason; the supersede verb names the new head", async t => {
  const { records, ownerKey } = await serve(t);
  const a = await records("POST", ownerKey, createBody({ pr: 111 }));
  const revoked = await records("POST", ownerKey, { reason: "issued in error" }, `/${a.json.record.id}/revoke`);
  assert.equal(revoked.status, 200);
  assert.equal(revoked.json.record.state, "revoked");
  assert.equal(revoked.json.record.revokeReason, "issued in error");

  const b = await records("POST", ownerKey, createBody({ pr: 222 }));
  const sameHead = await records("POST", ownerKey, { headSha: HEAD_A }, `/${b.json.record.id}/supersede`);
  assert.equal(sameHead.status, 422);
  const superseded = await records("POST", ownerKey, { headSha: HEAD_B, note: "watch saw the move" }, `/${b.json.record.id}/supersede`);
  assert.equal(superseded.status, 200);
  assert.equal(superseded.json.record.state, "superseded");
  assert.equal(superseded.json.record.supersededByHeadSha, HEAD_B);
});

// --- land-queue derivation ----------------------------------------------------------

test("derivation: the land queue's observed head supersedes a land-ready record on read", async t => {
  const f = await serve(t);
  const { records, ownerKey, store } = f;
  const created = await records("POST", ownerKey, createBody({ pr: 777 }));
  assert.equal(created.json.record.state, "land-ready");
  store.db.prepare(`INSERT INTO land_queue
    (room_id, item_id, repo, pr_number, claimant_member_id, added_by_member_id, title, head_sha,
     mergeable, behind, checks_state, merged_sha, created_at, updated_at)
    VALUES ('commons', 'lq_test777', 'Uuriko/project-room', 777, 'owner', 'owner', 'PR 777', ?,
     'mergeable', 0, 'green', NULL, ?, ?)`)
    .run(HEAD_B, f.now(), f.now());
  const read = await records("GET", ownerKey, undefined, `/${created.json.record.id}`);
  assert.equal(read.json.record.state, "superseded");
  assert.equal(read.json.record.supersededByHeadSha, HEAD_B);
  const listed = await records("GET", ownerKey, undefined, `?state=superseded`);
  assert.equal(listed.json.records.length, 1);

  // a queue observation at the SAME head changes nothing
  const second = await records("POST", ownerKey, createBody({ pr: 888 }));
  store.db.prepare(`INSERT INTO land_queue
    (room_id, item_id, repo, pr_number, claimant_member_id, added_by_member_id, title, head_sha,
     mergeable, behind, checks_state, merged_sha, created_at, updated_at)
    VALUES ('commons', 'lq_test888', 'Uuriko/project-room', 888, 'owner', 'owner', 'PR 888', ?,
     'mergeable', 0, 'green', NULL, ?, ?)`)
    .run(HEAD_A, f.now(), f.now());
  const stillReady = await records("GET", ownerKey, undefined, `/${second.json.record.id}`);
  assert.equal(stillReady.json.record.state, "land-ready");
});

// --- MCP door -----------------------------------------------------------------------

function mcpFixture(t) {
  const f = storeFixture(t);
  const owner = f.store.identities.create("Owen");
  const rooms = new AgentRooms(f.store);
  const { roomId, ownerMemberId } = rooms.create(owner.secret, { title: "Record room", purpose: "record mcp", displayName: "Owen" });
  const mcp = createHostedRoomMcp(f.store);
  const rpcCall = (name, args, secret) => mcp(
    { jsonrpc: "2.0", id: "c", method: "tools/call", params: { name, arguments: args } },
    { authorization: `Bearer ${secret}` });
  const valueOf = response => {
    if (response.error) throw new Error(`mcp error: ${JSON.stringify(response.error)}`);
    return response.result?.structuredContent ?? JSON.parse(response.result.content[0].text);
  };
  return { ...f, owner, roomId, ownerMemberId, rpcCall, valueOf, mcp };
}

test("mcp: the five landing-record tools create, list, land, revoke, supersede", async t => {
  const { owner, roomId, rpcCall, valueOf, mcp } = mcpFixture(t);
  const listed = await mcp({ jsonrpc: "2.0", id: "l", method: "tools/list", params: { profile: "full" } }, { authorization: `Bearer ${owner.secret}` });
  const names = listed.result.tools.map(tool => tool.name);
  for (const name of ["room_create_landing_record", "room_list_landing_records", "room_land_record", "room_revoke_landing_record", "room_supersede_landing_record"]) {
    assert.ok(names.includes(name), `${name} is in the hosted catalog`);
  }

  const created = valueOf(await rpcCall("room_create_landing_record",
    { roomId, pr: 4496, headSha: HEAD_A, baseSha: BASE, note: "via mcp" }, owner.secret));
  assert.equal(created.record.state, "land-ready");
  assert.equal(created.record.note, "via mcp");

  const all = valueOf(await rpcCall("room_list_landing_records", { roomId }, owner.secret));
  assert.equal(all.records.length, 1);

  const landed = valueOf(await rpcCall("room_land_record",
    { roomId, recordId: created.record.id, mergedSha: MERGED, treeSha: TREE }, owner.secret));
  assert.equal(landed.record.state, "landed");
  assert.equal(landed.record.mergedSha, MERGED);

  const second = valueOf(await rpcCall("room_create_landing_record",
    { roomId, pr: 222, headSha: HEAD_A, baseSha: BASE }, owner.secret));
  const revoked = valueOf(await rpcCall("room_revoke_landing_record",
    { roomId, recordId: second.record.id, reason: "mcp revoke" }, owner.secret));
  assert.equal(revoked.record.state, "revoked");

  const third = valueOf(await rpcCall("room_create_landing_record",
    { roomId, pr: 333, headSha: HEAD_A, baseSha: BASE }, owner.secret));
  const superseded = valueOf(await rpcCall("room_supersede_landing_record",
    { roomId, recordId: third.record.id, headSha: HEAD_B }, owner.secret));
  assert.equal(superseded.record.state, "superseded");
  assert.equal(superseded.record.supersededByHeadSha, HEAD_B);
});

// --- cross-door byte-faithfulness specimen -------------------------------------------

test("cross-door: a record written via HTTP reads byte-faithful via MCP, and the reverse", async t => {
  const f = mcpFixture(t);
  const { owner, roomId, ownerMemberId, rpcCall, valueOf, store } = f;
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const ownerKey = store.issueAccessKey(roomId, ownerMemberId);
  const call = async (method, body, path) => {
    const res = await fetch(`${origin}${path}`, {
      method, headers: { Origin: origin, Authorization: `Bearer ${ownerKey}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  const fullBody = {
    pr: 4496, headSha: HEAD_A, baseSha: BASE,
    evidence: [
      { kind: "suite", ref: "verify:affected at head", headSha: HEAD_A },
      { kind: "verdict", ref: "vd_0123456789abcdef" },
    ],
    flags: [{ flag: "browser shard priced" }],
    acceptingAuthority: "Jill (fleet coordinator)",
    note: "cross-door specimen",
  };

  // HTTP write -> MCP read
  const createdHttp = await call("POST", fullBody, `/api/rooms/${roomId}/landing-records`);
  assert.equal(createdHttp.status, 201);
  const viaMcp = valueOf(await rpcCall("room_list_landing_records", { roomId, recordId: createdHttp.json.record.id }, owner.secret));
  assert.deepEqual(viaMcp.record, createdHttp.json.record);
  assert.equal(JSON.stringify(viaMcp.record), JSON.stringify(createdHttp.json.record),
    "the MCP serialization is byte-identical to the HTTP serialization");

  // MCP write -> HTTP read
  const createdMcp = valueOf(await rpcCall("room_create_landing_record", { roomId, ...fullBody, pr: 4497 }, owner.secret));
  const viaHttp = await call("GET", undefined, `/api/rooms/${roomId}/landing-records/${createdMcp.record.id}`);
  assert.equal(viaHttp.status, 200);
  assert.deepEqual(viaHttp.json.record, createdMcp.record);
  assert.equal(JSON.stringify(viaHttp.json.record), JSON.stringify(createdMcp.record),
    "the HTTP serialization is byte-identical to the MCP serialization");

  // a transition through one door is the same object through the other
  const landedHttp = await call("POST", { mergedSha: MERGED, treeSha: TREE }, `/api/rooms/${roomId}/landing-records/${createdHttp.json.record.id}/land`);
  assert.equal(landedHttp.status, 200);
  const landedViaMcp = valueOf(await rpcCall("room_list_landing_records", { roomId, recordId: createdHttp.json.record.id }, owner.secret));
  assert.equal(JSON.stringify(landedViaMcp.record), JSON.stringify(landedHttp.json.record));
});
