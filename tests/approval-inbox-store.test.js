// Approval inbox store contracts: SQLite persistence for the unified
// approval inbox (server/approval-inbox-store.mjs). This file owns the
// store's domain contracts: card validation and round-trip, the
// pending->decided transition gate, double-decide idempotency, expiry
// sweeping, and list filters. The routes layer owns transport risk
// (status codes, the human-only 403) and never re-asserts these.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  ApprovalInboxStore, ApprovalInboxError, ensureApprovalInboxSchema,
  APPROVAL_KINDS, APPROVAL_DECISIONS, APPROVAL_STATUSES,
} from "../server/approval-inbox-store.mjs";

const NOW = 1_700_000_000_000;
const makeStore = (over = {}) => {
  let nowMs = over.now ?? NOW;
  let seq = 0;
  const store = new ApprovalInboxStore({
    db: over.db ?? new DatabaseSync(":memory:"),
    now: () => nowMs,
    newId: () => `card-${++seq}`,
  });
  return { store, setNow: ms => { nowMs = ms; } };
};

const goodCard = (over = {}) => ({
  kind: "deploy",
  title: "Deploy build fcf0b18a to production",
  what: "Deploy main@fcf0b18a (includes #2403, #2465) to room.trydemigod.com.",
  context: { links: [{ label: "CI run", url: "https://ci.example/run/1" }] },
  options: [
    { label: "Approve", consequence: "Production moves to fcf0b18a." },
    { label: "Deny", consequence: "Production stays on the current build." },
  ],
  requestedBy: "ai_jill",
  expiresAt: NOW + 3600_000,
  ...over,
});

const throwsCode = (fn, code) =>
  assert.throws(fn, e => e instanceof ApprovalInboxError && e.code === code,
    `expected ApprovalInboxError ${code}`);

test("create + get round-trips every card field", () => {
  const { store } = makeStore();
  const created = store.createCard(goodCard());
  assert.equal(created.id, "card-1");
  assert.equal(created.kind, "deploy");
  assert.equal(created.title, goodCard().title);
  assert.equal(created.what, goodCard().what);
  assert.deepEqual(created.context, { links: [{ label: "CI run", url: "https://ci.example/run/1" }] });
  assert.deepEqual(created.options, goodCard().options);
  assert.equal(created.requestedBy, "ai_jill");
  assert.equal(created.createdAt, NOW);
  assert.equal(created.expiresAt, NOW + 3600_000);
  assert.equal(created.status, "pending");
  assert.equal(created.decision, null);
  const fetched = store.getCard("card-1");
  assert.deepEqual(fetched, created);
  assert.equal(store.getCard("card-zzz"), null);
});

test("createCard rejects malformed input", () => {
  const { store } = makeStore();
  throwsCode(() => store.createCard(goodCard({ kind: "bribe" })), "invalid_card");
  throwsCode(() => store.createCard(goodCard({ title: "" })), "invalid_card");
  throwsCode(() => store.createCard(goodCard({ what: "  ".slice(0, 0) })), "invalid_card");
  throwsCode(() => store.createCard(goodCard({ expiresAt: NOW - 1 })), "invalid_card");
  throwsCode(() => store.createCard(goodCard({ options: [{ label: "x" }] })), "invalid_card");
  throwsCode(() => store.createCard(goodCard({ options: [{ consequence: "y" }] })), "invalid_card");
  throwsCode(() => store.createCard(goodCard({ context: { links: [{ label: "x" }] } })), "invalid_card");
  throwsCode(() => store.createCard(goodCard({ requestedBy: "" })), "invalid_card");
  // Duplicate ids are refused, not overwritten.
  store.createCard(goodCard({ id: "dup" }));
  throwsCode(() => store.createCard(goodCard({ id: "dup" })), "duplicate_card");
});

test("schema is lazy and additive: a second store on the same db reuses the tables", () => {
  const db = new DatabaseSync(":memory:");
  const a = makeStore({ db }).store;
  a.createCard(goodCard({ id: "shared-1" }));
  // A fresh module instance on the same database sees the same rows —
  // CREATE TABLE IF NOT EXISTS never wipes or migrates.
  const b = makeStore({ db }).store;
  assert.equal(b.getCard("shared-1").title, goodCard().title);
  assert.equal(b.listCards().length, 1);
  ensureApprovalInboxSchema(db); // idempotent even mid-use
  assert.equal(b.getCard("shared-1").status, "pending");
});

test("decideCard approve -> approved with a recorded decision row", () => {
  const { store } = makeStore();
  store.createCard(goodCard());
  const { card, decision } = store.decideCard("card-1", { decision: "approve", decidedBy: "john" });
  assert.equal(card.status, "approved");
  assert.equal(decision.decision, "approve");
  assert.equal(decision.decidedBy, "john");
  assert.equal(decision.cardId, "card-1");
  assert.equal(decision.createdAt, NOW);
  assert.deepEqual(store.getCard("card-1").decision, decision);
});

test("deny-stop -> rejected; approve-session -> approved", () => {
  const { store, setNow } = makeStore();
  store.createCard(goodCard({ kind: "money" }));
  store.createCard(goodCard({ kind: "permission" }));
  const denied = store.decideCard("card-1", { decision: "deny-stop", decidedBy: "john" });
  assert.equal(denied.card.status, "rejected");
  setNow(NOW + 5000);
  const session = store.decideCard("card-2", { decision: "approve-session", decidedBy: "john" });
  assert.equal(session.card.status, "approved");
  assert.equal(session.decision.decision, "approve-session");
  assert.equal(session.decision.createdAt, NOW + 5000);
});

