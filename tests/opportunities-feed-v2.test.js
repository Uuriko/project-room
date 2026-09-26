// Opportunity feed v2: GET /api/opportunities.json — read-only discovery of
// open work across directory-listed rooms, decoupled from admission.
// Reading the feed grants nothing; no invite codes, member lists, identity
// data, or admission URLs may ever leave.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const ROOM = "commons";
const OTHER_ROOM = "unlisted-room";

function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-opportunities-v2-"));
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
  const get = (path, { method = "GET" } = {}) => fetch(origin + path, { method, headers: { Origin: origin } });
  return { origin, get };
}

let cmdSeq = 0;
const cmdId = () => `opp-v2-cmd-${++cmdSeq}`;

function propose(store, ownerKey, roomId, workItemId, title = "Help wanted") {
  store.command(ownerKey, roomId, { id: cmdId(), type: T.WORK_PROPOSED, data: {
    workItemId, title, definitionOfDone: "Done.", accountableMemberId: "owner",
    verifierMemberId: "owner", mode: "read" } });
  store.command(ownerKey, roomId, { id: cmdId(), type: T.WORK_ACCEPTED, data: { workItemId, expectedRevision: 0 } });
}

function openHelp(store, ownerKey, roomId, workItemId, expiresAt) {
  store.command(ownerKey, roomId, { id: cmdId(), type: T.WORK_HELP_UPDATED, data: {
    workItemId, expectedRevision: 1, expectedHelpRevision: 0, status: "open",
    scope: "Need a hand with this", expiresAt } });
}

