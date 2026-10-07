// Supervision routes (herdr redesign lane B6): the 9 routes under
// /api/rooms/{roomId}/supervision/cards* (server/supervision-routes.mjs).
//
// Authoring-gate answers (repo test-audit skill):
// 1. Protects the HTTP contract: caller-scoped cards (an agent can never
//    touch another lane's card), retract-before/after-deadline, confirm-only
//    refusal without {confirm:true}, stale-on-refetch, snoozed opt-in.
// 2. Credible regressions: a route clearing another member's card (auth
//    bypass), pick recording an intent without an undo deadline, confirm
//    firing on {confirm:false}, refetch resurrecting a resolved source.
// 3. Existing coverage: tests/supervision.test.js owns the pure module only;
//    this file owns the transport/auth/lifecycle layer the pure module cannot
//    reach. Distinct risk, distinct owner.
// 4. Production seam: the SupervisionCardStore injection (B5's
//    server/supervision-sqlite.mjs has not landed) is a real seam the
//    integration lane will fill; the in-memory double implements the
//    contract documented in supervision-routes.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";

import { handleSupervisionRoutes } from "../server/supervision-routes.mjs";

const NOW = 1_789_000_000_000;
const ROOM = "room-1";
const OP = "member-op";
const OTHER = "member-other";

const TERMINAL = new Set(["dispatched", "resolved", "dismissed", "stale"]);

// In-memory double of the storage contract documented at the top of
// server/supervision-routes.mjs (B5's server/supervision-sqlite.mjs will
// provide the real one). Same upsert rule: never downgrade triaged state.
function makeMemoryStore() {
  const rows = new Map();
  const journalRows = [];
  const key = (r, m, c) => `${r}|${m}|${c}`;
  return {
    upsertCard(roomId, memberId, card) {
      const k = key(roomId, memberId, card.id);
      const existing = rows.get(k);
      if (existing && TERMINAL.has(existing.state)) return existing;
      rows.set(k, card);
      return card;
    },
    getCard(roomId, memberId, cardId) {
      return rows.get(key(roomId, memberId, cardId)) ?? null;
    },
    listCards(roomId, memberId, { includeSnoozed = false } = {}) {
      return [...rows.values()].filter(c =>
        c.roomId === roomId && c.memberId === memberId
        && (includeSnoozed || c.state !== "snoozed")
        && !TERMINAL.has(c.state));
    },
    journal(roomId, memberId, cardId, entry) {
      journalRows.push({ roomId, memberId, cardId, ...entry });
    },
    history(roomId, memberId, cardId) {
      return journalRows.filter(j => j.cardId === cardId);
    },
  };
}

const sourcesFor = (over = {}) => ({
  claims: [],
  messages: [],
  replyRequests: [],
  routerHints: new Map(),
  nextClaimFor: () => null,
  ...over,
});

// Minimal HTTP harness: json records, reject throws (tests catch), body
// returns the request's preloaded payload.
function harness({ store, sources, memberId = OP, nowMs = NOW, decide = null } = {}) {
  const sent = [];
  const rejected = [];
  const helpers = {
    json: (res, status, obj) => { sent.push({ status, obj }); return obj; },
    reject: (status, code, message) => {
      const err = new Error(message);
      err.status = status; err.code = code; rejected.push(err); throw err;
    },
    body: async req => req._body ?? {},
  };
  const call = async ({ method, route, cardId = null, bodyData = {}, query = {} }) => {
    const req = { method, _body: bodyData };
    const res = {};
    const url = { pathname: "", searchParams: new URLSearchParams(query) };
    const auth = memberId === null ? null : { member: { id: memberId } };
    try {
      await handleSupervisionRoutes({
        req, res, url, roomId: ROOM, auth,
        supervisionRoute: route, cardId,
        helpers,
        deps: { store, sources, nowMs, decide },
      });
    } catch (err) {
      if (err.status === undefined) throw err; // real bug, not a rejection
    }
    return { sent, rejected };
  };
  return { call, sent, rejected };
}

const blockedClaim = (over = {}) => ({
  id: "claim-1", title: "Fix the router", state: "blocked", owner: OP,
  reviewers: [], reviewPolicy: "self_attested", pullRequest: null, headSha: null,
  ciState: null, failingChecks: [], deliveryMode: null, note: "need the API key",
  completedAtMs: null, revision: 1, reviews: [], dependsOn: [], files: [],
  ...over,
});

