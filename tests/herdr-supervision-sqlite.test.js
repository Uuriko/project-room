// Herdr session storage layer (server/supervision-sqlite.mjs).
//
// Contracts guarded (each answers the test-audit authoring gate):
//  1. The four additive tables are created idempotently and existing tables/rows
//     are untouched — backward-compat acceptance bar (compat-plan §1: "existing
//     behavior unchanged"; "No migrations that rewrite existing rows").
//  2. herdr_session_journal is append-only — the integrity gate. A journal that
//     could be edited would let a lane rewrite backend-switch history; the
//     store exposes no update/delete path for journal rows.
//  3. Occupant pinning: attach records a pin token; a rotated occupant rejects
//     the stale token. Groundwork for B2's OccupantChangedError — a stale
//     supervisor handle must never send to a re-occupied pane.
//  4. Claim linkage survives detach: detach marks detached_at and journals the
//     event but never deletes the row (herdr `done` != claim `done`).
//  5. Lane opt-in is the Phase B gate: unset lanes read null (not "herdr"),
//     so the gate cannot accidentally route a non-opted-in lane.
//  6. Backend health is the fail-closed evidence: consecutive failures count
//     up and last error is retained; a success resets the counter.
//  7. Schema drift fails closed ("requires operator reconciliation") instead
//     of silently reading a foreign shape; absent schema is detectable.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  herdrSessionSchema,
  createHerdrSessionStore,
  verifyHerdrSessionSchema,
  ensureHerdrSessionSchema,
  HERDR_JOURNAL_EVENTS,
  HERDR_SESSION_STATES,
} from "../server/supervision-sqlite.mjs";

const database = t => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "herdr-session-store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "room.sqlite");
};

const openStore = (t, file = database(t)) => {
  const db = new DatabaseSync(file);
  t.after(() => db.close());
  return { db, store: createHerdrSessionStore(db) };
};

test("1: the four tables are created additively; existing tables and rows are untouched", t => {
  const file = database(t);
  const db = new DatabaseSync(file);
  t.after(() => db.close());
  // Pre-existing table with a live row: the herdr schema must not touch it.
  db.exec(`CREATE TABLE IF NOT EXISTS work_claims (
    room_id TEXT NOT NULL, claim_id TEXT NOT NULL, item_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL, PRIMARY KEY (room_id, claim_id))`);
  db.prepare("INSERT INTO work_claims VALUES (?,?,?,?)").run("room1", "rc-1", "{}", 1);
  createHerdrSessionStore(db);
  for (const table of ["herdr_sessions", "herdr_session_journal", "herdr_lane_optin", "herdr_backend_state"]) {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
    assert.equal(row?.name, table, `table ${table} exists`);
  }
  // Existing row is byte-identical: no migration rewrote it.
  const row = db.prepare("SELECT * FROM work_claims").get();
  assert.deepEqual({ ...row }, { room_id: "room1", claim_id: "rc-1", item_json: "{}", updated_at: 1 });
  // Re-running the schema is idempotent (CREATE TABLE IF NOT EXISTS).
  assert.doesNotThrow(() => db.exec(herdrSessionSchema));
});

test("2: the journal is append-only — no update or delete path exists", t => {
  const { store } = openStore(t);
  store.createSession({ sessionId: "s1", roomId: "room1", forkSessionId: "fork-1", occupantToken: "tok-1",
    createDetail: { by: "bridge" } });
  store.appendJournal({ sessionId: "s1", roomId: "room1", event: "heartbeat", detail: { state: "working" } });
  assert.ok(!("updateJournal" in store) && !("deleteJournal" in store) && !("clearJournal" in store),
    "the store exposes no journal mutation path");
  const entries = store.journalFor("s1");
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map(e => e.event), ["create", "heartbeat"]);
  assert.ok(entries[0].seq < entries[1].seq, "journal rows arrive in seq order");
  assert.deepEqual(entries[0].detail, { by: "bridge" });
  assert.ok(Number.isInteger(entries[1].createdAt), "journal timestamps are integer epoch ms");
});

test("3: occupant pinning — a rotated occupant rejects the stale token", t => {
  const { store } = openStore(t);
  store.createSession({ sessionId: "s1", roomId: "room1", forkSessionId: "fork-1", occupantToken: "tok-1" });
  assert.equal(store.checkOccupant("s1", "tok-1"), true);
  assert.equal(store.checkOccupant("s1", "tok-stale"), false);
  // Re-attach (e.g. lane re-issued the claim) rotates the pin.
  store.attachSession("s1", { memberId: "jill", claimId: "rc-1", occupantToken: "tok-2" });
  assert.equal(store.checkOccupant("s1", "tok-1"), false, "the old pin no longer verifies");
  assert.equal(store.checkOccupant("s1", "tok-2"), true);
  // Unknown session: fail closed, never "valid".
  assert.equal(store.checkOccupant("nope", "tok-2"), false);
});

