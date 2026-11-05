// Agents holding work on the same file, pull request, or branch both get a
// room post and a wake when ROOM_COLLISION_ALERTS is on. The flag off path
// posts nothing. An exclusive file lease still refuses the second claim.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { findAgentOverlaps, collisionAlertsEnabled, concurrentMergeTargets, notifyConcurrentMerge } from "../server/agent-collisions.mjs";
import { linkWithProof } from "./helpers/link-with-proof.mjs";

const live = (id, owner, extra) => ({ id, owner, state: "claimed", files: [], ...extra });

test("overlaps name files, pull requests, branches, and changed files", () => {
  const claims = [
    live("a", "ada", { files: ["server/a.mjs"], repo: "Uuriko/project-room", branch: "lane-a" }),
    live("b", "bea", { files: ["server/a.mjs"], pullRequest: { url: "https://github.com/Uuriko/project-room/pull/7" } }),
    live("c", "ada", { files: ["docs/only-ada.md"] }),
    live("d", "bea", { files: ["src/app.js"], repo: "Uuriko/project-room", branch: "lane-a" }),
    live("e", "cy", { files: ["other.js"], pullRequest: { url: "https://github.com/Uuriko/project-room/pull/7" } }),
    live("f", "dee", { files: ["server/http.mjs"], fileBlocks: { "server/http.mjs": "top" } }),
    live("g", "eve", { files: ["server/http.mjs"], fileBlocks: { "server/http.mjs": "bottom" } }),
    live("h", "fay", { changedFiles: ["pkg/overlap.go"] }),
    live("i", "gus", { files: ["pkg/overlap.go"] }),
    live("j", "hold", { state: "done", files: ["server/a.mjs"] })
  ];
  const pairs = findAgentOverlaps(claims);
  const key = pair => `${pair.left.claimId}+${pair.right.claimId}`;
  const by = Object.fromEntries(pairs.map(pair => [key(pair), pair.parts.map(part => `${part.kind}:${part.key}`)]));
  assert.deepEqual(by["a+b"], ["file:server/a.mjs"]);
  assert.ok(by["b+e"].includes("pull:https://github.com/Uuriko/project-room/pull/7"));
  assert.deepEqual(by["a+d"], ["branch:Uuriko/project-room@lane-a"]);
  assert.equal(by["f+g"], undefined, "different blocks on one path are not the same edit");
  assert.deepEqual(by["h+i"], ["file:pkg/overlap.go"]);
  assert.equal(pairs.some(pair => pair.left.owner === pair.right.owner), false);
  assert.equal(pairs.some(pair => pair.left.claimId === "j" || pair.right.claimId === "j"), false);
  assert.equal(collisionAlertsEnabled({ featureEnv: {} }, "commons"), false);
  assert.equal(collisionAlertsEnabled({ featureEnv: { ROOM_COLLISION_ALERTS: "on" } }, "commons"), true);
  assert.equal(collisionAlertsEnabled({ featureEnv: { ROOM_COLLISION_ALERTS: "other,commons" } }, "commons"), true);
  assert.equal(collisionAlertsEnabled({ featureEnv: { ROOM_COLLISION_ALERTS: "other" } }, "commons"), false);
});

async function room(t, featureEnv) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  if (featureEnv) store.featureEnv = featureEnv;
  const ownerKey = store.issueAccessKey("commons", "owner");
  const ada = store.identities.create("Ada");
  const bea = store.identities.create("Bea");
  for (const [identity, memberId, displayName] of [[ada, "ada", "Ada"], [bea, "bea", "Bea"]]) {
    linkWithProof(store, ownerKey, "commons", identity, {
      memberId, displayName, permissions: ["accept_work", "complete_work"]
    });
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
  return {
    store, origin, ada: client(ada.secret), bea: client(bea.secret),
    adaSecret: ada.secret, beaSecret: bea.secret, adaId: ada.identityId, beaId: bea.identityId
  };
}

const claimWith = async (origin, secret, id, body) => {
  const headers = { "content-type": "application/json", authorization: `Bearer ${secret}` };
  const created = await fetch(`${origin}/api/rooms/commons/work-claims`, { method: "POST", headers, body: JSON.stringify({ id }) });
  assert.equal(created.status, 201);
  const claimed = await fetch(`${origin}/api/rooms/commons/work-claims/${id}/claim`, { method: "POST", headers, body: JSON.stringify(body) });
  assert.equal(claimed.status, 200, await claimed.clone().text());
  return claimed.json();
};

const posts = async client => (await client.changes(0, 100)).events
  .filter(row => row.event.type === "message.posted")
  .map(row => row.event.data.body);