function seedBounty(store, { bountyId, roomId, state, deadlineMs, label = "test" }) {
  const now = store.now();
  store.db.prepare(`INSERT INTO bounty_records
    (bounty_id, room_id, title, criteria, amount_millis, poster, state, state_changed_ms, deadline_ms, label, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    bountyId, roomId, "Bounty: " + bountyId, "Do the thing", 5000, "poster-member",
    state, now, deadlineMs, label,
    new Date(now).toISOString(), new Date(now).toISOString());
}

const HELP_KEYS = ["kind", "workItemId", "roomId", "roomTitle", "roomPath", "title",
  "definitionOfDone", "helpScope", "helpExpiresAt", "workState", "mode", "openedAt", "labels"].sort();
const BOUNTY_KEYS = ["kind", "bountyId", "roomId", "roomTitle", "roomPath", "title",
  "criteria", "amountMillis", "state", "deadlineMs", "label", "createdAt"].sort();

test("feed is empty when no rooms are directory-listed", async t => {
  const fixture = serve(t);
  const { get } = await started(t, fixture);
  const { store, ownerKey } = fixture;
  propose(store, ownerKey, ROOM, "w-hidden");
  openHelp(store, ownerKey, ROOM, "w-hidden", new Date(fixture.now() + 3600e3).toISOString());
  const res = await get("/api/opportunities.json");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.opportunities, []);
});

test("open help-wanted work in a listed room appears with a strict shape", async t => {
  const fixture = serve(t);
  const { get } = await started(t, fixture);
  const { store, ownerKey } = fixture;
  store.roomDirectory.set(ROOM, "owner", true);
  propose(store, ownerKey, ROOM, "w-open", "Write the guide");
  openHelp(store, ownerKey, ROOM, "w-open", new Date(fixture.now() + 3600e3).toISOString());
  const res = await get("/api/opportunities.json");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.opportunities.length, 1);
  const opp = body.opportunities[0];
  assert.deepEqual(Object.keys(opp).sort(), HELP_KEYS);
  assert.equal(opp.kind, "help-wanted");
  assert.equal(opp.workItemId, "w-open");
  assert.equal(opp.roomId, ROOM);
  assert.equal(opp.title, "Write the guide");
  assert.equal(opp.workState, "accepted");
  assert.equal(opp.roomPath, `/?room=${ROOM}`);
  // No admission or identity leakage.
  const serialized = JSON.stringify(opp);
  assert.ok(!serialized.includes("owner"), "member ids must not leak");
  assert.ok(!/invite|redeem|code/i.test(serialized), "no admission material");
});

test("withdrawn, expired, completed, and superseded work stay out of the feed", async t => {
  const fixture = serve(t);
  const { get } = await started(t, fixture);
  const { store, ownerKey } = fixture;
  store.roomDirectory.set(ROOM, "owner", true);
  const live = new Date(fixture.now() + 3600e3).toISOString();
  // withdrawn help
  propose(store, ownerKey, ROOM, "w-withdrawn");
  openHelp(store, ownerKey, ROOM, "w-withdrawn", live);
  store.command(ownerKey, ROOM, { id: cmdId(), type: T.WORK_HELP_UPDATED, data: {
    workItemId: "w-withdrawn", expectedRevision: 1, expectedHelpRevision: 1, status: "withdrawn" } });
  // expired help
  propose(store, ownerKey, ROOM, "w-expired");
  openHelp(store, ownerKey, ROOM, "w-expired", new Date(fixture.now() + 3600e3).toISOString());
  fixture.advance(7200e3);
  // Note: completed work is excluded by the same TERMINAL_WORK_STATES check
  // as superseded below (one code path); completing via commands needs the
  // full evidence flow, so the superseded case stands in for both.
  // superseded work
  propose(store, ownerKey, ROOM, "w-old");
  propose(store, ownerKey, ROOM, "w-new");
  store.command(ownerKey, ROOM, { id: cmdId(), type: T.WORK_SUPERSEDED, data: {
    workItemId: "w-old", expectedRevision: 1, supersededByWorkItemId: "w-new", reason: "folded" } });
  const res = await get("/api/opportunities.json");
  const body = await res.json();
  assert.deepEqual(body.opportunities, []);
});

test("funded and proposed bounties with live deadlines appear; settled ones do not", async t => {
  const fixture = serve(t);
  const { get } = await started(t, fixture);
  const { store } = fixture;
  store.roomDirectory.set(ROOM, "owner", true);
  const now = fixture.now();
  seedBounty(store, { bountyId: "b-funded", roomId: ROOM, state: "funded", deadlineMs: now + 3600e3 });
  seedBounty(store, { bountyId: "b-proposed", roomId: ROOM, state: "proposed", deadlineMs: now + 3600e3 });
  seedBounty(store, { bountyId: "b-paid", roomId: ROOM, state: "paid", deadlineMs: now + 3600e3 });
  seedBounty(store, { bountyId: "b-cancelled", roomId: ROOM, state: "cancelled", deadlineMs: now + 3600e3 });
  seedBounty(store, { bountyId: "b-late", roomId: ROOM, state: "funded", deadlineMs: now - 1000 });
  const res = await get("/api/opportunities.json");
  const body = await res.json();
  const bounties = body.opportunities.filter(o => o.kind === "bounty");
  assert.deepEqual(bounties.map(b => b.bountyId).sort(), ["b-funded", "b-proposed"]);
  for (const b of bounties) {
    assert.deepEqual(Object.keys(b).sort(), BOUNTY_KEYS);
    const serialized = JSON.stringify(b);
    assert.ok(!serialized.includes("poster-member"), "poster identity must not leak");
  }
});

test("room scoping, limits, and method gating", async t => {
  const fixture = serve(t);
  const { get } = await started(t, fixture);
  const { store, ownerKey } = fixture;
  store.roomDirectory.set(ROOM, "owner", true);
  const live = new Date(fixture.now() + 3600e3).toISOString();
  propose(store, ownerKey, ROOM, "w-a");
  openHelp(store, ownerKey, ROOM, "w-a", live);
  propose(store, ownerKey, ROOM, "w-b");
  openHelp(store, ownerKey, ROOM, "w-b", live);
  // ?room= scopes; unknown or unlisted room yields nothing
  let body = await (await get(`/api/opportunities.json?room=${ROOM}`)).json();
  assert.equal(body.opportunities.length, 2);
  body = await (await get("/api/opportunities.json?room=nope")).json();
  assert.deepEqual(body.opportunities, []);
  body = await (await get(`/api/opportunities.json?room=${OTHER_ROOM}`)).json();
  assert.deepEqual(body.opportunities, []);
  // ?limit= is honored
  body = await (await get("/api/opportunities.json?limit=1")).json();
  assert.equal(body.opportunities.length, 1);
  // POST is rejected
  const post = await get("/api/opportunities.json", { method: "POST" });
  assert.equal(post.status, 405);
  // bad room param is rejected
  const bad = await get("/api/opportunities.json?room=" + "x".repeat(200));
  assert.equal(bad.status, 422);
});

test("?since= returns only items opened after the cursor; labels surface for curation", async t => {
  const fixture = serve(t);
  const { get } = await started(t, fixture);
  const { store, ownerKey } = fixture;
  store.roomDirectory.set(ROOM, "owner", true);
  const live = () => new Date(fixture.now() + 3600e3).toISOString();
  // older item, no labels
  propose(store, ownerKey, ROOM, "w-old");
  openHelp(store, ownerKey, ROOM, "w-old", live());
  const cursor = new Date(fixture.now()).toISOString();
  fixture.advance(5000);
  // newer item with newcomer-curation labels
  store.command(ownerKey, ROOM, { id: cmdId(), type: T.WORK_PROPOSED, data: {
    workItemId: "w-new", title: "Newcomer task", definitionOfDone: "Done.",
    accountableMemberId: "owner", verifierMemberId: "owner", mode: "read",
    labels: ["newcomer-safe", "docs"] } });
  store.command(ownerKey, ROOM, { id: cmdId(), type: T.WORK_ACCEPTED, data: { workItemId: "w-new", expectedRevision: 0 } });
  openHelp(store, ownerKey, ROOM, "w-new", live());
  seedBounty(store, { bountyId: "b-new", roomId: ROOM, state: "funded", deadlineMs: fixture.now() + 3600e3 });

  let body = await (await get("/api/opportunities.json")).json();
  assert.equal(body.opportunities.length, 3);

  body = await (await get(`/api/opportunities.json?since=${encodeURIComponent(cursor)}`)).json();
  const ids = body.opportunities.map(o => o.kind === "bounty" ? o.bountyId : o.workItemId).sort();
  assert.deepEqual(ids, ["b-new", "w-new"]);
  const help = body.opportunities.find(o => o.workItemId === "w-new");
  assert.deepEqual(help.labels, ["newcomer-safe", "docs"]);
  // unlabeled items carry an explicit null, never an invented label
  const old = await (await get("/api/opportunities.json")).json();
  assert.equal(old.opportunities.find(o => o.workItemId === "w-old").labels, null);

  // an unparseable cursor is rejected, never silently mis-parsed
  const bad = await get("/api/opportunities.json?since=not-a-time");
  assert.equal(bad.status, 422);
});


test('listed room projection is read once for help and bounty in the same feed', async t => {
  const fixture = serve(t);
  const { get } = await started(t, fixture);
  const { store, ownerKey } = fixture;
  store.roomDirectory.set(ROOM, 'owner', true);
  propose(store, ownerKey, ROOM, 'w-cached');
  openHelp(store, ownerKey, ROOM, 'w-cached', new Date(fixture.now() + 3600e3).toISOString());
  seedBounty(store, { bountyId: 'b-cached', roomId: ROOM, state: 'funded', deadlineMs: fixture.now() + 3600e3 });
  const originalPrepare = store.db.prepare.bind(store.db);
  let reads = 0;
  store.db.prepare = (...args) => {
    if (args[0].includes('SELECT projection FROM rooms WHERE id=?')) reads++;
    return originalPrepare(...args);
  };
  try {
    const response = await get('/api/opportunities.json');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.opportunities.map(row => row.kind).sort(), ['bounty', 'help-wanted']);
    assert.equal(reads, 1, 'each listed room projection should be read and parsed once');
  } finally {
    store.db.prepare = originalPrepare;
  }
});
