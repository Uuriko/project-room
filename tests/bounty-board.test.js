// Tests for src/bounty-board.js (#3437 first slice): the in-room human money
// surface over the bounty-escrow endpoints. Pure helpers (lane normalization,
// credit formatting, view model, HTML rendering, payload builders) plus the
// wired panel behavior against a stub client and a fake document.
// No real DOM, no network.
import test from "node:test";
import assert from "node:assert/strict";
import {
  escapeHtml,
  canonicalLaneId,
  formatCredits,
  bountyStateLabel,
  safeEvidenceUrl,
  bountyBoardModel,
  bountyBalanceHtml,
  bountyListHtml,
  bountyReceiptsHtml,
  defaultDeadlineLocal,
  buildPostPayload,
  buildAcceptAttestation,
  installBountyBoard,
  bountyFocusKey,
  restoreBountyFocus,
} from "../src/bounty-board.js";

const SUBMITTED = {
  bountyId: "ROOMX-1", roomId: "room1", title: "Write the thing", criteria: "It exists",
  amount: 25, amountMillis: 25000, poster: "m9", verifier: null, claimant: "id:agent/jill",
  approvalMode: "human", state: "submitted", group: "in-review",
  deadline: "2999-01-10T00:00:00.000Z",
  evidence: { evidenceUrl: "https://example.com/work", summary: "Done it", evidenceKind: "link", checksClaimed: [], producerId: null },
  rubric: { version: 1, hash: "abc123", criteria: [{ criterionId: "c1", description: "It exists" }] },
};
const PROPOSED = { ...SUBMITTED, bountyId: "ROOMX-2", title: "Second task", state: "proposed", group: "proposed", claimant: null, evidence: null };
const BALANCES = { identity: "m9", payable: 95, locked: 25, attributed: 0, approved: 0, total: 120 };
const RECEIPTS = [
  { receiptId: "lot_aaa", at: "2026-10-14T00:00:00.000Z", kind: "escrow-lock", memo: "locked", bountyId: "ROOMX-1", amount: 25, amountMillis: 25000, signedReceiptIds: [] },
  { receiptId: "lot_bbb", at: "2026-10-15T00:00:00.000Z", kind: "attribute", memo: "attributed", bountyId: "ROOMX-1", amount: 25, amountMillis: 25000, signedReceiptIds: ["room-bounty-receipt:at:0123456789abcdef0123456789abcdef"] },
];

test("canonicalLaneId mirrors the server lane normalizer", () => {
  assert.equal(canonicalLaneId("id:agent:jill"), "id:agent/jill");
  assert.equal(canonicalLaneId("id:agent/jill"), "id:agent/jill");
  assert.equal(canonicalLaneId("m9"), "m9");
  assert.equal(canonicalLaneId(null), "");
  assert.equal(canonicalLaneId(42), "");
});

test("formatCredits trims millis without hiding them", () => {
  assert.equal(formatCredits(95), "95");
  assert.equal(formatCredits(0.5), "0.5");
  assert.equal(formatCredits(1.234), "1.234");
  assert.equal(formatCredits(0), "0");
  assert.equal(formatCredits("lots"), "0");
  assert.equal(formatCredits(undefined), "0");
});

test("bountyStateLabel uses the journey vocabulary", () => {
  assert.equal(bountyStateLabel("funded"), "Open");
  assert.equal(bountyStateLabel("claimed"), "Claimed");
  assert.equal(bountyStateLabel("submitted"), "Submitted");
  assert.equal(bountyStateLabel("paid"), "Settled");
  assert.equal(bountyStateLabel("proposed"), "Proposed");
  assert.equal(bountyStateLabel("mystery"), "mystery");
  assert.equal(bountyStateLabel(null), "Unknown");
});

