// DC3-P3 (accept slice): permission before shape on bounty accept, both
// faces. Forbidden seats get a clean 403 with no attestation-contract
// content; the authorised poster's shape refusal teaches the complete
// inner attestation contract; the happy path is unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { BountyEscrow } from "../server/bounty-escrow.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";
import { ensureSpendGrantsSchema, issueSpendGrant } from "../server/spend-grants.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AgentRooms, agentRoomSchema } from "../server/agent-rooms.mjs";
import { createRateLimiter } from "../server/identity-ratelimit.mjs";
import { createHostedRoomMcp } from "../server/mcp-room-profile.mjs";

const ROOM = "commons";
const SHAPE_TOKENS = ["verifierAttestation", "idempotencyKey", "citations", "criterionId"];
const INNER_TOKENS = ["citations", "criterionId", "verdict", "pass", "fail"];
const FULL = { verifierAttestation: { citations: [{ criterionId: "c1", verdict: "pass" }] } };

async function restSubmitted(t) {
  const fixture = createAcceptanceFixture();
  const escrow = new BountyEscrow(fixture.store, { allowLegacyStringLanes: true });
  fixture.store.transaction(() => {
    escrow._ensure();
    const at = new Date().toISOString();
    for (const memberId of ["owner", "guest", "producer", "reviewer"])
      escrow._append({ roomId: ROOM, accountId: memberId, at, kind: "genesis",
        amount: 100 * 1000, lotState: "payable", memo: "test seeding", actor: { kind: "rule", id: "test" } });
  });
  ensureSpendGrantsSchema(fixture.store.db);
  for (const memberId of ["producer", "reviewer"]) {
    setTier(fixture.store.db, ROOM, memberId, "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
    issueSpendGrant(fixture.store.db, ROOM, memberId,
      { grantedBy: "owner", capCents: "100000", perTxCapCents: "100000", nowMs: Date.now() });
  }
  const server = createRoomServer({ store: fixture.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fixture.store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body, secret) => {
    const res = await fetch(`${origin}${path}`, { method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify(body) });
    return { status: res.status, text: await res.text() };
  };
  const created = await post(`/api/rooms/${ROOM}/bounties`, {
    title: "Write the migration guide", criteria: "Cover every breaking change.",
    amount: 100, deadline: new Date(Date.now() + 86400000).toISOString(),
  }, fixture.keys.owner);
  const bountyId = JSON.parse(created.text).bounty.bountyId;
  await post(`/api/rooms/${ROOM}/bounties/${bountyId}/fund`, {}, fixture.keys.owner);
  await post(`/api/rooms/${ROOM}/bounties/${bountyId}/claim`, {}, fixture.keys.producer);
  await post(`/api/rooms/${ROOM}/bounties/${bountyId}/submit`, {
    evidenceUrl: "https://room.example/receipts/1", evidenceKind: "work.completed",
    summary: "Drafted.", checksClaimed: ["breaking-changes"], producerId: "producer",
  }, fixture.keys.producer);
  return { post, keys: fixture.keys, bountyId };
}

test("REST accept: forbidden seats get a clean 403 before shape; poster 422 teaches the full contract", async t => {
  const { post, keys, bountyId } = await restSubmitted(t);
  const path = `/api/rooms/${ROOM}/bounties/${bountyId}/accept`;
  for (const secret of [keys.guest, keys.reviewer]) {
    const r = await post(path, {}, secret);
    assert.equal(r.status, 403);
    assert.match(r.text, /not_authorized/);
    assert.match(r.text, /only the poster may accept a human-approved bounty/);
    assert.match(r.text, /room_check_access/);
    for (const token of SHAPE_TOKENS) assert.ok(!r.text.includes(token), `403 must not name ${token}`);
    const full = await post(path, FULL, secret);
    assert.equal(full.status, 403, "full-attestation forbidden seat stays 403");
  }
  const poster = await post(path, {}, keys.owner);
  assert.equal(poster.status, 422);
  for (const token of INNER_TOKENS) assert.ok(poster.text.includes(token), `poster 422 must teach ${token}`);
  const ok = await post(path, FULL, keys.owner);
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.text).bounty.state, "accepted");
});

test("MCP bounty_accept: forbidden seats get a clean 403 before transport shape validation; poster error teaches the full contract", async t => {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  store.db.exec(agentRoomSchema);
  t.after(() => store.close());
  const rooms = new AgentRooms(store, { rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 }) });
  const mcp = createHostedRoomMcp(store);
  const tool = (secret, name, args) =>
    mcp({ jsonrpc: "2.0", id: "c", method: "tools/call", params: { name, arguments: args } },
      { authorization: `Bearer ${secret}` });
  const owner = store.identities.create("F3 Owner");
  const created = rooms.create(owner.secret, { title: "accept order room", purpose: "test", displayName: "F3 Owner" });
  const roomId = created.roomId;
  const joinAs = async (profile, name) => {
    const identity = store.identities.create(name);
    const invite = store.invites.create(owner.secret, roomId, { profile, displayName: name }, null);
    const joined = store.invites.redeem(invite.code, { displayName: name, identitySecret: identity.secret });
    const memberId = joined.memberId ?? joined.member?.id;
    setTier(store.db, roomId, memberId, "t2_standard", { updatedBy: created.ownerMemberId ?? "owner", nowMs: Date.now() });
    return { secret: identity.secret, memberId };
  };
  const worker = await joinAs("contribute", "F3 Worker");
  const verifier = await joinAs("collaborate", "F3 Verifier");
  const zero = await joinAs("chat", "F3 Zero");
  const posted = await tool(owner.secret, "bounty_post", { roomId, title: "T", criteria: "C",
    amount: 10, deadline: new Date(Date.now() + 7 * 864e5).toISOString(),
    rubric: [{ criterionId: "c1", description: "one thing" }] });
  const bountyId = (posted.result?.structuredContent ?? JSON.parse(posted.result.content[0].text)).bounty.bountyId;
  await tool(owner.secret, "bounty_fund", { roomId, bountyId, idempotencyKey: `fund-${randomUUID()}` });
  await tool(worker.secret, "bounty_claim", { roomId, bountyId, idempotencyKey: `claim-${randomUUID()}` });
  await tool(worker.secret, "bounty_submit", { roomId, bountyId, evidenceUrl: "https://example.com/work",
    summary: "done", evidenceKind: "document", checksClaimed: ["c1"], idempotencyKey: `sub-${randomUUID()}` });

  for (const seat of [zero, verifier]) {
    const res = await tool(seat.secret, "bounty_accept", { roomId, bountyId });
    const text = JSON.stringify(res);
    assert.ok(!res.error, "forbidden seat must not get the -32602 shape error");
    assert.match(text, /403/);
    assert.match(text, /not_authorized/);
    for (const token of SHAPE_TOKENS) assert.ok(!text.includes(token), `403 must not name ${token}`);
  }
  const poster = await tool(owner.secret, "bounty_accept", { roomId, bountyId });
  const posterText = JSON.stringify(poster);
  assert.equal(poster.error?.code, -32602);
  for (const token of INNER_TOKENS) assert.ok(posterText.includes(token), `poster error must teach ${token}`);
  const ok = await tool(owner.secret, "bounty_accept",
    { roomId, bountyId, ...FULL, idempotencyKey: `ok-${randomUUID()}` });
  assert.ok(!ok.result?.isError);
  assert.match(JSON.stringify(ok), /accepted/);
});
