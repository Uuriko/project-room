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
  payoutSplit,
  disputeBondCredits,
  bountyPaySentence,
  bountyWindowLine,
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
  assert.ok(html.includes("Accept work"), "review action renders for the poster");
  assert.ok(!html.includes("release escrow"), "the button no longer promises a release the click does not perform (H-1)");
  assert.ok(html.includes("Accepting does not pay the worker now"), "the review block names the challenge window before the click");
  assert.ok(html.includes("72-hour"), "a 25-credit bounty carries the 72-hour window");
  assert.ok(html.includes("Your attestation"), "the review block is headed as the attestation it is (H-3)");
  assert.ok(html.includes('<option value="" selected>Choose…</option>'), "verdict selects start unchosen (H-3)");
  assert.ok(/data-bounty-action="accept" data-bounty-id="ROOMX-1" disabled/.test(html), "accept is disabled until every criterion has a verdict (H-3)");
  assert.ok(html.includes('data-bounty-action="fund"'), "fund action renders for an own proposed bounty");
  assert.ok(html.includes("25 credits"), "amount renders");
  const empty = bountyListHtml(bountyBoardModel({}));
  assert.ok(empty.includes("No bounties in this room yet"), "empty state is honest");
});

test("bountyBalanceHtml shows every bucket and the total", () => {
  const html = bountyBalanceHtml(bountyBoardModel({ balances: BALANCES }));
  for (const text of ["Payable 95", "Locked in escrow 25", "Attributed 0", "Total 120"]) assert.ok(html.includes(text), text);
  // H-4: the strip explains its own buckets in-panel, in the plain terms of
  // offers.html's settlement passage — Attributed above all, the bucket an
  // accepted amount silently lands in.
  for (const text of ["Attributed bucket", "challenge window closes", "next settlement sweep", "not cash"])
    assert.ok(html.includes(text), `explainer names: ${text}`);
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

test("buildAcceptAttestation refuses unset criteria and attests exactly the chosen verdicts (H-3)", () => {
  const item = bountyBoardModel({ bounties: [SUBMITTED], selfId: "m9" }).items[0];
  // No default-to-pass anywhere: missing, empty, and junk verdicts all refuse.
  assert.throws(() => buildAcceptAttestation(item, {}, "2026-10-15T00:00:00.000Z"), /still unchosen/);
  assert.throws(() => buildAcceptAttestation(item, { c1: "" }, "2026-10-15T00:00:00.000Z"), /still unchosen/);
  assert.throws(() => buildAcceptAttestation(item, { c1: "maybe" }, "2026-10-15T00:00:00.000Z"), /still unchosen/);
  const { verifierAttestation } = buildAcceptAttestation(item, { c1: "pass" }, "2026-10-15T00:00:00.000Z");
  assert.deepEqual(verifierAttestation.citations, [{ criterionId: "c1", verdict: "pass" }]);
  assert.equal(verifierAttestation.at, "2026-10-15T00:00:00.000Z");
  const failed = buildAcceptAttestation(item, { c1: "fail" }, "2026-10-15T00:00:00.000Z");
  assert.deepEqual(failed.verifierAttestation.citations, [{ criterionId: "c1", verdict: "fail" }]);
  // A rubric-free bounty has nothing to attest; the build is an empty citation set.
  const bare = bountyBoardModel({ bounties: [{ ...SUBMITTED, rubric: null }], selfId: "m9" }).items[0];
  assert.deepEqual(buildAcceptAttestation(bare, {}, "2026-10-15T00:00:00.000Z").verifierAttestation.citations, []);
});

test("payoutSplit and disputeBondCredits mirror the server's milli rules", () => {
  // server/bounty-escrow.mjs: fee = floor(amountMillis / 100); bond = ceil(amountMillis * 0.25).
  assert.deepEqual(payoutSplit(25), { fee: 0.25, net: 24.75 });
  assert.deepEqual(payoutSplit(0.5), { fee: 0.005, net: 0.495 });
  assert.deepEqual(payoutSplit(0.05), { fee: 0, net: 0.05 }, "a sub-0.1-credit award pays no fee");
  assert.equal(disputeBondCredits(25), 6.25);
  assert.equal(disputeBondCredits(0.5), 0.125);
});

const ACCEPTED = {
  ...SUBMITTED, bountyId: "ROOMX-3", title: "Accepted task", state: "accepted", group: "in-review",
  challengeEnds: "2026-10-21T12:00:00.000Z", disputeDecider: "id:agent/max", verifier: "id:agent/max",
  evidence: null,
};

test("an accepted card names the pay date, the net amount, and the dispute path for both parties (H-1)", () => {
  for (const selfId of ["m9", "id:agent/jill"]) {
    const html = bountyListHtml(bountyBoardModel({ bounties: [ACCEPTED], selfId }));
    assert.ok(html.includes("Not paid yet"), `window line renders for ${selfId}`);
    assert.ok(html.includes("the worker is paid 24.75 credits on Oct 21 unless disputed"),
      "net of the 1% pool fee, on the challengeEnds date");
    assert.ok(html.includes("25-credit award"), "the award behind the net figure is named");
    assert.ok(html.includes("1% payout fee"), "the fee is disclosed, not hidden");
    assert.ok(html.includes("bond of exactly 25% of the bounty (6.25 credits)"), "the dispute bond is named");
    assert.ok(html.includes("no dispute button yet"), "the copy names where disputes actually open");
  }
  // A micro bounty under the fee floor quotes its full amount, no fee clause.
  const micro = bountyListHtml(bountyBoardModel({
    bounties: [{ ...ACCEPTED, amount: 0.05, amountMillis: 50 }], selfId: "m9",
  }));
  assert.ok(micro.includes("the worker is paid 0.05 credits on Oct 21 unless disputed"));
  assert.ok(!micro.includes("payout fee"), "no fee is claimed where the server takes none");
});

test("the window line is honest when no dispute can open, and after the window closes", () => {
  const noDecider = bountyBoardModel({
    bounties: [{ ...ACCEPTED, disputeDecider: null, verifier: null }], selfId: "m9",
  }).items[0];
  assert.ok(bountyWindowLine(noDecider).includes("No dispute decider was named on this bounty"),
    "the server refuses to seat a decider-less dispute; the copy says so");
  assert.equal(bountyPaySentence(noDecider).includes("Oct 21"), true, "the pay date still renders");
  const approved = bountyBoardModel({
    bounties: [{ ...ACCEPTED, state: "approved" }], selfId: "m9",
  }).items[0];
  assert.ok(bountyWindowLine(approved).includes("next settlement sweep"), "approved means sweep-pending, not paid");
  const submitted = bountyBoardModel({ bounties: [SUBMITTED], selfId: "m9" }).items[0];
  assert.equal(bountyWindowLine(submitted), "", "no window line before acceptance");
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

test("the panel refuses an accept with unset verdicts, then attests exactly what was chosen (H-3/H-1)", async () => {
  const realDocument = globalThis.document;
  const realCSS = globalThis.CSS;
  globalThis.CSS = { escape: value => String(value) };
  const listeners = {};
  const statusEl = { textContent: "", classList: { toggle() {} } };
  const verdictSelect = { dataset: { verdictFor: "ROOMX-1:c1" }, value: "" };
  const acceptButton = { dataset: { bountyAction: "accept", bountyId: "ROOMX-1" }, disabled: true };
  let hostHtml = "";
  const host = {
    addEventListener(type, fn) { listeners[type] = fn; },
    contains: () => false,
    set innerHTML(html) { hostHtml = html; },
    get innerHTML() { return hostHtml; },
    querySelectorAll(selector) { return selector.includes("data-verdict-for") ? [verdictSelect] : []; },
    querySelector(selector) { return selector.includes('data-bounty-action="accept"') ? acceptButton : null; },
  };
  globalThis.document = {
    activeElement: null,
    querySelector: selector => {
      if (selector === "#bounty-panel") return { open: true };
      if (selector === "#bounty-count") return { textContent: "" };
      if (selector === "#bounty-board-host") return host;
      if (selector === "#bounty-status") return statusEl;
      return null;
    },
  };
  let accepted = false;
  const requests = [];
  const client = {
    path(suffix) { return `/api/rooms/room1${suffix}`; },
    async request(path, opts) {
      requests.push({ path, data: opts?.data });
      if (opts?.method === "POST" && path.endsWith("/accept")) { accepted = true; return {}; }
      if (path.endsWith("/bounties")) {
        return { roomId: "room1", bounties: [accepted
          ? { ...SUBMITTED, state: "accepted", challengeEnds: "2026-10-21T12:00:00.000Z", disputeDecider: "id:agent/max", verifier: "id:agent/max" }
          : SUBMITTED] };
      }
      if (path.includes("/credits/balances/")) return { roomId: "room1", balances: BALANCES };
      if (path.includes("/credits/history/")) return { roomId: "room1", receipts: RECEIPTS };
      throw new Error(`unexpected path ${path}`);
    },
  };
  const settle = () => new Promise(resolve => setTimeout(resolve, 10));
  try {
    const panel = installBountyBoard({ client, getSession: () => ({ roomId: "room1", member: { id: "m9" } }) });
    await panel.sync();
    const clickAccept = () => listeners.click({
      target: { closest: sel => (sel === "[data-bounty-action]" ? acceptButton : null) },
    });
    const changeVerdict = () => listeners.change({
      target: { closest: sel => (sel === "[data-verdict-for]" ? verdictSelect : null) },
    });
    // One click with the verdict unchosen: refused inline, nothing reaches the wire.
    clickAccept();
    await settle();
    assert.equal(requests.some(r => r.path.endsWith("/accept")), false, "no accept is posted with an unset criterion");
    assert.match(statusEl.textContent, /still unchosen/, "the refusal names the unfinished attestation");
    // The button enables only while every verdict is chosen.
    verdictSelect.value = "pass";
    changeVerdict();
    assert.equal(acceptButton.disabled, false, "all verdicts chosen enables accept");
    verdictSelect.value = "";
    changeVerdict();
    assert.equal(acceptButton.disabled, true, "resetting a verdict to unchosen disables accept again");
    verdictSelect.value = "pass";
    changeVerdict();
    clickAccept();
    await settle(); await settle();
    const posts = requests.filter(r => r.path.endsWith("/accept"));
    assert.equal(posts.length, 1, "exactly one accept posts");
    assert.deepEqual(posts[0].data.verifierAttestation.citations,
      [{ criterionId: "c1", verdict: "pass" }], "the attestation carries exactly the chosen verdict");
    assert.match(statusEl.textContent, /The worker is paid 24\.75 credits on Oct 21 unless disputed/,
      "the post-accept status names the window instead of implying a release");
    assert.match(statusEl.textContent, /Receipt lot_bbb/, "the movement receipt is still named");
  } finally {
    if (realDocument === undefined) delete globalThis.document; else globalThis.document = realDocument;
    if (realCSS === undefined) delete globalThis.CSS; else globalThis.CSS = realCSS;
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
