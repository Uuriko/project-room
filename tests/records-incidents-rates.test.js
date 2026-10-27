// Tests for #3618 (accountability R-10 / R-12): incident linkage and
// stored performance aggregates.
//
// What these protect:
// 1. ACCEPTANCE (hand-computed fold): over the seeded fixture below, the
//    stored aggregate for an agent/room reports counts and rates matching
//    a HAND-COMPUTED fold of the raw signals — the expected numbers in
//    this file are literals worked out from the fixture by hand (see the
//    arithmetic in the comments), never produced by the code under test.
// 2. ACCEPTANCE (incident enumeration): a seeded incident enumerates
//    exactly the affected set — no more, no less — per selector and as a
//    union, from records as already stored (provenance stamps included),
//    and again from the stored link journal alone.
// 3. Stored-record integrity: aggregates round-trip through SQLite and a
//    tampered rate fails the codec; re-refresh is idempotent.
// 4. No production seams: pure folds + in-memory node:sqlite only.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  createIncident, closeIncident, incidentOf, selectorOf, recordSelectorValues,
  enumerateBySelector, enumerateIncident, buildIncidentLinks, enumerateFromLinks,
  incidentCountsBySubject, ensureIncidentRecordsSchema, storeIncident, getIncident,
  listIncidents, storeIncidentLinks, listIncidentLinks, enumerateIncidentFromStore,
} from "../server/records-incidents.mjs";
import {
  AGGREGATE_WINDOWS, observationsFromBountyEvents, observationsFromClaimRows,
  computeAggregates, aggregateOf, refreshPerformanceAggregates, getAggregate, listAggregates,
} from "../server/records-performance.mjs";

const DAY = 24 * 3600 * 1000;
const AS_OF = Date.parse("2026-10-15T00:00:00.000Z");
const isoDaysAgo = days => new Date(AS_OF - days * DAY).toISOString();
const msDaysAgo = days => AS_OF - days * DAY;

const W = "id:agent/worker";
const X = "id:agent/other";
const C = "id:agent/challenger";
const V = "id:agent/verifier";
const BND = "id:agent/boundary";
const SESS = "sess_aaaaaaaaaaaaaaaaaaaaaaaa";

// --- seeded bounty fixture (room-a) -------------------------------------------
// bOld: rejected 100d ago (outside every rolling window, inside "all")
// b0:   accepted + paid, 40d/39d ago (inside 90d, outside 30d)
// b1:   accepted + paid, 20d/19d ago
// b2:   accepted 18d ago, dispute decided UPHELD 10d ago (claimant W,
//       challenger C, verifier V) -> W dispute_lost + bond_forfeited +
//       reversed + disputed; C dispute_won + disputed; V acceptancesOverturned
// b3:   rejected 15d ago (claimant W) -> W rejected + bond_forfeited
// b4:   accepted 12d ago (claimant X), refunded-timeout 11d ago -> X flaked
const bountyEventsRoomA = [
  { seq: 1, at: isoDaysAgo(100), type: "bounty.rejected", bountyId: "bOld", data: { claimant: W, reason: "bad", rejectedBy: V } },
  { seq: 2, at: isoDaysAgo(40), type: "bounty.accepted", bountyId: "b0", data: { claimant: W } },
  { seq: 3, at: isoDaysAgo(39), type: "bounty.paid", bountyId: "b0", data: { earner: W } },
  { seq: 4, at: isoDaysAgo(20), type: "bounty.accepted", bountyId: "b1", data: { claimant: W } },
  { seq: 5, at: isoDaysAgo(19), type: "bounty.paid", bountyId: "b1", data: { earner: W } },
  { seq: 6, at: isoDaysAgo(18), type: "bounty.accepted", bountyId: "b2", data: { claimant: W } },
  { seq: 7, at: isoDaysAgo(15), type: "bounty.rejected", bountyId: "b3", data: { claimant: W, reason: "bad", rejectedBy: V } },
  { seq: 8, at: isoDaysAgo(12), type: "bounty.accepted", bountyId: "b4", data: { claimant: X } },
  { seq: 9, at: isoDaysAgo(11), type: "bounty.refunded", bountyId: "b4", data: { claimant: X, reason: "timeout" } },
  { seq: 10, at: isoDaysAgo(10), type: "bounty.decided", bountyId: "b2", data: { claimant: W, challenger: C, verifier: V, outcome: "upheld", resolution: { bondForfeited: true } } },
];

