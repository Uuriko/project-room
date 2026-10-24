// Tests for incident linkage + performance aggregate records (#3618,
// accountability R-10/R-12).
//
// What these protect:
// 1. Filed acceptance, incident half: after a seeded incident, ONE query
//    enumerates exactly the affected receipts/runs for at least two
//    selector dimensions (here: version and credential, plus room+subject
//    AND semantics), and excludes unaffected records. The link from an
//    affected record back to its incidents reads correctly, and the
//    incident open/close lifecycle is on the record.
// 2. Filed acceptance, aggregate half: the stored aggregate record for a
//    lane with known history reports rates equal to a HAND-COMPUTED fold
//    of its events (counts below are tallied by hand from the projector
//    signal rules, not by calling the code under test), with window +
//    as-of + input counts on the record so the fold is recomputable.
// 3. Derivation discipline: counts come from the projector folds — a
//    bounty.rejected contributes exactly the projector's bond_forfeited
//    signal as a rejected submission; events outside the window are not
//    counted; a subject with no judged outcomes gets null rates, never 0.
// 4. No production seams: in-memory node:sqlite, caller-owned fixtures.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  AGGREGATE_WINDOWS,
  closeIncident,
  computePerformanceAggregates,
  enumerateBySelectors,
  enumerateIncident,
  getIncident,
  getPerformanceAggregate,
  incidentsForRecord,
  linkIncident,
  listIncidents,
  listPerformanceAggregates,
  normalizeSelectors,
  openIncident,
  syncPerformanceAggregates
} from "../server/incident-records.mjs";

const DAY = 24 * 3600 * 1000;
const T0 = Date.parse("2026-09-01T00:00:00.000Z");
const iso = ms => new Date(ms).toISOString();

function makeDb() {
  const db = new DatabaseSync(":memory:");
  // Durable record sources, shaped as production writes them
  // (bounty-escrow.mjs bounty_events; store events rows read by
  // claim-reputation's journal sync).
  db.exec(`CREATE TABLE bounty_events (
    seq INTEGER PRIMARY KEY, room_id TEXT, at TEXT, type TEXT, bounty_id TEXT,
    actor_kind TEXT, actor_id TEXT, before_state TEXT, after_state TEXT, track TEXT, data TEXT);
  CREATE TABLE events (room_id TEXT, sequence INTEGER, body TEXT);`);
  return db;
}

function bountyEvent(db, seq, roomId, type, bountyId, actorId, atMs, data) {
  db.prepare("INSERT INTO bounty_events (seq, room_id, at, type, bounty_id, actor_id, data) VALUES (?,?,?,?,?,?,?)")
    .run(seq, roomId, iso(atMs), type, bountyId, actorId, JSON.stringify(data));
}
function roomEvent(db, seq, roomId, atMs, data) {
  db.prepare("INSERT INTO events (room_id, sequence, body) VALUES (?,?,?)")
    .run(roomId, seq, JSON.stringify({ type: "work_claim.updated", at: iso(atMs), data }));
}

// --- selectors ---------------------------------------------------------------

test("selectors: at least one of the four filed dimensions, nothing broader", () => {
  assert.throws(() => normalizeSelectors({}), /at least one dimension/);
  assert.throws(() => normalizeSelectors({ mood: "bad" }), /unknown selector dimension/);
  assert.throws(() => normalizeSelectors({ credential: "" }), /non-empty string/);
  assert.throws(() => normalizeSelectors("cred-1"), /must be an object/);
  // A numeric version pin normalizes to its stamped string form.
  assert.deepEqual(normalizeSelectors({ version: 2 }), { version: "2" });
  assert.deepEqual(
    normalizeSelectors({ credential: "c", version: "2", room: "r", subject: "s" }),
    { credential: "c", version: "2", room: "r", subject: "s" });
});

// --- incident lifecycle --------------------------------------------------------