test("4: detach journals the event and preserves the row — herdr done is not claim done", t => {
  const { store } = openStore(t);
  store.createSession({ sessionId: "s1", roomId: "room1", forkSessionId: "fork-1", occupantToken: "tok-1" });
  store.attachSession("s1", { memberId: "jill", claimId: "rc-1", occupantToken: "tok-1" });
  store.detachSession("s1", { reason: "lane released via done" });
  const row = store.getSession("s1");
  assert.ok(row !== null, "the session row survives detach");
  assert.ok(row.detachedAt > 0, "detach is a timestamp, not a delete");
  assert.deepEqual(store.journalFor("s1").map(e => e.event), ["create", "attach", "detach"]);
  // The claim linkage is still queryable for diagnostics after detach.
  const byClaim = store.sessionForClaim("room1", "rc-1");
  assert.equal(byClaim?.sessionId, "s1");
});

test("5: lane opt-in is explicit — unset lanes read null", t => {
  const { store } = openStore(t);
  assert.equal(store.getOptIn("room1", "jill"), null, "no marker means no opt-in");
  store.setOptIn({ roomId: "room1", memberId: "jill", backend: "herdr", setBy: "jill" });
  assert.equal(store.getOptIn("room1", "jill")?.backend, "herdr");
  // Re-issue flips the marker; the lane can return to legacy.
  store.setOptIn({ roomId: "room1", memberId: "jill", backend: "legacy", setBy: "jill" });
  assert.equal(store.getOptIn("room1", "jill")?.backend, "legacy");
  assert.throws(() => store.setOptIn({ roomId: "room1", memberId: "jill", backend: "forklift", setBy: "jill" }),
    /backend/, "unknown backends are rejected");
});

test("6: backend health records fail-closed evidence", t => {
  const { store } = openStore(t);
  assert.equal(store.getHealth("room1"), null, "no health row before any report");
  store.recordHealth({ roomId: "room1", reachable: false, error: { code: "timeout", detail: "2s" } });
  store.recordHealth({ roomId: "room1", reachable: false, error: { code: "timeout", detail: "2s" } });
  const down = store.getHealth("room1");
  assert.equal(down.reachable, 0);
  assert.equal(down.consecutiveFailures, 2);
  assert.deepEqual(down.lastError, { code: "timeout", detail: "2s" });
  store.recordHealth({ roomId: "room1", reachable: true });
  const up = store.getHealth("room1");
  assert.equal(up.reachable, 1);
  assert.equal(up.consecutiveFailures, 0, "a success resets the failure counter");
});

test("7: schema drift fails closed; absent schema is detectable", t => {
  const file = database(t);
  const empty = new DatabaseSync(file);
  t.after(() => empty.close());
  // Absent schema is detectable for the RoomStore stamp-style check.
  assert.equal(verifyHerdrSessionSchema(empty, { allowAbsent: true }), false);
  // Ensuring creates and verifies.
  ensureHerdrSessionSchema(empty);
  assert.equal(verifyHerdrSessionSchema(empty), true);
  // Constructing on a present schema also verifies.
  assert.equal(createHerdrSessionStore(empty).verifySchema(), true);
  // Drift: a table with a foreign shape fails closed.
  const drifted = new DatabaseSync(":memory:");
  t.after(() => drifted.close());
  drifted.exec("CREATE TABLE herdr_sessions (id TEXT PRIMARY KEY)");
  assert.throws(() => verifyHerdrSessionSchema(drifted), /requires operator reconciliation/);
  assert.throws(() => verifyHerdrSessionSchema(drifted, { allowAbsent: true }), /requires operator reconciliation/);
});

test("8: journal event vocabulary is closed", t => {
  const { store } = openStore(t);
  store.createSession({ sessionId: "s1", roomId: "room1", forkSessionId: "fork-1", occupantToken: "tok-1" });
  assert.deepEqual([...HERDR_JOURNAL_EVENTS].sort(), ["attach", "create", "detach", "fallback", "heartbeat"]);
  assert.ok(HERDR_SESSION_STATES.includes("unknown"));
  assert.throws(
    () => store.appendJournal({ sessionId: "s1", roomId: "room1", event: "state_report", detail: {} }),
    /event/, "events outside the five break the integrity-gate vocabulary");
  store.reportSessionState("s1", "working", { by: "reportState" });
  assert.equal(store.getSession("s1").state, "working");
  assert.throws(() => store.reportSessionState("s1", "vibing"), /state/, "unknown states are rejected");
});

