// Spend-pricing kill switch (jill-spend-pricing-killswitch): the owner-only
// emergency lever promised to Dot's QA lane (room seq 2748).
//
// Contracts owned here (nothing else covers them):
// - room.spend_pricing_set is event-sourced, owner-only in the reducer,
//   replayable, and defaults to enabled (absent = current behavior)
// - priceForTool(name, state) returns null for every tool when pricing is
//   disabled; the pure one-arg form keeps the static catalog
// - chargeSpendBeforeCall returns null (tool forwards free, no charge, no
//   rows) when pricing is disabled, even with a live grant in place
// - POST /api/rooms/:id/spend-pricing is owner-only (403 before parsing),
//   strict boolean shape, recorded as a room event; GET reflects state
// - both routes live in the declarative route table with room auth
//
// Authoring gate: every test names the regression it would catch; no test
// asserts implementation (all go through exported production functions or
// real HTTP).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AgentRooms, agentRoomSchema } from "../server/agent-rooms.mjs";
import { createRateLimiter } from "../server/identity-ratelimit.mjs";
import { EVENT_TYPES as T, replay, spendPricingEnabled } from "../src/events.js";
import { classifyCommand } from "../server/action-classes.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";
import {
  PRICED_MCP_TOOLS,
  priceForTool,
  ensureSpendGrantsSchema,
  issueSpendGrant,
  spendGrantSummary,
  chargeSpendBeforeCall,
} from "../server/spend-grants.mjs";
import { readSpendPricing, setSpendPricing } from "../server/spend-pricing.mjs";
import { SPEND_PRICING_ROUTES } from "../server/routes/spend-pricing.mjs";
import { ROUTES } from "../server/routes/table.mjs";

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-spend-pricing-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.db.exec(agentRoomSchema);
  ensureSpendGrantsSchema(store.db);
  const rooms = new AgentRooms(store, {
    rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 })
  });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, rooms };
}

// Owner + one t2 agent peer in a fresh room.
function roomWithPeer(t) {
  const { store, rooms } = setup(t);
  const owner = store.identities.create("Owen");
  const peer = store.identities.create("Peer agent");
  const created = rooms.create(owner.secret, { title: "Pricing room", purpose: "Kill switch", displayName: "Owner" });
  const roomId = created.roomId;
  const ownerMemberId = created.ownerMemberId ?? owner.identityId;
  const invite = store.invites.create(owner.secret, roomId, { profile: "chat", displayName: "Peer agent" }, null);
  const joined = store.invites.redeem(invite.code, { displayName: "Peer agent", identitySecret: peer.secret });
  const peerMemberId = joined.memberId ?? joined.member?.id;
  assert.ok(peerMemberId, "peer member id missing from redeem response");
  setTier(store.db, roomId, peerMemberId, "t2_standard", { updatedBy: ownerMemberId, nowMs: Date.now() });
  return { store, roomId, ownerMemberId, peerMemberId, ownerSecret: owner.secret, peerSecret: peer.secret };
}

const stateOf = f => f.store.room(f.roomId).state;

test("reducer: pricing defaults enabled, owner-only, strict shape, replayable", async t => {
  const f = roomWithPeer(t);
  assert.equal(spendPricingEnabled(stateOf(f)), true, "absent pricing state means enabled (current behavior)");
  assert.throws(() => f.store.command(f.peerSecret, f.roomId, {
    id: randomUUID(), type: T.ROOM_SPEND_PRICING_SET, data: { enabled: false },
  }), /Only the Room owner may set spend pricing/, "non-owner event refused in the reducer");
  for (const [data, pattern] of [
    [{}, /enabled must be a boolean/],
    [{ enabled: "false" }, /Invalid field: enabled/],
    [{ enabled: 0 }, /Invalid field: enabled/],
    [{ enabled: null }, /enabled must be a boolean/],
    [{ enabled: false, extra: 1 }, /Unexpected field: extra/],
  ]) {
    assert.throws(() => f.store.command(f.ownerSecret, f.roomId, {
      id: randomUUID(), type: T.ROOM_SPEND_PRICING_SET, data,
    }), pattern, `bad shape refused: ${JSON.stringify(data)}`);
  }
  f.store.command(f.ownerSecret, f.roomId, { id: randomUUID(), type: T.ROOM_SPEND_PRICING_SET, data: { enabled: false } });
  assert.equal(spendPricingEnabled(stateOf(f)), false);
  assert.equal(stateOf(f).room.spendPricing.revision, 1);
  f.store.command(f.ownerSecret, f.roomId, { id: randomUUID(), type: T.ROOM_SPEND_PRICING_SET, data: { enabled: true } });
  assert.equal(spendPricingEnabled(stateOf(f)), true);
  assert.equal(stateOf(f).room.spendPricing.revision, 2);
  const events = f.store.db.prepare("SELECT body FROM events WHERE room_id=? ORDER BY sequence").all(f.roomId).map(row => JSON.parse(row.body));
  assert.deepEqual(replay(events).room.spendPricing, stateOf(f).room.spendPricing, "pricing state is event-sourced");
  assert.equal(classifyCommand(T.ROOM_SPEND_PRICING_SET), "act", "the new event type is classified like its sibling");
});