test("incident record: open -> close lifecycle is on the record", () => {
  const db = makeDb();
  const opened = openIncident(db, {
    id: "inc-1", roomId: "room-a", scope: "rubric v2 misjudged a batch",
    selectors: { version: "2" }, openedBy: "operator", at: T0
  });
  assert.equal(opened.status, "open");
  assert.equal(opened.openedAt, T0);
  assert.equal(opened.closedAt, null);
  assert.deepEqual(opened.selectors, { version: "2" });
  const closed = closeIncident(db, "inc-1", { at: T0 + DAY, closedBy: "operator" });
  assert.equal(closed.status, "closed");
  assert.equal(closed.closedAt, T0 + DAY);
  assert.equal(getIncident(db, "inc-1").status, "closed");
  assert.throws(() => closeIncident(db, "inc-1", { at: T0 + 2 * DAY }), /already closed/);
  assert.throws(() => getIncident(db, "inc-nope"), /no incident record/);
  assert.equal(listIncidents(db, { status: "closed" }).length, 1);
  assert.equal(listIncidents(db, { roomId: "room-a", status: "open" }).length, 0);
  assert.throws(() => openIncident(db, { scope: "x", selectors: {} }), /at least one dimension/);
});

// --- enumeration ---------------------------------------------------------------

function seedEnumerationDb() {
  const db = makeDb();
  bountyEvent(db, 1, "room-a", "bounty.proposed", "B1", "cred-1", T0 + 1 * DAY, { rubricVersion: 2 });
  bountyEvent(db, 2, "room-a", "bounty.accepted", "B1", "cred-2", T0 + 2 * DAY, { claimant: "lane-w", rubricVersion: 2 });
  bountyEvent(db, 3, "room-a", "bounty.proposed", "B2", "cred-1", T0 + 3 * DAY, { rubricVersion: 3 });
  bountyEvent(db, 4, "room-a", "bounty.accepted", "B2", "cred-2", T0 + 4 * DAY, { claimant: "lane-w", rubricVersion: 3 });
  bountyEvent(db, 5, "room-b", "bounty.proposed", "B9", "cred-1", T0 + 5 * DAY, { rubricVersion: 2 });
  roomEvent(db, 1, "room-a", T0 + 1 * DAY, { workClaim: "wc-1", action: "claimed", claimState: "claimed", ownerId: "lane-w", rubricVersion: 2 });
  roomEvent(db, 2, "room-a", T0 + 2 * DAY, { workClaim: "wc-2", action: "claimed", claimState: "claimed", ownerId: "lane-z", rubricVersion: 3 });
  return db;
}
const ids = records => records.map(r => r.id).sort();

test("enumeration by version: exactly the runs the version touched", () => {
  const db = seedEnumerationDb();
  const got = enumerateBySelectors(db, { version: "2" });
  assert.deepEqual(ids(got), [
    "bounty_event:room-a:1", "bounty_event:room-a:2", "bounty_event:room-b:5", "room_event:room-a:1"
  ]);
});

test("enumeration by credential: exactly the runs under that credential", () => {
  const db = seedEnumerationDb();
  const got = enumerateBySelectors(db, { credential: "cred-1" });
  assert.deepEqual(ids(got), ["bounty_event:room-a:1", "bounty_event:room-a:3", "bounty_event:room-b:5"]);
  // Claim-board records attribute by their owner lane.
  assert.deepEqual(ids(enumerateBySelectors(db, { credential: "lane-z" })), ["room_event:room-a:2"]);
});

test("enumeration dimensions combine with AND (room + subject)", () => {
  const db = seedEnumerationDb();
  assert.deepEqual(ids(enumerateBySelectors(db, { room: "room-a", subject: "B2" })),
    ["bounty_event:room-a:3", "bounty_event:room-a:4"]);
  assert.deepEqual(ids(enumerateBySelectors(db, { room: "room-b", subject: "B2" })), []);
});

test("seeded incident: one query enumerates the affected receipts; the link reads back from the record", () => {
  const db = seedEnumerationDb();
  openIncident(db, {
    id: "inc-v2", roomId: "room-a", scope: "rubric v2 incident in room-a",
    selectors: { room: "room-a", version: "2" }, openedBy: "operator", at: T0 + 6 * DAY
  });
  const { matched, linked, records } = linkIncident(db, "inc-v2", { at: T0 + 6 * DAY });
  assert.equal(matched, 3);
  assert.equal(linked, 3);
  assert.deepEqual(ids(records), ["bounty_event:room-a:1", "bounty_event:room-a:2", "room_event:room-a:1"]);
  // The incident's own enumeration read returns the same set, one query.
  assert.deepEqual(ids(enumerateIncident(db, "inc-v2")), ids(records));
  // Unaffected records (version 3) carry no link.
  assert.deepEqual(incidentsForRecord(db, "bounty_event", "bounty_event:room-a:4"), []);
  // The link from the affected record's side names the incident.
  const fromRecord = incidentsForRecord(db, "bounty_event", "bounty_event:room-a:2");
  assert.equal(fromRecord.length, 1);
  assert.equal(fromRecord[0].id, "inc-v2");
  assert.equal(fromRecord[0].scope, "rubric v2 incident in room-a");
  // Re-linking is idempotent.
  assert.equal(linkIncident(db, "inc-v2", { at: T0 + 7 * DAY }).linked, 0);
});

