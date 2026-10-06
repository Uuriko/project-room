// Work-claims ?view=summary: the board list gains a compact projection
// (id, title, state, owner, leaseExpiresAt) for the 331+ item muse-room
// list, while the default view stays byte-identical.
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

const COMPACT_KEYS = ["id", "leaseExpiresAt", "owner", "state", "title"];

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
  assert.ok(Date.parse(heavy.leaseExpiresAt) > Date.now(), "lease expiry is a future timestamp");
  const light = value.claims.find(c => c.id === "sum-2");
  assert.equal(light.state, "unclaimed");
  assert.equal(light.owner, null);
  assert.equal(light.leaseExpiresAt, null);
  // the paging envelope is unchanged
  assert.equal(value.roomId, "commons");
  assert.equal(value.hasMore, false);
});

test("the default list view still returns full claims with history", async t => {
  const { owner, ownerKey, call } = await fixture(t);
  await owner.workClaimCreate({ id: "full-1", title: "Full claim", note: "keep me" });
  const { status, value } = await call(ownerKey, "/work-claims");
  assert.equal(status, 200);
  const claim = value.claims.find(c => c.id === "full-1");
  assert.ok(Array.isArray(claim.history) && claim.history.length >= 1, "default view keeps history entries");
});

test("an unknown view value is rejected", async t => {
  const { ownerKey, call } = await fixture(t);
  const { status, value } = await call(ownerKey, "/work-claims?view=full");
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
