// Dispatch-level idempotency for the hosted MCP bounty tools.
//
// Regression: the bounty write tools advertised idempotencyKey in their input
// schemas (and idempotentHint: true in their annotations), but the hosted
// dispatch in server/mcp-full-profile.mjs called the escrow methods raw, with
// no idemExecute on that path. An MCP retry of any write tool duplicated the
// credit movement instead of replaying the receipt, while the HTTP route
// wrapped every mutation in escrow.idemExecute. The schema-level tests missed
// it because they asserted the property exists, not behavior.
//
// These tests drive the real dispatch (callHostedStdioTool) against a real
// RoomStore and assert replay-not-duplicate on a retried call, key isolation
// between different keys, and rejection when a key is reused with different
// input — the same contract the HTTP route's idem() helper provides.

import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { createRateLimiter } from "../server/identity-ratelimit.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";
import { callHostedStdioTool } from "../server/mcp-full-profile.mjs";

const ROOM = "commons";
const AGENT = "agent";

function fixture(t) {
  const store = new RoomStore(":memory:"); t.after(() => store.close());
  store.initialize(initialRoom());
  const keys = { owner: store.issueAccessKey(ROOM, "owner") };
  const send = (actor, command) => store.command(keys[actor], ROOM, command);
  send("owner", { id: "add-agent", type: "member.added",
    data: { memberId: AGENT, displayName: AGENT, kind: "agent",
      permissions: ["accept_work", "complete_work"] } });
  keys[AGENT] = store.issueAccessKey(ROOM, AGENT);
  // New agent members default to t1_readonly; the bounty tools need write access.
  setTier(store.db, ROOM, AGENT, "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  // The one and only mint: 100 credits per active member, issued by the real
  // genesis path rather than a hand-built journal row (amounts are millis).
  store.bountyEscrow.ensureGenesis(ROOM);
  return { store, keys };
}

const call = (store, keys, name, args) =>
  callHostedStdioTool(store, keys[AGENT], name, { roomId: ROOM, ...args });

const postArgs = (overrides = {}) => ({
  title: "Test bounty", criteria: "Done means done.", amount: 10,
  deadline: new Date(Date.now() + 3_600_000).toISOString(), ...overrides });

const bounties = (store, keys) =>
  store.bountyEscrow.listBounties(ROOM, { group: null, viewer: null });

test("a retried bounty_post with the same idempotencyKey replays instead of posting twice", async t => {
  const { store, keys } = fixture(t);
  // One args object, reused verbatim: a real retry sends the exact same input.
  const args = postArgs({ idempotencyKey: "post-1" });
  const first = await call(store, keys, "bounty_post", args);
  assert.equal(first.isError, false);
  assert.equal(first.value.idempotentReplay, false);
  const second = await call(store, keys, "bounty_post", args);
  assert.equal(second.isError, false);
  assert.equal(second.value.idempotentReplay, true, "the retry must replay, not execute");
  assert.equal(second.value.bounty.bountyId, first.value.bounty.bountyId,
    "the replayed body must be the original bounty, not a new one");
  assert.equal(bounties(store, keys).length, 1, "only one bounty may exist after the retry");
});

test("a different idempotencyKey executes a second post", async t => {
  const { store, keys } = fixture(t);
  await call(store, keys, "bounty_post", postArgs({ idempotencyKey: "post-a" }));
  const second = await call(store, keys, "bounty_post", postArgs({ idempotencyKey: "post-b" }));
  assert.equal(second.value.idempotentReplay, false);
  assert.equal(bounties(store, keys).length, 2);
});

test("reusing an idempotencyKey with different input is rejected, not replayed", async t => {
  const { store, keys } = fixture(t);
  await call(store, keys, "bounty_post", postArgs({ idempotencyKey: "post-k", title: "First" }));
  await assert.rejects(
    call(store, keys, "bounty_post", postArgs({ idempotencyKey: "post-k", title: "Second" })),
    err => err?.code === "idempotency_key_reused",
    "a key bound to one payload must not silently return another payload's receipt");
  assert.equal(bounties(store, keys).length, 1, "the rejected retry must not post");
});

test("a retried bounty_fund replays instead of double-locking credits", async t => {
  const { store, keys } = fixture(t);
  const posted = await call(store, keys, "bounty_post", postArgs({ idempotencyKey: "pf-1" }));
  const bountyId = posted.value.bounty.bountyId;
  const first = await call(store, keys, "bounty_fund", { bountyId, idempotencyKey: "fund-1" });
  assert.equal(first.isError, false);
  assert.equal(first.value.idempotentReplay, false);
  const second = await call(store, keys, "bounty_fund", { bountyId, idempotencyKey: "fund-1" });
  assert.equal(second.isError, false);
  assert.equal(second.value.idempotentReplay, true, "the retry must replay, not fund again");
  const balances = store.bountyEscrow.balances(ROOM, AGENT);
  assert.equal(balances.locked, 10, "the award must be locked exactly once");
  assert.equal(balances.payable, 90, "payable must be debited exactly once (100 genesis - 10)");
});

test("writes without an idempotencyKey execute every time", async t => {
  const { store, keys } = fixture(t);
  const first = await call(store, keys, "bounty_post", postArgs());
  const second = await call(store, keys, "bounty_post", postArgs());
  assert.equal(first.value.idempotentReplay, false);
  assert.equal(second.value.idempotentReplay, false);
  assert.equal(bounties(store, keys).length, 2,
    "keyless writes are not deduplicated; callers that want safety must send a key");
});

test("the retry scope is per-caller: another member's same key executes", async t => {
  const { store, keys } = fixture(t);
  // Second agent member sharing the fixture.
  const send = store.command(keys.owner, ROOM, { id: "add-agent2", type: "member.added",
    data: { memberId: "agent2", displayName: "agent2", kind: "agent",
      permissions: ["accept_work", "complete_work"] } });
  assert.ok(send);
  keys.agent2 = store.issueAccessKey(ROOM, "agent2");
  setTier(store.db, ROOM, "agent2", "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  await call(store, keys, "bounty_post", postArgs({ idempotencyKey: "shared-key" }));
  const other = await callHostedStdioTool(store, keys.agent2, "bounty_post",
    { roomId: ROOM, ...postArgs({ idempotencyKey: "shared-key" }) });
  assert.equal(other.isError, false);
  assert.equal(other.value.idempotentReplay, false,
    "a different caller's key must execute, never replay the first caller's body");
  assert.equal(bounties(store, keys).length, 2);
});

test("target-room read-only authority refuses writes and retry receipts without changing state", async t => {
  const { store, keys } = fixture(t);
  const args = postArgs({ idempotencyKey: "authority-retry" });
  await call(store, keys, "bounty_post", args);
  const before = store.bountyEscrow.balances(ROOM, AGENT);
  setTier(store.db, ROOM, AGENT, "t1_readonly", { updatedBy: "owner", nowMs: Date.now() });
  for (const input of [args, postArgs({ idempotencyKey: "new-denied" })])
    await assert.rejects(call(store, keys, "bounty_post", input), error => error.code === "agent_readonly");
  assert.equal(bounties(store, keys).length, 1);
  assert.deepEqual(store.bountyEscrow.balances(ROOM, AGENT), before);
  assert.equal((await call(store, keys, "bounty_list", {})).value.bounties.length, 1);
});

test("MCP lifecycle events publish once and transport-switch retries replay the same receipt", async t => {
  const { store, keys } = fixture(t);
  const delivered = [];
  store.agentPlugin.fanoutRoomEvent = event => delivered.push(event);
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = async (bountyId, key) => {
    const response = await fetch(`${origin}/api/rooms/${ROOM}/bounties/${bountyId}/fund`, {
      method: "POST", headers: { authorization: `Bearer ${keys[AGENT]}`,
        "content-type": "application/json", "idempotency-key": key }, body: "{}" });
    assert.equal(response.status, 200);
    return response.json();
  };
  const args = postArgs({ idempotencyKey: "lifecycle-post" });
  const posted = await call(store, keys, "bounty_post", args);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].roomId, ROOM);
  assert.equal(delivered[0].event.id, `bounty-event-${posted.value.receipt.event.seq}`);
  assert.equal(delivered[0].event.data.bountyId, posted.value.bounty.bountyId);
  await call(store, keys, "bounty_post", args);
  assert.equal(delivered.length, 1);
  const bountyId = posted.value.bounty.bountyId;
  const funded = await call(store, keys, "bounty_fund", { bountyId, idempotencyKey: "mcp-first" });
  assert.deepEqual(await post(bountyId, "mcp-first"),
    Object.fromEntries(Object.entries(funded.value).filter(([key]) => key !== "idempotentReplay")));
  assert.equal(delivered.length, 2, "HTTP replay must not deliver the event again");
  const second = await call(store, keys, "bounty_post", postArgs({ idempotencyKey: "second-post" }));
  const fromHttp = await post(second.value.bounty.bountyId, "http-first");
  const replay = await call(store, keys, "bounty_fund", {
    bountyId: second.value.bounty.bountyId, idempotencyKey: "http-first" });
  assert.equal(replay.value.idempotentReplay, true);
  assert.deepEqual({ ...fromHttp, idempotentReplay: true }, replay.value);
  assert.equal(delivered.length, 4);
  assert.equal(store.bountyEscrow.balances(ROOM, AGENT).locked, 20);
});

