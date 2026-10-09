// FIX-65: maxClaimsPerAgentPerCycle was a documented-but-unenforced "cap"
// (LOAD squad c16: a second concurrent claim while holding the first 200'd
// even though the activation pack advertised maxClaimsPerAgentPerCycle: 1).
//
// Resolution: UN-ADVERTISE. The server enforces a real per-agent open-claim
// cap — maxMemberOpenClaims (default 20, owner-configurable 1..10000) with a
// clean 409 too_many_open_claims on claim/assign/land paths (covered by
// "the room owner sets the per-member claim cap and a second claim is
// refused" in tests/work-claim-board.test.js). The pack's "per cycle" norm
// was never a server concept, never enforced, and a hard cap of 1 would be
// a breaking change against the default-20 behavior every agent relies on.
// So the pack no longer advertises the misleading field, and this suite
// pins the truth: what the pack says matches what the server enforces.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { buildActivationPack, COORDINATION_NORMS } from "../server/room-activation-pack.mjs";
import { EVENT_TYPES as T, PERMISSIONS, event } from "../src/events.js";

const ROOM = "fix65-norms";
const SHA = "a".repeat(40);

async function boardFixture(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: "add-agent", type: "member.added",
    data: { memberId: "agent", displayName: "Agent", kind: "agent",
      permissions: ["accept_work", "complete_work"] } });
  const agentKey = store.issueAccessKey("commons", "agent");
  const server = createRoomServer({ store, fetchPullRequest: async () => {
    throw new Error("unexpected GitHub call");
  }, githubToken: "test-token" });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (token, path, body) => {
    const response = await fetch(`${origin}/api/rooms/commons${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, value: await response.json() };
  };
  return { call, ownerKey, agentKey };
}

function packFixture(t) {
  const store = new RoomStore(":memory:");
  store.initialize([
    event({ type: T.ROOM_CREATED, actorId: "owner", roomId: ROOM,
      data: { roomId: ROOM, ownerId: "owner", title: "FIX-65", purpose: "x", kind: "personal" } }),
    event({ type: T.MEMBER_ADDED, actorId: "owner", roomId: ROOM,
      data: { memberId: "owner", displayName: "Owner", kind: "human", permissions: [...PERMISSIONS] } })
  ]);
  t.after(() => store.close());
  return store;
}

test("the activation pack no longer advertises maxClaimsPerAgentPerCycle", t => {
  // Fails before the fix: the pack advertised a per-agent per-cycle cap of 1
  // that no server path enforced — false confidence for any reader.
  assert.ok(!("maxClaimsPerAgentPerCycle" in COORDINATION_NORMS),
    "COORDINATION_NORMS must not contain maxClaimsPerAgentPerCycle");
  const pack = buildActivationPack(packFixture(t), ROOM);
  assert.deepEqual(Object.keys(pack.coordinationNorms).sort(),
    ["releaseOnInactivityHours", "stopAfterRepeatedNoopWakes"],
    "the pack keeps the behavioral norms but drops the unenforced cap");
});

test("the enforced per-agent cap is maxMemberOpenClaims, not the removed norm", async t => {
  // LOAD measurement, pinned as the truth: under the default room config an
  // agent holding one claim makes a second concurrent claim and the server
  // accepts it — the enforced cap is maxMemberOpenClaims (default 20),
  // configurable per room by the owner. The old norm said "1" while this 200'd.
  const { call, agentKey } = await boardFixture(t);
  assert.equal((await call(agentKey, "/work-claims", { id: "fix65-first" })).status, 201);
  assert.equal((await call(agentKey, "/work-claims/fix65-first/claim", {})).status, 200);
  assert.equal((await call(agentKey, "/work-claims", { id: "fix65-second" })).status, 201);
  const second = await call(agentKey, "/work-claims/fix65-second/claim", {});
  assert.equal(second.status, 200,
    "a second claim 200s under default config: maxMemberOpenClaims (20) is the enforced cap");
  const config = await call(agentKey, "/work-claims/config");
  assert.equal(config.status, 200);
  assert.equal(config.value.maxMemberOpenClaims, 20);
});
