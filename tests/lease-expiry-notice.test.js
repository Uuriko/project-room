// Lease-expiry notice: when a lapsed lease is auto-released, agents whose live
// claims overlap the freed paths get one post and a wake (ROOM_COLLISION_ALERTS).
import test from "node:test";
import assert from "node:assert/strict";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { leaseExpiryProposer, leaseExpiryTargets } from "../server/agent-collisions.mjs";
import { linkWithProof } from "./helpers/link-with-proof.mjs";

const live = (id, owner, extra) => ({ id, owner, state: "claimed", files: [], ...extra });

test("lease expiry targets only other owners' live claims that overlap the freed paths", () => {
  const repo = "Uuriko/project-room";
  const expired = { id: "x", owner: "ada", state: "unclaimed", repo, files: ["server/a.mjs", "docs/x.md"], leaseExpiresAt: "2026-11-03T00:00:00.000Z" };
  const claims = [
    expired,
    live("shared", "bea", { repo, files: ["server/a.mjs", "src/b.js"] }),
    live("disjoint", "cy", { repo, files: ["src/c.js"] }),
    live("other-repo", "dee", { repo: "Uuriko/elsewhere", files: ["server/a.mjs"] }),
    live("finished", "eve", { repo, state: "done", files: ["server/a.mjs"] }),
    live("own", "ada", { repo, files: ["server/a.mjs"] })
  ];
  const targets = leaseExpiryTargets(claims, expired);
  assert.deepEqual(targets.map(t => t.claimId), ["shared"]);
  assert.deepEqual(targets[0].overlap, ["server/a.mjs"]);
  assert.deepEqual(leaseExpiryTargets(claims, { id: "x", owner: "ada", files: [] }), []);
  assert.deepEqual(leaseExpiryTargets(claims, null), []);
});

async function room(t, featureEnv) {
  const store = new RoomStore(":memory:");
  let at = Date.now();
  store.now = () => at;
  store.initialize(initialRoom("commons"));
  store.featureEnv = featureEnv;
  const ownerKey = store.issueAccessKey("commons", "owner");
  const ada = store.identities.create("Ada");
  const bea = store.identities.create("Bea");
  for (const [identity, memberId, displayName] of [[ada, "ada", "Ada"], [bea, "bea", "Bea"]]) {
    linkWithProof(store, ownerKey, "commons", identity, { memberId, displayName, permissions: ["accept_work", "complete_work"] });
  }
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const client = secret => new RoomAgentClient({ origin, roomId: "commons", token: secret });
  return { store, ada: client(ada.secret), bea: client(bea.secret), adaId: ada.identityId, beaId: bea.identityId, advance: ms => { at += ms; } };
}

const posts = async client => (await client.changes(0, 100)).events
  .filter(row => row.event.type === "message.posted").map(row => row.event.data.body);

test("a lapsed lease tells the overlapping live agent the paths are free, once, only when the flag is on", async t => {
  for (const flag of ["off", "on"]) {
    const { store, ada, bea, beaId, advance } = await room(t, { ROOM_COLLISION_ALERTS: flag });
    await ada.workClaim("lane-a", { files: ["server/a.mjs"], repo: "Uuriko/project-room", leaseHours: 1, advisory: true });
    await bea.workClaim("lane-b", { files: ["server/a.mjs", "src/b.js"], repo: "Uuriko/project-room", leaseHours: 24, advisory: true });
    const wakesBefore = store.agentHeartbeats.pendingWakes(beaId).length;
    advance(2 * 60 * 60 * 1000);
    const listed = await bea.workClaims();
    assert.deepEqual(listed.swept, ["lane-a"]);
    const notices = (await posts(bea)).filter(body => body.includes("the lease on lane-a"));
    if (flag === "off") {
      assert.equal(notices.length, 0);
      assert.equal(store.agentHeartbeats.pendingWakes(beaId).length, wakesBefore);
      continue;
    }
    assert.equal(notices.length, 1);
    assert.match(notices[0], /^Bea \(lane-b\): the lease on lane-a held by Ada expired and was released\. Paths it held that overlap your claim are now free: server\/a\.mjs\./);
    assert.equal(store.agentHeartbeats.pendingWakes(beaId).length, wakesBefore + 1);
    await bea.workClaims();
    assert.equal((await posts(bea)).filter(body => body.includes("the lease on lane-a")).length, 1, "a repeat sweep does not duplicate");
  }
});

test("the proposer is derived from existing history: latest reassign to the holder, else create", () => {
  const stamp = (agentId, action) => ({ at: "2026-11-03T00:00:00.000Z", agentId, action, note: null });
  assert.equal(leaseExpiryProposer({ owner: "ada", history: [stamp("bea", "created"), stamp("ada", "claimed")] }), "bea");
  assert.equal(leaseExpiryProposer({ owner: "ada", history: [stamp("bea", "created"), stamp("cy", "reassigned:ada")] }), "cy");
  assert.equal(leaseExpiryProposer({ owner: "ada", history: [stamp("ada", "created"), stamp("ada", "claimed")] }), null, "self-created");
  assert.equal(leaseExpiryProposer({ owner: "ada", history: [stamp("system", "created")] }), null, "system create");
  assert.equal(leaseExpiryProposer({ owner: "ada", history: [stamp("ada", "claimed")], historyOmitted: 300 }), null, "trimmed history");
  assert.equal(leaseExpiryProposer({ owner: null, history: [stamp("bea", "created")] }), null);
});

test("a lapsed assigned claim tells the agent who assigned it, once, only when the flag is on", async t => {
  for (const flag of ["off", "on"]) {
    const { store, bea, beaId, advance } = await room(t, { ROOM_COLLISION_ALERTS: flag });
    await bea.workClaimCreate({ id: "handed", title: "Handed work", files: ["docs/h.md"], assignee: "ada" });
    const created = await bea.workClaimGet("handed");
    assert.equal((created.item ?? created).owner, "ada");
    const wakesBefore = store.agentHeartbeats.pendingWakes(beaId).length;
    advance(400 * 24 * 60 * 60 * 1000);
    const listed = await bea.workClaims();
    assert.ok(listed.swept.includes("handed"), "the assigned lease lapsed");
    const notices = (await posts(bea)).filter(body => body.includes("which you handed to"));
    if (flag === "off") {
      assert.equal(notices.length, 0);
      assert.equal(store.agentHeartbeats.pendingWakes(beaId).length, wakesBefore);
      continue;
    }
    assert.equal(notices.length, 1);
    assert.match(notices[0], /^Bea: the lease on handed, which you handed to Ada, expired and was released with no result\./);
    assert.equal(store.agentHeartbeats.pendingWakes(beaId).length, wakesBefore + 1);
    await bea.workClaims();
    assert.equal((await posts(bea)).filter(body => body.includes("which you handed to")).length, 1, "a repeat sweep does not duplicate");
  }
});