// Boundary fixture (room-b): one acceptance exactly at the 30d window
// start (excluded: windows are (start, asOf]) and one exactly at asOf
// (included in every window).
const bountyEventsRoomB = [
  { seq: 1, at: isoDaysAgo(30), type: "bounty.accepted", bountyId: "bb0", data: { claimant: BND } },
  { seq: 2, at: isoDaysAgo(0), type: "bounty.accepted", bountyId: "bb1", data: { claimant: BND } },
];

// Seeded claim fixture (room-a), work_claim.updated rows for W:
// c1 claimed -9d -> done -5d (completed); c2 claimed -8d -> lease_expired
// -6d (flaked, previousOwner W); c3 claimed -7d -> reviewed
// changes_requested -4d (judgedBad).
const claimRow = (seq, claimId, action, daysAgo, data = {}) => ({
  roomId: "room-a", seq, atMs: msDaysAgo(daysAgo),
  data: { workClaim: claimId, action, claimState: "claimed", ownerId: W, ...data },
});
const claimRowsRoomA = [
  claimRow(1, "c1", "claimed", 9),
  claimRow(2, "c3", "claimed", 7),
  claimRow(3, "c2", "claimed", 8),
  claimRow(4, "c1", "state_changed", 5, { claimState: "done" }),
  claimRow(5, "c2", "lease_expired", 6, { ownerId: null, previousOwnerId: W }),
  claimRow(6, "c3", "reviewed", 4, { verdict: "changes_requested" }),
];

const allObservations = () => [
  ...observationsFromBountyEvents(bountyEventsRoomA, { roomId: "room-a" }),
  ...observationsFromBountyEvents(bountyEventsRoomB, { roomId: "room-b" }),
  ...observationsFromClaimRows(claimRowsRoomA),
];
const aggregateFor = (records, kind, id, window) =>
  records.find(r => r.subjectKind === kind && r.subjectId === id && r.window === window);

// --- R-12: the hand-computed fold ----------------------------------------------

test("hand-computed fold: worker W, 30d window", () => {
  // By hand from the fixture, 30d only:
  //   accepted 2 (b1,b2)  rejected 1 (b3)  paid 1 (b1)  completed 1 (c1)
  //   flaked 1 (c2)  judgedBad 1 (c3)  bondForfeited 2 (b2 decided, b3)
  //   disputed 1  disputeLost 1  reversed 1
  // outcomeTotal = 2+1+1+1+1+1+1 = 8
  // acceptanceRate = 2/3, reversalRate = 1/2, disputeRate = 1/8
  const records = computeAggregates(allObservations(), { asOfMs: AS_OF });
  const agg = aggregateFor(records, "agent", W, "30d");
  assert.ok(agg, "W 30d aggregate exists");
  assert.deepEqual({ ...agg.counts }, {
    accepted: 2, rejected: 1, paid: 1, completed: 1, released: 0, flaked: 1,
    judgedBad: 1, bondForfeited: 2, disputed: 1, disputeWon: 0, disputeLost: 1,
    disputeSplit: 0, reversed: 1, acceptancesOverturned: 0,
  });
  assert.equal(agg.outcomeTotal, 8);
  assert.equal(agg.rates.acceptanceRate, 2 / 3);
  assert.equal(agg.rates.reversalRate, 1 / 2);
  assert.equal(agg.rates.disputeRate, 1 / 8);
  assert.equal(agg.windowStartMs, AS_OF - 30 * DAY);
  assert.equal(agg.asOfMs, AS_OF);
  assert.equal(agg.incidentCount, 0); // no linkage supplied to the pure fold
});