test("priceForTool: disabled pricing nulls every priced tool", async t => {
  const f = roomWithPeer(t);
  const names = Object.keys(PRICED_MCP_TOOLS);
  assert.ok(names.length > 0, "the catalog is non-empty so the gate has something to null");
  for (const name of names) {
    assert.equal(typeof priceForTool(name), "number", `pure form keeps the static catalog: ${name}`);
    assert.equal(typeof priceForTool(name, stateOf(f)), "number", `enabled state prices ${name}`);
  }
  f.store.command(f.ownerSecret, f.roomId, { id: randomUUID(), type: T.ROOM_SPEND_PRICING_SET, data: { enabled: false } });
  const disabled = stateOf(f);
  for (const name of names) {
    assert.equal(priceForTool(name, disabled), null, `disabled pricing nulls ${name}`);
  }
  assert.equal(priceForTool("room_list_files", disabled), null, "unpriced tools stay null too");
});

test("chargeSpendBeforeCall: disabled pricing forwards free even with a live grant", async t => {
  const f = roomWithPeer(t);
  issueSpendGrant(f.store.db, f.roomId, f.peerMemberId, {
    grantedBy: f.ownerMemberId, capCents: "100", perTxCapCents: "10", nowMs: Date.now(),
  });
  const before = spendGrantSummary(f.store.db, f.roomId, f.peerMemberId, { nowMs: Date.now() }).remainingCents;
  assert.equal(before, "100");
  // Enabled: the boundary authorizes against the grant.
  const handle = chargeSpendBeforeCall(f.store, f.peerSecret, "room_put_file", { roomId: f.roomId });
  assert.ok(handle && typeof handle.settle === "function", "enabled pricing authorizes the priced call");
  assert.ok(handle.void(), "void the probe reservation so the grant is untouched");
  // Disabled: the boundary returns null — the tool forwards free, nothing reserved.
  f.store.command(f.ownerSecret, f.roomId, { id: randomUUID(), type: T.ROOM_SPEND_PRICING_SET, data: { enabled: false } });
  const free = chargeSpendBeforeCall(f.store, f.peerSecret, "room_put_file", { roomId: f.roomId });
  assert.equal(free, null, "disabled pricing: no charge handle, tool forwards free");
  assert.equal(
    spendGrantSummary(f.store.db, f.roomId, f.peerMemberId, { nowMs: Date.now() }).remainingCents,
    "100", "no reservation row was written while disabled");
  // Re-enable: pricing resumes exactly.
  f.store.command(f.ownerSecret, f.roomId, { id: randomUUID(), type: T.ROOM_SPEND_PRICING_SET, data: { enabled: true } });
  const again = chargeSpendBeforeCall(f.store, f.peerSecret, "room_put_file", { roomId: f.roomId });
  assert.ok(again && typeof again.settle === "function", "re-enabled pricing authorizes again");
  assert.ok(again.void());
});

