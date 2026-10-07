// Fail-first tests for src/supervision-client.js — the triage data layer B17 builds
// for the B7 #pr-view/triage view. Covers: pure keyboard nav (J/K/E state machine),
// client-held undo-hold timer semantics, snooze presets, the client-side card
// transition mirror, and the stubbed HTTP contract against the supervision routes
// spec (inbox-mapping.md §2.7).
import test from "node:test";
import assert from "node:assert/strict";
import {
  createSupervisionClient,
  reduceNav,
  resolveUndoDeadline,
  holdExpired,
  holdRemainingMs,
  snoozeUntil,
  isConfirmOnly,
  shouldMarkSeen,
  transitionCard,
  clampUndoWindowMs,
  CARD_KINDS,
  CARD_STATES,
  SNOOZE_PRESETS,
  DEFAULT_UNDO_WINDOW_MS,
  MAX_UNDO_WINDOW_MS,
} from "../src/supervision-client.js";

const cards = () => [
  { id: "card-a", kind: "review_request", state: "new" },
  { id: "card-b", kind: "blocked_lane", state: "seen" },
  { id: "card-c", kind: "done_receipt", state: "seen" },
];

// ---------------------------------------------------------------------------
// pure keyboard nav
// ---------------------------------------------------------------------------

test("j/k moves focus and clamps at the ends (no wrap)", () => {
  let r = reduceNav("card-a", "j", cards());
  assert.equal(r.focusedId, "card-b"); assert.equal(r.intent, null);
  r = reduceNav("card-b", "k", cards());
  assert.equal(r.focusedId, "card-a");
  r = reduceNav("card-a", "k", cards());
  assert.equal(r.focusedId, "card-a"); // clamped at top
  r = reduceNav("card-c", "j", cards());
  assert.equal(r.focusedId, "card-c"); // clamped at bottom
});

test("nav keys emit intents for the focused card", () => {
  assert.deepEqual(reduceNav("card-b", "e", cards()).intent, { type: "dismiss", cardId: "card-b" });
  assert.deepEqual(reduceNav("card-b", "1", cards()).intent, { type: "pick", cardId: "card-b", suggestionIndex: 0 });
  assert.deepEqual(reduceNav("card-b", "2", cards()).intent, { type: "pick", cardId: "card-b", suggestionIndex: 1 });
  assert.deepEqual(reduceNav("card-b", "s", cards()).intent, { type: "snooze", cardId: "card-b" });
  assert.deepEqual(reduceNav("card-b", "u", cards()).intent, { type: "retract", cardId: "card-b" });
  assert.deepEqual(reduceNav("card-b", "Escape", cards()).intent, { type: "retract", cardId: "card-b" });
  assert.deepEqual(reduceNav("card-b", "r", cards()).intent, { type: "refetch", cardId: "card-b" });
  assert.deepEqual(reduceNav("card-b", "Enter", cards()).intent, { type: "open", cardId: "card-b" });
  assert.deepEqual(reduceNav("card-b", "o", cards()).intent, { type: "open", cardId: "card-b" });
});

test("arrow keys navigate like j/k", () => {
  assert.equal(reduceNav("card-a", "ArrowDown", cards()).focusedId, "card-b");
  assert.equal(reduceNav("card-b", "ArrowUp", cards()).focusedId, "card-a");
});

test("? help works with no cards focused; other keys do nothing without cards", () => {
  const r = reduceNav(null, "?", []);
  assert.equal(r.focusedId, null); assert.deepEqual(r.intent, { type: "help" });
  const r2 = reduceNav(null, "j", []);
  assert.equal(r2.focusedId, null); assert.equal(r2.intent, null);
  const r3 = reduceNav(null, "e", []);
  assert.equal(r3.intent, null);
});

test("unknown keys change nothing and emit no intent", () => {
  const r = reduceNav("card-b", "x", cards());
  assert.equal(r.focusedId, "card-b"); assert.equal(r.intent, null);
  const r2 = reduceNav("card-b", "J", cards()); // case-sensitive: only lowercase j/k
  assert.equal(r2.intent, null);
});

