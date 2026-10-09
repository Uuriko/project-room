// Work-claims ?view=summary: the board list defaults to a compact projection
// (id, title, state, owner, leaseExpiresAt, leaseHeartbeatAt, expired) for the
// 331+ item muse-room list; ?view=full opts back into the heavy per-claim
// payload (history, description, notes, files, tags, reviews...).
// FIX-69 (event-light claim writes): leaseHeartbeatAt and the derived expired
// flag ride the summary projection so liveness and lapse are visible at a
// glance; "expired" is distinct from "unclaimed" in the read model.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";

function githubResponse(body, { status = 200, etag = null } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => (name.toLowerCase() === "etag" ? etag : null) },
    text: async () => JSON.stringify(body),
    json: async () => body
  };
}

const fakeGitHub = () => async url => {
  const target = String(url);
  if (target.includes("/pulls/")) return githubResponse({ state: "open", merged: false, head: { sha: "a".repeat(40) } });
  throw new Error(`unexpected GitHub url ${target}`);
};

async function fixture(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const add = (id, displayName, kind, permissions) => store.command(ownerKey, "commons", {
    id: `add-${id}`, type: "member.added",
    data: { memberId: id, displayName, kind, permissions }
  });
  add("coord", "Coord", "agent", ["accept_work", "complete_work"]);
  const coordKey = store.issueAccessKey("commons", "coord");
  const server = createRoomServer({ store, fetchPullRequest: fakeGitHub(), githubToken: "test-token" });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (token, path) => {
    const response = await fetch(`${origin}/api/rooms/commons${path}`, {
      headers: { authorization: `Bearer ${token}` }
    });
    return { status: response.status, value: await response.json() };
  };
  const owner = new RoomAgentClient({ origin, roomId: "commons", token: ownerKey });
  const coord = new RoomAgentClient({ origin, roomId: "commons", token: coordKey });
  return { ownerKey, coordKey, owner, coord, call };
}

const COMPACT_KEYS = ["expired", "id", "leaseExpiresAt", "leaseHeartbeatAt", "owner", "state", "title"];

test("?view=summary returns compact per-claim projections without heavy fields", async t => {
  const { owner, ownerKey, call } = await fixture(t);
  await owner.workClaimCreate({ id: "sum-1", title: "Heavy claim", note: "a long note", tags: ["x", "y"], files: ["server/a.mjs"] });
  await owner.workClaimCreate({ id: "sum-2", title: "Light claim" });
  await owner.claimWorkItem("sum-1", { leaseHours: 2 });

  const { status, value } = await call(ownerKey, "/work-claims?view=summary");
  assert.equal(status, 200);
  assert.equal(value.claims.length, 2);
  for (const claim of value.claims) {
    assert.deepEqual(Object.keys(claim).sort(), COMPACT_KEYS, `summary claim carries only compact fields: ${claim.id}`);
  }
  const heavy = value.claims.find(c => c.id === "sum-1");
  assert.equal(heavy.title, "Heavy claim");
  assert.equal(heavy.state, "claimed");
  assert.equal(heavy.owner, "owner");
  assert.equal(heavy.expired, false, "a held claim reads unexpired");
  assert.equal(heavy.leaseHeartbeatAt, null, "no heartbeat yet");
  assert.ok(Date.parse(heavy.leaseExpiresAt) > Date.now(), "lease expiry is a future timestamp");
  const light = value.claims.find(c => c.id === "sum-2");
  assert.equal(light.state, "unclaimed");
  assert.equal(light.owner, null);
  assert.equal(light.leaseExpiresAt, null);
  assert.equal(light.expired, false, "unclaimed with no lapse is not expired");
  // the paging envelope is unchanged
  assert.equal(value.roomId, "commons");
  assert.equal(value.hasMore, false);
});

test("the board list defaults to the summary projection", async t => {
  const { owner, ownerKey, call } = await fixture(t);
  await owner.workClaimCreate({ id: "def-1", title: "Default view claim", note: "heavy note" });
  const { status, value } = await call(ownerKey, "/work-claims");
  assert.equal(status, 200);
  const claim = value.claims.find(c => c.id === "def-1");
  assert.deepEqual(Object.keys(claim).sort(), COMPACT_KEYS, "default list view is the summary projection");
});

test("touch stamps leaseHeartbeatAt and the summary reflects it", async t => {
  const { owner, ownerKey, call } = await fixture(t);
  await owner.workClaimCreate({ id: "hb-1", title: "Heartbeat claim" });
  await owner.claimWorkItem("hb-1", { leaseHours: 2 });
  await owner.touchWorkItem("hb-1");
  const { status, value } = await call(ownerKey, "/work-claims?view=summary");
  assert.equal(status, 200);
  const claim = value.claims.find(c => c.id === "hb-1");
  assert.ok(Date.parse(claim.leaseHeartbeatAt) <= Date.now() + 1000, "heartbeat lands in the summary projection");
  assert.equal(claim.expired, false);
});

test("?view=full returns full claims with history", async t => {
  const { owner, ownerKey, call } = await fixture(t);
  await owner.workClaimCreate({ id: "full-1", title: "Full claim", note: "keep me" });
  const { status, value } = await call(ownerKey, "/work-claims?view=full");
  assert.equal(status, 200);
  const claim = value.claims.find(c => c.id === "full-1");
  assert.ok(Array.isArray(claim.history) && claim.history.length >= 1, "?view=full keeps history entries");
});

test("an unknown view value is rejected", async t => {
  const { ownerKey, call } = await fixture(t);
  const { status, value } = await call(ownerKey, "/work-claims?view=grid");
  assert.equal(status, 422);
  assert.equal(value.error.code, "invalid_claim_input");
});

test("?view=summary composes with the state filter", async t => {
  const { owner, ownerKey, call } = await fixture(t);
  await owner.workClaimCreate({ id: "st-1", title: "Claimed one" });
  await owner.workClaimCreate({ id: "st-2", title: "Open one" });
  await owner.claimWorkItem("st-1", { leaseHours: 2 });
  const { status, value } = await call(ownerKey, "/work-claims?state=claimed&view=summary");
  assert.equal(status, 200);
  assert.equal(value.claims.length, 1);
  assert.equal(value.claims[0].id, "st-1");
  assert.deepEqual(Object.keys(value.claims[0]).sort(), COMPACT_KEYS);
});

test("?view=summary composes with the ready queue", async t => {
  const { owner, ownerKey, call } = await fixture(t);
  await owner.workClaimCreate({ id: "rd-1", title: "Ready one" });
  const { status, value } = await call(ownerKey, "/work-claims?queue=ready&view=summary");
  assert.equal(status, 200);
  assert.equal(value.queue, "ready");
  const claim = value.claims.find(c => c.id === "rd-1");
  assert.ok(claim, "the unclaimed claim is in the ready queue");
  assert.deepEqual(Object.keys(claim).sort(), COMPACT_KEYS);
});

test("?view=summary preserves the untrusted marker on member-authored titles", async t => {
  const { coord, ownerKey, call } = await fixture(t);
  await coord.workClaimCreate({ id: "un-1", title: "Coord's claim" });
  const { status, value } = await call(ownerKey, "/work-claims?view=summary");
  assert.equal(status, 200);
  const claim = value.claims.find(c => c.id === "un-1");
  assert.equal(claim.untrusted, true, "another member's title stays marked untrusted in summary view");
  assert.deepEqual(Object.keys(claim).sort(), [...COMPACT_KEYS, "untrusted"].sort());
});
