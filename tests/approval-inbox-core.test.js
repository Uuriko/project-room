// WAVE-500 guild 10 slice 2/50: unified approval-inbox core — one live surface
// for pending HUMAN decisions. Fail-first tests for openCard validation,
// decideCard transitions, human-only enforcement, requestChanges, and the
// expiry sweep. Deciding nothing until a human says so is the point.
import test from "node:test";
import assert from "node:assert/strict";
import { ApprovalInboxError, cardStatuses, createApprovalInbox } from "../server/approval-inbox.mjs";

const agent = { kind: "agent", id: "claude", label: "Claude" };
const human = { kind: "human", id: "john", label: "John" };
const expectCode = (fn, code) => {
  try { fn(); } catch (error) { assert.ok(error instanceof ApprovalInboxError, `expected ApprovalInboxError, got ${error}`); assert.equal(error.code, code); return; }
  assert.fail(`expected ${code} but nothing threw`);
};
const fixedClock = (start = 1_000_000) => { let t = start; return () => (t += 1000); };
const seqIds = () => { let n = 0; return () => `card-${++n}`; };
const goodInput = (overrides = {}) => ({
  kind: "money", title: "Pay $50 bounty to worker-12", what: "Release $50 USDC for the merged landing-page PR.",
  contextLinks: ["https://github.com/Uuriko/project-room/pull/2403"],
  options: [{ label: "Pay", consequence: "$50 USDC leaves the pilot pot" }, { label: "Skip", consequence: "Worker unpaid this round" }],
  requestedBy: agent, ...overrides });
const inbox = (overrides = {}) => createApprovalInbox({ clock: fixedClock(), id: seqIds(), ...overrides });
const open = (box, input) => box.openCard(input === undefined ? goodInput() : input);

test("openCard creates a pending card with frozen fields and an opened history entry", () => {
  const box = inbox();
  const card = open(box);
  assert.equal(card.status, "pending");
  assert.equal(card.cardId, "apc-card-1");
  assert.equal(card.kind, "money");
  assert.deepEqual(card.requestedBy, agent);
  assert.equal(card.expiresAt, null);
  assert.equal(card.resolution, null);
  assert.equal(card.history.length, 1);
  assert.equal(card.history[0].status, "pending");
  assert.deepEqual(card.history[0].by, agent);
  assert.ok(Object.isFrozen(card) && Object.isFrozen(card.options) && Object.isFrozen(card.history));
});

test("openCard validation rejects a bad kind, empty title, overlong what, and bad options shape", () => {
  const box = inbox();
  expectCode(() => open(box, goodInput({ kind: "bribe" })), "inbox_invalid");
  expectCode(() => open(box, goodInput({ title: "  " })), "inbox_invalid");
  expectCode(() => open(box, goodInput({ what: "x".repeat(2001) })), "inbox_invalid");
  expectCode(() => open(box, goodInput({ options: [{ label: "Go" }] })), "inbox_invalid");
  expectCode(() => open(box, goodInput({ options: "yes" })), "inbox_invalid");
});

test("openCard validation rejects an unknown requestedBy kind and an expiresAt in the past", () => {
  const box = inbox();
  expectCode(() => open(box, goodInput({ requestedBy: { kind: "bot", id: "x" } })), "inbox_invalid");
  expectCode(() => open(box, goodInput({ expiresAt: 500 })), "inbox_invalid");
  const future = open(box, goodInput({ expiresAt: new Date(9_999_999_999_999).toISOString() }));
  assert.ok(future.expiresAt !== null);
});

test("openCard accepts every kind and stores contextLinks", () => {
  const box = inbox();
  for (const kind of ["money", "identity", "deploy", "permission", "publish", "other"])
    assert.equal(open(box, goodInput({ kind })).kind, kind);
  const noLinks = open(box, goodInput({ contextLinks: undefined }));
  assert.deepEqual(noLinks.contextLinks, []);
});

test("decideCard: a human approve resolves the card with a receipt ref and journal entry", () => {
  const box = inbox();
  const card = open(box);
  const resolved = box.decideCard({ cardId: card.cardId, decision: "approve", by: human, note: "Looks right." });
  assert.equal(resolved.status, "approved");
  assert.equal(resolved.resolution.decision, "approve");
  assert.equal(resolved.resolution.scope, "once");
  assert.deepEqual(resolved.resolution.by, human);
  assert.ok(resolved.resolution.receiptRef.includes(card.cardId));
  assert.equal(resolved.history.at(-1).status, "approved");
});

