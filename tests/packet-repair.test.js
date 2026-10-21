// PACKET-REPAIR (2026-10-20): the newcomer packet repair batch, graded
// against the UT-HTTP-PACKET strands (S-1..S-4, M-1, M-2) and UT-HOSTS
// F-2. The packet is the surface a cold newcomer reads; the server-side
// halves of S-1/S-2 (requestId idempotency, duplicate replay re-issuing
// the mcpToken) already existed at base — these specimens pin the
// documented contract over HTTP so the copy cannot drift from the
// behaviour, and the copy assertions fail until the packet teaches it.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { llmsTxt, llmsFullTxt } from "../server/agent-discovery.mjs";
import { listedMcpTools, liveMcpServerCardJson } from "../server/mcp-discovery.mjs";

const section = (packet, heading) => {
  const start = packet.indexOf(heading);
  assert.notEqual(start, -1, `packet carries the section ${heading}`);
  const rest = packet.slice(start + heading.length);
  const next = rest.indexOf("\n## ");
  return next === -1 ? rest : rest.slice(0, next);
};

for (const [label, packet] of [["llms.txt", llmsTxt()], ["llms-full.txt", llmsFullTxt()]]) {
  test(`${label}: create steps teach the idempotency + recovery contract (S-1)`, () => {
    const create = section(packet, "## New agent creating a room");
    assert.ok(create.includes("requestId"), "create steps name the requestId idempotency key");
    assert.ok(create.includes("duplicate: true"), "create steps name the duplicate:true replay answer");
    assert.ok(create.includes("request_conflict"), "create steps name the 409 request_conflict refusal");
    assert.ok(create.includes("GET /api/agent-rooms"), "create steps cross-reference the list-rooms recovery");
  });

  test(`${label}: create steps teach the mcpToken re-issue path (S-2)`, () => {
    const create = section(packet, "## New agent creating a room");
    assert.ok(create.includes("freshly issued"), "a duplicate replay carries a freshly issued mcpToken");
    assert.ok(create.includes("identity secret also works"), "the identity secret is named as the /mcp bearer fallback at the create steps");
  });

  test(`${label}: the seeded starter claim is documented (S-3 copy)`, () => {
    const create = section(packet, "## New agent creating a room");
    assert.ok(create.includes("`starter`"), "create steps name the seeded starter claim");
    assert.ok(create.includes("already claimed for you"), "create steps say the starter arrives pre-claimed");
    assert.ok(create.includes("starter: false"), "create steps name the opt-out");
    const board = section(packet, "## Work-claim board");
    assert.ok(board.includes("reads `null`"), "board section states the effective-policy rule for a null reviewPolicy");
  });

  test(`${label}: the room-archive exit is documented (S-4)`, () => {
    const create = section(packet, "## New agent creating a room");
    assert.ok(create.includes("room.archived"), "create flow names the room.archived command");
    assert.ok(create.includes("room_archived"), "create flow names the post-archive 409 room_archived");
  });

  test(`${label}: board claim-conflict shape is documented (M-1)`, () => {
    const board = section(packet, "## Work-claim board");
    assert.ok(board.includes("work_claim_conflict"), "board section documents the 409 work_claim_conflict shape");
  });

  test(`${label}: orient has an HTTP mapping (M-2)`, () => {
    assert.ok(packet.includes("`orient` field of the activation pack"),
      "routes/first-tools name the activation pack's embedded orient object as the HTTP mapping");
  });
}

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "packet-repair-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, origin: `http://127.0.0.1:${server.address().port}` };
}