test("double-decide is idempotent: same decider + decision replays without a second row", () => {
  const { store } = makeStore();
  store.createCard(goodCard());
  const first = store.decideCard("card-1", { decision: "approve", decidedBy: "john" });
  const second = store.decideCard("card-1", { decision: "approve", decidedBy: "john" });
  assert.equal(second.decision.id, first.decision.id);
  assert.equal(second.card.status, "approved");
  const rows = store.db.prepare("SELECT COUNT(*) AS n FROM approval_inbox_decisions").get();
  assert.equal(rows.n, 1);
});

test("a conflicting second decision is refused and changes nothing", () => {
  const { store } = makeStore();
  store.createCard(goodCard());
  store.decideCard("card-1", { decision: "approve", decidedBy: "john" });
  throwsCode(() => store.decideCard("card-1", { decision: "deny-stop", decidedBy: "john" }), "invalid_transition");
  throwsCode(() => store.decideCard("card-1", { decision: "approve", decidedBy: "jane" }), "invalid_transition");
  const card = store.getCard("card-1");
  assert.equal(card.status, "approved");
  assert.equal(card.decision.decision, "approve");
  assert.equal(card.decision.decidedBy, "john");
});

test("decideCard validates the decision and the card", () => {
  const { store } = makeStore();
  store.createCard(goodCard());
  throwsCode(() => store.decideCard("card-1", { decision: "maybe", decidedBy: "john" }), "invalid_decision");
  throwsCode(() => store.decideCard("card-1", { decision: "approve", decidedBy: "" }), "invalid_decision");
  throwsCode(() => store.decideCard("card-nope", { decision: "approve", decidedBy: "john" }), "not_found");
  // Expired cards cannot be decided.
  const { store: s2, setNow } = makeStore();
  s2.createCard(goodCard({ expiresAt: NOW + 1000 }));
  setNow(NOW + 2000);
  s2.expireCards();
  throwsCode(() => s2.decideCard("card-1", { decision: "approve", decidedBy: "john" }), "invalid_transition");
});

test("expireCards flips only past-due pending cards", () => {
  const { store, setNow } = makeStore();
  store.createCard(goodCard({ expiresAt: NOW + 1000 }));       // card-1: will lapse
  store.createCard(goodCard({ expiresAt: NOW + 999_000 }));    // card-2: still live
  store.createCard(goodCard({ expiresAt: null }));             // card-3: no expiry
  store.createCard(goodCard({ expiresAt: NOW + 500 }));        // card-4: decided before lapsing
  store.decideCard("card-4", { decision: "approve", decidedBy: "john" });
  setNow(NOW + 2000);
  const { expired } = store.expireCards();
  assert.deepEqual(expired, ["card-1"]);
  assert.equal(store.getCard("card-1").status, "expired");
  assert.equal(store.getCard("card-2").status, "pending");
  assert.equal(store.getCard("card-3").status, "pending");
  assert.equal(store.getCard("card-4").status, "approved");
  // A second sweep finds nothing new.
  assert.deepEqual(store.expireCards().expired, []);
});

test("listCards filters by status, kind, and requester with limit/offset", () => {
  const { store, setNow } = makeStore();
  setNow(NOW);
  store.createCard(goodCard({ kind: "money", requestedBy: "ai_jill" }));
  setNow(NOW + 1);
  store.createCard(goodCard({ kind: "deploy", requestedBy: "ai_fo" }));
  setNow(NOW + 2);
  store.createCard(goodCard({ kind: "money", requestedBy: "ai_fo" }));
  store.decideCard("card-2", { decision: "deny-stop", decidedBy: "john" });
  assert.deepEqual(store.listCards({ status: "pending" }).map(c => c.id), ["card-3", "card-1"]);
  assert.deepEqual(store.listCards({ status: "rejected" }).map(c => c.id), ["card-2"]);
  assert.deepEqual(store.listCards({ status: ["pending", "rejected"] }).map(c => c.id), ["card-3", "card-2", "card-1"]);
  assert.deepEqual(store.listCards({ kind: "money" }).map(c => c.id), ["card-3", "card-1"]);
  assert.deepEqual(store.listCards({ requestedBy: "ai_fo" }).map(c => c.id), ["card-3", "card-2"]);
  assert.deepEqual(store.listCards({ limit: 1, offset: 1 }).map(c => c.id), ["card-2"]);
  throwsCode(() => store.listCards({ status: "bogus" }), "invalid_filter");
  throwsCode(() => store.listCards({ kind: "bogus" }), "invalid_filter");
  throwsCode(() => store.listCards({ limit: 500 }), "invalid_filter");
});

test("injected clock and ids make every output deterministic", () => {
  const build = () => makeStore({ now: 42 }).store;
  const a = build().createCard(goodCard());
  const b = build().createCard(goodCard());
  assert.deepEqual({ ...a, decision: a.decision }, { ...b, decision: b.decision });
  assert.equal(a.id, "card-1");
  assert.equal(a.createdAt, 42);
});

test("module exports the documented enums", () => {
  assert.deepEqual([...APPROVAL_KINDS], ["money", "identity", "deploy", "permission", "publish", "other"]);
  assert.deepEqual([...APPROVAL_DECISIONS], ["approve", "approve-session", "deny-stop"]);
  assert.deepEqual([...APPROVAL_STATUSES], ["pending", "approved", "rejected", "changes", "expired"]);
});