test("hand-computed fold: worker W, 90d and all windows", () => {
  const records = computeAggregates(allObservations(), { asOfMs: AS_OF });
  // 90d adds b0 (accepted + paid): accepted 3, paid 2, outcomeTotal 10,
  // acceptance 3/4, reversal 1/3, dispute 1/10.
  const d90 = aggregateFor(records, "agent", W, "90d");
  assert.equal(d90.counts.accepted, 3);
  assert.equal(d90.counts.paid, 2);
  assert.equal(d90.outcomeTotal, 10);
  assert.equal(d90.rates.acceptanceRate, 3 / 4);
  assert.equal(d90.rates.reversalRate, 1 / 3);
  assert.equal(d90.rates.disputeRate, 1 / 10);
  // "all" adds bOld (rejected 100d ago): rejected 2, outcomeTotal 11,
  // acceptance 3/5, dispute 1/11; reversal unchanged at 1/3.
  const all = aggregateFor(records, "agent", W, "all");
  assert.equal(all.counts.rejected, 2);
  assert.equal(all.outcomeTotal, 11);
  assert.equal(all.rates.acceptanceRate, 3 / 5);
  assert.equal(all.rates.reversalRate, 1 / 3);
  assert.equal(all.rates.disputeRate, 1 / 11);
  assert.equal(all.windowStartMs, null);
});

test("hand-computed fold: worker W, 7d window has only the claim outcomes", () => {
  // Within 7d: c1 completed (-5d), c2 flaked (-6d), c3 judgedBad (-4d).
  // No bounty outcomes -> acceptance/reversal denominators are 0 -> null,
  // never a fabricated 0; disputeRate is a true 0/3.
  const records = computeAggregates(allObservations(), { asOfMs: AS_OF });
  const agg = aggregateFor(records, "agent", W, "7d");
  assert.equal(agg.counts.completed, 1);
  assert.equal(agg.counts.flaked, 1);
  assert.equal(agg.counts.judgedBad, 1);
  assert.equal(agg.outcomeTotal, 3);
  assert.equal(agg.rates.acceptanceRate, null);
  assert.equal(agg.rates.reversalRate, null);
  assert.equal(agg.rates.disputeRate, 0);
});

test("hand-computed fold: other agents in the fixture", () => {
  const records = computeAggregates(allObservations(), { asOfMs: AS_OF });
  // X: accepted 1 (b4), flaked 1 (timeout refund). acceptance 1/1,
  // outcomeTotal 2, dispute 0/2.
  const x = aggregateFor(records, "agent", X, "30d");
  assert.equal(x.counts.accepted, 1);
  assert.equal(x.counts.flaked, 1);
  assert.equal(x.rates.acceptanceRate, 1);
  assert.equal(x.rates.disputeRate, 0);
  // C: one disputed involvement, won. outcomeTotal = disputed 1 -> disputeRate 1.
  const c = aggregateFor(records, "agent", C, "30d");
  assert.equal(c.counts.disputed, 1);
  assert.equal(c.counts.disputeWon, 1);
  assert.equal(c.rates.disputeRate, 1);
  assert.equal(c.rates.acceptanceRate, null);
  // V: the verifier's overturned acceptance is a raw count only; it does
  // not enter V's reversal numerator or any rate denominator.
  const v = aggregateFor(records, "agent", V, "30d");
  assert.equal(v.counts.acceptancesOverturned, 1);
  assert.equal(v.counts.reversed, 0);
  assert.equal(v.outcomeTotal, 0);
  assert.equal(v.rates.disputeRate, null);
});

