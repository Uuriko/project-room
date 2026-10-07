// Fail-first unit tests for src/triage-state.js (B7 triage view, D4 §3).
// The view-state machine is pure: no DOM, no fetch, no timers. The DOM layer
// (src/triage-ui.js) executes the intents this machine returns.
// Written before the implementation; they must FAIL until triage-state.js lands.
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_GRACE_SECONDS,
  MAX_GRACE_SECONDS,
  clampGraceSeconds,
  escapeHtml,
  kindLabel,
  createViewMachine,
  cardHtml,
} from "../src/triage-state.js";

function card(id, overrides = {}) {
  return {
    id,
    kind: "review_request",
    state: "new",
    actorLabel: "tab",
    claimId: "c1",
    prRef: "https://github.com/Uuriko/project-room/pull/1728",
    headSha: "7e1634a1",
    priority: 87,
    priorityWhy: ["ci_success_exact_head:+30", "designated_verifier:+15"],
    sourceSeq: 6142,
    sourceType: "REVIEW_REQUESTED",
    summary: "REVIEW requested — PR #1728 at head 7e1634a1",
    undoDeadline: null,
    undoable: true,
    snoozedUntil: null,
    urgent: true,
    staleNote: null,
    suggested: [
      { rank: 1, label: "Post APPROVE on this head", actionType: "review_verdict",
        gate: "retractable", gateNote: "↩ retractable — 6s to take back",
        payload: { claimId: "c1", verdict: "approve", headSha: "7e1634a1" },
        reason: "CI green at 7e1634a1; lander rule: approve binds the exact head", draft: null },
      { rank: 2, label: "Merge the PR", actionType: "merge", gate: "confirm",
        gateNote: "⚠ confirm — cannot be undone",
        payload: { claimId: "c1" }, reason: "land it now", draft: null },
    ],
    pickedAction: null,
    receipt: null,
    updatedAt: 1728000000000,
    deepLink: "#room/r1/claim/c1",
    ...overrides,
  };
}
const byId = (ids, overrides = {}) => new Map(ids.map(id => [id, card(id, overrides)]));
const ctx = (ids, extra = {}) => ({ order: ids, cards: byId(ids), viewFocused: true, textFieldFocused: false, pendingUndoCardId: null, ...extra });

// ---------- grace config ----------

test("clampGraceSeconds: default 6s, range 0–10s", () => {
  assert.equal(DEFAULT_GRACE_SECONDS, 6);
  assert.equal(MAX_GRACE_SECONDS, 10);
  assert.equal(clampGraceSeconds(6), 6);
  assert.equal(clampGraceSeconds(0), 0);       // 0 disables the window
  assert.equal(clampGraceSeconds(10), 10);
  assert.equal(clampGraceSeconds(99), 10);     // clamped
  assert.equal(clampGraceSeconds(-3), 0);      // clamped
  assert.equal(clampGraceSeconds(undefined), 6);
  assert.equal(clampGraceSeconds("nope"), 6);
});

// ---------- key machine: movement + focus-implies-seen ----------

test("J moves focus to the next id and wraps at the end", () => {
  const m = createViewMachine();
  m.applySnapshot(["a", "b", "c"]);
  assert.equal(m.focusedId(), "a");
  const next = m.handleKey("j", ctx(["a", "b", "c"]));
  assert.equal(next.type, "focus");
  assert.equal(next.cardId, "b");
  m.applySnapshot(["a", "b", "c"]);
  // wrap: c -> a
  m.setFocus("c", ["a", "b", "c"]);
  const wrapped = m.handleKey("j", ctx(["a", "b", "c"]));
  assert.equal(wrapped.cardId, "a");
});

test("K moves to the previous id and wraps at the start", () => {
  const m = createViewMachine();
  m.applySnapshot(["a", "b", "c"]);
  const prev = m.handleKey("k", ctx(["a", "b", "c"]));
  assert.equal(prev.type, "focus");
  assert.equal(prev.cardId, "c");
});

test("J on an empty order is a noop", () => {
  const m = createViewMachine();
  m.applySnapshot([]);
  assert.equal(m.handleKey("j", ctx([])).type, "noop");
});

