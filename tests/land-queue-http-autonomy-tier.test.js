// Issue #941 P2 (SEC-VERIFY remainder): the HTTP land-queue routes in
// server/http.mjs called store.landQueue directly with no autonomy-tier
// gate, while their MCP twins (callLandTool, #993) refuse t1_readonly
// agents. A demoted agent could add, remove, and report tips over REST
// while MCP refused it. These tests pin the mirrored gate: t1 refused on
// every write with 403 agent_readonly, reads still allowed, and the
// permitted tiers (t2 agent, owner) keep the existing flows — including
// the claimant path the store-layer reassignment gate (#4765) guards.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { demoteToReadonly, getTier } from "../server/autonomy-tiers.mjs";

const SHA = "a".repeat(40);

function snapshot() {
  return {
    pr: {
      title: "Land the queue",
      merged: false,
      merge_commit_sha: null,
      mergeable: true,
      mergeable_state: "clean",
      head: { sha: SHA }
    },
    status: { state: "pending" },
    checks: { check_runs: [{ status: "in_progress", conclusion: null }] }
  };
}

function mockGitHub() {
  const fetchImpl = async url => {
    let body = snapshot().pr;
    if (url.includes("/check-runs")) body = snapshot().checks;
    else if (url.endsWith("/status")) body = snapshot().status;
    return { status: 200, ok: true, json: async () => body };
  };
  return { fetchImpl };
}

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-land-http-tier-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.landQueue.configure({ fetchImpl: mockGitHub().fetchImpl });
  const ownerKey = store.issueAccessKey("commons", "owner");
  const addAgent = memberId => store.command(ownerKey, "commons", {
    id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId, displayName: `Agent ${memberId}`, kind: "agent", permissions: [], accountableHumanId: "owner" }
  });
  addAgent("agent");
  addAgent("peer");
  const keys = {
    owner: ownerKey,
    agent: store.issueAccessKey("commons", "agent"),
    peer: store.issueAccessKey("commons", "peer")
  };
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, keys };
}

async function listen(t, store) {
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const post = (origin, key, action, payload) => fetch(`${origin}/api/rooms/commons/${action}`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
  body: JSON.stringify(payload)
});

test("t1_readonly agent is refused HTTP land-queue writes but can list", async t => {
  const f = fixture(t);
  const origin = await listen(t, f.store);
  demoteToReadonly(f.store.db, "commons", "agent", { updatedBy: "owner", nowMs: Date.now() });
  assert.equal(getTier(f.store.db, "commons", "agent").autonomyTier, "t1_readonly");

  for (const [action, payload] of [
    ["add_land_item", { repo: "acme/demo", prNumber: 969 }],
    ["remove_land_item", { itemId: "missing" }],
    ["report_tip", { itemId: "missing", buildId: "build-9" }]
  ]) {
    const refused = await post(origin, f.keys.agent, action, payload);
    assert.equal(refused.status, 403, `${action} should be refused at t1`);
    assert.equal((await refused.json()).error.code, "agent_readonly", `${action} refusal code`);
  }
  // No queue row was created by the refused add.
  assert.equal(f.store.landQueue.list("commons", "owner").items.length, 0);

  // Listing is a read: still allowed at the read-only tier.
  const listed = await fetch(`${origin}/api/rooms/commons/list_land_queue`, {
    headers: { authorization: `Bearer ${f.keys.agent}` }
  });
  assert.equal(listed.status, 200);
});

test("t2_standard agent keeps full HTTP land-queue access", async t => {
  const f = fixture(t);
  const origin = await listen(t, f.store);

  // add_land_item is a priced operation for agents (#3269): a t2 agent
  // without a spend grant is refused by the spend charge, never by the
  // tier gate — the tier gate must let it through to that charge.
  const peerAdd = await post(origin, f.keys.peer, "add_land_item", { repo: "acme/demo", prNumber: 969 });
  assert.notEqual((await peerAdd.json()).error?.code, "agent_readonly");

  const added = await post(origin, f.keys.owner, "add_land_item", { repo: "acme/demo", prNumber: 969 });
  assert.equal(added.status, 201);
  const created = await added.json();

  const tipped = await post(origin, f.keys.peer, "report_tip", { itemId: created.item.itemId, buildId: "build-9" });
  assert.equal(tipped.status, 200);
  assert.deepEqual((await tipped.json()).changed, ["tip"]);

  const removed = await post(origin, f.keys.peer, "remove_land_item", { itemId: created.item.itemId });
  assert.equal(removed.status, 200);
  assert.equal((await removed.json()).removed, true);
});

test("owner flows are unaffected by the tier gate, claimant add included", async t => {
  const f = fixture(t);
  const origin = await listen(t, f.store);
  demoteToReadonly(f.store.db, "commons", "agent", { updatedBy: "owner", nowMs: Date.now() });

  // The owner naming another member as claimant rides the same add path
  // the store-layer claimant gate guards; the tier gate must not block it.
  const added = await post(origin, f.keys.owner, "add_land_item", { repo: "acme/demo", prNumber: 970, claimantMemberId: "peer" });
  assert.equal(added.status, 201);
  const created = await added.json();
  assert.equal(created.item.claimantMemberId, "peer");

  const removed = await post(origin, f.keys.owner, "remove_land_item", { itemId: created.item.itemId });
  assert.equal(removed.status, 200);
  assert.equal((await removed.json()).removed, true);
});