test("HTTP: POST is owner-only with a strict boolean shape; GET reflects state", async t => {
  const f = roomWithPeer(t);
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { method = "GET", data, token } = {}) => fetch(origin + path, {
    method, headers: { Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) })
  }).then(async res => ({ status: res.status, json: await res.json().catch(() => null) }));

  const path = `/api/rooms/${f.roomId}/spend-pricing`;
  // Non-owner learns nothing but the refusal, even with a malformed body.
  for (const data of [{ enabled: false }, { enabled: "nope" }, {}]) {
    const denied = await request(path, { method: "POST", token: f.peerSecret, data });
    assert.equal(denied.status, 403, `non-owner refused: ${JSON.stringify(data)}`);
    assert.equal(denied.json.error.code, "owner_required");
  }
  // Malformed owner writes are 422, never 403.
  for (const data of [{}, { enabled: "false" }, { enabled: 0 }, { enabled: false, extra: true }]) {
    const bad = await request(path, { method: "POST", token: f.ownerSecret, data });
    assert.equal(bad.status, 422, `bad shape refused: ${JSON.stringify(data)}`);
    assert.equal(bad.json.error.code, "invalid_spend_pricing");
  }
  const get0 = await request(path, { token: f.peerSecret });
  assert.equal(get0.status, 200, "members can read the pricing state");
  assert.equal(get0.json.enabled, true, "default is enabled");
  const off = await request(path, { method: "POST", token: f.ownerSecret, data: { enabled: false } });
  assert.ok([200, 201].includes(off.status), `disable committed: ${off.status}`);
  const get1 = await request(path, { token: f.peerSecret });
  assert.equal(get1.json.enabled, false, "GET reflects the disabled state");
  assert.equal(get1.json.roomId, f.roomId);
  const on = await request(path, { method: "POST", token: f.ownerSecret, data: { enabled: true, requestId: randomUUID() } });
  assert.ok([200, 201].includes(on.status));
  const get2 = await request(path, { token: f.peerSecret });
  assert.equal(get2.json.enabled, true, "re-enable restores pricing");
  // The module functions agree with the HTTP surface.
  assert.equal(readSpendPricing(f.store, f.peerSecret, f.roomId).enabled, true);
  assert.throws(() => setSpendPricing(f.store, f.peerSecret, f.roomId, { enabled: false }),
    err => err.status === 403 && err.code === "owner_required", "module-level owner check fires before parsing");
});

test("route table: the two spend-pricing routes are registered with room auth", () => {
  const byId = Object.fromEntries(SPEND_PRICING_ROUTES.map(r => [r.id, r]));
  assert.equal(SPEND_PRICING_ROUTES.length, 2);
  assert.deepEqual(
    SPEND_PRICING_ROUTES.map(r => `${r.method} ${r.path}`),
    ["GET /api/rooms/{roomId}/spend-pricing", "POST /api/rooms/{roomId}/spend-pricing"]);
  for (const route of SPEND_PRICING_ROUTES) {
    assert.equal(route.auth, "room");
    assert.equal(route.scope, "room");
    assert.equal(typeof route.handler, "function");
  }
  const ids = new Set(ROUTES.map(r => r.id));
  assert.ok(ids.has("get-spend-pricing") && ids.has("set-spend-pricing"), "routes registered in server/routes/table.mjs");
  const postBody = byId["set-spend-pricing"].schema.body;
  assert.deepEqual(postBody.required, ["enabled"]);
  assert.equal(postBody.properties.enabled.type, "boolean");
});

// SEC-10 (Dot's acceptance, room seq 2807): the switch is admission-only.
// Regression caught: a future change that cancels in-flight work on disable
// (or one that lets disable block new grant issuance) would silently change
// the documented contract in docs/SPEND-PRIMITIVE.md.
test("admission-only: a call admitted before disable still settles; disable does not stop grant issuance", async t => {
  const f = roomWithPeer(t);
  issueSpendGrant(f.store.db, f.roomId, f.peerMemberId, {
    grantedBy: f.ownerMemberId, capCents: "100", perTxCapCents: "10", nowMs: Date.now(),
  });
  // Admitted while enabled: a reservation exists before the switch moves.
  const admitted = chargeSpendBeforeCall(f.store, f.peerSecret, "room_put_file", { roomId: f.roomId });
  assert.ok(admitted && typeof admitted.settle === "function");
  const price = PRICED_MCP_TOOLS.room_put_file;
  f.store.command(f.ownerSecret, f.roomId, { id: randomUUID(), type: T.ROOM_SPEND_PRICING_SET, data: { enabled: false } });
  assert.equal(spendPricingEnabled(stateOf(f)), false);
  // The in-flight call still settles after disable: the charge lands.
  assert.equal(admitted.settle(), true, "work admitted before disable settles afterwards");
  assert.equal(
    spendGrantSummary(f.store.db, f.roomId, f.peerMemberId, { nowMs: Date.now() }).remainingCents,
    String(100 - price), "the pre-disable charge is recorded against the grant");
  // New admissions while disabled are free and write nothing.
  assert.equal(chargeSpendBeforeCall(f.store, f.peerSecret, "room_put_file", { roomId: f.roomId }), null);
  assert.equal(
    spendGrantSummary(f.store.db, f.roomId, f.peerMemberId, { nowMs: Date.now() }).remainingCents,
    String(100 - price), "no new reservation while disabled");
  // Grant issuance is not frozen by the switch.
  const reissued = issueSpendGrant(f.store.db, f.roomId, f.peerMemberId, {
    grantedBy: f.ownerMemberId, capCents: "200", perTxCapCents: "10", nowMs: Date.now(),
  });
  assert.ok(reissued, "owner can still issue or replace a grant while pricing is disabled");
});