test("hand-computed fold: room-a aggregates are involvement sums", () => {
  const records = computeAggregates(allObservations(), { asOfMs: AS_OF });
  // 30d room-a = W + X + C + V observations in room-a:
  // accepted 3 (W2+X1), rejected 1, paid 1, completed 1, flaked 2 (W+X),
  // judgedBad 1, disputed 2 (one per decided party), bondForfeited 2,
  // reversed 1, acceptancesOverturned 1.
  // outcomeTotal = 3+1+1+1+2+1+2 = 11; acceptance 3/4; reversal 1/3; dispute 2/11.
  const room = aggregateFor(records, "room", "room-a", "30d");
  assert.deepEqual({ ...room.counts }, {
    accepted: 3, rejected: 1, paid: 1, completed: 1, released: 0, flaked: 2,
    judgedBad: 1, bondForfeited: 2, disputed: 2, disputeWon: 1, disputeLost: 1,
    disputeSplit: 0, reversed: 1, acceptancesOverturned: 1,
  });
  assert.equal(room.outcomeTotal, 11);
  assert.equal(room.rates.acceptanceRate, 3 / 4);
  assert.equal(room.rates.reversalRate, 1 / 3);
  assert.equal(room.rates.disputeRate, 2 / 11);
  // 90d room-a adds b0: accepted 4, paid 2, outcomeTotal 13,
  // acceptance 4/5, reversal 1/4, dispute 2/13.
  const room90 = aggregateFor(records, "room", "room-a", "90d");
  assert.equal(room90.outcomeTotal, 13);
  assert.equal(room90.rates.acceptanceRate, 4 / 5);
  assert.equal(room90.rates.reversalRate, 1 / 4);
  assert.equal(room90.rates.disputeRate, 2 / 13);
});

test("windows are (start, asOf]: start-exact excluded, asOf-exact included", () => {
  const records = computeAggregates(allObservations(), { asOfMs: AS_OF });
  assert.equal(aggregateFor(records, "agent", BND, "30d").counts.accepted, 1);
  assert.equal(aggregateFor(records, "agent", BND, "90d").counts.accepted, 2);
  assert.equal(aggregateFor(records, "agent", BND, "7d").counts.accepted, 1);
});

test("aggregate codec: round-trips, and a tampered stored rate fails closed", () => {
  const records = computeAggregates(allObservations(), { asOfMs: AS_OF });
  const agg = aggregateFor(records, "agent", W, "30d");
  assert.deepEqual(aggregateOf(JSON.parse(JSON.stringify(agg))), agg);
  const tampered = JSON.parse(JSON.stringify(agg));
  tampered.rates.acceptanceRate = 0.99;
  assert.throws(() => aggregateOf(tampered), /does not match its counts/);
});

test("named windows are the frozen set", () => {
  assert.deepEqual(Object.keys(AGGREGATE_WINDOWS), ["7d", "30d", "90d", "all"]);
});

// --- R-10: incident linkage + enumeration ---------------------------------------

const recordsFixture = [
  { id: "rec-1", kind: "submission", roomId: "room-a", subjectId: W,
    provenance: { sessionInstanceId: SESS, claimedModelVersion: "model-1", claimedHarnessVersion: "harness-1", authorizingPrincipalId: "human-1" } },
  { id: "rec-2", kind: "verdict", roomId: "room-a", subjectId: X, claimedModelVersion: "model-1" },
  { id: "rec-3", kind: "settlement", roomId: "room-b", subjectId: W, credentialId: "cred-9", claimedModelVersion: "model-2" },
  { id: "rec-4", kind: "submission", roomId: "room-b", subjectId: "id:agent/third", credentialId: "cred-1" },
];

