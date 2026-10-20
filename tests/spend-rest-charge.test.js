// #3269: priced operations must charge identically at every door.
// chargeSpendBeforeCall used to run only from the MCP profiles, so the REST
// twins of bounty_post / room_put_file / add_land_item executed free and
// ungated: no grant permission, no per-agent cap, no room allowance, no
// single-use consumption. These tests pin the shared-path contract over
// real HTTP: refuse without a grant, charge with one, never charge for a
// replay or a failed operation, and leave owner / pricing-disabled calls
// free — the same outcomes the MCP doors produce.
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
import { EVENT_TYPES as T } from "../src/events.js";
import { setTier } from "../server/autonomy-tiers.mjs";
import {
  ensureSpendGrantsSchema, issueSpendGrant, spendGrantSummary, setSpendDefaultRoute,
} from "../server/spend-grants.mjs";

const SHA = "a".repeat(40);
function mockGitHub() {
  const snapshot = {
    pr: { title: "Land the queue", merged: false, merge_commit_sha: null, mergeable: true, mergeable_state: "clean", head: { sha: SHA } },
    status: { state: "pending" },
    checks: { check_runs: [{ status: "in_progress", conclusion: null }] },
  };
  return { fetchImpl: async url => {
    let body = snapshot.pr;
    if (url.includes("/check-runs")) body = snapshot.checks;
    else if (url.endsWith("/status")) body = snapshot.status;
    return { status: 200, ok: true, json: async () => body };
  } };
}

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-spend-rest-charge-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.db.exec(agentRoomSchema);
  ensureSpendGrantsSchema(store.db);
  const rooms = new AgentRooms(store, {
    rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 }),
  });
  const owner = store.identities.create("Owen");
  const peer = store.identities.create("Peer agent");
  const created = rooms.create(owner.secret, { title: "Spend doors", purpose: "x", displayName: "Owner" });
  const roomId = created.roomId;
  const ownerMemberId = created.ownerMemberId ?? owner.identityId;
  const invite = store.invites.create(owner.secret, roomId, { profile: "chat", displayName: "Peer agent" }, null);
  const joined = store.invites.redeem(invite.code, { displayName: "Peer agent", identitySecret: peer.secret });
  const peerMemberId = joined.memberId ?? joined.member?.id;
  assert.ok(peerMemberId, "peer member id missing from redeem response");
  setTier(store.db, roomId, peerMemberId, "t2_standard", { updatedBy: ownerMemberId, nowMs: Date.now() });
  store.landQueue.configure({ fetchImpl: mockGitHub().fetchImpl });
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return { store, roomId, ownerMemberId, peerMemberId, ownerSecret: owner.secret, peerSecret: peer.secret,
    origin: `http://127.0.0.1:${server.address().port}` };
}

const post = (origin, path, body, secret, extraHeaders = {}) => fetch(`${origin}${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${secret}`, ...extraHeaders },
  body: JSON.stringify(body),
});
const bountyBody = (overrides = {}) => ({
  title: "Write the migration guide",
  criteria: "Cover every breaking change.",
  amount: 100,
  deadline: new Date(Date.now() + 86400000).toISOString(),
  ...overrides,
});
const fileBody = (id = "file-1") => ({
  id, filename: "notes.txt", mediaType: "text/plain",
  data: Buffer.from("hello").toString("base64"),
});
const remaining = f => spendGrantSummary(f.store.db, f.roomId, f.peerMemberId)?.remainingCents;
const grantPeer = (f, terms = {}) => issueSpendGrant(f.store.db, f.roomId, f.peerMemberId, {
  grantedBy: f.ownerMemberId, capCents: "100000", perTxCapCents: "100000", nowMs: Date.now(), ...terms,
});

test("REST priced doors refuse a grant-less agent with 402 payment_required and create nothing", async t => {
  const f = await serve(t);
  // Ruling 29b: a grant-less agent now holds the room's member spend
  // default; zero it to pin the refusal contract this test owns.
  setSpendDefaultRoute(f.store, f.ownerSecret, f.roomId, { cents: 0 });
  const bounty = await post(f.origin, `/api/rooms/${f.roomId}/bounties`, bountyBody(), f.peerSecret);
  assert.equal(bounty.status, 402, `bounty_post twin must refuse without a grant, got ${bounty.status}: ${await bounty.clone().text()}`);
  assert.equal((await bounty.json()).error?.code, "payment_required");

  const file = await post(f.origin, `/api/rooms/${f.roomId}/files`, fileBody(), f.peerSecret);
  assert.equal(file.status, 402, `room_put_file twin must refuse without a grant, got ${file.status}: ${await file.clone().text()}`);
  assert.equal((await file.json()).error?.code, "payment_required");

  const land = await post(f.origin, `/api/rooms/${f.roomId}/add_land_item`, { repo: "acme/demo", prNumber: 1 }, f.peerSecret);
  assert.equal(land.status, 402, `add_land_item twin must refuse without a grant, got ${land.status}: ${await land.clone().text()}`);
  assert.equal((await land.json()).error?.code, "payment_required");

  const escrowRows = f.store.db.prepare("SELECT COUNT(*) AS n FROM spend_authorizations WHERE room_id = ?").get(f.roomId).n;
  assert.equal(escrowRows, 0, "a refused call writes no authorization rows");
  const list = await fetch(`${f.origin}/api/rooms/${f.roomId}/bounties`, { headers: { authorization: `Bearer ${f.ownerSecret}` } });
  assert.equal((await list.json()).bounties.length, 0, "no bounty was created by the refused call");
});

