// Contract-change notices: when a claim links a pull request, live claims that
// declare dependsOn on it get one structured post and their agent is woken.
// ROOM_CONTRACT_NOTICES off (default) posts nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { contractNoticePlan, contractNoticesEnabled, pathMatchesInterface, noticeBody } from "../server/contract-notices.mjs";
import { linkWithProof } from "./helpers/link-with-proof.mjs";

const PR = "https://github.com/Uuriko/project-room/pull/77";

test("flag parsing", () => {
  assert.equal(contractNoticesEnabled({ featureEnv: {} }, "r"), false);
  assert.equal(contractNoticesEnabled({ featureEnv: { ROOM_CONTRACT_NOTICES: "on" } }, "r"), true);
  assert.equal(contractNoticesEnabled({ featureEnv: { ROOM_CONTRACT_NOTICES: "a,r" } }, "r"), true);
  assert.equal(contractNoticesEnabled({ featureEnv: { ROOM_CONTRACT_NOTICES: "a" } }, "r"), false);
});

test("interface globs", () => {
  assert.equal(pathMatchesInterface("spec/core/claim.md", ["spec/**"]), true);
  assert.equal(pathMatchesInterface("src/events.js", ["src/*.js"]), true);
  assert.equal(pathMatchesInterface("src/x/events.js", ["src/*.js"]), false);
  assert.equal(pathMatchesInterface("docs/openapi.yaml", ["docs/openapi.yaml"]), true);
  assert.equal(pathMatchesInterface("server/a.mjs", ["docs/openapi.yaml"]), false);
});

test("plan: dependents of the upstream, live, other owner, filtered by interface paths", () => {
  const upstream = { id: "api", owner: "ada", state: "claimed", files: ["src/events.js"], pullRequests: [{ url: PR }] };
  const claims = [
    upstream,
    { id: "consumer", owner: "bea", state: "claimed", dependsOn: ["api"] },
    { id: "done-consumer", owner: "bea", state: "done", dependsOn: ["api"] },
    { id: "self", owner: "ada", state: "claimed", dependsOn: ["api"] },
    { id: "unrelated", owner: "cy", state: "claimed", dependsOn: ["other"] },
    { id: "child", owner: "dee", state: "in_progress", parentClaimId: "api" }
  ];
  assert.deepEqual(contractNoticePlan(upstream, claims).map(e => e.dependent.id), ["consumer", "child"]);
  assert.deepEqual(contractNoticePlan(upstream, claims, ["src/events.js"]).map(e => e.dependent.id), ["consumer", "child"]);
  assert.deepEqual(contractNoticePlan(upstream, claims, ["docs/**"]), [], "touched paths miss every interface glob");
  assert.deepEqual(contractNoticePlan({ ...upstream, pullRequests: [] }, claims), [], "no pull, no notice");
  const body = noticeBody(upstream, contractNoticePlan(upstream, claims)[0], { ada: { displayName: "Ada" } });
  assert.match(body, /^Contract change: Ada linked https:\/\/github.com\/Uuriko\/project-room\/pull\/77 on api\./);
  assert.match(body, /Your task consumer builds on api \(dependsOn\)\./);
  assert.match(body, /Touched paths: src\/events.js\./);
});

async function room(t, featureEnv) {
  const store = new RoomStore(":memory:");
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
  return { store, origin, ada, bea, client: new RoomAgentClient({ origin, roomId: "commons", token: ada.secret }) };
}

async function call(origin, secret, path, body, expected) {
  const response = await fetch(`${origin}/api/rooms/commons/work-claims${path}`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${secret}` }, body: JSON.stringify(body)
  });
  assert.equal(response.status, expected, await response.clone().text());
  return response.json();
}

async function scenario(t, featureEnv) {
  const r = await room(t, featureEnv);
  await call(r.origin, r.ada.secret, "", { id: "api" }, 201);
  await call(r.origin, r.bea.secret, "", { id: "consumer", parentClaimId: "api" }, 201);
  await call(r.origin, r.bea.secret, "/consumer/claim", { files: ["src/consumer.js"] }, 200);
  await call(r.origin, r.ada.secret, "/api/claim", { files: ["src/events.js"], pullRequest: PR }, 200);
  const posts = (await r.client.changes(0, 100)).events.filter(row => row.event.type === "message.posted").map(row => row.event.data.body);
  return { ...r, posts };
}

test("flag on: the dependent agent gets one structured post and a wake", async t => {
  const { store, posts, bea } = await scenario(t, { ROOM_CONTRACT_NOTICES: "on", ROOM_CONTRACT_PATHS: "src/events.js,spec/**" });
  const notices = posts.filter(body => body.startsWith("Contract change:"));
  assert.equal(notices.length, 1, posts.join("\n---\n"));
  assert.match(notices[0], /Your task consumer builds on api \(parentClaimId\)/);
  const wakes = store.agentHeartbeats.pendingWakes(bea.identityId);
  assert.equal(wakes.length, 1);
  assert.match(wakes[0].messageId, /^cn[a-f0-9]{40}$/);
});

test("flag off (default): nothing is posted", async t => {
  const { posts, store, bea } = await scenario(t, {});
  assert.equal(posts.some(body => body.startsWith("Contract change:")), false);
  assert.equal(store.agentHeartbeats.pendingWakes(bea.identityId).length, 0);
});

test("flag on with interface globs that miss: nothing is posted", async t => {
  const { posts } = await scenario(t, { ROOM_CONTRACT_NOTICES: "on", ROOM_CONTRACT_PATHS: "docs/openapi.yaml" });
  assert.equal(posts.some(body => body.startsWith("Contract change:")), false);
});

test("delivered dependents still hear about a contract change; closed ones do not", async () => {
  const upstream = { id: "up", owner: "a", pullRequests: [{ url: "https://github.com/o/r/pull/1" }] };
  const dep = state => ({ id: `d-${state}`, owner: "b", state, dependsOn: ["up"] });
  const plan = contractNoticePlan(upstream, [dep("delivered"), dep("closed"), dep("done")]);
  assert.deepEqual(plan.map(p => p.dependent.id), ["d-delivered"]);
});
