// Fail-first tests for src/dialog-tab-trap.mjs.
//
// BUG: the board's j/k navigation focuses a claim-card heading (h4 with
// tabindex="-1"). The board dialog's focus trap then treats that heading as
// "focus outside the tabbable controls" and wraps Tab to the FIRST control of
// the dialog — the keyboard user loses their card and can never Tab from the
// j/k-navigated card into that card's own action buttons (Claim, Renew, Done,
// Release). Expected: Tab continues tab order from the heading (the card's
// first action); Shift+Tab goes to the previous control before it.
// Wrap-at-the-edges behavior for real controls must not change.
//
// Minimal DOM doubles only (same style as tests/review-focus-regression.test.js):
// this is not browser/visual evidence.
import test from "node:test";
import assert from "node:assert/strict";
import { handleDialogTabKey, tabControls } from "../src/dialog-tab-trap.mjs";

const FOLLOWING = 4; // Node.DOCUMENT_POSITION_FOLLOWING
const PRECEDING = 2; // Node.DOCUMENT_POSITION_PRECEDING

function fixture() {
  const doc = { activeElement: null };
  // Document order: [filterBtn, cardHeading(h4), claimBtn, renewBtn].
  const nodes = [];
  function node(tag, { tabindex = null, visible = true } = {}) {
    const el = {
      tagName: tag,
      tabIndexAttr: tabindex,
      index: nodes.length,
      focused: false,
      focus() { doc.activeElement = this; this.focused = true; },
      getClientRects() { return visible ? [{}] : []; },
      compareDocumentPosition(other) {
        if (this.index < other.index) return FOLLOWING; // other follows this
        if (this.index > other.index) return PRECEDING; // other precedes this
        return 0;
      },
      contains(other) { return other != null && other.dialogRoot === true; },
    };
    nodes.push(el);
    return el;
  }
  const filterBtn = node("button");
  const heading = node("h4", { tabindex: "-1" });
  const claimBtn = node("button");
  const renewBtn = node("button");
  for (const n of nodes) n.dialogRoot = true;
  const dialog = {
    dialogRoot: true,
    focused: false,
    focus() { doc.activeElement = this; this.focused = true; },
    contains(other) { return other != null && other.dialogRoot === true; },
    querySelectorAll() {
      // Mirror the trap's tabbable selector, in document order.
      return nodes.filter(n =>
        n.tagName === "button" ||
        (n.tabIndexAttr !== null && n.tabIndexAttr !== "-1")
      );
    },
  };
  return { doc, dialog, filterBtn, heading, claimBtn, renewBtn };
}

const tabKey = (over = {}) => ({
  key: "Tab", shiftKey: false, defaultPrevented: false,
  preventDefault() { this.defaultPrevented = true; },
  ...over,
});

test("Tab from a j/k-focused card heading reaches that card's first action", () => {
  const f = fixture();
  f.doc.activeElement = f.heading; // j/k put focus here (tabindex="-1")
  const event = tabKey();
  handleDialogTabKey(event, { dialog: f.dialog, document: f.doc });
  assert.equal(event.defaultPrevented, true);
  assert.equal(f.doc.activeElement, f.claimBtn, "must land on the card's Claim button, not the dialog header");
});

test("Shift+Tab from a card heading goes to the previous control", () => {
  const f = fixture();
  f.doc.activeElement = f.heading;
  const event = tabKey({ shiftKey: true });
  handleDialogTabKey(event, { dialog: f.dialog, document: f.doc });
  assert.equal(event.defaultPrevented, true);
  assert.equal(f.doc.activeElement, f.filterBtn, "must land on the filter control before the heading");
});

test("wrap-at-the-edges for real controls is unchanged", () => {
  const f = fixture();
  f.doc.activeElement = f.renewBtn;
  const event = tabKey();
  handleDialogTabKey(event, { dialog: f.dialog, document: f.doc });
  assert.equal(event.defaultPrevented, true);
  assert.equal(f.doc.activeElement, f.filterBtn);
});

test("Shift+Tab from the first control wraps to the last", () => {
  const f = fixture();
  f.doc.activeElement = f.filterBtn;
  const event = tabKey({ shiftKey: true });
  handleDialogTabKey(event, { dialog: f.dialog, document: f.doc });
  assert.equal(event.defaultPrevented, true);
  assert.equal(f.doc.activeElement, f.renewBtn);
});

test("Tab mid-list on a real control is left to the browser", () => {
  const f = fixture();
  f.doc.activeElement = f.claimBtn;
  const event = tabKey();
  handleDialogTabKey(event, { dialog: f.dialog, document: f.doc });
  assert.equal(event.defaultPrevented, false, "native tab order must not be swallowed");
  assert.equal(f.doc.activeElement, f.claimBtn);
});

test("focus outside the dialog still wraps to the dialog header", () => {
  const f = fixture();
  f.doc.activeElement = { dialogRoot: false, focus() {} };
  const event = tabKey();
  handleDialogTabKey(event, { dialog: f.dialog, document: f.doc });
  assert.equal(event.defaultPrevented, true);
  assert.equal(f.doc.activeElement, f.filterBtn);
});

test("tabControls lists visible tabbable controls in document order", () => {
  const f = fixture();
  const controls = tabControls(f.dialog);
  assert.deepEqual(controls, [f.filterBtn, f.claimBtn, f.renewBtn]);
});
