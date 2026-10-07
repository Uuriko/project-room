// The Summons: the room calls the agent by name.
//
// A member posts a standing, public call for capabilities the room needs.
// The summons persists. When a member advertises matching capabilities —
// the moment the room learns what an agent can do, usually minutes after
// arrival — the room answers with a public summons.called event naming them.
// Answering is a public, celebrated first act (summons.answered).
//
// Unit tests run over an in-memory SQLite database plus a minimal fake
// store (real events/rooms tables; only the store wrapper is synthetic).
// The closing test drives the whole loop over HTTP.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { applyEvent, emptyRoomState, EVENT_TYPES, event } from "../src/events.js";
import {
  SUMMONS_SCHEMA,
  SummonsInputError,
  normalizeSummonsInput,
  matchSummons,
  createSummons,
  listSummons,
  getSummons,
  answerSummons,
  withdrawSummons,
  noteCapabilitiesAdvertised,
  noteSummonsIssued,
  maybeNoteCapabilitiesAdvertised,
} from "../server/summons.mjs";

const NOW = 1_790_000_000_000;
const ROOM = "summons-room";
const OWNER = "owner_1";
const NEWBIE = "ai_newbie";

// ---- fixtures ----

function dbFixture(t) {
  const db = new DatabaseSync(":memory:");
  db.exec(SUMMONS_SCHEMA);
  db.exec(`CREATE TABLE events (room_id TEXT, sequence INTEGER, id TEXT, body TEXT)`);
  db.exec(`CREATE TABLE rooms (id TEXT PRIMARY KEY, sequence INTEGER, projection TEXT)`);
  t.after(() => db.close());
  return db;
}

function roomState() {
  const state = emptyRoomState();
  state.room = { id: ROOM, ownerId: OWNER, title: "Summons room" };
  state.members[OWNER] = { id: OWNER, displayName: "Owner", kind: "human", active: true };
  state.members[NEWBIE] = { id: NEWBIE, displayName: "Newbie", kind: "agent", active: true };
  return state;
}

// Minimal fake store: real tables, synthetic wrapper. appendRoomEvent only
// touches db, room(), now(), transaction(), storedProjection() and the
// optional agentPlugin fanout.
function storeFixture(t, state) {
  const db = dbFixture(t);
  db.prepare("INSERT INTO rooms(id, sequence, projection) VALUES(?,?,?)")
    .run(ROOM, 3, JSON.stringify({ ...state, eventLog: [], seenEvents: {}, seenIdempotencyKeys: {} }));
  return {
    db,
    now: () => NOW,
    transaction: fn => fn(),
    storedProjection: (roomId, compact) => JSON.stringify(compact),
    room: roomId => {
      assert.equal(roomId, ROOM);
      const row = db.prepare("SELECT sequence, projection FROM rooms WHERE id=?").get(roomId);
      return { state: JSON.parse(row.projection), sequence: row.sequence };
    },
    agentPlugin: null,
  };
}

const calledEvents = db =>
  db.prepare("SELECT body FROM events WHERE json_extract(body,'$.type')='summons.called'")
    .all().map(row => JSON.parse(row.body));

// ---- input validation: the board's vocabulary contract ----

test("summons labels are normalized, deduped, and validated", () => {
  const clean = normalizeSummonsInput({ labels: ["Rust", "rust", " web-review "], note: "  Port the lease guard. " });
  assert.deepEqual(clean.labels, ["rust", "web-review"]);
  assert.equal(clean.note, "Port the lease guard.");
  assert.throws(() => normalizeSummonsInput({ labels: [], note: "x" }), SummonsInputError);
  assert.throws(() => normalizeSummonsInput({ labels: Array(9).fill("rust"), note: "x" }), SummonsInputError);
  assert.throws(() => normalizeSummonsInput({ labels: ["has space"], note: "x" }), SummonsInputError);
  assert.throws(() => normalizeSummonsInput({ labels: ["bang!"], note: "x" }), SummonsInputError);
  assert.throws(() => normalizeSummonsInput({ labels: ["rust"], note: "   " }), SummonsInputError);
  assert.throws(() => normalizeSummonsInput({ labels: ["rust"], note: "x".repeat(501) }), SummonsInputError);
  assert.throws(() => normalizeSummonsInput({ note: "x" }), SummonsInputError);
  assert.throws(() => normalizeSummonsInput(null), SummonsInputError);
});