test("9: heartbeat updates the row and journals; fallback journaling captures degradation", t => {
  const { store } = openStore(t);
  store.createSession({ sessionId: "s1", roomId: "room1", forkSessionId: "fork-1", occupantToken: "tok-1" });
  store.heartbeat("s1", { state: "working" });
  const row = store.getSession("s1");
  assert.ok(row.lastHeartbeatAt > 0);
  assert.equal(row.state, "working");
  store.appendJournal({ sessionId: "s1", roomId: "room1", event: "fallback",
    detail: { from: "herdr", to: "legacy", reason: "broker unreachable" } });
  const events = store.journalFor("s1").map(e => e.event);
  assert.deepEqual(events, ["create", "heartbeat", "fallback"]);
});

test("10: session lookup shapes match the adapter handle linkage", t => {
  const { store } = openStore(t);
  store.createSession({ sessionId: "s1", roomId: "room1", forkSessionId: "fork-abc", occupantToken: "tok-1",
    memberId: "jill", claimId: "rc-1" });
  assert.equal(store.getByForkSessionId("fork-abc")?.sessionId, "s1");
  assert.equal(store.sessionForClaim("room1", "rc-1")?.forkSessionId, "fork-abc");
  assert.deepEqual(store.listActive("room1").map(s => s.sessionId), ["s1"]);
  assert.deepEqual(store.listByMember("room1", "jill").map(s => s.sessionId), ["s1"]);
  // A legacy-backend row carries the marker but never gains herdr linkage.
  store.createSession({ sessionId: "s2", roomId: "room1", forkSessionId: "fork-legacy-1",
    occupantToken: "tok-2", backend: "legacy" });
  assert.equal(store.getSession("s2").backend, "legacy");
});

// Contracts guarded (each answers the test-audit authoring gate):
//  11. Card dedupe: the same event re-ticked never spawns a second card —
//      the UNIQUE(room_id, operator_id, kind, claim_id, source_seq) key is the
//      re-derivation guard, and re-ticks refresh the excerpt, never the state.
//  12. Card transitions journal the state machine; nothing is ever deleted —
//      dismiss is a state, the history table is append-only, and unknown
//      states/cards fail closed.
//  13. listCards visibility: un-woken snoozed cards stay hidden by default,
//      delta fetch is driven by updated_at, ordering is priority-desc.
//  14. Card field validation fails closed (id shape, kind/state enums,
//      priority range, summary length, suggested shape).
//  15. updateCardFields maintains the pick-flow fields (picked_action,
//      undo_deadline, undoable) with an allowlist — no arbitrary column
//      writes from the API layer.
const cardBase = (overrides = {}) => ({
  id: "tc_11111111-1111-4111-8111-111111111111",
  roomId: "room1",
  operatorId: "jill",
  kind: "review_request",
  actorId: "grokbot",
  actorLabel: "Grok Bot",
  claimId: "rc-9",
  priority: 80,
  sourceSeq: 6142,
  sourceType: "REVIEW_REQUESTED",
  summary: "review requested on rc-9",
  suggested: [{ rank: 1, label: "Approve", actionType: "review_verdict", gate: "retractable", payload: {}, reason: "ci green" }],
  ...overrides,
});

test("11: the same event re-ticked never spawns a second card", t => {
  const { store } = openStore(t);
  const first = store.upsertCard(cardBase());
  assert.equal(first.created, true);
  assert.equal(first.card.state, "new");
  const second = store.upsertCard(cardBase({
    id: "tc_22222222-2222-4222-8222-222222222222",
    summary: "review requested on rc-9 (refreshed)",
    priority: 85,
  }));
  assert.equal(second.created, false);
  assert.equal(second.card.id, first.card.id, "re-tick returns the existing card, not a new row");
  assert.equal(second.card.summary, "review requested on rc-9 (refreshed)", "excerpt refreshes");
  assert.equal(second.card.priority, 85);
  assert.equal(second.card.state, "new", "re-derivation never moves the state");
  assert.equal(store.listCards("room1", "jill").length, 1);
});