test("focus is keyed by card id and survives reordering; stale focus falls back to first", () => {
  const reordered = [cards()[2], cards()[0], cards()[1]]; // [c, a, b]
  assert.equal(reduceNav("card-b", "k", reordered).focusedId, "card-a"); // id-keyed, not index-keyed
  const r = reduceNav("card-gone", "j", cards());
  assert.equal(r.focusedId, "card-a"); // stale focus re-anchors to first; the keypress is consumed
  assert.equal(r.intent, null);
});

test("single-card list: j/k stay put", () => {
  const one = [{ id: "only", kind: "needs_input", state: "new" }];
  assert.equal(reduceNav("only", "j", one).focusedId, "only");
  assert.equal(reduceNav("only", "k", one).focusedId, "only");
});

// ---------------------------------------------------------------------------
// undo window + hold timer semantics (pure)
// ---------------------------------------------------------------------------

test("undo window clamps to the 0–10s operator range", () => {
  assert.equal(clampUndoWindowMs(-5), 0);
  assert.equal(clampUndoWindowMs(0), 0);
  assert.equal(clampUndoWindowMs(6000), 6000);
  assert.equal(clampUndoWindowMs(60000), MAX_UNDO_WINDOW_MS);
  assert.equal(MAX_UNDO_WINDOW_MS, 10000);
  assert.equal(DEFAULT_UNDO_WINDOW_MS, 6000);
});

test("resolveUndoDeadline adds the clamped window to now", () => {
  assert.equal(resolveUndoDeadline(6000, 1_000_000), 1_006_000);
  assert.equal(resolveUndoDeadline(99999, 1_000_000), 1_010_000); // clamped
  assert.equal(resolveUndoDeadline(0, 1_000_000), 1_000_000);
});

test("holdExpired / holdRemainingMs are pure deadline predicates", () => {
  assert.equal(holdExpired(1_006_000, 1_005_999), false);
  assert.equal(holdExpired(1_006_000, 1_006_000), true);
  assert.equal(holdExpired(1_006_000, 1_009_000), true);
  assert.equal(holdRemainingMs(1_006_000, 1_004_500), 1500);
  assert.equal(holdRemainingMs(1_006_000, 1_006_000), 0);
  assert.equal(holdRemainingMs(1_006_000, 1_009_000), 0); // never negative
});

// ---------------------------------------------------------------------------
// snooze presets
// ---------------------------------------------------------------------------

test("snoozeUntil computes ISO deadlines for presets and passes through custom ISO", () => {
  const now = Date.UTC(2026, 9, 6, 21, 20, 0); // Tue 2026-10-06 21:20 UTC
  assert.equal(snoozeUntil("1h", now), new Date(now + 3600_000).toISOString());
  assert.equal(snoozeUntil("4h", now), new Date(now + 4 * 3600_000).toISOString());
  const tomorrow = new Date(snoozeUntil("tomorrow", now));
  assert.ok(tomorrow.getTime() > now, "tomorrow must be in the future");
  assert.equal(tomorrow.getHours(), 9); // 09:00 operator-local next day
  const custom = "2026-10-10T12:00:00.000Z";
  assert.equal(snoozeUntil(custom, now), custom);
  assert.throws(() => snoozeUntil("forever", now), /snooze preset/);
  assert.throws(() => snoozeUntil("not-a-date", now), /snooze preset/);
  assert.deepEqual(SNOOZE_PRESETS, ["1h", "4h", "tomorrow"]);
});

// ---------------------------------------------------------------------------
// suggestion gate + seen + transitions
// ---------------------------------------------------------------------------

test("isConfirmOnly reads the suggestion gate badge", () => {
  assert.equal(isConfirmOnly({ gate: "confirm_only" }), true);
  assert.equal(isConfirmOnly({ gate: "retractable" }), false);
  assert.equal(isConfirmOnly({}), false);
  assert.equal(isConfirmOnly(null), false);
});

