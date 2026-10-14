// #3269: the priced MCP tools (bounty_post, room_put_file, add_land_item)
// have REST twins that used to skip the spend boundary entirely — the same
// agent identity performing the same operation was gated at the MCP door
// and free at the REST door, voiding the grant permission, the per-agent
// cap, the room allowance, and single-use consumption. These tests pin the
// REST doors to the MCP contract:
//
// - grant-less agent -> 402 payment_required, and nothing is created
// - valid grant -> the exact MCP price is charged (10 / 5 / 1 credits)
// - idempotent replays/duplicates are never charged twice
// - a single-use grant is consumed by its first REST call
// - the room owner and human members are never charged (MCP parity)
//
// Every test goes through the real HTTP server and the real spend store;
// grants are issued with the production issueSpendGrant.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AgentRooms, agentRoomSchema } from "../server/agent-rooms.mjs";
import { createRateLimiter } from "../server/identity-ratelimit.mjs";
import { createRoomServer } from "../server/http.mjs";
import { ensureSpendGrantsSchema, issueSpendGrant, spendGrantSummary } from "../server/spend-grants.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const SHA = "a".repeat(40);

// GitHub read double for land-queue adds (same snapshot shape as
// tests/land-queue.test.js): a clean, green, mergeable PR.
function mockGitHub() {
  return async url => {
    let body = {
      title: "Land the queue", merged: false, merge_commit_sha: null,
      mergeable: true, mergeable_state: "clean", head: { sha: SHA },
    };
    if (url.includes("/check-runs")) body = { check_runs: [{ status: "completed", conclusion: "success" }] };
    else if (url.endsWith("/status")) body = { state: "success" };
    return { status: 200, ok: true, json: async () => body };
  };
}

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-spend-rest-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.db.exec(agentRoomSchema);
  ensureSpendGrantsSchema(store.db);
  const rooms = new AgentRooms(store, {
    rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 }),
  });
  const owner = store.identities.create("Owen");
  const peer = store.identities.create("Peer agent");
  const created = rooms.create(owner.secret, { title: "Spend room", purpose: "Paid tools", displayName: "Owner" });
  const roomId = created.roomId;
  const ownerMemberId = created.ownerMemberId ?? owner.identityId;
  const invite = store.invites.create(owner.secret, roomId, { profile: "chat", displayName: "Peer agent" }, null);
  const joined = store.invites.redeem(invite.code, { displayName: "Peer agent", identitySecret: peer.secret });
  const peerMemberId = joined.memberId ?? joined.member?.id;
  assert.ok(peerMemberId, "peer member id missing from redeem response");
  setTier(store.db, roomId, peerMemberId, "t2_standard", { updatedBy: ownerMemberId, nowMs: Date.now() });
  store.landQueue.configure({ token: "test-token", fetchImpl: mockGitHub() });
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, secret, headers = {}) => fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}`, ...headers },
    body: JSON.stringify(body),
  });
  const get = (path, secret) => fetch(`${origin}${path}`, { headers: { authorization: `Bearer ${secret}` } });
  const remaining = () => spendGrantSummary(store.db, roomId, peerMemberId, { nowMs: Date.now() })?.remainingCents;
  const grant = (overrides = {}) => issueSpendGrant(store.db, roomId, peerMemberId, {
    grantedBy: ownerMemberId, capCents: "100000", perTxCapCents: "100000", nowMs: Date.now(), ...overrides,
  });
  return { store, owner, peer, roomId, ownerMemberId, peerMemberId, post, get, remaining, grant };
}

const bountyBody = () => ({
  title: "Write the guide", criteria: "Cover every breaking change.",
  amount: 100, deadline: new Date(Date.now() + 86400000).toISOString(),
});
const fileBody = (id = "file-1") => ({
  id, filename: "note.txt", mediaType: "text/plain",
  data: Buffer.from("hello").toString("base64"),
});

test("REST twins refuse a grant-less agent with 402 payment_required and create nothing", async t => {
  const f = await fixture(t);
  for (const [name, path, body] of [
    ["bounty_post", `/api/rooms/${f.roomId}/bounties`, bountyBody()],
    ["room_put_file", `/api/rooms/${f.roomId}/files`, fileBody()],
    ["add_land_item", `/api/rooms/${f.roomId}/add_land_item`, { repo: "acme/demo", prNumber: 969 }],
  ]) {
    const res = await f.post(path, body, f.peer.secret);
    assert.equal(res.status, 402, `${name}: expected 402, got ${res.status}`);
    const payload = await res.json();
    assert.equal(payload.error?.code, "payment_required", `${name}: expected payment_required`);
  }
  // The refused calls must not have executed the operation at any door.
  const bounties = await (await f.get(`/api/rooms/${f.roomId}/bounties`, f.peer.secret)).json();
  assert.deepEqual(bounties.bounties, []);
  const files = await (await f.get(`/api/rooms/${f.roomId}/files`, f.peer.secret)).json();
  assert.equal(JSON.stringify(files).includes("file-1"), false);
  const queue = await (await f.get(`/api/rooms/${f.roomId}/list_land_queue`, f.peer.secret)).json();
  assert.deepEqual(queue.items, []);
});

test("REST twins charge a valid grant exactly the MCP prices (10 / 5 / 1)", async t => {
  const f = await fixture(t);
  f.grant();
  assert.equal(f.remaining(), "100000");

  const bounty = await f.post(`/api/rooms/${f.roomId}/bounties`, bountyBody(), f.peer.secret);
  assert.equal(bounty.status, 201);
  assert.equal(f.remaining(), "99990", "bounty_post must charge 10");

  const file = await f.post(`/api/rooms/${f.roomId}/files`, fileBody(), f.peer.secret);
  assert.equal(file.status, 201);
  assert.equal(f.remaining(), "99985", "room_put_file must charge 5");

  const land = await f.post(`/api/rooms/${f.roomId}/add_land_item`, { repo: "acme/demo", prNumber: 969 }, f.peer.secret);
  assert.equal(land.status, 201);
  assert.equal(f.remaining(), "99984", "add_land_item must charge 1");
});

test("REST charges respect the grant cap: a grant too small for the price refuses and charges nothing", async t => {
  const f = await fixture(t);
  f.grant({ capCents: "5", perTxCapCents: "5" });
  const res = await f.post(`/api/rooms/${f.roomId}/bounties`, bountyBody(), f.peer.secret);
  assert.equal(res.status, 402);
  assert.equal((await res.json()).error?.code, "payment_required");
  assert.equal(f.remaining(), "5", "a refused call must not reserve or settle anything");
  const bounties = await (await f.get(`/api/rooms/${f.roomId}/bounties`, f.peer.secret)).json();
  assert.deepEqual(bounties.bounties, []);
});

test("idempotent REST replays and duplicates are never charged twice", async t => {
  const f = await fixture(t);
  f.grant();

  // Bounty: same Idempotency-Key + identical payload replays the stored
  // 201 without re-executing (a changed payload is a 409 key reuse).
  const key = { "idempotency-key": "rest-twin-bounty-1" };
  const body = bountyBody();
  const first = await f.post(`/api/rooms/${f.roomId}/bounties`, body, f.peer.secret, key);
  assert.equal(first.status, 201);
  const firstBody = await first.json();
  const replay = await f.post(`/api/rooms/${f.roomId}/bounties`, body, f.peer.secret, key);
  assert.equal(replay.status, 201);
  assert.equal((await replay.json()).bounty.bountyId, firstBody.bounty.bountyId);
  assert.equal(f.remaining(), "99990", "bounty replay must not charge again");

  // File stage: re-staging the same id is a duplicate — voided, not settled.
  const stage1 = await f.post(`/api/rooms/${f.roomId}/files`, fileBody(), f.peer.secret);
  assert.equal(stage1.status, 201);
  const stage2 = await f.post(`/api/rooms/${f.roomId}/files`, fileBody(), f.peer.secret);
  assert.equal(stage2.status, 200);
  assert.equal((await stage2.json()).duplicate, true);
  assert.equal(f.remaining(), "99985", "duplicate stage must not charge again");

  // Land add: re-adding the same PR is a duplicate — voided, not settled.
  const add1 = await f.post(`/api/rooms/${f.roomId}/add_land_item`, { repo: "acme/demo", prNumber: 969 }, f.peer.secret);
  assert.equal(add1.status, 201);
  const add2 = await f.post(`/api/rooms/${f.roomId}/add_land_item`, { repo: "acme/demo", prNumber: 969 }, f.peer.secret);
  assert.equal(add2.status, 200);
  assert.equal((await add2.json()).duplicate, true);
  assert.equal(f.remaining(), "99984", "duplicate land add must not charge again");
});

test("a single-use grant is consumed by its first REST call; the second is refused", async t => {
  const f = await fixture(t);
  f.grant({ singleUse: true });
  const first = await f.post(`/api/rooms/${f.roomId}/bounties`, bountyBody(), f.peer.secret);
  assert.equal(first.status, 201);
  // Consumed: the grant is revoked by the settle, so no live summary remains.
  assert.equal(f.remaining(), undefined);
  const second = await f.post(`/api/rooms/${f.roomId}/bounties`, bountyBody(), f.peer.secret);
  assert.equal(second.status, 402, "single-use grant must be consumed by the first settled REST call");
  assert.equal((await second.json()).error?.code, "payment_required");
});

test("the room owner and human members are never charged at the REST twins", async t => {
  const f = await fixture(t);
  // Owner: full authority implies no charge and no grant needed (MCP parity).
  const ownerPost = await f.post(`/api/rooms/${f.roomId}/bounties`, bountyBody(), f.owner.secret);
  assert.equal(ownerPost.status, 201);

  // A human (non-owner) member: humans are never charged at either door.
  const human = f.store.identities.create("Hana");
  const humanMemberId = "human-peer-1";
  f.store.command(f.owner.secret, f.roomId, {
    id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: humanMemberId, displayName: "Hana", kind: "human", permissions: [] },
  });
  f.store.db.prepare("INSERT INTO identity_links(room_id,identity_id,member_id,linked_at) VALUES(?,?,?,?)")
    .run(f.roomId, human.identityId, humanMemberId, Date.now());
  const humanStage = await f.post(`/api/rooms/${f.roomId}/files`, fileBody("human-file"), human.secret);
  assert.equal(humanStage.status, 201, "human members stage files without a spend grant");
  const humanLand = await f.post(`/api/rooms/${f.roomId}/add_land_item`, { repo: "acme/demo", prNumber: 971 }, human.secret);
  assert.equal(humanLand.status, 201, "human members add land items without a spend grant");
});