test("12: transitions journal the state machine; nothing is ever deleted", t => {
  const { store } = openStore(t);
  const { card } = store.upsertCard(cardBase());
  const seen = store.transitionCard(card.id, "seen", { by: "jill" });
  assert.equal(seen.state, "seen");
  store.transitionCard(card.id, "dismissed", { by: "jill", note: "deferred" });
  assert.equal(store.getCard(card.id).state, "dismissed");
  const history = store.cardHistory(card.id);
  assert.deepEqual(history.map(h => [h.fromState, h.toState]), [["new", "seen"], ["seen", "dismissed"]]);
  assert.equal(history[0].by, "jill");
  assert.equal(history[1].note, "deferred");
  assert.ok(history[0].seq < history[1].seq);
  assert.ok(!("deleteCard" in store), "dismiss is a state, never a delete");
  assert.throws(() => store.transitionCard(card.id, "vibing", { by: "jill" }), /state/,
    "unknown card states fail closed");
  assert.throws(() => store.transitionCard("tc_99999999-9999-4999-8999-999999999999", "seen", { by: "jill" }),
    /unknown card/, "transitions on unknown cards fail closed");
});

test("13: listCards hides un-woken snoozed cards and supports delta fetch", t => {
  let fakeNow = 1_000_000;
  const file = database(t);
  const db = new DatabaseSync(file);
  t.after(() => db.close());
  const store = createHerdrSessionStore(db, { now: () => fakeNow });
  const mk = (id, extra = {}) => store.upsertCard(cardBase({
    id, kind: "done_receipt", priority: 10, sourceSeq: 1, sourceType: "WORK_COMPLETED",
    summary: "done", suggested: [], ...extra,
  })).card;
  const a = mk("tc_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", { sourceSeq: 1 });
  fakeNow += 1000;
  const b = mk("tc_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", { priority: 90, sourceSeq: 2 });
  store.transitionCard(b.id, "snoozed", { by: "jill" });
  store.updateCardFields(b.id, { snoozedUntil: fakeNow + 3_600_000 });
  assert.deepEqual(store.listCards("room1", "jill").map(c => c.id), [a.id],
    "a snoozed card whose snoozed_until is in the future stays hidden");
  assert.deepEqual(store.listCards("room1", "jill", { includeSnoozed: true }).map(c => c.id), [b.id, a.id],
    "opt-in shows snoozed cards, still priority-desc");
  assert.deepEqual(store.listCards("room1", "jill", { since: a.updatedAt, includeSnoozed: true }).map(c => c.id), [b.id],
    "delta fetch returns only rows updated after since");
  // Woken snoozed cards (snoozed_until in the past) reappear without a state write.
  fakeNow += 4_000_000;
  assert.deepEqual(store.listCards("room1", "jill").map(c => c.id), [b.id, a.id]);
});

test("14: card field validation fails closed", t => {
  const { store } = openStore(t);
  assert.throws(() => store.upsertCard(cardBase({ id: "nope" })), /tc_/, "card ids are tc_<uuid>");
  assert.throws(() => store.upsertCard(cardBase({ kind: "vibing" })), /kind/);
  assert.throws(() => store.upsertCard(cardBase({ priority: 101 })), /priority/);
  assert.throws(() => store.upsertCard(cardBase({ priority: -1 })), /priority/);
  assert.throws(() => store.upsertCard(cardBase({ summary: "x".repeat(141) })), /summary/);
  assert.throws(() => store.upsertCard(cardBase({ reviewVerdict: "maybe" })), /verdict/);
  assert.throws(() => store.upsertCard(cardBase({ suggested: "not-an-array" })), /suggested/);
  assert.throws(() => store.upsertCard(cardBase({ suggested: [{}, {}, {}] })), /suggested/,
    "at most two suggestions per card");
});

test("15: updateCardFields maintains the pick-flow fields through an allowlist", t => {
  const { store } = openStore(t);
  const { card } = store.upsertCard(cardBase());
  const updated = store.updateCardFields(card.id, {
    pickedAction: { label: "Approve", payload: {} },
    undoable: true,
    undoDeadline: 1_234_567,
  });
  assert.deepEqual(updated.pickedAction, { label: "Approve", payload: {} });
  assert.equal(updated.undoable, true);
  assert.equal(updated.undoDeadline, 1_234_567);
  const dismissed = store.updateCardFields(card.id, { receipt: "posted", reviewVerdict: "approve" });
  assert.equal(dismissed.receipt, "posted");
  assert.equal(dismissed.reviewVerdict, "approve");
  assert.throws(() => store.updateCardFields(card.id, { bogus: 1 }), /not updatable/,
    "no arbitrary column writes from the API layer");
  assert.throws(() => store.updateCardFields(card.id, { priority: 500 }), /priority/);
  assert.throws(() => store.updateCardFields("tc_99999999-9999-4999-8999-999999999999", { receipt: "x" }),
    /unknown card/);
  assert.throws(() => store.updateCardFields(card.id, {}), /at least one field/);
});