// ---- matching: an explainable filter, not a ranker ----

test("matching is a case-insensitive label intersection", () => {
  const open = [
    { id: "a", status: "open", labels: ["rust", "code-review"] },
    { id: "b", status: "open", labels: ["go"] },
    { id: "c", status: "answered", labels: ["rust"] },
  ];
  const hits = matchSummons(open, ["Rust", "  CODE-REVIEW "]);
  assert.deepEqual(hits.map(h => h.summons.id), ["a"]);
  assert.deepEqual(hits[0].matchedLabels, ["rust", "code-review"]);
  assert.deepEqual(matchSummons(open, ["cobol"]), []);
  assert.deepEqual(matchSummons(open, []), []);
  assert.deepEqual(matchSummons(open, null), []);
});

// ---- storage: the table is the source of truth ----

test("create, list, and get round-trip through the table", t => {
  const db = dbFixture(t);
  const created = createSummons(db, ROOM, { labels: ["rust"], note: "Port the lease guard" },
    { byMemberId: OWNER, now: NOW });
  assert.equal(created.roomId, ROOM);
  assert.equal(created.status, "open");
  assert.equal(created.createdBy, OWNER);
  assert.equal(created.answeredBy, null);
  assert.ok(created.id.length > 8);
  assert.equal(created.createdAt, new Date(NOW).toISOString());
  const listed = listSummons(db, ROOM);
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0], created);
  assert.deepEqual(getSummons(db, ROOM, created.id), created);
  assert.equal(getSummons(db, ROOM, "nope"), null);
  assert.deepEqual(listSummons(db, ROOM, { status: "answered" }), []);
});

test("answer drives the state machine; everything else is refused", t => {
  const db = dbFixture(t);
  const mine = createSummons(db, ROOM, { labels: ["rust"], note: "one" }, { byMemberId: OWNER, now: NOW });
  const theirs = createSummons(db, ROOM, { labels: ["go"], note: "two" }, { byMemberId: NEWBIE, now: NOW });
  const answered = answerSummons(db, ROOM, mine.id, { byMemberId: NEWBIE, now: NOW + 1000 });
  assert.equal(answered.status, "answered");
  assert.equal(answered.answeredBy, NEWBIE);
  assert.equal(answered.answeredAt, new Date(NOW + 1000).toISOString());
  assert.throws(() => answerSummons(db, ROOM, mine.id, { byMemberId: OWNER, now: NOW }), /already answered/);
  assert.throws(() => answerSummons(db, ROOM, theirs.id, { byMemberId: NEWBIE, now: NOW }), /own summons/);
  assert.throws(() => answerSummons(db, ROOM, "missing", { byMemberId: NEWBIE, now: NOW }), /not found/);
  withdrawSummons(db, ROOM, theirs.id, { byMemberId: NEWBIE, now: NOW });
  assert.throws(() => answerSummons(db, ROOM, theirs.id, { byMemberId: OWNER, now: NOW }), /not open/);
  assert.throws(() => withdrawSummons(db, ROOM, theirs.id, { byMemberId: NEWBIE, now: NOW }), /not open/);
  assert.equal(listSummons(db, ROOM).length, 0);
  assert.equal(listSummons(db, ROOM, { status: "answered" }).length, 1);
  assert.equal(listSummons(db, ROOM, { status: "withdrawn" }).length, 1);
});

// ---- the call: the room reaches out ----

test("advertising matching capabilities calls the member by name, once", t => {
  const store = storeFixture(t, roomState());
  createSummons(store.db, ROOM, { labels: ["rust"], note: "Port the lease guard" }, { byMemberId: OWNER, now: NOW });
  const call = noteCapabilitiesAdvertised(store, ROOM, NEWBIE, ["Rust", "nonsense"], { now: NOW });
  assert.ok(call, "a call was placed");
  const events = calledEvents(store.db);
  assert.equal(events.length, 1);
  const data = events[0].data;
  assert.equal(events[0].type, "summons.called");
  assert.equal(data.calledMemberId, NEWBIE);
  assert.equal(data.calledDisplayName, "Newbie");
  assert.equal(data.trigger, "capabilities_advertised");
  assert.equal(data.summons.length, 1);
  assert.deepEqual(data.summons[0].labels, ["rust"]);
  assert.equal(data.summons[0].note, "Port the lease guard");
  assert.equal(data.summons[0].summonerDisplayName, "Owner");
  // Idempotent: re-advertising never re-calls.
  assert.equal(noteCapabilitiesAdvertised(store, ROOM, NEWBIE, ["rust"], { now: NOW + 5000 }), null);
  assert.equal(calledEvents(store.db).length, 1);
});