// --- aggregates: hand-computed fold ---------------------------------------------
//
// Fixture history for room-a (all inside the 90d window ending T0+10d,
// except the one stale acceptance marked OLD):
//   lane-w: bounty.accepted x3 (submission_accepted x3)
//           bounty.rejected x1 (projector: bond_forfeited; rejected submission x1)
//           bounty.decided upheld as claimant (dispute_lost + bond_forfeited)
//           claim wc-1 done (claim_completed), claim wc-2 changes_requested (claim_judged_bad)
//   lane-c: the challenger above (dispute_won)
//   lane-v: the verifier above (acceptance_overturned)
// Hand fold for lane-w: judged = 3 + 1 + 1 = 5 -> acceptanceRate 3/5;
// disputeOutcomes = 1 -> disputeRate 1/(5+1) = 1/6; overturns 0 -> reversalRate 0/3 = 0.

const AS_OF = T0 + 10 * DAY;
function aggregateBountyEvents() {
  return [
    { seq: 1, at: iso(T0 + 1 * DAY), type: "bounty.accepted", data: { claimant: "lane-w" } },
    { seq: 2, at: iso(T0 + 2 * DAY), type: "bounty.accepted", data: { claimant: "lane-w" } },
    { seq: 3, at: iso(T0 + 3 * DAY), type: "bounty.accepted", data: { claimant: "lane-w" } },
    { seq: 4, at: iso(T0 + 4 * DAY), type: "bounty.rejected", data: { claimant: "lane-w" } },
    { seq: 5, at: iso(T0 + 5 * DAY), type: "bounty.decided",
      data: { claimant: "lane-w", challenger: "lane-c", verifier: "lane-v", outcome: "upheld" } },
    // OLD: outside the 90d window (window opens at AS_OF-90d = T0-80d).
    { seq: 6, at: iso(T0 - 100 * DAY), type: "bounty.accepted", data: { claimant: "lane-w" } }
  ];
}
function aggregateClaimRows() {
  const row = (seq, claimId, action, data = {}) =>
    ({ roomId: "room-a", seq, atMs: T0 + seq * DAY, data: { workClaim: claimId, action, ownerId: "lane-w", ...data } });
  return [
    row(1, "wc-1", "claimed", { claimState: "claimed" }),
    row(2, "wc-1", "state_changed", { claimState: "done" }),
    row(3, "wc-2", "claimed", { claimState: "claimed" }),
    row(4, "wc-2", "reviewed", { verdict: "changes_requested" })
  ];
}
const bySubject = records => new Map(records.map(r => [`${r.subjectKind}:${r.subjectId}`, r]));

test("aggregate fold: rates equal the hand-computed fold of the same events", () => {
  const records = computePerformanceAggregates({
    roomId: "room-a", bountyEvents: aggregateBountyEvents(), claimRows: aggregateClaimRows(),
    windowName: "90d", asOfMs: AS_OF
  });
  const got = bySubject(records);
  const w = got.get("agent:lane-w");
  assert.equal(w.inputs.submissionAccepted, 3); // the OLD acceptance is out of window
  assert.equal(w.inputs.submissionsRejected, 1);
  assert.equal(w.inputs.claimJudgedBad, 1);
  assert.equal(w.inputs.claimCompleted, 1);
  assert.equal(w.inputs.disputeLost, 1);
  assert.equal(w.inputs.bondForfeited, 2); // rejected + upheld-dispute slash
  assert.equal(w.inputs.judgedSubmissions, 5);
  assert.equal(w.acceptanceRate, 3 / 5);
  assert.equal(w.disputeRate, 1 / 6);
  assert.equal(w.reversalRate, 0);
  assert.equal(w.incidentCount, 0);
  // The record carries its window + as-of so the fold is recomputable.
  assert.equal(w.window, "90d");
  assert.equal(w.windowToMs, AS_OF);
  assert.equal(w.windowFromMs, AS_OF - AGGREGATE_WINDOWS["90d"]);
  assert.equal(w.asOfMs, AS_OF);

  const c = got.get("agent:lane-c");
  assert.equal(c.disputeRate, 1); // 1 dispute outcome, no judged submissions
  assert.equal(c.acceptanceRate, null); // no history -> no rate, never a fabricated 0
  assert.equal(c.reversalRate, null);

  const v = got.get("agent:lane-v");
  assert.equal(v.inputs.acceptanceOverturned, 1);
  assert.equal(v.reversalRate, 1); // 1 overturn / (0 accepted + 1 overturned)

  const room = got.get("room:room-a");
  assert.equal(room.acceptanceRate, 3 / 5);
  assert.equal(room.disputeRate, 2 / 7); // won + lost over judged + outcomes
  assert.equal(room.reversalRate, 1 / 4); // 1 overturn / (3 accepted + 1)
});

