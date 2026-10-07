// Claim provenance + rollback (orch-provenance-rollback).
//
// A single seeded atomic error reached 100% system-wide false consensus in
// 5 of 6 frameworks (Xie et al., "From Spark to Fire", arXiv 2603.04474);
// detection without rollback contains ~3% of error cascades, block+rollback
// 89-94%. These tests pin the provenance contract at its two owner
// boundaries:
//
//   pure (server/work-claims.mjs): parentClaimId + evidenceRefs recorded and
//   validated on create/claim/update; walkProvenance returns the direct and
//   transitive downstream graph; flagPremiseInvalid/clearPremiseFlag stamp
//   history without changing work outcomes.
//   HTTP (server/work-claim-routes.mjs): the create/claim/update bodies
//   accept the new optional fields; GET .../provenance walks the graph;
//   POST .../premise-invalid flags the premise and every downstream claim.
//
// The fields are purely additive: items stored without them normalize to
// parentClaimId null and evidenceRefs [], so old rows and old clients keep
// working (backward compatibility is itself asserted below).
import test from "node:test";
import assert from "node:assert/strict";
import {
  createWork, claimWork, updateWork,
  walkProvenance, flagPremiseInvalid, clearPremiseFlag,
  ClaimError,
} from "../server/work-claims.mjs";

const NOW = "2026-10-06T05:00:00.000Z";
const SHA_REF = `sha256:${"ab".repeat(32)}`;
const URL_REF = "https://example.com/evidence/report.md";

const makeRoom = (...defs) => defs.map(def =>
  createWork({ id: def.id, title: def.title ?? def.id, parentClaimId: def.parentClaimId }, { now: NOW, agentId: "coord" }));

// --- pure: recording ------------------------------------------------------

test("createWork records parentClaimId and evidenceRefs", () => {
  const item = createWork({ id: "child", parentClaimId: "parent", evidenceRefs: [SHA_REF, URL_REF] },
    { now: NOW, agentId: "coord" });
  assert.equal(item.parentClaimId, "parent");
  assert.deepEqual([...item.evidenceRefs], [SHA_REF, URL_REF]);
});

test("provenance fields default on legacy items (backward compatible)", () => {
  const item = createWork({ id: "legacy" }, { now: NOW, agentId: "coord" });
  assert.equal(item.parentClaimId, null);
  assert.deepEqual([...item.evidenceRefs], []);
});

test("createWork rejects a self parent and malformed refs", () => {
  assert.throws(() => createWork({ id: "x", parentClaimId: "x" }, { now: NOW, agentId: "coord" }), ClaimError);
  assert.throws(() => createWork({ id: "x", parentClaimId: "not a valid id!!" }, { now: NOW, agentId: "coord" }), ClaimError);
  assert.throws(() => createWork({ id: "x", evidenceRefs: ["nope"] }, { now: NOW, agentId: "coord" }), ClaimError);
  assert.throws(() => createWork({ id: "x", evidenceRefs: ["http://insecure.example/x"] }, { now: NOW, agentId: "coord" }), ClaimError);
  assert.throws(() => createWork({ id: "x", evidenceRefs: ["sha256:short"] }, { now: NOW, agentId: "coord" }), ClaimError);
});

test("claimWork sets or replaces provenance; updateWork amends it on active claims", () => {
  const created = createWork({ id: "c", parentClaimId: "p0" }, { now: NOW, agentId: "coord" });
  const claimed = claimWork(created, "worker", { parentClaimId: "p1", evidenceRefs: [URL_REF], now: NOW });
  assert.equal(claimed.parentClaimId, "p1");
  assert.deepEqual([...claimed.evidenceRefs], [URL_REF]);
  // Omitted fields preserve the claim-time values.
  const kept = claimWork(createWork({ id: "d", evidenceRefs: [SHA_REF] }, { now: NOW, agentId: "coord" }),
    "worker", { now: NOW });
  assert.deepEqual([...kept.evidenceRefs], [SHA_REF]);
  assert.equal(kept.parentClaimId, null);
  // Owner update can set and clear.
  const updated = updateWork(claimed, "worker", { parentClaimId: null, now: NOW });
  assert.equal(updated.parentClaimId, null);
  const started = updateWork(updated, "worker", { state: "in_progress", now: NOW });
  const done = updateWork(started, "worker", { state: "done", evidenceRefs: [SHA_REF], now: NOW });
  assert.equal(done.state, "done");
  assert.deepEqual([...done.evidenceRefs], [SHA_REF], "evidence refs ride the claim onto its receipt");
  assert.equal(done.parentClaimId, null, "parent recorded before done freezes with the receipt");
});

// --- pure: walk ------------------------------------------------------------