test("no open summonses or no matching capabilities means no call", t => {
  const store = storeFixture(t, roomState());
  assert.equal(noteCapabilitiesAdvertised(store, ROOM, NEWBIE, ["rust"], { now: NOW }), null);
  createSummons(store.db, ROOM, { labels: ["rust"], note: "Port it" }, { byMemberId: OWNER, now: NOW });
  assert.equal(noteCapabilitiesAdvertised(store, ROOM, NEWBIE, ["cobol"], { now: NOW }), null);
  assert.equal(noteCapabilitiesAdvertised(store, ROOM, NEWBIE, [], { now: NOW }), null);
  assert.equal(calledEvents(store.db).length, 0);
});

test("issuing a summons calls members whose advertised capabilities match", t => {
  const state = roomState();
  state.members[NEWBIE].capabilities = ["rust"];
  const store = storeFixture(t, state);
  const summons = createSummons(store.db, ROOM, { labels: ["rust"], note: "Port it" }, { byMemberId: OWNER, now: NOW });
  const calls = noteSummonsIssued(store, ROOM, summons, { now: NOW });
  assert.equal(calls.length, 1);
  const data = calledEvents(store.db)[0].data;
  assert.equal(data.calledMemberId, NEWBIE);
  assert.equal(data.trigger, "summons_issued");
  // A member with no matching capabilities is not called.
  const state2 = roomState();
  state2.members[NEWBIE].capabilities = ["cobol"];
  const store2 = storeFixture(t, state2);
  const summons2 = createSummons(store2.db, ROOM, { labels: ["rust"], note: "Port it" }, { byMemberId: OWNER, now: NOW });
  assert.deepEqual(noteSummonsIssued(store2, ROOM, summons2, { now: NOW }), []);
  assert.equal(calledEvents(store2.db).length, 0);
});

// ---- the store.command postamble guard ----

test("the postamble only fires for a fresh capabilities.advertised command", t => {
  const db = dbFixture(t);
  let calls = 0;
  const store = { db, now: () => NOW };
  const advertised = { type: "capabilities.advertised", data: { capabilities: ["rust"] } };
  assert.equal(maybeNoteCapabilitiesAdvertised(store, ROOM, advertised, { duplicate: true, event: { actorId: NEWBIE } }), null);
  assert.equal(maybeNoteCapabilitiesAdvertised(store, ROOM, { type: "message.posted", data: {} }, { duplicate: false, event: { actorId: NEWBIE } }), null);
  assert.equal(calls, 0);
  // A fresh advertise delegates to the caller-supplied notifier.
  const store2 = { db, now: () => NOW };
  const spy = () => { calls++; return "called"; };
  assert.equal(maybeNoteCapabilitiesAdvertised(store2, ROOM, advertised, { duplicate: false, event: { actorId: NEWBIE } }, spy), "called");
  assert.equal(calls, 1);
});

// ---- event envelopes: validate-only handlers, table stays source of truth ----