test("aggregate windows are named and bounded: a 7d window drops older fold inputs", () => {
  const records = computePerformanceAggregates({
    roomId: "room-a", bountyEvents: aggregateBountyEvents(), claimRows: aggregateClaimRows(),
    windowName: "7d", asOfMs: AS_OF
  });
  const w = bySubject(records).get("agent:lane-w");
  // 7d window opens at T0+3d: only the T0+3d acceptance, the rejection,
  // and the dispute remain (claim rows at T0+1..4d: wc-2 review at T0+4d stays).
  assert.equal(w.inputs.submissionAccepted, 1);
  assert.equal(w.inputs.submissionsRejected, 1);
  assert.equal(w.inputs.claimJudgedBad, 1);
  assert.equal(w.acceptanceRate, 1 / 3);
  assert.throws(() => computePerformanceAggregates(
    { roomId: "room-a", windowName: "1y", asOfMs: AS_OF }), /windowName must be one of/);
});

// --- aggregates: stored records via the sync path --------------------------------

test("stored aggregate records: sync materializes records whose rates match the hand fold, incident count included", () => {
  const db = makeDb();
  aggregateBountyEvents().forEach((e, i) =>
    bountyEvent(db, i + 1, "room-a", e.type, `B${i + 1}`, "cred-9", Date.parse(e.at), e.data));
  for (const r of aggregateClaimRows())
    roomEvent(db, r.seq, "room-a", r.atMs, r.data);
  // Incident over the wc-1 claim records, opened inside the window.
  openIncident(db, {
    id: "inc-wc1", roomId: "room-a", scope: "wc-1 delivery incident",
    selectors: { subject: "wc-1" }, openedBy: "operator", at: T0 + 6 * DAY
  });
  linkIncident(db, "inc-wc1", { at: T0 + 6 * DAY });

  const stored = syncPerformanceAggregates(db, { roomId: "room-a", windowName: "90d", asOfMs: AS_OF });
  const w = stored.find(r => r.subjectKind === "agent" && r.subjectId === "lane-w");
  assert.equal(w.acceptanceRate, 3 / 5);
  assert.equal(w.disputeRate, 1 / 6);
  assert.equal(w.reversalRate, 0);
  assert.equal(w.incidentCount, 1); // inc-wc1 links lane-w's wc-1 records
  assert.equal(w.window, "90d");
  assert.equal(w.asOfMs, AS_OF);
  assert.equal(w.inputs.judgedSubmissions, 5);

  const room = stored.find(r => r.subjectKind === "room");
  assert.equal(room.incidentCount, 1);
  assert.equal(room.reversalRate, 1 / 4);

  // Reading back gives the same stored record; re-sync replaces, never duplicates.
  assert.deepEqual(getPerformanceAggregate(db,
    { subjectKind: "agent", subjectId: "lane-w", roomId: "room-a", windowName: "90d" }), w);
  syncPerformanceAggregates(db, { roomId: "room-a", windowName: "90d", asOfMs: AS_OF });
  assert.equal(listPerformanceAggregates(db, { roomId: "room-a" }).length, stored.length);
  assert.equal(getPerformanceAggregate(db,
    { subjectKind: "agent", subjectId: "lane-nobody", roomId: "room-a", windowName: "90d" }), null);
});