test("J/K landing on a new card journals seen exactly once", () => {
  const m = createViewMachine();
  m.applySnapshot(["a", "b"]);
  const first = m.handleKey("j", ctx(["a", "b"]));
  assert.equal(first.type, "focus");
  assert.equal(first.journalSeen, true);
  m.markSeenJournaled("b");
  m.setFocus("b", ["a", "b"]);
  m.setFocus("a", ["a", "b"]);
  const again = m.handleKey("j", ctx(["a", "b"]));
  assert.equal(again.journalSeen, false, "re-landing must not re-journal");
});

test("J/K landing on an already-seen card does not journal", () => {
  const m = createViewMachine();
  m.applySnapshot(["a", "b"]);
  const seen = ctx(["a", "b"], { cards: byId(["a", "b"], { state: "seen" }) });
  const mv = m.handleKey("j", seen);
  assert.equal(mv.journalSeen, false);
});

// ---------- type-ahead safety ----------

test("keys are dead unless the view is focused", () => {
  const m = createViewMachine();
  m.applySnapshot(["a"]);
  assert.equal(m.handleKey("j", ctx(["a"], { viewFocused: false })).type, "noop");
  assert.equal(m.handleKey("e", ctx(["a"], { viewFocused: false })).type, "noop");
  assert.equal(m.handleKey("1", ctx(["a"], { viewFocused: false })).type, "noop");
});

test("keys are dead while a text field has focus", () => {
  const m = createViewMachine();
  m.applySnapshot(["a"]);
  assert.equal(m.handleKey("j", ctx(["a"], { textFieldFocused: true })).type, "noop");
  assert.equal(m.handleKey("e", ctx(["a"], { textFieldFocused: true })).type, "noop");
  assert.equal(m.handleKey("?", ctx(["a"], { textFieldFocused: true })).type, "noop");
});

test("keys are dead while a sheet is open; only Esc closes it", () => {
  const m = createViewMachine();
  m.applySnapshot(["a"]);
  m.openSheet("snooze_picker", "a");
  assert.equal(m.mode(), "sheet");
  assert.equal(m.handleKey("j", ctx(["a"])).type, "noop");
  assert.equal(m.handleKey("e", ctx(["a"])).type, "noop");
  const esc = m.handleKey("Escape", ctx(["a"]));
  assert.equal(esc.type, "close-sheet");
  assert.equal(m.mode(), "list");
});

// ---------- E / dismiss ----------

test("E dismisses an active card", () => {
  const m = createViewMachine();
  m.applySnapshot(["a", "b"]);
  const intent = m.handleKey("e", ctx(["a", "b"]));
  assert.equal(intent.type, "dismiss");
  assert.equal(intent.cardId, "a");
});

test("E is refused on non-dismissable states", () => {
  const m = createViewMachine();
  for (const state of ["pending_undo", "acting", "dispatched", "dismissed", "resolved"]) {
    m.applySnapshot(["a"]);
    const c = ctx(["a"], { cards: byId(["a"], { state }) });
    assert.equal(m.handleKey("e", c).type, "noop", `E must be a noop on ${state}`);
  }
});

test("E with no focused card is a noop", () => {
  const m = createViewMachine();
  m.applySnapshot([]);
  assert.equal(m.handleKey("e", ctx([])).type, "noop");
});

// ---------- 1/2 / pick ----------

test("1/2 pick the ranked suggestion; missing ranks are noops", () => {
  const m = createViewMachine();
  m.applySnapshot(["a"]);
  assert.deepEqual(m.handleKey("1", ctx(["a"])), { type: "pick", cardId: "a", rank: 1 });
  assert.deepEqual(m.handleKey("2", ctx(["a"])), { type: "pick", cardId: "a", rank: 2 });
  assert.equal(m.handleKey("3", ctx(["a"])).type, "noop");
  const one = ctx(["a"], { cards: byId(["a"], { suggested: [card("a").suggested[0]] }) });
  assert.equal(m.handleKey("2", one).type, "noop");
});

test("1/2 are refused while the card is mid-dispatch", () => {
  const m = createViewMachine();
  m.applySnapshot(["a"]);
  for (const state of ["pending_undo", "acting", "dispatched", "dismissed", "stale"]) {
    const c = ctx(["a"], { cards: byId(["a"], { state }) });
    assert.equal(m.handleKey("1", c).type, "noop", `pick must be a noop on ${state}`);
  }
});

