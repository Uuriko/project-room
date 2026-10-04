// BOARD-WAKE-2: opt-in "new ready work" wake.
//
// Authoring gate:
// 1. Observable contract: an agent that PUTs wantsWork on its own membership
//    gets one ready_work wake (on /api/agent-wakes/poll) for a matching
//    unassigned create or a release; five matching creates inside ten minutes
//    produce one wake and four folded matches; the next match after the
//    window wakes again. Default off, filters that don't match, the actor
//    itself, and a paused agent get no wake. Humans can't opt in.
// 2. Regression: the hook wakes on every create, wakes agents that never
//    opted in, ignores the filter, wakes the releasing agent, or wakes
//    through a pause.
// 3. Existing board-wake tests cover assigned and lease_expired only.
// 4. No test-only seam: the HTTP route, the claim routes and wake poll are
//    the production surfaces.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { normalizeWantsWork, wantsWorkMatches } from "../server/work-wants.mjs";
import { WANTS_WORK_ROUTES } from "../server/routes/wants-work.mjs";
import { ROUTES } from "../server/routes/table.mjs";

const TEN_MINUTES = 10 * 60 * 1000;

async function fixture(t) {
  const store = new RoomStore(":memory:");
  let at = Date.now();
  store.now = () => at;
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
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
  const wants = (agent, body) => call("PUT", "/api/rooms/commons/members/me/wants-work", agent.key, body);
  const readWants = agent => call("GET", "/api/rooms/commons/members/me/wants-work", agent.key);
  const readyWakes = async agent => {
    const polled = await call("GET", "/api/agent-wakes/poll?hostId=host-1&waitMs=0", agent.secret);
    assert.equal(polled.status, 200);
    return polled.value.pendingWakes.filter(wake => wake.reason === "ready_work");
  };
  return { store, ownerKey, owner, call, enroll, wants, readWants, readyWakes, advance: ms => { at += ms; } };
}

test("five matching creates inside ten minutes are one ready_work wake; the next window wakes again", async t => {
  const { owner, enroll, wants, readWants, readyWakes, advance } = await fixture(t);
  const agent = await enroll("Docs Agent");
  const set = await wants(agent, { labels: ["Docs"] });
  assert.equal(set.status, 200);
  assert.deepEqual(set.value.wantsWork, { labels: ["docs"], capabilities: [] });
  for (let index = 0; index < 5; index += 1) {
    await owner.workClaimCreate({ id: `docs-${index}`, title: `Docs ${index}`, tags: ["docs"] });
    advance(60 * 1000);
  }
  const first = await readyWakes(agent);
  assert.equal(first.length, 1);
  assert.equal(first[0].workClaim, "docs-0");
  assert.match(first[0].messageId, /^work-claim:docs-0:ready_work:/);
  const state = await readWants(agent);
  assert.equal(state.value.foldedSinceWake, 4);
  assert.equal(typeof state.value.lastWakeAt, "string");
  advance(TEN_MINUTES);
  await owner.workClaimCreate({ id: "docs-late", title: "Docs late", tags: ["docs"] });
  const second = (await readyWakes(agent)).map(wake => wake.workClaim);
  assert.deepEqual(second.sort(), ["docs-0", "docs-late"].sort());
  assert.equal((await readWants(agent)).value.foldedSinceWake, 0);
});

test("default off, a filter that does not match, and an assigned create send no ready_work wake", async t => {
  const { ownerKey, owner, call, enroll, wants, readWants, readyWakes } = await fixture(t);
  const silent = await enroll("Quiet Agent");
  const landOnly = await enroll("Land Agent");
  assert.equal((await wants(landOnly, { capabilities: ["land"] })).status, 200);
  assert.deepEqual((await readWants(silent)).value, { roomId: "commons", memberId: silent.memberId, wantsWork: null, lastWakeAt: null, foldedSinceWake: 0 });
  await owner.workClaimCreate({ id: "plain", title: "Plain work" });
  assert.equal((await call("POST", "/api/rooms/commons/work-claims", ownerKey, { id: "for-quiet", title: "Assigned", kind: "land", assignee: silent.memberId })).status, 201);
  assert.equal((await readyWakes(silent)).length, 0);
  assert.equal((await readyWakes(landOnly)).length, 0);
  const landItem = await call("POST", "/api/rooms/commons/work-claims", ownerKey, { id: "land-1", title: "Land it", kind: "land" });
  assert.equal(landItem.status, 201);
  assert.equal(landItem.value.kind, "land");
  assert.deepEqual((await readyWakes(landOnly)).map(wake => wake.workClaim), ["land-1"]);
});