async function deriveOne(h, overrides = {}) {
  const { call } = h;
  await call({ method: "POST", route: "derive" });
  return h.sent.at(-1).obj.cards[0];
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

test("GET /cards requires authentication", async () => {
  const h = harness({ store: makeMemoryStore(), sources: sourcesFor(), memberId: null });
  const { rejected } = await h.call({ method: "GET", route: "list" });
  assert.equal(rejected[0].status, 401);
});

test("GET /cards lists active cards priority-sorted with live suggestions", async () => {
  const store = makeMemoryStore();
  const sources = sourcesFor({ claims: [blockedClaim()] });
  const h = harness({ store, sources });
  await h.call({ method: "POST", route: "derive" });
  const { sent } = await h.call({ method: "GET", route: "list" });
  const { cards } = sent.at(-1).obj;
  assert.equal(cards.length, 1);
  assert.equal(cards[0].kind, "blocked_lane");
  assert.ok(cards[0].suggestions.length <= 2);
  assert.ok(cards[0].suggestions.every(s => typeof s.reason === "string"));
});

test("GET /cards hides snoozed cards unless include=snoozed", async () => {
  const store = makeMemoryStore();
  const h = harness({ store, sources: sourcesFor({ claims: [blockedClaim()] }) });
  const card = await deriveOne(h);
  await h.call({ method: "POST", route: "snooze", cardId: card.id, bodyData: { snoozeFor: "1h" } });
  const before = await h.call({ method: "GET", route: "list" });
  assert.equal(before.sent.at(-1).obj.cards.length, 0);
  const after = await h.call({ method: "GET", route: "list", query: { include: "snoozed" } });
  assert.equal(after.sent.at(-1).obj.cards.length, 1);
});

// ---------------------------------------------------------------------------
// derive (internal roll-up)
// ---------------------------------------------------------------------------

test("POST /cards derives from the event tail and dedupes on re-run", async () => {
  const store = makeMemoryStore();
  const h = harness({ store, sources: sourcesFor({ claims: [blockedClaim()] }) });
  const first = await h.call({ method: "POST", route: "derive" });
  assert.equal(first.sent.at(-1).obj.derived, 1);
  const second = await h.call({ method: "POST", route: "derive" });
  assert.equal(second.sent.at(-1).obj.derived, 0); // same dedupe key, still active → no new card
  assert.equal(second.sent.at(-1).obj.cards.length, 1);
});

// ---------------------------------------------------------------------------
// caller scoping — agents can never touch another lane's cards
// ---------------------------------------------------------------------------

test("a member cannot read, see, or act on another member's card", async () => {
  const store = makeMemoryStore();
  const sources = sourcesFor({ claims: [blockedClaim()] });
  const owner = harness({ store, sources, memberId: OP });
  const card = await deriveOne(owner);
  const intruder = harness({ store, sources, memberId: OTHER });
  const seen = await intruder.call({ method: "POST", route: "seen", cardId: card.id });
  assert.equal(seen.rejected[0].status, 404);
  const picked = await intruder.call({ method: "POST", route: "pick", cardId: card.id, bodyData: { suggestionIndex: 1 } });
  assert.equal(picked.rejected[0].status, 404);
  const dismissed = await intruder.call({ method: "POST", route: "dismiss", cardId: card.id });
  assert.equal(dismissed.rejected[0].status, 404);
});

// ---------------------------------------------------------------------------
// seen / pick / retract — the pre-dispatch hold
// ---------------------------------------------------------------------------

test("POST /cards/{id}/seen moves new → seen", async () => {
  const h = harness({ store: makeMemoryStore(), sources: sourcesFor({ claims: [blockedClaim()] }) });
  const card = await deriveOne(h);
  const { sent } = await h.call({ method: "POST", route: "seen", cardId: card.id });
  assert.equal(sent.at(-1).obj.card.state, "seen");
});

test("pick records pending_undo with an undo deadline; retract before it returns to seen", async () => {
  const store = makeMemoryStore();
  let nowMs = NOW;
  const sources = sourcesFor({ claims: [blockedClaim()] });
  const mk = () => harness({ store, sources, nowMs });
  const card = await deriveOne(mk());
  await mk().call({ method: "POST", route: "seen", cardId: card.id });
  const picked = await mk().call({
    method: "POST", route: "pick", cardId: card.id,
    bodyData: { suggestionIndex: 1 },
  });
  const pickedCard = picked.sent.at(-1).obj.card;
  assert.equal(pickedCard.state, "pending_undo");
  assert.equal(pickedCard.undoDeadlineMs, NOW + 6000);
  assert.ok(picked.sent.at(-1).obj.intent.journaled);
  nowMs = NOW + 3000; // still inside the window
  const retracted = await mk().call({ method: "POST", route: "retract", cardId: card.id });
  assert.equal(retracted.sent.at(-1).obj.card.state, "seen");
});

test("retract after the deadline is rejected with 409 — the write already fired", async () => {
  const store = makeMemoryStore();
  let nowMs = NOW;
  const sources = sourcesFor({ claims: [blockedClaim()] });
  const mk = () => harness({ store, sources, nowMs });
  const card = await deriveOne(mk());
  await mk().call({ method: "POST", route: "seen", cardId: card.id });
  await mk().call({ method: "POST", route: "pick", cardId: card.id, bodyData: { suggestionIndex: 1 } });
  nowMs = NOW + 7000; // window lapsed
  const { rejected } = await mk().call({ method: "POST", route: "retract", cardId: card.id });
  assert.equal(rejected[0].status, 409);
  assert.equal(rejected[0].code, "undo_expired");
});

test("pick validates the suggestion index", async () => {
  const h = harness({ store: makeMemoryStore(), sources: sourcesFor({ claims: [blockedClaim()] }) });
  const card = await deriveOne(h);
  await h.call({ method: "POST", route: "seen", cardId: card.id });
  const { rejected } = await h.call({
    method: "POST", route: "pick", cardId: card.id, bodyData: { suggestionIndex: 9 },
  });
  assert.equal(rejected[0].status, 422);
});

// ---------------------------------------------------------------------------
// confirm — confirm-only class (money/merges/deploys/permission changes)
// ---------------------------------------------------------------------------

test("pick on a confirm-gated suggestion returns a challenge; confirm requires {confirm:true}", async () => {
  const store = makeMemoryStore();
  const sources = sourcesFor({ claims: [blockedClaim()] });
  // The v1 decider never suggests confirm-class actions (money/merges/deploys
  // are never draft suggestions), so the integration seam `deps.decide` stands
  // in for a future decider rule here — the route's confirm gate is the thing
  // under test, and the seam is the integration lane's documented extension
  // point for confirm-class suggestions.
  const confirmSuggestion = {
    id: "s1", index: 1, kind: "release_grant", title: "Release the grant",
    reason: "confirm-class action: cannot be undone", gate: "confirm",
    api: { method: "POST", path: `/api/rooms/${ROOM}/grants/g1/release`, body: {} },
    deepLink: null, draft: null, badge: "⚠ confirm — cannot be undone",
  };
  const h = harness({ store, sources, decide: () => [confirmSuggestion] });
  const card = await deriveOne(h);
  const challenged = await h.call({
    method: "POST", route: "pick", cardId: card.id,
    bodyData: { suggestionIndex: 1 },
  });
  assert.equal(challenged.sent.at(-1).obj.requiresConfirm, true);
  assert.equal(challenged.sent.at(-1).obj.card.state, "acting");
  const refused = await h.call({
    method: "POST", route: "confirm", cardId: card.id, bodyData: { confirm: false },
  });
  assert.equal(refused.rejected[0].status, 422);
  assert.equal(refused.rejected[0].code, "confirmation_required");
  const confirmed = await h.call({
    method: "POST", route: "confirm", cardId: card.id, bodyData: { confirm: true },
  });
  assert.equal(confirmed.sent.at(-1).obj.confirmed, true);
  assert.equal(confirmed.sent.at(-1).obj.card.state, "pending_undo");
  assert.equal(confirmed.sent.at(-1).obj.card.undoDeadlineMs, NOW); // zero-second window
});

// ---------------------------------------------------------------------------
// dismiss / snooze — audit, never delete
// ---------------------------------------------------------------------------

test("dismiss records the note and keeps the card in the journal (audit, never delete)", async () => {
  const store = makeMemoryStore();
  const h = harness({ store, sources: sourcesFor({ claims: [blockedClaim()] }) });
  const card = await deriveOne(h);
  const { sent } = await h.call({
    method: "POST", route: "dismiss", cardId: card.id, bodyData: { note: "not my lane" },
  });
  assert.equal(sent.at(-1).obj.card.state, "dismissed");
  const history = store.history(ROOM, OP, card.id);
  assert.ok(history.some(e => e.to === "dismissed" && e.note === "not my lane"));
  const listed = await h.call({ method: "GET", route: "list" });
  assert.equal(listed.sent.at(-1).obj.cards.length, 0); // out of the active queue
});

test("snooze accepts 1h/4h/tomorrow/custom and rejects the past", async () => {
  const store = makeMemoryStore();
  const h = harness({ store, sources: sourcesFor({ claims: [blockedClaim()] }) });
  const card = await deriveOne(h);
  const { sent } = await h.call({
    method: "POST", route: "snooze", cardId: card.id, bodyData: { snoozeFor: "4h" },
  });
  assert.equal(sent.at(-1).obj.card.snoozedUntilMs, NOW + 4 * 3600_000);
  // A fresh card for the invalid case (snooze-from-snoozed is 409 illegal,
  // tested at the pure boundary).
  const card2 = await deriveOne(harness({ store, sources: sourcesFor({ claims: [blockedClaim({ id: "claim-9" })] }) }));
  const bad = await h.call({
    method: "POST", route: "snooze", cardId: card2.id, bodyData: { untilMs: NOW - 1 },
  });
  assert.equal(bad.rejected.at(-1).status, 422);
});

// ---------------------------------------------------------------------------
// refetch — stale-on-refetch (notification ≠ truth)
// ---------------------------------------------------------------------------

test("refetch retires the card as stale when the source claim is no longer blocked", async () => {
  const store = makeMemoryStore();
  const sources = sourcesFor({ claims: [blockedClaim()] });
  const h = harness({ store, sources });
  const card = await deriveOne(h);
  sources.claims = [blockedClaim({ state: "claimed" })]; // unblocked elsewhere
  const { sent } = await h.call({ method: "POST", route: "refetch", cardId: card.id });
  assert.equal(sent.at(-1).obj.stale, true);
  assert.equal(sent.at(-1).obj.card.state, "stale");
});

test("refetch keeps the card live when the source state still holds", async () => {
  const store = makeMemoryStore();
  const h = harness({ store, sources: sourcesFor({ claims: [blockedClaim()] }) });
  const card = await deriveOne(h);
  const { sent } = await h.call({ method: "POST", route: "refetch", cardId: card.id });
  assert.equal(sent.at(-1).obj.stale, false);
  assert.equal(sent.at(-1).obj.card.state, "new");
});

test("refetch with {fired:true} marks a lapsed pending_undo as dispatched", async () => {
  const store = makeMemoryStore();
  let nowMs = NOW;
  const sources = sourcesFor({ claims: [blockedClaim()] });
  const mk = () => harness({ store, sources, nowMs });
  const card = await deriveOne(mk());
  await mk().call({ method: "POST", route: "seen", cardId: card.id });
  await mk().call({ method: "POST", route: "pick", cardId: card.id, bodyData: { suggestionIndex: 1 } });
  nowMs = NOW + 7000;
  const { sent } = await mk().call({
    method: "POST", route: "refetch", cardId: card.id, bodyData: { fired: true },
  });
  assert.equal(sent.at(-1).obj.card.state, "dispatched");
});

// ---------------------------------------------------------------------------
// error surface
// ---------------------------------------------------------------------------

test("unknown card ids 404; unknown routes 404; wrong methods 405", async () => {
  const h = harness({ store: makeMemoryStore(), sources: sourcesFor() });
  const missing = await h.call({ method: "POST", route: "seen", cardId: "sv_nope" });
  assert.equal(missing.rejected.at(-1).status, 404);
  const badRoute = await h.call({ method: "GET", route: "explode" });
  assert.equal(badRoute.rejected.at(-1).status, 404);
  const badMethod = await h.call({ method: "DELETE", route: "list" });
  assert.equal(badMethod.rejected.at(-1).status, 405);
});

test("card ids are validated against the path pattern", async () => {
  const h = harness({ store: makeMemoryStore(), sources: sourcesFor() });
  const { rejected } = await h.call({ method: "POST", route: "seen", cardId: "../../x" });
  assert.equal(rejected[0].status, 422);
});