test("decideCard: approve-session records the session scope; deny-stop rejects", () => {
  const box = inbox();
  const session = box.decideCard({ cardId: open(box).cardId, decision: "approve-session", by: human });
  assert.equal(session.status, "approved");
  assert.equal(session.resolution.scope, "session");
  const stopped = box.decideCard({ cardId: open(box).cardId, decision: "deny-stop", by: human });
  assert.equal(stopped.status, "rejected");
  assert.equal(stopped.resolution.decision, "deny-stop");
});

test("decideCard: agents get the human-only gate, and invalid transitions fail", () => {
  const box = inbox();
  const pending = open(box);
  expectCode(() => box.decideCard({ cardId: pending.cardId, decision: "approve", by: agent }), "inbox_not_human");
  expectCode(() => box.decideCard({ cardId: pending.cardId, decision: "maybe", by: human }), "inbox_invalid");
  expectCode(() => box.decideCard({ cardId: "nope", decision: "approve", by: human }), "inbox_not_found");
  box.decideCard({ cardId: pending.cardId, decision: "approve", by: human });
  expectCode(() => box.decideCard({ cardId: pending.cardId, decision: "deny-stop", by: human }), "inbox_transition");
});

test("requestChanges moves pending to changes with the human's note; it cannot be decided after", () => {
  const box = inbox();
  const card = open(box);
  const changed = box.requestChanges(card.cardId, { by: human, note: "Add the PR link first." });
  assert.equal(changed.status, "changes");
  assert.equal(changed.history.at(-1).note, "Add the PR link first.");
  expectCode(() => box.decideCard({ cardId: card.cardId, decision: "approve", by: human }), "inbox_transition");
  expectCode(() => box.requestChanges(card.cardId, { by: human, note: "again" }), "inbox_transition");
  expectCode(() => box.requestChanges(open(box).cardId, { by: human }), "inbox_invalid");
  expectCode(() => box.requestChanges(open(box).cardId, { by: agent, note: "nope" }), "inbox_not_human");
});

test("expireSweep expires only due pending cards and leaves the rest alone", () => {
  let now = 5_000_000;
  const box = createApprovalInbox({ clock: () => now, id: seqIds() });
  const due = open(box, goodInput({ expiresAt: now + 5_000 }));
  const future = open(box, goodInput({ expiresAt: now + 60_000 }));
  const decided = open(box, goodInput({ expiresAt: now + 5_000 }));
  box.decideCard({ cardId: decided.cardId, decision: "deny-stop", by: human });
  assert.deepEqual(box.expireSweep({ now }), []);
  now += 10_000;
  const expired = box.expireSweep({ now });
  assert.deepEqual(expired, [due.cardId]);
  assert.equal(box.get(due.cardId).status, "expired");
  assert.equal(box.get(future.cardId).status, "pending");
  assert.equal(box.get(decided.cardId).status, "rejected");
  assert.deepEqual(box.expireSweep({ now }), []);
});

test("list filters by status/kind; pendingCount counts only pending; get throws on unknown", () => {
  const box = inbox();
  const a = open(box, goodInput({ kind: "money" }));
  open(box, goodInput({ kind: "deploy" }));
  box.decideCard({ cardId: a.cardId, decision: "approve", by: human });
  assert.equal(box.pendingCount(), 1);
  assert.equal(box.list({ status: "pending" }).length, 1);
  assert.equal(box.list({ kind: "deploy" }).length, 1);
  expectCode(() => box.list({ status: "bogus" }), "inbox_invalid");
  expectCode(() => box.get("missing"), "inbox_not_found");
});

test("an injected store seam is honored (slice 1's store plugs in without edits here)", () => {
  const rows = new Map();
  const store = { get: id => rows.get(id) ?? null, save: card => rows.set(card.cardId, card), list: () => [...rows.values()] };
  const box = createApprovalInbox({ store, clock: fixedClock(), id: seqIds() });
  const card = open(box);
  assert.ok(rows.has(card.cardId));
  box.decideCard({ cardId: card.cardId, decision: "deny-stop", by: human });
  assert.equal(store.get(card.cardId).status, "rejected");
});

test("a store that rejects unknown methods is still compatible (minimal seam: get/save/list)", () => {
  const box = createApprovalInbox({ clock: fixedClock(), id: seqIds(),
    store: { get() { return null; }, save() { throw new Error("nope"); }, list: () => [] } });
  assert.equal(box.pendingCount(), 0);
  assert.deepEqual(box.expireSweep(), []);
});
