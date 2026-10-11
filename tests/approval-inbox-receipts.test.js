// Approval-inbox receipt linkage (WAVE-500 guild 10 slice 7): resolving an
// inbox card records a cardId->receiptId linkage and builds the four-field
// receipt payload (what ran / what it read / what changed / who signed off)
// against the receiptId convention the run-receipt surface (#2546)
// establishes: "rc_" + cardId, resolvable lazily, never fabricated.
//
// Covers: payload shape on resolution; linkage recorded as "pending" (never
// "linked" without evidence); lazy flip to "linked" via an injected
// receiptProbe; backfill marks historically resolved cards "pending" with no
// fabricated payload; unknown cardIds return null, never a row; duplicates
// and malformed input throw.
import test from "node:test";
import assert from "node:assert/strict";
import {
  InboxReceiptError,
  receiptIdForCardId,
  createInboxReceiptStore,
} from "../server/approval-inbox-receipts.mjs";

const expectCode = (fn, code) => {
  try { fn(); } catch (error) { assert.ok(error instanceof InboxReceiptError); assert.equal(error.code, code); return; }
  assert.fail(`expected ${code} but nothing threw`);
};
const card = (overrides = {}) => ({ cardId: "card-1", title: "Deploy the new landing", ...overrides });
const resolution = (overrides = {}) => ({
  decision: "approved",
  decidedBy: "john",
  decidedAt: "2026-10-10T19:00:00.000Z",
  whatRan: { run: "deploy:production", by: "deploy-lane" },
  whatRead: ["CI run #4481 (green)", "diff review note"],
  whatChanged: { files: ["server/http.mjs"], notes: "deployed at fcf0b18a" },
  ...overrides,
});

test("recordResolution stores the linkage and returns the frozen payload", () => {
  const store = createInboxReceiptStore();
  const linkage = store.recordResolution(card(), resolution());
  assert.equal(linkage.cardId, "card-1");
  assert.equal(linkage.receiptId, "rc_card-1");
  assert.equal(linkage.status, "pending");
  assert.ok(Object.isFrozen(linkage.payload));
  assert.deepEqual(Object.keys(linkage.payload).sort(), [
    "cardId", "decidedAt", "decidedBy", "decision", "receiptId", "signedOff", "whatChanged", "whatRan", "whatRead",
  ].sort());
  assert.equal(linkage.payload.decision, "approved");
  assert.equal(linkage.payload.decidedBy, "john");
  assert.deepEqual(linkage.payload.signedOff, { by: "john", at: "2026-10-10T19:00:00.000Z" });
  assert.deepEqual(linkage.payload.whatRan, { run: "deploy:production", by: "deploy-lane" });
  assert.deepEqual(linkage.payload.whatRead, ["CI run #4481 (green)", "diff review note"]);
  assert.deepEqual(linkage.payload.whatChanged, { files: ["server/http.mjs"], notes: "deployed at fcf0b18a" });
});

test("receiptId follows the rc_<cardId> convention of the receipt surface", () => {
  assert.equal(receiptIdForCardId("card-1"), "rc_card-1");
  assert.match(receiptIdForCardId("card-1"), /^rc_[A-Za-z0-9_-]{1,128}$/);
  assert.ok(receiptIdForCardId("a".repeat(128)).startsWith("rc_"));
  expectCode(() => receiptIdForCardId(""), "inbox_receipt_bad_card_id");
  expectCode(() => receiptIdForCardId("card with spaces"), "inbox_receipt_bad_card_id");
  expectCode(() => receiptIdForCardId("card/evil"), "inbox_receipt_bad_card_id");
  expectCode(() => receiptIdForCardId("a".repeat(129)), "inbox_receipt_bad_card_id");
  expectCode(() => receiptIdForCardId(null), "inbox_receipt_bad_card_id");
});

test("resolution requires decision, decider, and a real timestamp", () => {
  const store = createInboxReceiptStore();
  expectCode(() => store.recordResolution(card(), resolution({ decision: "" })), "inbox_receipt_invalid");
  expectCode(() => store.recordResolution(card(), resolution({ decidedBy: "" })), "inbox_receipt_invalid");
  expectCode(() => store.recordResolution(card(), resolution({ decidedAt: "not-a-date" })), "inbox_receipt_invalid");
  expectCode(() => store.recordResolution(card(), resolution({ decidedAt: undefined })), "inbox_receipt_invalid");
  expectCode(() => store.recordResolution({}, resolution()), "inbox_receipt_invalid");
});