test("a release wakes other opted-in agents, not the agent that released it", async t => {
  const { owner, enroll, wants, readyWakes } = await fixture(t);
  const holder = await enroll("Holder Agent");
  const watcher = await enroll("Watcher Agent");
  assert.equal((await wants(holder, {})).status, 200);
  await owner.workClaimCreate({ id: "lane-r", title: "Lane R", assignee: holder.memberId });
  assert.equal((await wants(watcher, {})).status, 200);
  await holder.client.releaseWorkItem("lane-r", { reason: "handing back" });
  assert.deepEqual((await readyWakes(watcher)).map(wake => wake.workClaim), ["lane-r"]);
  assert.equal((await readyWakes(holder)).length, 0);
});

test("a paused agent gets no ready_work wake and its window does not start", async t => {
  const { store, ownerKey, owner, enroll, wants, readWants, readyWakes } = await fixture(t);
  const agent = await enroll("Paused Agent");
  assert.equal((await wants(agent, {})).status, 200);
  store.wakeQueue.pause(ownerKey, "commons", { requestId: randomUUID(), reason: "away" }, null, { memberId: agent.memberId });
  await owner.workClaimCreate({ id: "while-paused", title: "While paused" });
  assert.equal((await readyWakes(agent)).length, 0);
  assert.equal((await readWants(agent)).value.lastWakeAt, null);
});

test("only agents opt in, input is validated, and DELETE turns it off", async t => {
  const { ownerKey, owner, call, enroll, wants, readWants, readyWakes } = await fixture(t);
  const human = await call("PUT", "/api/rooms/commons/members/me/wants-work", ownerKey, { labels: ["docs"] });
  assert.equal(human.status, 403);
  assert.equal(human.value.error.code ?? human.value.error, "agent_only");
  const agent = await enroll("Picky Agent");
  for (const bad of [{ labels: "docs" }, { labels: ["has space"] }, { capabilities: ["cook"] }, { extra: true }, { labels: Array.from({ length: 17 }, (_, i) => `l${i}`) }]) {
    const refused = await wants(agent, bad);
    assert.equal(refused.status, 422, JSON.stringify(bad));
  }
  assert.equal((await readWants(agent)).value.wantsWork, null);
  assert.equal((await wants(agent, { labels: ["docs"] })).status, 200);
  const cleared = await call("DELETE", "/api/rooms/commons/members/me/wants-work", agent.key);
  assert.equal(cleared.status, 200);
  assert.equal(cleared.value.wantsWork, null);
  await owner.workClaimCreate({ id: "after-off", title: "After off", tags: ["docs"] });
  assert.equal((await readyWakes(agent)).length, 0);
});

test("matching rules: any tag overlap, kind in capabilities, empty lists match all", () => {
  const pref = normalizeWantsWork({ labels: ["docs", "DOCS", "ui"], capabilities: ["work"] });
  assert.deepEqual(pref, { labels: ["docs", "ui"], capabilities: ["work"] });
  assert.equal(wantsWorkMatches(pref, { tags: ["UI"], kind: "work" }), true);
  assert.equal(wantsWorkMatches(pref, { tags: ["ui"], kind: "deploy" }), false);
  assert.equal(wantsWorkMatches(pref, { tags: [], kind: "work" }), false);
  assert.equal(wantsWorkMatches({ labels: [], capabilities: [] }, { tags: [] }), true);
});

test("the wants-work rows are in the route table: GET, PUT and DELETE on the caller's own membership", () => {
  const rows = ROUTES.filter(row => row.path === "/api/rooms/{roomId}/members/me/wants-work");
  assert.deepEqual(rows.map(row => row.method).sort(), ["DELETE", "GET", "PUT"]);
  assert.deepEqual(rows.map(row => row.id).sort(), WANTS_WORK_ROUTES.map(row => row.id).sort());
  assert.ok(rows.every(row => row.auth === "room" && row.scope === "room" && row.events.length === 0));
});