test("shouldMarkSeen is true only for new cards", () => {
  assert.equal(shouldMarkSeen({ state: "new" }), true);
  assert.equal(shouldMarkSeen({ state: "seen" }), false);
  assert.equal(shouldMarkSeen(null), false);
});

test("transitionCard allows the documented axis-A transitions", () => {
  const t = (state, event) => transitionCard({ id: "c", state }, event).state;
  assert.equal(t("new", "seen"), "seen");
  assert.equal(t("seen", "open"), "acting");
  assert.equal(t("seen", "pick"), "pending_undo");
  assert.equal(t("acting", "pick"), "pending_undo");
  assert.equal(t("pending_undo", "retract"), "seen");
  assert.equal(t("pending_undo", "dispatch"), "dispatched");
  assert.equal(t("dispatched", "resolve"), "resolved");
  assert.equal(t("snoozed", "wake"), "seen");
  assert.equal(t("seen", "dismiss"), "dismissed");
  assert.equal(t("acting", "snooze"), "snoozed");
  assert.equal(t("seen", "stale"), "stale");
});

test("transitionCard rejects illegal transitions", () => {
  const bad = (state, event) => () => transitionCard({ id: "c", state }, event);
  assert.throws(bad("new", "retract"), /illegal transition/);
  assert.throws(bad("seen", "dispatch"), /illegal transition/);
  assert.throws(bad("dismissed", "pick"), /illegal transition/);
  assert.throws(bad("stale", "wake"), /illegal transition/);
  assert.throws(bad("resolved", "retract"), /illegal transition/);
});

test("card kind/state vocabularies match the mapping doc", () => {
  assert.deepEqual([...CARD_KINDS].sort(), ["blocked_lane", "done_receipt", "needs_input", "review_request"]);
  for (const s of ["new", "seen", "acting", "pending_undo", "dispatched", "resolved", "dismissed", "snoozed", "stale"]) {
    assert.ok(CARD_STATES.includes(s), s);
  }
});

// ---------------------------------------------------------------------------
// client: HTTP contract (stubbed request)
// ---------------------------------------------------------------------------

const stub = (handlers) => {
  const calls = [];
  const request = async (path, { method = "GET", data } = {}) => {
    calls.push({ path, method, data });
    const handler = handlers[calls.length - 1] ?? handlers.default;
    if (typeof handler === "function") return handler({ path, method, data, calls });
    return handler;
  };
  return { request, calls };
};

const base = "/api/rooms/room1/supervision";

test("listCards GETs the cards route, priority-sorted by the server", async () => {
  const { request, calls } = stub({ default: { cards: [{ id: "a" }] } });
  const client = createSupervisionClient({ roomId: "room1", request });
  const out = await client.listCards();
  assert.deepEqual(out, [{ id: "a" }]);
  assert.deepEqual(calls[0], { path: `${base}/cards`, method: "GET", data: undefined });
  const out2 = await client.listCards({ includeSnoozed: true });
  assert.deepEqual(out2, [{ id: "a" }]);
  assert.equal(calls[1].path, `${base}/cards?include=snoozed`);
});

test("focusCard journals seen exactly once per card", async () => {
  const { request, calls } = stub({ default: ({ }) => ({ id: "card-a", state: "seen" }) });
  const client = createSupervisionClient({ roomId: "room1", request });
  const seen = await client.focusCard({ id: "card-a", state: "new" });
  assert.equal(seen.state, "seen");
  assert.deepEqual(calls[0], { path: `${base}/cards/card-a/seen`, method: "POST", data: undefined });
  await client.focusCard({ id: "card-a", state: "seen" }); // already seen: no POST
  await client.focusCard({ id: "card-a", state: "new" });  // journaled once: no POST
  assert.equal(calls.length, 1);
});