test("no fake receipts: get() returns null for unknown cards, never a row", () => {
  const store = createInboxReceiptStore();
  assert.equal(store.get("nope"), null);
  assert.equal(store.status("nope"), null);
});

test("recording the same card twice throws — no duplicate rows", () => {
  const store = createInboxReceiptStore();
  store.recordResolution(card(), resolution());
  expectCode(() => store.recordResolution(card(), resolution()), "inbox_receipt_duplicate");
});

test("linkage flips to linked when the probe says the receipt surface resolves it", () => {
  const store = createInboxReceiptStore({ receiptProbe: id => id === "rc_card-1" });
  store.recordResolution(card(), resolution());
  const resolved = store.status("card-1");
  assert.equal(resolved.status, "linked");
  assert.equal(resolved.receiptId, "rc_card-1");
  // Persistence of the flip: the stored record is now linked too.
  assert.equal(store.get("card-1").status, "linked");
});

test("a probe that says no keeps the linkage pending — never optimistic", () => {
  const store = createInboxReceiptStore({ receiptProbe: () => false });
  store.recordResolution(card(), resolution());
  assert.equal(store.status("card-1").status, "pending");
  assert.equal(store.get("card-1").status, "pending");
});

test("without a probe the linkage stays pending forever — honesty, not optimism", () => {
  const store = createInboxReceiptStore();
  store.recordResolution(card(), resolution());
  assert.equal(store.status("card-1").status, "pending");
});

test("markLinked flips pending to linked on caller-confirmed resolution", () => {
  const store = createInboxReceiptStore();
  store.recordResolution(card(), resolution());
  const marked = store.markLinked("card-1");
  assert.equal(marked.status, "linked");
  assert.equal(store.get("card-1").status, "linked");
  expectCode(() => store.markLinked("unknown"), "inbox_receipt_not_found");
});

test("backfill marks already-resolved cards receipt-pending, never fabricates a receipt", () => {
  const store = createInboxReceiptStore({ receiptProbe: () => true });
  const linkages = store.backfillResolved([
    { cardId: "old-1", decision: "approved", decidedBy: "john", decidedAt: "2026-09-22T12:00:00.000Z" },
    { cardId: "old-2", decision: "rejected", decidedBy: null, decidedAt: null },
  ]);
  assert.equal(linkages.length, 2);
  for (const linkage of linkages) {
    // Even with a working probe, historical rows never mint a payload:
    // no untraceable rows, ever.
    assert.equal(linkage.status, "pending");
    assert.equal(linkage.payload, null);
    assert.match(linkage.receiptId, /^rc_/);
    assert.equal(linkage.backfilled, true);
  }
  const old1 = store.get("old-1");
  assert.equal(old1.decision, "approved");
  assert.equal(old1.decidedBy, "john");
  assert.equal(old1.decidedAt, "2026-09-22T12:00:00.000Z");
  const old2 = store.get("old-2");
  assert.equal(old2.decidedBy, null);
  assert.equal(old2.decidedAt, null);
  assert.equal(old2.payload, null);
});

test("backfill skips cards already recorded — no duplicates", () => {
  const store = createInboxReceiptStore();
  store.recordResolution(card(), resolution());
  const out = store.backfillResolved([{ cardId: "card-1", decision: "approved", decidedBy: "john", decidedAt: "2026-10-10T19:00:00.000Z" }]);
  assert.equal(out.length, 0);
  assert.equal(store.get("card-1").payload.decision, "approved");
});

test("list returns every recorded linkage; snapshot/restore round-trips", () => {
  const store = createInboxReceiptStore();
  store.recordResolution(card(), resolution());
  store.backfillResolved([{ cardId: "old-1", decision: "rejected", decidedBy: null, decidedAt: null }]);
  assert.equal(store.list().length, 2);
  const snap = store.snapshot();
  assert.ok(Array.isArray(snap) && snap.length === 2);
  const restored = createInboxReceiptStore();
  restored.restore(snap);
  assert.equal(restored.list().length, 2);
  assert.equal(restored.get("card-1").receiptId, "rc_card-1");
  assert.equal(restored.get("old-1").status, "pending");
  expectCode(() => restored.restore([{ nope: true }]), "inbox_receipt_invalid");
});
