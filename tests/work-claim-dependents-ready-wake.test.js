// Ready-queue wakes: dependency unblocking and the readiness guard.
//
// Authoring gate (.agents/skills/test-audit/SKILL.md):
// 1. Observable contracts:
//    (a) completing a claim wakes opted-in ready-work watchers about each
//        dependent that just became ready (all dependencies done). Today the
//        BOARD-WAKE-2 hook fires only on created/released, so a lane waiting
//        on a dependency is never told it unblocked — the ready queue fills
//        with work nobody is nudged toward (ready-queue starvation).
//    (b) creating (or releasing) a claim whose dependencies are NOT done
//        must not wake ready-work watchers: the item is not ready, the
//        queue=ready view would not list it, and the wake is a false signal.
// 2. Credible regressions: a later commit() refactor drops the dependents
//    scan; or someone reverts the readiness guard on created and every
//    blocked create spams opted-in agents again.
// 3. Existing coverage: tests/board-wake-ready-work.test.js covers
//    created/released of dependency-free items; nothing covers
//    dependency-unblock or the unready-create suppression.
// 4. No test-only seam: the HTTP routes, the real RoomStore, the real wake
//    poll — the same surfaces the production board uses.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";

async function fixture(t) {
  const store = new RoomStore(":memory:");
  const at = Date.now();
  store.now = () => at;
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const owner = new RoomAgentClient({ origin, roomId: "commons", token: ownerKey });
  const call = async (method, path, token, body) => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, value: await response.json() };
  };
  const enroll = async name => {
    const identity = store.identities.create(name);
    const memberId = name.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 32);
    store.identities.link(ownerKey, "commons", {
      identityId: identity.identityId, memberId, displayName: name,
      permissions: ["accept_work", "complete_work"]
    });
    const beat = await call("POST", "/api/agent-heartbeats", identity.secret, { hostId: "host-1", mode: "pull-only" });
    assert.equal(beat.status, 200);
    const key = store.issueAccessKey("commons", memberId);
    return { ...identity, memberId, key, client: new RoomAgentClient({ origin, roomId: "commons", token: key }) };
  };
  const readyWakes = async agent => {
    const polled = await call("GET", "/api/agent-wakes/poll?hostId=host-1&waitMs=0", agent.secret);
    assert.equal(polled.status, 200);
    return polled.value.pendingWakes.filter(wake => wake.reason === "ready_work");
  };
  return { store, owner, enroll, readyWakes,
    wants: (agent, body) => call("PUT", "/api/rooms/commons/members/me/wants-work", agent.key, body) };
}

test("creating a claim with unmet dependencies does not wake ready-work watchers", async t => {
  const { owner, enroll, wants, readyWakes } = await fixture(t);
  const agent = await enroll("Docs Agent");
  assert.equal((await wants(agent, { labels: ["docs"] })).status, 200);

  await owner.workClaimCreate({ id: "dep-a", title: "Dep A" });
  await owner.claimWorkItem("dep-a", { leaseHours: 2 });
  // B depends on A, which is not done: B is not ready, so no ready_work wake.
  await owner.workClaimCreate({ id: "dep-b", title: "Dep B", tags: ["docs"], dependsOn: ["dep-a"] });

  const wakes = await readyWakes(agent);
  assert.deepEqual(wakes, [], `an unready create must not wake ready-work watchers; got ${JSON.stringify(wakes.map(w => w.messageId))}`);
});

test("completing a claim wakes ready-work watchers about the dependent it unblocked", async t => {
  const { owner, enroll, wants, readyWakes } = await fixture(t);
  const agent = await enroll("Docs Agent");
  assert.equal((await wants(agent, { labels: ["docs"] })).status, 200);

  await owner.workClaimCreate({ id: "base-a", title: "Base A" });
  await owner.claimWorkItem("base-a", { leaseHours: 2 });
  await owner.updateWorkItem("base-a", { state: "in_progress" });
  await owner.workClaimCreate({ id: "base-b", title: "Base B", tags: ["docs"], dependsOn: ["base-a"] });
  // The poll never acknowledges (signals leave only through ackWakes), so
  // diff on message ids: only a wake minted by the completion counts.
  const before = new Set((await readyWakes(agent)).map(wake => wake.messageId));

  await owner.updateWorkItem("base-a", { state: "done", note: "shipped" });

  const fresh = (await readyWakes(agent))
    .filter(wake => !before.has(wake.messageId) && wake.messageId.startsWith("work-claim:base-b:ready_work:"));
  assert.equal(fresh.length, 1, `completing base-a must wake ready-work watchers about base-b; new wakes: ${JSON.stringify(fresh.map(w => w.messageId))}`);
});