test("summons event envelopes are validated by applyEvent", () => {
  const state = roomState();
  const good = event({
    id: randomUUID(), type: EVENT_TYPES.SUMMONS_CALLED, actorId: OWNER, roomId: ROOM,
    data: {
      calledMemberId: NEWBIE, calledDisplayName: "Newbie", trigger: "capabilities_advertised",
      summons: [{ id: "smn_abc123", labels: ["rust"], note: "Port it", summonerId: OWNER, createdAt: new Date(NOW).toISOString() }],
    },
  });
  const next = applyEvent(state, good);
  assert.deepEqual(next.members, state.members, "the call records nothing in the projection");
  assert.throws(() => applyEvent(state, event({
    id: randomUUID(), type: EVENT_TYPES.SUMMONS_CALLED, actorId: OWNER, roomId: ROOM,
    data: {
      calledMemberId: "ghost", trigger: "capabilities_advertised",
      summons: [{ id: "smn_abc123", labels: ["rust"], note: "Port it", summonerId: OWNER }],
    },
  })), /member/);
  assert.throws(() => applyEvent(state, event({
    id: randomUUID(), type: EVENT_TYPES.SUMMONS_ISSUED, actorId: OWNER, roomId: ROOM, data: {},
  })), /summonsId/);
  const issued = applyEvent(state, event({
    id: randomUUID(), type: EVENT_TYPES.SUMMONS_ISSUED, actorId: OWNER, roomId: ROOM,
    data: { summonsId: "smn_x", labels: ["rust"], note: "Port it" },
  }));
  assert.ok(issued);
  assert.throws(() => applyEvent(state, event({
    id: randomUUID(), type: EVENT_TYPES.SUMMONS_ANSWERED, actorId: OWNER, roomId: ROOM,
    data: { summonsId: "smn_x", summonerId: OWNER },
  })), /own summons/);
});

// ---- acceptance: the whole loop over HTTP ----

test("a summons is issued, calls the newcomer, and is answered in public", async t => {
  const { createAcceptanceFixture } = await import("../scripts/acceptance-fixture.mjs");
  const { createRoomServer } = await import("../server/http.mjs");
  const fixture = createAcceptanceFixture();
  const server = createRoomServer({ store: fixture.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fixture.store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, secret) => fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
    body: JSON.stringify(body),
  });
  const get = (path, secret) => fetch(`${origin}${path}`, {
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  });

  const owner = fixture.store.identities.create("summons owner");
  const friend = fixture.store.identities.create("summons friend");
  const roomId = "summons-loop";
  const mkRoom = await post("/api/agent-rooms", { roomId, title: "Summons", purpose: "probe", kind: "personal", displayName: "Summons" }, owner.secret);
  assert.equal(mkRoom.status, 201);
  const reqId = randomUUID();
  assert.equal((await post("/api/access-requests", {
    roomId, identityId: friend.identityId, displayName: "Friend",
    requestedPermissions: ["accept_work"], note: null, requestId: reqId,
  })).status, 201);
  const decide = await post(`/api/rooms/${roomId}/access-requests/${reqId}/decide`, {
    decision: "approve", permissions: ["accept_work"], note: null,
  }, owner.secret);
  assert.equal(decide.status, 200);
  const memberId = (await decide.json()).memberId;
  assert.ok(memberId);

  // The owner posts a standing call for a capability the room needs.
  const issued = await post(`/api/rooms/${roomId}/summons`,
    { labels: ["rust-crates"], note: "Port the lease guard to the new registry" }, owner.secret);
  assert.equal(issued.status, 201);
  const summons = await issued.json();
  assert.equal(summons.status, "open");
  assert.deepEqual(summons.labels, ["rust-crates"]);

  // The newcomer advertises what it can do; the room calls it by name.
  const advertised = await post(`/api/rooms/${roomId}/commands`, {
    id: randomUUID(), type: "capabilities.advertised", data: { capabilities: ["rust-crates"] },
  }, friend.secret);
  assert.equal(advertised.status, 201);
  const page = await (await get(`/api/rooms/${roomId}/events?after=0&limit=100`, friend.secret)).json();
  const calls = page.events.map(r => r.event).filter(e => e.type === "summons.called");
  assert.equal(calls.length, 1, "the room called exactly once");
  assert.equal(calls[0].data.calledMemberId, memberId);
  assert.equal(calls[0].data.summons[0].id, summons.id);

  // Answering is public and celebrated; the board reflects it.
  const answered = await post(`/api/rooms/${roomId}/summons/${summons.id}/answer`, {}, friend.secret);
  assert.equal(answered.status, 200);
  assert.equal((await answered.json()).status, "answered");
  const page2 = await (await get(`/api/rooms/${roomId}/events?after=0&limit=100`, friend.secret)).json();
  const celebrations = page2.events.map(r => r.event).filter(e => e.type === "summons.answered");
  assert.equal(celebrations.length, 1);
  assert.equal(celebrations[0].actorId, memberId);
  const open = await (await get(`/api/rooms/${roomId}/summons?status=open`, owner.secret)).json();
  assert.deepEqual(open.summons, []);
});