test("REST priced doors charge the grant exactly like MCP (10 / 5 / 1)", async t => {
  const f = await serve(t);
  grantPeer(f);
  assert.equal(remaining(f), "100000");

  const bounty = await post(f.origin, `/api/rooms/${f.roomId}/bounties`, bountyBody(), f.peerSecret);
  assert.equal(bounty.status, 201, `granted bounty post must succeed, got ${bounty.status}: ${await bounty.clone().text()}`);
  await bounty.text();
  assert.equal(remaining(f), "99990", "bounty_post charged 10 at the REST door");

  const file = await post(f.origin, `/api/rooms/${f.roomId}/files`, fileBody(), f.peerSecret);
  assert.equal(file.status, 201, `granted file stage must succeed, got ${file.status}: ${await file.clone().text()}`);
  await file.text();
  assert.equal(remaining(f), "99985", "room_put_file charged 5 at the REST door");

  const land = await post(f.origin, `/api/rooms/${f.roomId}/add_land_item`, { repo: "acme/demo", prNumber: 7 }, f.peerSecret);
  assert.equal(land.status, 201, `granted land add must succeed, got ${land.status}: ${await land.clone().text()}`);
  await land.text();
  assert.equal(remaining(f), "99984", "add_land_item charged 1 at the REST door");
});

test("REST replays and duplicates are not charged twice", async t => {
  const f = await serve(t);
  grantPeer(f);
  const headers = { "idempotency-key": "fx3-bounty-once" };
  const bodyOnce = bountyBody();
  const first = await post(f.origin, `/api/rooms/${f.roomId}/bounties`, bodyOnce, f.peerSecret, headers);
  assert.equal(first.status, 201);
  await first.text();
  const replay = await post(f.origin, `/api/rooms/${f.roomId}/bounties`, bodyOnce, f.peerSecret, headers);
  assert.equal(replay.status, 201, "the replay returns the original 201");
  await replay.text();
  assert.equal(remaining(f), "99990", "bounty replay charged once, not twice");

  const stage1 = await post(f.origin, `/api/rooms/${f.roomId}/files`, fileBody("dup-file"), f.peerSecret);
  assert.equal(stage1.status, 201);
  await stage1.text();
  const stage2 = await post(f.origin, `/api/rooms/${f.roomId}/files`, fileBody("dup-file"), f.peerSecret);
  assert.equal(stage2.status, 200, "re-staging the same file id is a duplicate");
  await stage2.text();
  assert.equal(remaining(f), "99985", "duplicate file stage charged once, not twice");
});

test("a REST operation that fails after authorization is voided, not charged", async t => {
  const f = await serve(t);
  grantPeer(f);
  const bad = await post(f.origin, `/api/rooms/${f.roomId}/bounties`, bountyBody({ amount: 0 }), f.peerSecret);
  assert.notEqual(bad.status, 201, `escrow must refuse a zero-amount bounty, got ${bad.status}`);
  await bad.text();
  assert.equal(remaining(f), "100000", "a failed operation leaves the grant untouched");
  const settled = f.store.db.prepare("SELECT COUNT(*) AS n FROM spend_authorizations WHERE room_id = ? AND status = 'settled'").get(f.roomId).n;
  assert.equal(settled, 0, "no settled charge for the failed operation");
});

test("owner calls and the pricing kill switch stay free at the REST doors", async t => {
  const f = await serve(t);
  const own = await post(f.origin, `/api/rooms/${f.roomId}/bounties`, bountyBody(), f.ownerSecret);
  assert.equal(own.status, 201, `the room owner posts free, got ${own.status}: ${await own.clone().text()}`);
  await own.text();

  f.store.command(f.ownerSecret, f.roomId, { id: randomUUID(), type: T.ROOM_SPEND_PRICING_SET, data: { enabled: false } });
  const free = await post(f.origin, `/api/rooms/${f.roomId}/files`, fileBody("free-file"), f.peerSecret);
  assert.equal(free.status, 201, `disabled pricing forwards free even without a grant, got ${free.status}: ${await free.clone().text()}`);
  await free.text();
});