const post = (origin, path, secret, body) => fetch(`${origin}${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", "user-agent": "project-room-agent", ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
  body: JSON.stringify(body)
});

test("S-1/S-2 over HTTP: a retried create returns the same room, a named refusal on conflict, and a freshly issued mcpToken", async t => {
  const { origin } = await serve(t);
  const mint = await post(origin, "/api/agent-identities", null, { displayName: "Packet Repair Walker" });
  assert.equal(mint.status, 201);
  const identity = await mint.json();

  const body = { title: "Packet Repair Den", purpose: "Prove the create contract", requestId: "pkt-repair-1" };
  const first = await post(origin, "/api/agent-rooms", identity.secret, body);
  assert.equal(first.status, 201);
  const created = await first.json();
  assert.equal(created.duplicate, false);
  assert.ok(created.mcpToken?.credential, "first create carries an mcpToken credential");

  // The uncertain-response retry: identical body, same requestId.
  const retry = await post(origin, "/api/agent-rooms", identity.secret, body);
  assert.equal(retry.status, 200, "an idempotent replay answers 200, not a second 201");
  const replayed = await retry.json();
  assert.equal(replayed.duplicate, true);
  assert.equal(replayed.roomId, created.roomId, "the retry returns the original room, never a silent duplicate");
  assert.ok(replayed.mcpToken?.credential, "the replay re-issues an mcpToken (the S-2 recovery path)");

  // The re-issued token authenticates on /mcp.
  const listed = await post(origin, "/mcp", replayed.mcpToken.credential, { jsonrpc: "2.0", id: "1", method: "tools/list" });
  assert.equal(listed.status, 200);
  assert.ok((await listed.json()).result.tools.length > 0, "the re-issued token lists tools");

  // Same key, different parameters: a named refusal, never a new room.
  const clash = await post(origin, "/api/agent-rooms", identity.secret, { ...body, title: "A Different Den" });
  assert.equal(clash.status, 409);
  const clashBody = await clash.json();
  assert.equal(clashBody.error?.code ?? clashBody.code, "request_conflict");

  // Exactly one room exists for the identity after all of the above.
  const rooms = await (await fetch(`${origin}/api/agent-rooms`, { headers: { authorization: `Bearer ${identity.secret}`, "user-agent": "project-room-agent" } })).json();
  assert.deepEqual(rooms.rooms.map(room => room.roomId), [created.roomId], "no duplicate room was minted");
});

test("S-3: the activation pack's menu surfaces the viewer's held starter claim", async t => {
  const { origin } = await serve(t);
  const mint = await post(origin, "/api/agent-identities", null, { displayName: "Packet Pack Walker" });
  const identity = await mint.json();
  const created = await (await post(origin, "/api/agent-rooms", identity.secret,
    { title: "Packet Pack Den", purpose: "Prove the pack menu", requestId: "pkt-repair-2" })).json();

  const pack = await (await fetch(`${origin}/api/rooms/${created.roomId}/activation-pack`,
    { headers: { authorization: `Bearer ${identity.secret}`, "user-agent": "project-room-agent" } })).json();
  assert.ok(Array.isArray(pack.myClaims), "the pack carries the viewer's own claims as myClaims");
  const starter = pack.myClaims.find(claim => claim.id === "starter");
  assert.ok(starter, "the seeded starter is visible in the pack, not only on the board");
  assert.equal(starter.state, "claimed", "the starter arrives pre-claimed to the creator");
  assert.ok(starter.leaseExpiresAt && Date.parse(starter.leaseExpiresAt) > Date.now(), "the starter's lease expiry rides the pack entry");
  assert.deepEqual(pack.openClaims, [], "openClaims still lists only unclaimed work — the starter is held, not open");
});

test("F-2: the MCP server card advertises the roomless lobby tier beside public and enrolled", () => {
  const card = JSON.parse(liveMcpServerCardJson());
  assert.ok(Array.isArray(card.tools.lobby), "the card carries a lobby tier");
  assert.deepEqual(card.tools.lobby, listedMcpTools("core", false, { memberships: [] }),
    "the lobby tier is the live roomless list a saved identity with no membership is served");
  assert.notDeepEqual(card.tools.lobby, card.tools.public, "the lobby is not the anonymous public tier");
  assert.notDeepEqual(card.tools.lobby, card.tools.enrolled, "the lobby is not the enrolled member tier");
  const names = card.tools.lobby.map(tool => tool.name);
  assert.ok(names.includes("public_work_claim") && names.includes("room_join_packet"),
    "the lobby names the public-work verbs and the join readers a roomless identity actually gets");
});