test("flag on: both agents are named and woken for a shared file, branch, or pull request", async t => {
  const { store, origin, ada, bea, adaSecret, beaSecret, adaId, beaId } = await room(t, { ROOM_COLLISION_ALERTS: "on" });
  await ada.workClaim("lane-a", { files: ["server/a.mjs"], advisory: true });
  await bea.workClaim("lane-b", { files: ["server/a.mjs"], advisory: true });
  const bodies = await posts(ada);
  const fileAlert = bodies.find(body => body.includes("server/a.mjs") && body.includes("Coordinate the merge."));
  assert.ok(fileAlert, bodies.join("\n"));
  assert.match(fileAlert, /Ada \(lane-a\) and Bea \(lane-b\)/);
  const fileWakes = [adaId, beaId].map(identityId => store.agentHeartbeats.pendingWakes(identityId));
  assert.equal(fileWakes[0].length, 1);
  assert.equal(fileWakes[1].length, 1);
  assert.equal(fileWakes[0][0].messageId, fileWakes[1][0].messageId);
  assert.match(fileWakes[0][0].messageId, /^cx[a-f0-9]{40}$/);

  await claimWith(origin, adaSecret, "branch-a", { files: ["src/a.js"], repo: "Uuriko/project-room", branch: "shared-lane" });
  await claimWith(origin, beaSecret, "branch-b", { files: ["src/b.js"], repo: "Uuriko/project-room", branch: "shared-lane" });
  const branchAlert = (await posts(ada)).find(body => body.includes("branch Uuriko/project-room@shared-lane"));
  assert.match(branchAlert, /Ada \(branch-a\) and Bea \(branch-b\)/);

  const pull = "https://github.com/Uuriko/project-room/pull/9";
  await ada.workClaim("pull-a", { files: ["docs/a.md"], pullRequest: pull });
  await bea.workClaim("pull-b", { files: ["docs/b.md"], pullRequest: pull });
  const pullAlert = (await posts(ada)).find(body => body.includes(pull));
  assert.match(pullAlert, /Ada \(pull-a\) and Bea \(pull-b\)/);
  assert.equal(store.agentHeartbeats.pendingWakes(adaId).length, 3);
});

test("flag off posts nothing, and a hard file lease still refuses the second claim while alerting the holder when the flag is on", async t => {
  const quiet = await room(t, { ROOM_COLLISION_ALERTS: "off" });
  await quiet.ada.workClaim("quiet-a", { files: ["server/quiet.mjs"], advisory: true });
  await quiet.bea.workClaim("quiet-b", { files: ["server/quiet.mjs"], advisory: true });
  assert.equal((await posts(quiet.ada)).some(body => body.includes("Coordinate the merge.")), false);
  assert.equal(quiet.store.agentHeartbeats.pendingWakes(quiet.adaId).length, 0);

  const loud = await room(t, { ROOM_COLLISION_ALERTS: "on" });
  await loud.ada.workClaim("held", { files: ["server/held.mjs"] });
  await assert.rejects(loud.bea.workClaim("other", { files: ["server/held.mjs"] }), error => error.status === 409 && error.code === "file_lease_conflict");
  const held = await loud.ada.workClaimGet("held");
  assert.equal(held.owner, "ada");
  const other = await loud.bea.workClaimGet("other");
  assert.equal(other.state, "unclaimed");
  assert.equal(other.owner ?? null, null);
  const refusal = (await posts(loud.ada)).find(body => body.includes("server/held.mjs") && body.includes("tried to claim"));
  assert.match(refusal, /Bea tried to claim other/);
  assert.match(refusal, /Ada \(held\)/);
  assert.equal(loud.store.agentHeartbeats.pendingWakes(loud.adaId).length, 1);
  assert.equal(loud.store.agentHeartbeats.pendingWakes(loud.beaId).length, 1);
});

test("concurrent merge targets every other live claim in the repo, with or without shared paths", () => {
  const repo = "Uuriko/project-room";
  const merged = { id: "m", owner: "ada", state: "done", repo, branch: "lane-m", files: ["server/a.mjs"] };
  const claims = [
    merged,
    live("disjoint", "bea", { repo, files: ["src/b.js"] }),
    live("shared", "cy", { repo, files: ["server/a.mjs", "x.js"] }),
    live("other-repo", "dee", { repo: "Uuriko/elsewhere", files: ["server/a.mjs"] }),
    live("finished", "eve", { repo, state: "done", files: ["server/a.mjs"] }),
    live("same-lane", "ada", { repo, branch: "lane-m", files: ["server/a.mjs"] })
  ];
  const targets = concurrentMergeTargets(claims, merged);
  assert.deepEqual(targets.map(t => t.claimId), ["disjoint", "shared"]);
  assert.deepEqual(targets.find(t => t.claimId === "shared").overlap, ["server/a.mjs"]);
  assert.deepEqual(targets.find(t => t.claimId === "disjoint").overlap, []);
  assert.deepEqual(concurrentMergeTargets(claims, { id: "m" }), []);
});

test("a merged pull tells the other live agent what landed and wakes it, only when the flag is on", async t => {
  for (const [flag, expectPost] of [["off", false], ["on", true]]) {
    const { store, ada, bea, beaId, adaId } = await room(t, { ROOM_COLLISION_ALERTS: flag });
    await ada.workClaim("lane-a", { files: ["server/a.mjs"], repo: "Uuriko/project-room", branch: "lane-a", advisory: true });
    await bea.workClaim("lane-b", { files: ["src/b.js"], repo: "Uuriko/project-room", branch: "lane-b", advisory: true });
    const merged = store.workClaims.get("commons", "lane-a");
    const url = "https://github.com/Uuriko/project-room/pull/42";
    const sent = notifyConcurrentMerge(store, "commons", merged, { url, mergedSha: "0123456789abcdef" });
    const notice = (await posts(bea)).find(body => body.includes(`${url} merged`));
    if (!expectPost) { assert.deepEqual(sent, []); assert.equal(notice, undefined); continue; }
    assert.equal(sent.length, 1);
    assert.match(notice, /Bea \(lane-b\): .*pull\/42 merged at 0123456789ab from lane-a\./);
    assert.match(notice, /No shared paths/);
    assert.match(notice, /Rebase onto the new base and re-run your tests/);
    assert.equal(store.agentHeartbeats.pendingWakes(beaId).length, 1);
    assert.equal(store.agentHeartbeats.pendingWakes(adaId).length, 0, "the merging agent is not told about its own merge");
    notifyConcurrentMerge(store, "commons", merged, { url, mergedSha: "0123456789abcdef" });
    assert.equal((await posts(bea)).filter(body => body.includes(`${url} merged`)).length, 1, "retry does not duplicate the post");
  }
});
