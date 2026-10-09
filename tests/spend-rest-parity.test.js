// Regression: REST twins of priced MCP tools must charge exactly like the MCP
// route. Before this, POST /api/rooms/:id/files staged free while MCP
// room_put_file returned 402 payment_required.
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
import { createHostedRoomMcp } from "../server/mcp-room-profile.mjs";
import { createRoomServer } from "../server/http.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";
import { ensureSpendGrantsSchema, issueSpendGrant } from "../server/spend-grants.mjs";

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-spend-rest-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.db.exec(agentRoomSchema);
  ensureSpendGrantsSchema(store.db);
  const rooms = new AgentRooms(store, { rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 }) });
  const owner = store.identities.create("Owen");
  const peer = store.identities.create("Peer agent");
  const created = rooms.create(owner.secret, { title: "Spend room", purpose: "Paid tools", displayName: "Owner" });
  const roomId = created.roomId;
  const ownerMemberId = created.ownerMemberId ?? owner.identityId;
  const invite = store.invites.create(owner.secret, roomId, { profile: "chat", displayName: "Peer agent" }, null);
  const joined = store.invites.redeem(invite.code, { displayName: "Peer agent", identitySecret: peer.secret });
  const peerMemberId = joined.memberId ?? joined.member?.id;
  setTier(store.db, roomId, peerMemberId, "t2_standard", { updatedBy: ownerMemberId, nowMs: Date.now() });
  const mcp = createHostedRoomMcp(store);
  const call = (name, args) => mcp({ jsonrpc: "2.0", id: "c", method: "tools/call", params: { name, arguments: args } }, { authorization: `Bearer ${peer.secret}` });
  const server = createRoomServer({ store, streamInterval: 15 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.closeStreams(); server.closeAllConnections(); server.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const rest = (path, data) => fetch(`${origin}${path}`, { method: "POST", headers: { Authorization: `Bearer ${peer.secret}`, "Content-Type": "application/json" }, body: JSON.stringify(data) });
  return { store, roomId, ownerMemberId, peerMemberId, call, rest, origin, secret: peer.secret };
}

const file = id => ({ id, filename: "a.txt", mediaType: "text/plain", data: Buffer.from("hello").toString("base64") });

test("ungranted agent is refused 402 on REST file staging, same as MCP room_put_file", async t => {
  const f = await fixture(t);
  const viaMcp = await f.call("room_put_file", { roomId: f.roomId, ...file("file-mcp") });
  assert.equal(viaMcp.result?.isError, true);
  assert.equal(viaMcp.result.structuredContent.code ?? viaMcp.result.structuredContent.error?.code, "payment_required");
  const viaRest = await f.rest(`/api/rooms/${f.roomId}/files`, file("file-rest"));
  assert.equal(viaRest.status, 402, "REST must not stage for free what MCP prices");
  assert.equal((await viaRest.json()).error.code, "payment_required");
  const listed = f.store.db.prepare("SELECT id FROM room_attachments WHERE room_id=?").all(f.roomId);
  assert.deepEqual(listed, [], "nothing was staged by either route");
});

test("granted agent is charged once on REST file staging; replay is not double-charged", async t => {
  const f = await fixture(t);
  issueSpendGrant(f.store.db, f.roomId, f.peerMemberId, { grantedBy: f.ownerMemberId, capCents: "100", perTxCapCents: "10", nowMs: Date.now() });
  const spent = () => f.store.db.prepare("SELECT COALESCE(SUM(CAST(price_cents AS INTEGER)),0) AS n FROM spend_authorizations WHERE room_id=? AND status='settled'").get(f.roomId).n;
  assert.equal((await f.rest(`/api/rooms/${f.roomId}/files`, file("file-1"))).status, 201);
  assert.equal(spent(), 5);
  assert.equal((await f.rest(`/api/rooms/${f.roomId}/files`, file("file-1"))).status, 200, "idempotent replay");
  assert.equal(spent(), 5, "replay voids its reservation instead of charging again");
});

const bounty = (title = "Fix the thing") => ({ title, criteria: "Cover every breaking change with a before/after example.", amount: 100, deadline: new Date(Date.now() + 86400000).toISOString() });

test("REST bounty post is refused 402 for an ungranted agent, like MCP bounty_post", async t => {
  const f = await fixture(t);
  const res = await f.rest(`/api/rooms/${f.roomId}/bounties`, bounty());
  assert.equal(res.status, 402, await res.clone().text());
  assert.equal((await res.json()).error.code, "payment_required");
});

test("REST bounty post charges once for a granted agent; an idempotent replay is voided", async t => {
  const f = await fixture(t);
  issueSpendGrant(f.store.db, f.roomId, f.peerMemberId, { grantedBy: f.ownerMemberId, capCents: "100", perTxCapCents: "20", nowMs: Date.now() });
  const spent = () => f.store.db.prepare("SELECT COALESCE(SUM(CAST(price_cents AS INTEGER)),0) AS n FROM spend_authorizations WHERE room_id=? AND status='settled'").get(f.roomId).n;
  const sameBody = bounty();
  const post = () => fetch(`${f.origin}/api/rooms/${f.roomId}/bounties`, { method: "POST", headers: { Authorization: `Bearer ${f.secret}`, "Content-Type": "application/json", "Idempotency-Key": "bounty-idem-1" }, body: JSON.stringify(sameBody) });
  const first = await post();
  assert.equal(first.status, 201, await first.clone().text());
  assert.equal(spent(), 10);
  const replay = await post();
  assert.ok([200, 201].includes(replay.status), `replay ${replay.status} ${await replay.clone().text()}`);
  assert.equal(spent(), 10, "replay must not charge again");
  const open = f.store.db.prepare("SELECT COUNT(*) AS n FROM spend_authorizations WHERE room_id=? AND status='reserved'").get(f.roomId).n;
  assert.equal(open, 0, "no reservation left dangling");
});
