// Public discovery: GET /api/opportunities.json — joinable rooms, their
// open room-local work, and the invite-packet/onboarding URLs. Links land
// in the agent manifest and the well-known agent card.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { buildPluginManifest } from "../server/agent-plugin-manifest.mjs";
import { agentCard } from "../deploy/agent-discovery.mjs";

const ROOM = "commons";
const OPPORTUNITIES_URL = "https://room.trydemigod.com/api/opportunities.json";

function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-opportunities-"));
  let clock = Date.now();
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock });
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey(ROOM, "owner");
  const server = createRoomServer({ store });
  return { store, ownerKey, server, directory, advance: ms => { clock += ms; } };
}

async function started(t, fixture) {
  const { server, directory, store } = fixture;
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = (path, { method = "GET" } = {}) => fetch(origin + path, { method, headers: { Origin: origin } });
  return { origin, get };
}

function seedWork(store, ownerKey) {
  // work-1: proposed, never claimed -> open.
  store.command(ownerKey, ROOM, { id: "opp-propose-1", type: T.WORK_PROPOSED, data: {
    workItemId: "opp-work-1", title: "Write the onboarding guide",
    definitionOfDone: "Guide merged.", accountableMemberId: "owner", verifierMemberId: "owner", mode: "read" } });
  // work-2: accepted and actively claimed -> hidden.
  store.command(ownerKey, ROOM, { id: "opp-propose-2", type: T.WORK_PROPOSED, data: {
    workItemId: "opp-work-2", title: "Rebuild the index",
    definitionOfDone: "Index rebuilt.", accountableMemberId: "owner", verifierMemberId: "owner", mode: "write" } });
  store.command(ownerKey, ROOM, { id: "opp-accept-2", type: T.WORK_ACCEPTED, data: { workItemId: "opp-work-2", expectedRevision: 0 } });
  store.command(ownerKey, ROOM, { id: "opp-claim-2", type: T.CLAIM_ACQUIRED, data: {
    workItemId: "opp-work-2", expectedRevision: 1, repository: "room", ref: "main", paths: ["a"],
    expiresAt: new Date(Date.now() + 8 * 3600 * 1000).toISOString() } });
  // work-3: accepted, claim that the test then lets lapse -> open again (claimStatus "expired").
  store.command(ownerKey, ROOM, { id: "opp-propose-3", type: T.WORK_PROPOSED, data: {
    workItemId: "opp-work-3", title: "Audit the old webhooks",
    definitionOfDone: "Audit done.", accountableMemberId: "owner", verifierMemberId: "owner", mode: "write" } });
  store.command(ownerKey, ROOM, { id: "opp-accept-3", type: T.WORK_ACCEPTED, data: { workItemId: "opp-work-3", expectedRevision: 0 } });
  store.command(ownerKey, ROOM, { id: "opp-claim-3", type: T.CLAIM_ACQUIRED, data: {
    workItemId: "opp-work-3", expectedRevision: 1, repository: "room", ref: "main", paths: ["b"],
    expiresAt: new Date(Date.now() + 3600 * 1000).toISOString() } });
  // work-4: superseded -> hidden.
  store.command(ownerKey, ROOM, { id: "opp-propose-4", type: T.WORK_PROPOSED, data: {
    workItemId: "opp-work-4", title: "Ship the thing",
    definitionOfDone: "Shipped.", accountableMemberId: "owner", verifierMemberId: "owner", mode: "write" } });
  store.command(ownerKey, ROOM, { id: "opp-supersede-4", type: T.WORK_SUPERSEDED, data: {
    workItemId: "opp-work-4", supersededByWorkItemId: "opp-work-1", reason: "folded into the guide", expectedRevision: 0 } });
}

test("the feed lists opt-in rooms with a strict public shape", t => {
  const { store, directory } = serve(t);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.roomDirectory.set(ROOM, "owner", true);
  const feed = store.roomDirectory.opportunitiesFeed();
  assert.equal(feed.rooms.length, 1);
  const entry = feed.rooms[0];
  assert.deepEqual(Object.keys(entry).sort(),
    ["kind", "listedAt", "memberCount", "openWork", "purpose", "roomId", "title"]);
  assert.equal(entry.roomId, ROOM);
  assert.deepEqual(Object.keys(feed.onboarding).sort(),
    ["directory", "inviteContract", "opportunities", "redeemCard", "redeemInvite"]);
  assert.equal(feed.onboarding.redeemCard, "/api/guest-agent-links/redeem-card");
  assert.equal(feed.onboarding.opportunities, "/api/opportunities.json");
  assert.ok(Number.isFinite(feed.generatedAt));
});

test("private rooms never appear in the feed", t => {
  const { store, directory } = serve(t);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  // "commons" stays private: the feed is empty.
  const feed = store.roomDirectory.opportunitiesFeed();
  assert.deepEqual(feed.rooms, []);
});

test("open work shows only unclaimed items and never claimant identities", t => {
  const { store, ownerKey, directory, advance } = serve(t);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.roomDirectory.set(ROOM, "owner", true);
  seedWork(store, ownerKey);
  advance(2 * 3600 * 1000); // work-3's 1-hour claim lapses; work-2's 8-hour claim stays live
  const feed = store.roomDirectory.opportunitiesFeed();
  const openWork = feed.rooms[0].openWork;
  const byId = Object.fromEntries(openWork.map(w => [w.id, w]));
  assert.deepEqual(Object.keys(byId).sort(), ["opp-work-1", "opp-work-3"]);
  assert.deepEqual(Object.keys(byId["opp-work-1"]).sort(), ["claimStatus", "id", "state", "title"]);
  assert.equal(byId["opp-work-1"].claimStatus, "open");
  assert.equal(byId["opp-work-3"].claimStatus, "expired");
  assert.equal(byId["opp-work-3"].state, "accepted");
  for (const item of openWork) {
    assert.ok(!("claim" in item) && !("holderId" in item) && !("by" in item),
      `no claimant identity may leak: ${JSON.stringify(item)}`);
  }
});

test("GET /api/opportunities.json serves the feed with a 5-minute cache header", async t => {
  const { store, ownerKey, server, directory, advance } = serve(t);
  const { get } = await started(t, { store, server, directory });
  store.roomDirectory.set(ROOM, "owner", true);
  seedWork(store, ownerKey);
  advance(2 * 3600 * 1000);
  const res = await get("/api/opportunities.json");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "public, max-age=300");
  assert.match(res.headers.get("content-type"), /application\/json/);
  const feed = await res.json();
  assert.equal(feed.rooms.length, 1);
  assert.equal(feed.rooms[0].openWork.length, 2);
  const head = await get("/api/opportunities.json", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("cache-control"), "public, max-age=300");
  const post = await get("/api/opportunities.json", { method: "POST" });
  assert.equal(post.status, 405);
});

test("the agent manifest and the well-known agent card link the feed", () => {
  const manifest = buildPluginManifest({ serviceOrigin: "https://room.trydemigod.com" });
  assert.equal(manifest.opportunities, OPPORTUNITIES_URL);
  const card = agentCard();
  assert.equal(card.opportunities, OPPORTUNITIES_URL);
  assert.equal(card.endpoints.opportunities, OPPORTUNITIES_URL);
});