test("an identity with full access elsewhere cannot write into its read-only target room", async t => {
  const { store } = fixture(t);
  const rooms = new AgentRooms(store, {
    rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 }) });
  const peer = store.identities.create("Peer");
  const owner = store.identities.create("Target owner");
  const full = rooms.create(peer.secret, { title: "Full room", purpose: "Fixture", displayName: "Peer" });
  const target = rooms.create(owner.secret, { title: "Read room", purpose: "Fixture", displayName: "Owner" });
  const invite = store.invites.create(owner.secret, target.roomId, { profile: "chat", displayName: "Peer" }, null);
  const joined = store.invites.redeem(invite.code, { displayName: "Peer", identitySecret: peer.secret });
  setTier(store.db, target.roomId, joined.memberId ?? joined.member.id, "t1_readonly",
    { updatedBy: "owner", nowMs: Date.now() });
  await callHostedStdioTool(store, peer.secret, "bounty_post", { roomId: full.roomId, ...postArgs() });
  await assert.rejects(callHostedStdioTool(store, peer.secret, "bounty_post", {
    roomId: target.roomId, ...postArgs() }), error => error.code === "agent_readonly");
  assert.equal(store.bountyEscrow.listBounties(target.roomId, {}).length, 0);
  assert.equal((await callHostedStdioTool(store, peer.secret, "bounty_list", {
    roomId: target.roomId })).value.bounties.length, 0);
});