test("safeEvidenceUrl only allows web links", () => {
  assert.equal(safeEvidenceUrl("https://example.com/x"), "https://example.com/x");
  assert.equal(safeEvidenceUrl("http://example.com"), "http://example.com");
  assert.equal(safeEvidenceUrl("javascript:alert(1)"), "");
  assert.equal(safeEvidenceUrl("/relative/path"), "");
  assert.equal(safeEvidenceUrl(null), "");
});

test("bountyBoardModel gates fund and review actions by state and self", () => {
  const model = bountyBoardModel({ bounties: [SUBMITTED, PROPOSED], balances: BALANCES, receipts: RECEIPTS, selfId: "m9" });
  assert.equal(model.count, 2);
  const [submitted, proposed] = model.items;
  assert.equal(submitted.canReview, true, "the poster reviews a submitted bounty");
  assert.equal(submitted.canFund, false);
  assert.deepEqual(submitted.rubricCriteria, [{ criterionId: "c1", description: "It exists" }]);
  assert.equal(submitted.evidence.summary, "Done it");
  assert.equal(proposed.canFund, true, "the poster funds their own proposed bounty");
  assert.equal(proposed.canReview, false);
  assert.equal(model.balance.payable, 95);
  assert.equal(model.balance.total, 120);
  assert.deepEqual(model.receipts.map(r => r.receiptId), ["lot_bbb", "lot_aaa"], "receipts newest first");
  assert.equal(model.receipts[0].signed, true);
  assert.equal(model.receipts[1].signed, false);
});

test("bountyBoardModel never offers review to the claimant or a bystander", () => {
  const asClaimant = bountyBoardModel({ bounties: [SUBMITTED], selfId: "id:agent:jill" });
  assert.equal(asClaimant.items[0].canReview, false);
  const asBystander = bountyBoardModel({ bounties: [SUBMITTED, PROPOSED], selfId: "someone-else" });
  assert.equal(asBystander.items[0].canReview, false);
  assert.equal(asBystander.items[1].canFund, false);
  const asVerifier = bountyBoardModel({ bounties: [{ ...SUBMITTED, approvalMode: "agent", verifier: "id:agent/max" }], selfId: "id:agent/max" });
  assert.equal(asVerifier.items[0].canReview, true, "the designated verifier reviews agent-mode bounties");
});

test("bountyBoardModel tolerates missing payloads with safe defaults", () => {
  const model = bountyBoardModel({});
  assert.equal(model.count, 0);
  assert.deepEqual(model.balance, { payable: 0, locked: 0, attributed: 0, approved: 0, total: 0 });
  assert.deepEqual(model.receipts, []);
  assert.deepEqual(bountyBoardModel(), model);
});

test("bountyListHtml escapes titles and renders only the actions the model allows", () => {
  const model = bountyBoardModel({
    bounties: [{ ...SUBMITTED, title: "<img src=x onerror=alert(1)>" }, PROPOSED],
    balances: BALANCES, receipts: [], selfId: "m9",
  });
  const html = bountyListHtml(model);
  assert.ok(!html.includes("<img src=x"), "raw markup must not appear");
  assert.ok(html.includes("&lt;img src=x"), "escaped markup appears instead");
  assert.ok(html.includes("Accept &amp; release escrow"), "review action renders for the poster");
  assert.ok(html.includes('data-bounty-action="fund"'), "fund action renders for an own proposed bounty");
  assert.ok(html.includes("25 credits"), "amount renders");
  const empty = bountyListHtml(bountyBoardModel({}));
  assert.ok(empty.includes("No bounties in this room yet"), "empty state is honest");
});

test("bountyBalanceHtml shows every bucket and the total", () => {
  const html = bountyBalanceHtml(bountyBoardModel({ balances: BALANCES }));
  for (const text of ["Payable 95", "Locked in escrow 25", "Attributed 0", "Total 120"]) assert.ok(html.includes(text), text);
});