// ---------- S / snooze ----------

test("S opens the snooze picker sheet", () => {
  const m = createViewMachine();
  m.applySnapshot(["a"]);
  const intent = m.handleKey("s", ctx(["a"]));
  assert.equal(intent.type, "snooze-sheet");
  assert.equal(intent.cardId, "a");
  assert.equal(m.sheetKind(), "snooze_picker");
});

test("S is refused on non-active cards", () => {
  const m = createViewMachine();
  m.applySnapshot(["a"]);
  const c = ctx(["a"], { cards: byId(["a"], { state: "dispatched" }) });
  assert.equal(m.handleKey("s", c).type, "noop");
});

// ---------- U / Esc / retract ----------

test("U retracts a focused pending_undo card", () => {
  const m = createViewMachine();
  m.applySnapshot(["a"]);
  const c = ctx(["a"], { cards: byId(["a"], { state: "pending_undo" }) });
  assert.deepEqual(m.handleKey("u", c), { type: "retract", cardId: "a" });
});

test("U is a noop when the focused card is not pending_undo", () => {
  const m = createViewMachine();
  m.applySnapshot(["a"]);
  assert.equal(m.handleKey("u", ctx(["a"])).type, "noop");
});

test("Esc retracts pending_undo with precedence over sheet-close", () => {
  const m = createViewMachine();
  m.applySnapshot(["a"]);
  const c = ctx(["a"], { cards: byId(["a"], { state: "pending_undo" }) });
  assert.equal(m.handleKey("Escape", c).type, "retract");
});

// ---------- R / refetch ----------

test("R refetches the focused card", () => {
  const m = createViewMachine();
  m.applySnapshot(["a"]);
  assert.deepEqual(m.handleKey("r", ctx(["a"])), { type: "refetch", cardId: "a" });
});

// ---------- Enter / deep link ----------

test("Enter opens the card deep link without state change", () => {
  const m = createViewMachine();
  m.applySnapshot(["a"]);
  assert.deepEqual(m.handleKey("Enter", ctx(["a"])), { type: "open-deep-link", cardId: "a" });
  const noLink = ctx(["a"], { cards: byId(["a"], { deepLink: null }) });
  assert.equal(m.handleKey("Enter", noLink).type, "noop");
});

// ---------- ? / help ----------

test("? toggles the help overlay; other keys are dead while open", () => {
  const m = createViewMachine();
  m.applySnapshot(["a"]);
  assert.equal(m.handleKey("?", ctx(["a"])).type, "help");
  assert.equal(m.mode(), "help");
  assert.equal(m.handleKey("j", ctx(["a"])).type, "noop");
  assert.equal(m.handleKey("?", ctx(["a"])).type, "close-help");
  assert.equal(m.mode(), "list");
  m.handleKey("?", ctx(["a"]));
  assert.equal(m.handleKey("Escape", ctx(["a"])).type, "close-help");
});

// ---------- focus keying + neighbor fallover ----------

test("applySnapshot keeps focus on the same card id across reorders", () => {
  const m = createViewMachine();
  m.applySnapshot(["a", "b", "c"]);
  m.setFocus("b", ["a", "b", "c"]);
  const r = m.applySnapshot(["c", "a", "b"]);   // reorder
  assert.equal(r.focusedId, "b");
  assert.equal(r.moved, false);
});

test("inserts above the focus never move it", () => {
  const m = createViewMachine();
  m.applySnapshot(["a", "b"]);
  m.setFocus("b", ["a", "b"]);
  const r = m.applySnapshot(["x", "y", "a", "b"]);
  assert.equal(r.focusedId, "b");
});

test("removed focus falls to the same index, else index-1", () => {
  const m = createViewMachine();
  m.applySnapshot(["a", "b", "c", "d"]);
  m.setFocus("b", ["a", "b", "c", "d"]);   // index 1
  let r = m.applySnapshot(["a", "c", "d"]); // b removed -> same index = "c"
  assert.equal(r.focusedId, "c");
  m.setFocus("d", ["a", "c", "d"]);          // index 2 (last)
  r = m.applySnapshot(["a", "c"]);           // d removed -> index-1 = "c"
  assert.equal(r.focusedId, "c");
});