test("enumeration by each selector kind returns exactly the affected set", () => {
  assert.deepEqual([...enumerateBySelector(recordsFixture, { kind: "version", value: "model-1" }).recordIds], ["rec-1", "rec-2"]);
  assert.deepEqual([...enumerateBySelector(recordsFixture, { kind: "credential", value: "cred-9" }).recordIds], ["rec-3"]);
  assert.deepEqual([...enumerateBySelector(recordsFixture, { kind: "room", value: "room-b" }).recordIds], ["rec-3", "rec-4"]);
  assert.deepEqual([...enumerateBySelector(recordsFixture, { kind: "subject", value: W }).recordIds], ["rec-1", "rec-3"]);
  // Provenance-carried values (#3612): session, claimed harness, principal.
  assert.deepEqual([...enumerateBySelector(recordsFixture, { kind: "session", value: SESS }).recordIds], ["rec-1"]);
  assert.deepEqual([...enumerateBySelector(recordsFixture, { kind: "version", value: "harness-1" }).recordIds], ["rec-1"]);
  assert.deepEqual([...enumerateBySelector(recordsFixture, { kind: "subject", value: "human-1" }).recordIds], ["rec-1"]);
  // A selector nothing carries enumerates nothing — no guessing.
  assert.deepEqual([...enumerateBySelector(recordsFixture, { kind: "version", value: "model-zzz" }).recordIds], []);
});

test("recordSelectorValues reads only fields the record already carries", () => {
  const values = recordSelectorValues(recordsFixture[0]).map(s => `${s.kind}:${s.value}`);
  assert.deepEqual(values.sort(), [
    "room:room-a", `session:${SESS}`, `subject:${W}`, "subject:human-1",
    "version:harness-1", "version:model-1",
  ].sort());
});

const seededIncident = () => createIncident({
  incidentId: "inc_seeded1", title: "model-1 produced bad work", severity: "sev2",
  openedAtMs: msDaysAgo(2), openedBy: "op-1",
  selectors: [{ kind: "version", value: "model-1" }, { kind: "subject", value: W }],
});

test("seeded incident enumerates exactly the affected set — no more, no less", () => {
  const incident = seededIncident();
  const result = enumerateIncident(recordsFixture, incident);
  // rec-1 matches both selectors, rec-2 the version, rec-3 the subject;
  // rec-4 matches nothing and must NOT appear.
  assert.deepEqual([...result.recordIds], ["rec-1", "rec-2", "rec-3"]);
  assert.deepEqual([...result.bySelector["version:model-1"]], ["rec-1", "rec-2"]);
  assert.deepEqual([...result.bySelector[`subject:${W}`]], ["rec-1", "rec-3"]);
});

test("links are an index over existing records: the records are never rewritten", () => {
  const incident = seededIncident();
  const before = JSON.stringify(recordsFixture);
  const links = buildIncidentLinks(incident, recordsFixture, { linkedAtMs: msDaysAgo(1), linkedBy: "op-1" });
  assert.equal(JSON.stringify(recordsFixture), before);
  // One link per (record, matched selector): rec-1 x2, rec-2 x1, rec-3 x1.
  assert.equal(links.length, 4);
  assert.deepEqual([...enumerateFromLinks(links, "inc_seeded1").recordIds], ["rec-1", "rec-2", "rec-3"]);
  assert.deepEqual([...enumerateFromLinks(links, "inc_other").recordIds], []);
});

test("incidentCountsBySubject counts distinct incidents per agent and room", () => {
  const links = buildIncidentLinks(seededIncident(), recordsFixture, { linkedAtMs: msDaysAgo(1), linkedBy: "op-1" });
  const counts = incidentCountsBySubject([...links], new Map(recordsFixture.map(r => [r.id, r])));
  assert.equal(counts.get(`agent:${W}`), 1); // two linked records, ONE incident
  assert.equal(counts.get(`agent:${X}`), 1);
  assert.equal(counts.get("agent:human-1"), 1);
  assert.equal(counts.get("room:room-a"), 1);
  assert.equal(counts.get("room:room-b"), 1);
  assert.equal(counts.get("agent:id:agent/third"), undefined); // rec-4 was never linked
});