test("bountyReceiptsHtml highlights the named receipt and badges signed ones", () => {
  const model = bountyBoardModel({ receipts: RECEIPTS });
  const html = bountyReceiptsHtml(model, "lot_bbb");
  assert.ok(html.includes('id="bounty-receipt-lot_bbb"'));
  assert.ok(html.includes("bounty-receipt-hot"), "the accepted receipt is highlighted");
  assert.ok(html.includes("signed"), "signed receipts are badged");
  assert.ok(bountyReceiptsHtml(bountyBoardModel({})).includes("No credit movements yet"));
});

test("buildPostPayload shapes the create body and enforces the server rules", () => {
  const payload = buildPostPayload({ title: "  Do it  ", criteria: " Done means shipped ", amount: "12.5", deadlineLocal: "2999-01-01T09:30" });
  assert.equal(payload.title, "Do it");
  assert.equal(payload.criteria, "Done means shipped");
  assert.equal(payload.amount, 12.5);
  assert.ok(Number.isFinite(Date.parse(payload.deadline)), "deadline becomes an ISO timestamp");
  assert.throws(() => buildPostPayload({ title: "", criteria: "x", amount: 1, deadlineLocal: "2999-01-01T00:00" }), /title/);
  assert.throws(() => buildPostPayload({ title: "x", criteria: "", amount: 1, deadlineLocal: "2999-01-01T00:00" }), /done looks like/);
  assert.throws(() => buildPostPayload({ title: "x", criteria: "y", amount: 0, deadlineLocal: "2999-01-01T00:00" }), /positive/);
  assert.throws(() => buildPostPayload({ title: "x", criteria: "y", amount: 1, deadlineLocal: "2000-01-01T00:00" }), /future/);
});

test("defaultDeadlineLocal is a datetime-local string a week out", () => {
  const value = defaultDeadlineLocal(Date.parse("2026-10-15T12:00:00.000Z"));
  assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  const payload = buildPostPayload({ title: "x", criteria: "y", amount: 1, deadlineLocal: value });
  assert.ok(Date.parse(payload.deadline) > Date.now(), "the default deadline is in the future");
});

test("buildAcceptAttestation cites every pinned criterion exactly once", () => {
  const item = bountyBoardModel({ bounties: [SUBMITTED], selfId: "m9" }).items[0];
  const { verifierAttestation } = buildAcceptAttestation(item, {}, "2026-10-15T00:00:00.000Z");
  assert.deepEqual(verifierAttestation.citations, [{ criterionId: "c1", verdict: "pass" }]);
  assert.equal(verifierAttestation.at, "2026-10-15T00:00:00.000Z");
  const failed = buildAcceptAttestation(item, { c1: "fail" }, "2026-10-15T00:00:00.000Z");
  assert.deepEqual(failed.verifierAttestation.citations, [{ criterionId: "c1", verdict: "fail" }]);
});

test("escapeHtml neutralizes markup", () => {
  assert.equal(escapeHtml("<script>alert(1)</script>"), "&lt;script&gt;alert(1)&lt;/script&gt;");
  assert.equal(escapeHtml(null), "");
});

test("installBountyBoard without a panel never touches client or session", () => {
  const realDocument = globalThis.document;
  globalThis.document = { querySelector: () => null };
  try {
    const panel = installBountyBoard({
      client: { request() { throw new Error("must not fetch without a panel"); } },
      getSession() { throw new Error("must not read the session without a panel"); },
    });
    assert.doesNotThrow(() => { panel.sync(); panel.reset(); });
  } finally {
    if (realDocument === undefined) delete globalThis.document; else globalThis.document = realDocument;
  }
});

