// B4 agent read-path: server-side events filters + compact mode (A2), the
// agent-inbox after-cursor (A3), and needs-me Board-section snippets (A3).
// The contract that matters most: with none of the new parameters present,
// the events page and the inbox are exactly the legacy responses.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { setTier } from "../server/autonomy-tiers.mjs";
import { collectNeedsMe } from "../server/needs-me.mjs";
import { createWork, claimWork, updateWork, recordCi } from "../server/work-claims.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-read-path-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED, data: {
    memberId: "agent", displayName: "Test agent", kind: "agent", permissions: ["accept_work"] } });
  setTier(store.db, "commons", "agent", "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  const agentKey = store.issueAccessKey("commons", "agent");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = (path, token = agentKey) => fetch(origin + path, {
    headers: { Origin: origin, Authorization: `Bearer ${token}` }
  });
  const post = (body, token = ownerKey) => store.command(token, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: body });
  return { store, get, post, agentKey, ownerKey };
}

test("events type filter returns only matching types, server-side", async t => {
  const { get, post } = await serve(t);
  post({ messageId: "m1", body: "one" });
  post({ messageId: "m2", body: "two" });
  const all = await (await get("/api/rooms/commons/events?after=0&limit=100")).json();
  const messagesOnly = await (await get("/api/rooms/commons/events?after=0&limit=100&type=message.posted")).json();
  assert.ok(messagesOnly.events.length >= 2);
  assert.ok(messagesOnly.events.every(({ event }) => event.type === "message.posted"));
  assert.ok(messagesOnly.events.length < all.events.length, "the log also holds member/room events");
  const membersOnly = await (await get("/api/rooms/commons/events?after=0&limit=100&type=member.added")).json();
  assert.ok(membersOnly.events.length >= 1);
  assert.ok(membersOnly.events.every(({ event }) => event.type === "member.added"));
  const both = await (await get("/api/rooms/commons/events?after=0&limit=100&type=message.posted,member.added")).json();
  assert.equal(both.events.length, messagesOnly.events.length + membersOnly.events.length);
  // The cursor contract survives filtering: next/hasMore describe the scan.
  assert.equal(messagesOnly.hasMore, false);
  assert.equal(messagesOnly.next, all.next);
});

test("events mentions filter returns only events that mention the member", async t => {
  const { get, post } = await serve(t);
  post({ messageId: "plain", body: "no mention here" });
  post({ messageId: "ask", body: "@agent can you check this?" });
  post({ messageId: "plain2", body: "another plain note" });
  const byId = await (await get("/api/rooms/commons/events?after=0&limit=100&mentions=agent")).json();
  assert.deepEqual(byId.events.map(({ event }) => event.data.messageId), ["ask"]);
  const byMe = await (await get("/api/rooms/commons/events?after=0&limit=100&mentions=me")).json();
  assert.deepEqual(byMe.events.map(({ event }) => event.data.messageId), ["ask"]);
  const nobody = await (await get("/api/rooms/commons/events?after=0&limit=100&mentions=owner")).json();
  assert.deepEqual(nobody.events, []);
});

test("events compact drops envelope noise and nothing else; default is untouched", async t => {
  const { get, post } = await serve(t);
  post({ messageId: "ask", body: "@agent can you check this?" });
  post({ messageId: "plain", body: "plain body worth keeping" });
  const legacy = await (await get("/api/rooms/commons/events?after=0&limit=100")).json();
  const compact = await (await get("/api/rooms/commons/events?after=0&limit=100&compact=1")).json();
  assert.equal(compact.events.length, legacy.events.length);
  assert.equal(compact.next, legacy.next);
  for (const [index, row] of legacy.events.entries()) {
    const shrunk = compact.events[index];
    assert.equal(shrunk.sequence, row.sequence);
    // The legacy envelope is still the default.
    assert.ok("idempotencyKey" in row.event && "roomId" in row.event);
    assert.ok(!("idempotencyKey" in shrunk.event), "compact drops the idempotency key");
    assert.ok(!("roomId" in shrunk.event), "compact drops the repeated room id");
    assert.ok(!("causationId" in shrunk.event) || shrunk.event.causationId !== null,
      "compact drops only a null causation id");
    assert.equal(shrunk.event.id, row.event.id);
    assert.equal(shrunk.event.type, row.event.type);
    assert.equal(shrunk.event.actorId, row.event.actorId);
    assert.deepEqual(shrunk.event.data, row.event.data, "compact never touches event data");
    if (row.event.mentions) {
      assert.ok(shrunk.event.mentions.every(chip => !("displayName" in chip)), "chips keep memberId/state, drop displayName");
      assert.deepEqual(shrunk.event.mentions.map(chip => chip.memberId), row.event.mentions.map(chip => chip.memberId));
    }
  }
  assert.ok(JSON.stringify(compact).length < JSON.stringify(legacy).length);
});

test("events filters refuse malformed values instead of silently ignoring them", async t => {
  const { get } = await serve(t);
  const badType = await get("/api/rooms/commons/events?type=Bad%20Type!");
  assert.equal(badType.status, 422);
  assert.equal((await badType.json()).error.code, "invalid_cursor");
  const emptyType = await get("/api/rooms/commons/events?type=");
  assert.equal(emptyType.status, 422);
  const badCompact = await get("/api/rooms/commons/events?compact=maybe");
  assert.equal(badCompact.status, 422);
  assert.equal((await badCompact.json()).error.code, "invalid_event_cursor");
  const tailMixed = await get("/api/rooms/commons/events?tail=5&type=message.posted");
  assert.equal(tailMixed.status, 422, "tail still refuses companion parameters");
});

