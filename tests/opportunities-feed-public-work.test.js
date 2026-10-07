// Opportunity feed v2 — public-work pool discovery (#1609).
//
// GET /api/opportunities.json must surface unclaimed volunteer public-work
// tasks as feed items (a third signal alongside help-wanted work and
// bounties) and carry a stable seeAlso pointer to the public-work API so the
// feed never degrades into a dead end when the pool is empty.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

const ROOM = "commons";

function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-opportunities-pw-"));
  let clock = Date.now();
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock });
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey(ROOM, "owner");
  const server = createRoomServer({ store });
  return { store, ownerKey, server, directory, advance: ms => { clock += ms; }, now: () => clock };
}

async function started(t, fixture) {
  const { server, directory, store } = fixture;
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = path => fetch(origin + path, { method: "GET", headers: { Origin: origin } });
  return { origin, get };
}

function enableTask(store, id, { roomId = ROOM, reward = { kind: "unpaid" }, published = true, files = [`src/${id}.js`] } = {}) {
  const input = { requestId: `create-${id}`, offerId: id, reviewerMemberIds: ["owner"],
    terms: { kind: "task", title: `Public task ${id}`, summary: "Do open work",
      acceptanceCriteria: ["Deliver the declared change"],
      repositoryUrl: "https://github.com/Example/Project", reward, approvalPolicy: { mode: "human" } } };
  store.projectOffers.create(roomId, "owner", input);
  if (published) {
    store.projectOffers.transition(roomId, "owner", id, "publish", { requestId: `publish-${id}`, expectedRevision: 1 });
  }
  return store.publicWorkClaims.enable(roomId, "owner", id, {
    requestId: `enable-${id}`, expectedRevision: published ? 2 : 1, expectedTermsVersion: 1,
    repositoryRef: "main", files });
}

const PUBLIC_WORK_KEYS = ["kind", "taskId", "roomId", "roomTitle", "roomPath", "title",
  "acceptanceCriteria", "repositoryUrl", "claimState", "openedAt"].sort();

test("unclaimed volunteer public-work tasks appear as feed items with a strict shape", async t => {
  const fixture = serve(t);
  const { get } = await started(t, fixture);
  const { store } = fixture;
  store.roomDirectory.set(ROOM, "owner", true);
  enableTask(store, "pw-task-1");
  const res = await get("/api/opportunities.json");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.opportunities.length, 1);
  const opp = body.opportunities[0];
  assert.deepEqual(Object.keys(opp).sort(), PUBLIC_WORK_KEYS);
  assert.equal(opp.kind, "public-work");
  assert.equal(opp.taskId, "pw-task-1");
  assert.equal(opp.roomId, ROOM);
  assert.equal(opp.title, "Public task pw-task-1");
  assert.equal(opp.claimState, "unclaimed");
  assert.equal(opp.roomPath, `/?room=${ROOM}`);
  assert.deepEqual(opp.acceptanceCriteria, ["Deliver the declared change"]);
  assert.equal(opp.repositoryUrl, "https://github.com/example/project"); // normalized by enable()
  assert.ok(Date.parse(opp.openedAt) > 0, "openedAt must be a parseable timestamp");
  // No admission or identity leakage.
  const serialized = JSON.stringify(opp);
  assert.ok(!/secret|owner|invite|redeem|code/i.test(serialized), "no admission or identity material");
});

test("feed carries a seeAlso pointer to the public-work API even when the pool is empty", async t => {
  const fixture = serve(t);
  const { get } = await started(t, fixture);
  const body = await (await get("/api/opportunities.json")).json();
  assert.deepEqual(body.opportunities, []);
  assert.deepEqual(body.seeAlso, { publicWork: "/api/public-work/tasks" });
});

test("claimed and submitted public-work tasks stay out of the feed", async t => {
  const fixture = serve(t);
  const { get } = await started(t, fixture);
  const { store } = fixture;
  store.roomDirectory.set(ROOM, "owner", true);
  enableTask(store, "pw-claimed");
  enableTask(store, "pw-submitted");
  enableTask(store, "pw-free");
  const [worker] = [store.identities.create("Feed worker")];
  const claim = requestId => ({ requestId, expectedTermsVersion: 1 });
  store.publicWorkClaims.act("pw-claimed", worker.secret, "claim", claim("c1"));
  store.publicWorkClaims.act("pw-submitted", worker.secret, "claim", claim("c2"));
  store.publicWorkClaims.act("pw-submitted", worker.secret, "finish",
    { ...claim("c3"), generation: 1, artifactText: "done", checksReported: ["tests pass"] });
  const body = await (await get("/api/opportunities.json")).json();
  assert.deepEqual(body.opportunities.map(o => o.taskId), ["pw-free"]);
});

test("public-work items respect the owner feed opt-out like the other signals", async t => {
  const fixture = serve(t);
  const { get } = await started(t, fixture);
  const { store } = fixture;
  store.roomDirectory.set(ROOM, "owner", true);
  enableTask(store, "pw-toggle");
  const feed = async () => (await (await get("/api/opportunities.json")).json()).opportunities;
  assert.equal((await feed()).length, 1);
  store.roomDirectory.setOpportunities(ROOM, "owner", false);
  assert.deepEqual(await feed(), []);
  store.roomDirectory.setOpportunities(ROOM, "owner", true);
  assert.equal((await feed()).length, 1);
});

test("since cursor filters public-work items by task creation time", async t => {
  const fixture = serve(t);
  const { get } = await started(t, fixture);
  const { store } = fixture;
  store.roomDirectory.set(ROOM, "owner", true);
  enableTask(store, "pw-old");
  const cursor = fixture.now();
  fixture.advance(3600e3);
  enableTask(store, "pw-new");
  const all = await (await get("/api/opportunities.json")).json();
  assert.deepEqual(all.opportunities.map(o => o.taskId).sort(), ["pw-new", "pw-old"]);
  const delta = await (await get(`/api/opportunities.json?since=${cursor}`)).json();
  assert.deepEqual(delta.opportunities.map(o => o.taskId), ["pw-new"]);
});

test("withdrawn offers drop their public-work tasks from the feed", async t => {
  const fixture = serve(t);
  const { get } = await started(t, fixture);
  const { store } = fixture;
  store.roomDirectory.set(ROOM, "owner", true);
  enableTask(store, "pw-live");
  enableTask(store, "pw-withdrawn");
  store.projectOffers.transition(ROOM, "owner", "pw-withdrawn", "withdraw",
    { requestId: "withdraw-pw", expectedRevision: 2 });
  const body = await (await get("/api/opportunities.json")).json();
  assert.deepEqual(body.opportunities.map(o => o.taskId), ["pw-live"]);
});