test("walkProvenance returns direct and transitive downstream with depth", () => {
  const items = makeRoom(
    { id: "root" },
    { id: "a", parentClaimId: "root" },
    { id: "b", parentClaimId: "a" },
    { id: "c", parentClaimId: "root" },
    { id: "unrelated" },
  );
  const walk = walkProvenance(items, "root");
  const byId = new Map(walk.downstream.map(node => [node.id, node]));
  assert.equal(walk.downstream.length, 3);
  assert.equal(byId.get("a").depth, 1);
  assert.equal(byId.get("c").depth, 1);
  assert.equal(byId.get("b").depth, 2, "transitive child is reached through its parent");
  assert.ok(!byId.has("unrelated"));
  for (const node of walk.downstream) {
    assert.ok(typeof node.state === "string" && typeof node.title === "string");
  }
});

test("walkProvenance is cycle-safe and caps runaway graphs", () => {
  // A cycle built through two claimed items (the pure layer refuses only
  // direct self-parenting; longer cycles stay possible through updates).
  let x = claimWork(createWork({ id: "x", parentClaimId: "y" }, { now: NOW, agentId: "coord" }), "worker", { now: NOW });
  let y = claimWork(createWork({ id: "y" }, { now: NOW, agentId: "coord" }), "worker", { now: NOW });
  y = updateWork(y, "worker", { parentClaimId: "x", now: NOW });
  const walk = walkProvenance([x, y], "x");
  assert.ok(walk.downstream.some(node => node.id === "y"), "reaches the child once");
  assert.equal(walk.downstream.filter(node => node.id === "y").length, 1, "no infinite loop on cycles");
  assert.throws(() => walkProvenance([x, y], "missing"), ClaimError, "unknown root is refused");
});

// --- pure: flag / clear -----------------------------------------------------

test("flagPremiseInvalid stamps the item without changing its work state", () => {
  const claimed = claimWork(createWork({ id: "built" }, { now: NOW, agentId: "coord" }), "worker", { now: NOW });
  const started = updateWork(claimed, "worker", { state: "in_progress", now: NOW });
  const item = updateWork(started, "worker", { state: "done", now: NOW });
  const flagged = flagPremiseInvalid(item, { premiseId: "root", reason: "the premise doc was wrong", byMemberId: "coord", now: NOW });
  assert.equal(flagged.state, "done", "flagging never reopens or reverts work");
  assert.equal(flagged.premiseFlag.premiseId, "root");
  assert.equal(flagged.premiseFlag.reason, "the premise doc was wrong");
  assert.equal(flagged.premiseFlag.by, "coord");
  assert.ok(flagged.history.some(entry => entry.action === "premise_flagged"));
  const cleared = clearPremiseFlag(flagged, { byMemberId: "coord", note: "re-verified against the corrected doc", now: NOW });
  assert.equal(cleared.premiseFlag, null);
  assert.ok(cleared.history.some(entry => entry.action === "premise_cleared"));
});

test("flagPremiseInvalid validates its inputs", () => {
  const item = createWork({ id: "w" }, { now: NOW, agentId: "coord" });
  assert.throws(() => flagPremiseInvalid(item, { premiseId: "r", reason: "", byMemberId: "coord", now: NOW }), ClaimError);
  assert.throws(() => clearPremiseFlag(item, { byMemberId: "coord", now: NOW }), ClaimError, "clearing an unflagged claim is refused");
});

// --- HTTP: routes ------------------------------------------------------------
// The transport boundary: new optional body fields are accepted on the
// existing write routes, and the provenance / premise-invalid routes behave.
// Uses a live server (the same fixture shape as work-claim-board.test.js).
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function httpFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "provenance-http-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const add = (id, displayName, permissions) => store.command(ownerKey, "commons", {
    id: `add-${id}`, type: "member.added",
    data: { memberId: id, displayName, kind: "agent", permissions }
  });
  add("coord", "Coord", ["accept_work", "complete_work", "manage_claims"]);
  add("worker", "Worker", ["accept_work", "complete_work"]);
  const keys = { owner: ownerKey, coord: store.issueAccessKey("commons", "coord"), worker: store.issueAccessKey("commons", "worker") };
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); await rm(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (token, path, body, method) => {
    const response = await fetch(`${origin}/api/rooms/commons${path}`, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, value: await response.json() };
  };
  return { keys, call };
}

test("HTTP create/claim/update accept provenance fields; provenance walks the graph", async t => {
  const f = await httpFixture(t);
  const { keys, call } = f;
  // Old clients keep working: no provenance fields at all.
  assert.equal((await call(keys.coord, "/work-claims", { id: "root", title: "Root premise" })).status, 201);
  const created = await call(keys.coord, "/work-claims",
    { id: "child", title: "Child", parentClaimId: "root", evidenceRefs: [SHA_REF, URL_REF] });
  assert.equal(created.status, 201);
  assert.equal(created.value.parentClaimId, "root");
  assert.deepEqual(created.value.evidenceRefs, [SHA_REF, URL_REF]);
  assert.equal((await call(keys.worker, "/work-claims/child/claim", { parentClaimId: "root" })).status, 200);
  assert.equal((await call(keys.coord, "/work-claims", { id: "grandchild", parentClaimId: "child" })).status, 201);
  // Unknown body keys are still refused (strict shapes).
  assert.equal((await call(keys.coord, "/work-claims", { id: "bad", parent_claim_id: "root" })).status, 422);
  // The walk: REST read of the downstream graph.
  const walk = await call(keys.worker, "/work-claims/root/provenance");
  assert.equal(walk.status, 200);
  assert.equal(walk.value.claimId, "root");
  const ids = new Map(walk.value.downstream.map(node => [node.id, node.depth]));
  assert.deepEqual([...ids.keys()].sort(), ["child", "grandchild"]);
  assert.equal(ids.get("child"), 1);
  assert.equal(ids.get("grandchild"), 2);
  assert.equal((await call(keys.worker, "/work-claims/missing/provenance")).status, 404);
});