test("agent inbox after-cursor stops re-fetching the head of the log lists", async t => {
  const { store, get, post, agentKey } = await serve(t);
  post({ messageId: "dm1", body: "first direct note", toMemberId: "agent" });
  post({ messageId: "dm2", body: "second direct note", toMemberId: "agent" });
  post({ messageId: "ask", body: "@agent a question for you" });

  const first = store.agentInbox(agentKey, "commons", { limit: 50 });
  assert.deepEqual(first.directMessages.map(row => row.messageId), ["dm2", "dm1"]);
  assert.equal(first.directMentions.length, 1);
  assert.ok(first.cursor.after >= first.directMessages[0].sequence);

  // A steady-state poll with the cursor returns neither list's head again.
  const steady = store.agentInbox(agentKey, "commons", { limit: 50, after: first.cursor.after });
  assert.deepEqual(steady.directMessages, []);
  assert.deepEqual(steady.directMentions, []);
  assert.equal(steady.cursor.after, first.cursor.after);

  // One new DM: the next poll returns exactly it and advances the cursor.
  post({ messageId: "dm3", body: "third direct note", toMemberId: "agent" });
  const next = store.agentInbox(agentKey, "commons", { limit: 50, after: first.cursor.after });
  assert.deepEqual(next.directMessages.map(row => row.messageId), ["dm3"]);
  assert.ok(next.cursor.after > first.cursor.after);

  // The HTTP route carries the same cursor; bad values are refused.
  const viaHttp = await (await get(`/api/rooms/commons/agent-inbox?after=${first.cursor.after}`)).json();
  assert.deepEqual(viaHttp.directMessages.map(row => row.messageId), ["dm3"]);
  assert.equal(viaHttp.cursor.after, next.cursor.after);
  const negative = await get("/api/rooms/commons/agent-inbox?after=-1");
  assert.equal(negative.status, 422);
  assert.equal((await negative.json()).error.code, "invalid_inbox_selection");
  const junk = await get("/api/rooms/commons/agent-inbox?after=abc");
  assert.equal(junk.status, 422);
  assert.throws(() => store.agentInbox(agentKey, "commons", { after: -1 }),
    error => error.status === 422 && error.code === "invalid_inbox_cursor");
});

test("needs-me Board sections carry a triage snippet from the claim itself", t => {
  const store = new RoomStore(":memory:", { now: () => Date.parse("2026-10-05T00:00:00Z") });
  t.after(() => store.close());
  const rooms = new AgentRooms(store);
  const owner = store.identities.create("Owen");
  const ada = store.identities.create("Ada");
  rooms.create(owner.secret, { roomId: "board", title: "board", purpose: "snippets", kind: "personal" });
  store.identities.link(owner.secret, "board", { identityId: ada.identityId, displayName: "Ada",
    permissions: ["steer", "accept_work", "complete_work", "verify"] });
  const adaId = store.db.prepare("SELECT member_id AS m FROM identity_links WHERE identity_id=? AND room_id=?")
    .get(ada.identityId, "board").m;
  const t0 = Date.parse("2026-10-05T00:00:00Z");
  const put = (id, extra = {}) => {
    const item = { ...createWork({ id, title: `Task ${id}`, ...extra }, { now: t0, agentId: owner.identityId }) };
    store.workClaims.set("board", item);
    return item;
  };

  // Open work: the snippet is the first acceptance criterion.
  put("open-crit", { acceptanceCriteria: ["Ship the read-path filters with tests", "Second criterion"] });
  // Open work with no criteria falls back to the create note.
  put("open-note", { note: "Created because the board was unreadable" });
  // Open work with neither carries no snippet key at all.
  put("open-bare");
  const open = collectNeedsMe(store, ada.secret, {}).openWork.find(section => section.roomId === "board");
  const byId = Object.fromEntries(open.top.map(row => [row.id, row]));
  assert.equal(byId["open-crit"].snippet, "Ship the read-path filters with tests");
  assert.equal(byId["open-note"].snippet, "Created because the board was unreadable");
  assert.ok(!("snippet" in byId["open-bare"]));

  // My claims: same snippet; a long criterion is clipped like other summaries.
  let mine = claimWork(put("mine-long", { acceptanceCriteria: ["x".repeat(300)] }), adaId, { now: t0 });
  mine = updateWork(mine, adaId, { state: "in_progress", now: t0 });
  store.workClaims.set("board", mine);
  const myClaims = collectNeedsMe(store, ada.secret, {}).myClaims.find(section => section.roomId === "board");
  const mineRow = myClaims.top.find(row => row.id === "mine-long");
  assert.ok(mineRow.snippet.length <= 141 && mineRow.snippet.endsWith("…"));

  // Actions needed: a CI failure row carries the snippet; a changes-requested
  // row keeps the review summary as its text (no second snippet beside it).
  let broken = claimWork(put("mine-broken", { acceptanceCriteria: ["Keep CI green"] }), adaId, { now: t0 });
  broken = updateWork(broken, adaId, { state: "in_progress", now: t0 });
  broken = recordCi(broken, { state: "failure", headSha: "c".repeat(40) }, t0).item;
  store.workClaims.set("board", broken);
  const actions = collectNeedsMe(store, ada.secret, {}).actionsNeeded.find(section => section.roomId === "board");
  const brokenRow = actions.top.find(row => row.id === "mine-broken");
  assert.equal(brokenRow.why, "ci_failed");
  assert.equal(brokenRow.snippet, "Keep CI green");
});