test("incident codec: create/close round-trip and validation", () => {
  const incident = seededIncident();
  assert.deepEqual(incidentOf(JSON.parse(JSON.stringify(incident))), incident);
  const closed = closeIncident(incident, { closedAtMs: msDaysAgo(1), closedBy: "op-2" });
  assert.equal(closed.status, "closed");
  assert.deepEqual(incidentOf(JSON.parse(JSON.stringify(closed))), closed);
  assert.throws(() => closeIncident(closed, { closedAtMs: msDaysAgo(0), closedBy: "op-2" }), /already closed/);
  assert.throws(() => createIncident({ title: "x", openedAtMs: 0, openedBy: "op", selectors: [] }), /at least one selector/);
  assert.throws(() => selectorOf({ kind: "planet", value: "mars" }), /selector kind/);
});

// --- stored records: SQLite journal + explicit recompute refresh -----------------

test("stored incidents + links: journal round-trip, idempotent, exact enumeration", () => {
  const db = new DatabaseSync(":memory:");
  ensureIncidentRecordsSchema(db);
  const incident = seededIncident();
  storeIncident(db, incident);
  assert.deepEqual(getIncident(db, "inc_seeded1"), incident);
  const links = buildIncidentLinks(incident, recordsFixture, { linkedAtMs: msDaysAgo(1), linkedBy: "op-1" });
  assert.equal(storeIncidentLinks(db, links).linksWritten, 4);
  assert.equal(storeIncidentLinks(db, links).linksWritten, 0); // idempotent re-store
  assert.equal(listIncidentLinks(db, "inc_seeded1").length, 4);
  assert.deepEqual([...enumerateIncidentFromStore(db, "inc_seeded1").recordIds], ["rec-1", "rec-2", "rec-3"]);
  const closed = closeIncident(incident, { closedAtMs: msDaysAgo(1), closedBy: "op-2" });
  storeIncident(db, closed);
  assert.deepEqual(listIncidents(db, { status: "closed" }).map(i => i.incidentId), ["inc_seeded1"]);
  assert.deepEqual(listIncidents(db, { status: "open" }), []);
  db.close();
});

test("refresh stores aggregates with incident counts; re-refresh never double-counts", () => {
  const db = new DatabaseSync(":memory:");
  const incident = seededIncident();
  storeIncident(db, incident);
  storeIncidentLinks(db, buildIncidentLinks(incident, recordsFixture, { linkedAtMs: msDaysAgo(1), linkedBy: "op-1" }));
  const recordsById = new Map(recordsFixture.map(r => [r.id, r]));
  const refresh = () => refreshPerformanceAggregates(db, {
    bountyEventsByRoom: new Map([["room-a", bountyEventsRoomA], ["room-b", bountyEventsRoomB]]),
    claimRows: claimRowsRoomA,
    recordsById,
    asOfMs: AS_OF,
  });
  const first = refresh();
  assert.ok(first.aggregatesWritten > 0);
  // The stored record — read back, not recomputed — matches the hand fold
  // AND carries the R-10 incident count for W and room-a.
  const storedW = getAggregate(db, "agent", W, "30d");
  assert.equal(storedW.rates.acceptanceRate, 2 / 3);
  assert.equal(storedW.rates.reversalRate, 1 / 2);
  assert.equal(storedW.rates.disputeRate, 1 / 8);
  assert.equal(storedW.incidentCount, 1);
  assert.equal(getAggregate(db, "room", "room-a", "30d").incidentCount, 1);
  assert.equal(getAggregate(db, "agent", X, "30d").incidentCount, 1);
  assert.equal(getAggregate(db, "agent", C, "30d").incidentCount, 0);
  const totalAfterFirst = listAggregates(db).length;
  const second = refresh();
  assert.equal(listAggregates(db).length, totalAfterFirst);
  assert.deepEqual(getAggregate(db, "agent", W, "30d"), storedW);
  assert.equal(second.aggregates.length, first.aggregates.length);
  db.close();
});