test("dismiss and snooze POST the right bodies", async () => {
  const { request, calls } = stub({ default: ({ path }) => ({ id: "x", state: "ok", path }) });
  const client = createSupervisionClient({ roomId: "room1", request });
  await client.dismiss("card-a", "not relevant");
  assert.deepEqual(calls[0], { path: `${base}/cards/card-a/dismiss`, method: "POST", data: { note: "not relevant" } });
  await client.snooze("card-b", "1h");
  assert.equal(calls[1].path, `${base}/cards/card-b/snooze`);
  assert.equal(calls[1].method, "POST");
  assert.match(calls[1].data.snoozedUntil, /^\d{4}-\d{2}-\d{2}T/);
});

test("confirm POSTs {confirm:true} for confirm-only actions", async () => {
  const { request, calls } = stub({ default: { id: "card-a", state: "dispatched" } });
  const client = createSupervisionClient({ roomId: "room1", request });
  const card = await client.confirm("card-a", 0);
  assert.equal(card.state, "dispatched");
  assert.deepEqual(calls[0], { path: `${base}/cards/card-a/confirm`, method: "POST", data: { confirm: true, suggestionIndex: 0 } });
});

test("refetch POSTs and can surface a stale card", async () => {
  const { request, calls } = stub({ default: { id: "card-a", state: "stale" } });
  const client = createSupervisionClient({ roomId: "room1", request });
  const card = await client.refetch("card-a");
  assert.equal(card.state, "stale");
  assert.deepEqual(calls[0], { path: `${base}/cards/card-a/refetch`, method: "POST", data: undefined });
});

test("pick on a retractable suggestion arms the client-held undo timer", async () => {
  let now = 1_000_000;
  const scheduled = [];
  const schedule = (fn, ms) => { const h = scheduled.push({ fn, ms, cancelled: false }) - 1; return h; };
  const cancelSchedule = (h) => { scheduled[h].cancelled = true; };
  const hold = { cardId: "card-a", suggestionIndex: 0, undoDeadline: 1_006_000,
    dispatch: { method: "POST", path: "/api/rooms/room1/work-claims/c1/review", body: { verdict: "approve" } } };
  const { request, calls } = stub({ default: { card: { id: "card-a", state: "pending_undo" }, hold } });
  const client = createSupervisionClient({ roomId: "room1", request, now: () => now, schedule, cancelSchedule });
  const out = await client.pick("card-a", 0);
  assert.equal(out.card.state, "pending_undo");
  assert.equal(out.needsConfirm, false);
  assert.deepEqual(calls[0], { path: `${base}/cards/card-a/pick`, method: "POST", data: { suggestionIndex: 0 } });
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].ms, 6000); // fires at the undo deadline
  assert.deepEqual(client.getHold("card-a"), { cardId: "card-a", suggestionIndex: 0, undoDeadline: 1_006_000, remainingMs: 6000 });
});

test("retract cancels the timer and restores the card before the deadline", async () => {
  let now = 1_000_000;
  const scheduled = [];
  const schedule = (fn, ms) => scheduled.push({ fn, ms, cancelled: false }) - 1;
  const cancelSchedule = (h) => { scheduled[h].cancelled = true; };
  const hold = { cardId: "card-a", suggestionIndex: 1, undoDeadline: 1_006_000, dispatch: null };
  const responses = [
    { card: { id: "card-a", state: "pending_undo" }, hold }, // pick
    { id: "card-a", state: "seen" },                          // retract
  ];
  const { request, calls } = stub({ default: ({ calls }) => responses[calls.length - 1] });
  const client = createSupervisionClient({ roomId: "room1", request, now: () => now, schedule, cancelSchedule });
  await client.pick("card-a", 1);
  assert.equal(scheduled.length, 1);
  const card = await client.retract("card-a");
  assert.equal(card.state, "seen");
  assert.equal(scheduled[0].cancelled, true); // the held write never fires
  assert.equal(client.getHold("card-a"), null);
  assert.deepEqual(calls[1], { path: `${base}/cards/card-a/retract`, method: "POST", data: undefined });
});