test("HTTP premise-invalid flags the premise and all downstream claims", async t => {
  const f = await httpFixture(t);
  const { keys, call } = f;
  assert.equal((await call(keys.coord, "/work-claims", { id: "premise", title: "Bad premise" })).status, 201);
  assert.equal((await call(keys.coord, "/work-claims", { id: "down-a", parentClaimId: "premise" })).status, 201);
  assert.equal((await call(keys.coord, "/work-claims", { id: "down-b", parentClaimId: "down-a" })).status, 201);
  assert.equal((await call(keys.coord, "/work-claims", { id: "other" })).status, 201);
  // A member who is neither the premise owner nor a claim manager is refused.
  assert.equal((await call(keys.worker, "/work-claims/premise/premise-invalid", { reason: "x" })).status, 403);
  // The premise owner (coord created it, owner key acts with authority) flags it.
  const flagged = await call(keys.owner, "/work-claims/premise/premise-invalid",
    { reason: "the premise doc was wrong" });
  assert.equal(flagged.status, 200);
  assert.deepEqual([...flagged.value.flagged].sort(), ["down-a", "down-b", "premise"]);
  for (const id of ["premise", "down-a", "down-b"]) {
    const read = await call(keys.coord, `/work-claims/${id}`);
    assert.equal(read.value.premiseFlag.premiseId, "premise", `${id} carries the flag`);
  }
  const untouched = await call(keys.coord, "/work-claims/other");
  assert.equal(untouched.value.premiseFlag ?? null, null, "unrelated claims are not flagged");
  // Clearing after re-review removes the flag.
  const cleared = await call(keys.owner, "/work-claims/down-a/premise-invalid", { clear: true, note: "re-verified" });
  assert.equal(cleared.status, 200);
  assert.equal((await call(keys.coord, "/work-claims/down-a")).value.premiseFlag ?? null, null);
});

// --- MCP: parity for the walk ------------------------------------------------
// The hosted MCP tool room_work_claim_provenance must return the same graph
// as the REST route, through the real tools/call dispatch.
import { mkdtempSync, rmSync } from "node:fs";
import { AgentRooms, agentRoomSchema } from "../server/agent-rooms.mjs";
import { createHostedRoomMcp } from "../server/mcp-room-profile.mjs";

test("MCP room_work_claim_provenance returns the same downstream graph", async t => {
  const directory = mkdtempSync(join(tmpdir(), "provenance-mcp-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.db.exec(agentRoomSchema);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const rooms = new AgentRooms(store);
  const owner = store.identities.create("Owen");
  const created = rooms.create(owner.secret, { title: "Provenance room", purpose: "walk test", displayName: "Owen" });
  const roomId = created.roomId;
  store.workClaims.set(roomId, createWork({ id: "root", title: "Root" }, { now: NOW, agentId: "coord" }));
  store.workClaims.set(roomId, createWork({ id: "child", title: "Child", parentClaimId: "root" }, { now: NOW, agentId: "coord" }));
  store.workClaims.set(roomId, createWork({ id: "grandchild", title: "Grandchild", parentClaimId: "child" }, { now: NOW, agentId: "coord" }));
  const mcp = createHostedRoomMcp(store);
  const response = await mcp(
    { jsonrpc: "2.0", id: "w1", method: "tools/call",
      params: { name: "room_work_claim_provenance", arguments: { roomId, claimId: "root" } } },
    { authorization: `Bearer ${owner.secret}` });
  assert.ok(!response.error, `expected a result, got ${JSON.stringify(response.error ?? null).slice(0, 200)}`);
  const value = response.result.structuredContent ?? JSON.parse(response.result.content[0].text);
  assert.equal(value.claimId, "root");
  const ids = new Map(value.downstream.map(node => [node.id, node.depth]));
  assert.deepEqual([...ids.keys()].sort(), ["child", "grandchild"]);
  assert.equal(ids.get("child"), 1);
  assert.equal(ids.get("grandchild"), 2);
  // Unknown claims are a clean 404-shaped error, not a crash.
  const missing = await mcp(
    { jsonrpc: "2.0", id: "w2", method: "tools/call",
      params: { name: "room_work_claim_provenance", arguments: { roomId, claimId: "nope" } } },
    { authorization: `Bearer ${owner.secret}` });
  const missingValue = missing.error
    ? { ...missing.error.data, message: missing.error.message }
    : missing.result.structuredContent;
  assert.equal(missingValue.code, "work_claim_not_found");
  assert.equal(missingValue.isError ?? true, true);
});