test("full membership elsewhere cannot confer bounty writes on a linked guest target", async t => {
  const { store, keys } = fixture(t);
  const rooms = new AgentRooms(store, {
    rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 }) });
  const peer = store.identities.create("Guest peer");
  const full = rooms.create(peer.secret, { title: "Full room", purpose: "Fixture", displayName: "Guest peer" });
  const guestId = "guest-agent-fixture";
  store.identities.link(keys.owner, ROOM, { identityId: peer.identityId,
    memberId: guestId, displayName: "Guest peer", permissions: [] });
  setTier(store.db, ROOM, guestId, "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  await callHostedStdioTool(store, peer.secret, "bounty_post", { roomId: full.roomId, ...postArgs() });
  const before = store.bountyEscrow.balances(ROOM, guestId);
  await assert.rejects(callHostedStdioTool(store, peer.secret, "bounty_post", {
    roomId: ROOM, ...postArgs({ idempotencyKey: "guest-denied" }) }),
  error => error.code === "guest_scope_denied");
  assert.equal(store.bountyEscrow.listBounties(ROOM, {}).length, 0);
  assert.deepEqual(store.bountyEscrow.balances(ROOM, guestId), before);
  assert.equal((await callHostedStdioTool(store, peer.secret, "bounty_list", {
    roomId: ROOM })).value.bounties.length, 0);
});