test("when the hold lapses, the client fires the real write then re-reads the card", async () => {
  let now = 1_000_000;
  const scheduled = [];
  const schedule = (fn, ms) => scheduled.push({ fn, ms, cancelled: false }) - 1;
  const hold = { cardId: "card-a", suggestionIndex: 0, undoDeadline: 1_006_000,
    dispatch: { method: "POST", path: "/api/rooms/room1/work-claims/c1/review", body: { verdict: "approve" } } };
  const responses = [
    { card: { id: "card-a", state: "pending_undo" }, hold }, // pick
    { ok: true },                                            // the real write
    { id: "card-a", state: "dispatched" },                   // refetch after commit
  ];
  const { request, calls } = stub({ default: ({ calls }) => responses[calls.length - 1] });
  const client = createSupervisionClient({ roomId: "room1", request, now: () => now, schedule, cancelSchedule: () => {} });
  const out = await client.pick("card-a", 0);
  now = 1_006_001; // lapse the window
  scheduled[0].fn(); // the hold timer fires
  const committed = await out.commitPromise;
  assert.equal(committed.state, "dispatched");
  assert.deepEqual(calls[1], { path: "/api/rooms/room1/work-claims/c1/review", method: "POST", data: { verdict: "approve" } });
  assert.equal(calls[2].path, `${base}/cards/card-a/refetch`);
});

test("a confirm-only suggestion never arms a timer; it asks for explicit confirmation", async () => {
  const scheduled = [];
  const { request, calls } = stub({ default: { card: { id: "card-a", state: "acting" }, needsConfirm: true } });
  const client = createSupervisionClient({ roomId: "room1", request, schedule: (fn, ms) => scheduled.push(ms) });
  const out = await client.pick("card-a", 0);
  assert.equal(out.needsConfirm, true);
  assert.equal(out.hold, null);
  assert.equal(scheduled.length, 0); // money/merges/deploys never enter the undo window
});

test("undoWindowMs 0 commits immediately with no timer", async () => {
  const scheduled = [];
  const hold = { cardId: "card-a", suggestionIndex: 0, undoDeadline: 1_000_000,
    dispatch: { method: "POST", path: "/api/rooms/room1/x", body: {} } };
  const responses = [
    { card: { id: "card-a", state: "pending_undo" }, hold },
    { ok: true },
    { id: "card-a", state: "dispatched" },
  ];
  const { request } = stub({ default: ({ calls }) => responses[calls.length - 1] });
  const client = createSupervisionClient({ roomId: "room1", request, now: () => 1_000_000,
    schedule: (fn, ms) => scheduled.push(ms), undoWindowMs: 0 });
  const out = await client.pick("card-a", 0);
  assert.equal(scheduled.length, 0);
  assert.equal((await out.commitPromise).state, "dispatched");
});

test("a failed commit surfaces the error and clears the hold", async () => {
  const scheduled = [];
  const hold = { cardId: "card-a", suggestionIndex: 0, undoDeadline: 1_006_000,
    dispatch: { method: "POST", path: "/api/rooms/room1/x", body: {} } };
  const { request } = stub({
    default: ({ calls }) => calls.length === 1
      ? { card: { id: "card-a", state: "pending_undo" }, hold }
      : Promise.reject(Object.assign(new Error("room write failed"), { status: 500 })),
  });
  const client = createSupervisionClient({ roomId: "room1", request, now: () => 1_000_000, schedule: (fn, ms) => scheduled.push({ fn, ms }) });
  const out = await client.pick("card-a", 0);
  scheduled[0].fn(); // the hold timer fires; the room write throws
  await assert.rejects(out.commitPromise, /room write failed/);
  assert.equal(client.getHold("card-a"), null);
});

test("card ids are validated before any network call", async () => {
  const { request, calls } = stub({ default: {} });
  const client = createSupervisionClient({ roomId: "room1", request });
  await assert.rejects(client.dismiss("../evil"), /invalid card id/);
  await assert.rejects(client.pick("card-a", 5), /suggestion index/);
  await assert.rejects(client.snooze("card-a", "forever"), /snooze preset/);
  assert.equal(calls.length, 0);
});