test("applySnapshot on an empty order clears focus", () => {
  const m = createViewMachine();
  m.applySnapshot(["a"]);
  const r = m.applySnapshot([]);
  assert.equal(r.focusedId, null);
  assert.equal(m.focusedId(), null);
});

test("initial focus lands on the first card", () => {
  const m = createViewMachine();
  m.applySnapshot(["x", "y"]);
  assert.equal(m.focusedId(), "x");
});

// ---------- rendering: sanitizer, badges, banners ----------

test("cardHtml escapes every pane-derived string", () => {
  const evil = card("a", {
    actorLabel: "<img src=x onerror=alert(1)>",
    summary: "<script>alert('summary')</script>",
    staleNote: "<b>stale</b>",
    receipt: "<i>rc</i>",
    priorityWhy: ["<svg onload=x>:+30"],
    suggested: [{ rank: 1, label: "<u>do it</u>", actionType: "acknowledge",
      gate: "retractable", gateNote: "<marquee>note</marquee>",
      payload: {}, reason: "<style>pwn</style>", draft: null }],
  });
  const html = cardHtml(evil, { focused: true });
  for (const raw of ["<script>", "<img", "<svg", "<marquee>", "<style>", "<u>", "<b>", "<i>"]) {
    assert.equal(html.includes(raw), false, `raw ${raw} must not appear`);
  }
  assert.ok(html.includes("&lt;script&gt;"));
});

test("cardHtml renders honesty badges and reason lines before the pick", () => {
  const html = cardHtml(card("a"), { focused: true });
  assert.ok(html.includes("↩ retractable — 6s to take back"), "retractable badge");
  assert.ok(html.includes("⚠ confirm — cannot be undone"), "confirm-only badge");
  assert.ok(html.includes("CI green at 7e1634a1; lander rule: approve binds the exact head"), "reason line");
});

test("cardHtml renders priorityWhy chips and the seq-staleness banner", () => {
  const html = cardHtml(card("a"), { focused: false });
  assert.ok(html.includes("ci_success_exact_head:+30"));
  assert.ok(html.includes("designated_verifier:+15"));
  assert.ok(html.includes("as of seq 6142"), "seq anchor");
  assert.ok(html.includes("#room/r1/claim/c1"), "deep link");
});

test("cardHtml renders the stale banner when the card went stale", () => {
  const html = cardHtml(card("a", { state: "stale", staleNote: "resolved elsewhere at seq 6200" }), {});
  assert.ok(html.includes("resolved elsewhere at seq 6200"));
});

test("cardHtml shows the countdown slot for pending_undo cards", () => {
  const html = cardHtml(card("a", { state: "pending_undo", undoDeadline: Date.now() + 6000 }), {});
  assert.ok(html.includes("data-countdown"), "countdown slot present");
  assert.ok(html.includes("pending_undo"));
});

test("cardHtml marks interrupt-class cards and never offers a raw view", () => {
  const html = cardHtml(card("a", { urgent: true }), {});
  assert.ok(html.includes("urgent") || html.includes("interrupt"), "urgent marker");
  assert.equal(/view.?raw/i.test(html), false, "no raw-view toggle (D1 requirement)");
});

test("kindLabel names every card kind; unknown kinds pass through escaped", () => {
  assert.equal(kindLabel("review_request"), "Review request");
  assert.equal(kindLabel("blocked_lane"), "Blocked lane");
  assert.equal(kindLabel("done_receipt"), "Done receipt");
  assert.equal(kindLabel("needs_input"), "Needs input");
  assert.ok(!kindLabel("<script>").includes("<script>"));
});

test("escapeHtml neutralizes markup", () => {
  assert.equal(escapeHtml("<script>alert(1)</script>"), "&lt;script&gt;alert(1)&lt;/script&gt;");
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(42), "42");
});

// The flag-off contract: with B17's src/supervision-client.js unlanded, the
// triage view must report unavailable so app.js keeps it hidden (zero impact).
test("triageAvailable is false while the B17 data layer has not landed", async () => {
  const { triageAvailable } = await import("../src/triage-ui.js");
  assert.equal(
    await triageAvailable({ getRoom: () => ({ room: { id: "r1" } }), getSession: () => ({ member: { id: "m1" } }) }),
    false);
});