test("installBountyBoard reads list, balances, and history for the session member and renders", async () => {
  const realDocument = globalThis.document;
  let hostHtml = "", chipText = null;
  const host = { addEventListener() {}, set innerHTML(html) { hostHtml = html; }, get innerHTML() { return hostHtml; } };
  globalThis.document = {
    querySelector: selector => {
      if (selector === "#bounty-panel") return { open: true };
      if (selector === "#bounty-count") return { set textContent(t) { chipText = t; } };
      if (selector === "#bounty-board-host") return host;
      if (selector === "#bounty-status") return { textContent: "", classList: { toggle() {} } };
      return null;
    },
  };
  const requested = [];
  const client = {
    session: { roomId: "room1", member: { id: "m9" } },
    path(suffix) { return `/api/rooms/room1${suffix}`; },
    async request(path) {
      requested.push(path);
      if (path.endsWith("/bounties")) return { roomId: "room1", bounties: [SUBMITTED, PROPOSED] };
      if (path.includes("/credits/balances/")) return { roomId: "room1", balances: BALANCES };
      if (path.includes("/credits/history/")) return { roomId: "room1", receipts: RECEIPTS };
      throw new Error(`unexpected path ${path}`);
    },
  };
  try {
    const panel = installBountyBoard({ client, getSession: () => client.session });
    await panel.sync();
    assert.deepEqual(requested, [
      "/api/rooms/room1/bounties",
      "/api/rooms/room1/credits/balances/m9",
      "/api/rooms/room1/credits/history/m9",
    ]);
    assert.equal(chipText, "2", "count chip shows the bounty count");
    assert.ok(hostHtml.includes("Write the thing"), "bounty rows render");
    assert.ok(hostHtml.includes("Payable 95"), "balance renders");
    assert.ok(hostHtml.includes("lot_bbb"), "receipts render");
    assert.ok(hostHtml.includes('id="bounty-post-form"'), "post form renders");
    await panel.sync();
    assert.equal(requested.length, 3, "a second sync without changes does not refetch");
  } finally {
    if (realDocument === undefined) delete globalThis.document; else globalThis.document = realDocument;
  }
});

test("bountyFocusKey captures a stable key per control kind (A11Y-LOOP)", () => {
  assert.equal(bountyFocusKey(null), null);
  assert.equal(bountyFocusKey({}), null);
  assert.equal(bountyFocusKey({ id: "bounty-title" }), "id:bounty-title");
  assert.equal(
    bountyFocusKey({ dataset: { bountyAction: "fund", bountyId: "ROOMX-1" } }),
    "action:fund:ROOMX-1");
  assert.equal(
    bountyFocusKey({ dataset: { verdictFor: "ROOMX-1:c1" } }),
    "verdict:ROOMX-1:c1");
  assert.equal(
    bountyFocusKey({ dataset: { rejectReason: "ROOMX-1" } }),
    "reject:ROOMX-1");
  assert.equal(
    bountyFocusKey({ getAttribute: (name) => name === "aria-label" ? "Recover escrow" : null }),
    "aria:Recover escrow");
  assert.equal(bountyFocusKey({ type: "submit" }), "submit:");
});

test("restoreBountyFocus focuses the equivalent control and reports misses (A11Y-LOOP)", () => {
  const focused = [];
  const target = { focus() { focused.push(this.selector); } };
  const root = {
    querySelector(selector) {
      target.selector = selector;
      return selector.includes("missing") ? null : target;
    },
  };
  assert.equal(restoreBountyFocus(root, "id:bounty-title"), true);
  assert.equal(focused[0], '[id="bounty-title"]');
  assert.equal(restoreBountyFocus(root, "action:fund:ROOMX-1"), true);
  assert.equal(focused[1], '[data-bounty-action="fund"][data-bounty-id="ROOMX-1"]');
  assert.equal(restoreBountyFocus(root, "verdict:ROOMX-1:c1"), true);
  assert.equal(focused[2], '[data-verdict-for="ROOMX-1:c1"]');
  assert.equal(restoreBountyFocus(root, "submit:"), true);
  assert.equal(restoreBountyFocus(root, null), false);
  assert.equal(restoreBountyFocus(null, "id:bounty-title"), false);
  const emptyRoot = { querySelector: () => null };
  assert.equal(restoreBountyFocus(emptyRoot, "id:bounty-title"), false,
    "a control that legitimately vanished restores nothing");
});
