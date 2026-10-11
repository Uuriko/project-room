// Dialog Tab-trap decision (src/dialog-focus-trap.mjs), used by the keydown
// trap on every modal dialog in src/app.js (invitation, work, action,
// board, …).
//
// Fail-first for the board focus bug: j/k card navigation
// (src/board-keyboard.mjs) and board-ui.js's focus restore after an action
// both leave focus on a claim-card h4 — tabindex=-1, so it is inside the
// dialog but NOT a tabbable control. The old trap treated "not a tabbable
// control" as "focus left the dialog" and yanked Tab to the first/last
// control, so a keyboard user pressing Tab after j/k was teleported to the
// top of the dialog instead of continuing from the card. The trap must only
// wrap when focus has actually left the dialog.
import test from "node:test";
import assert from "node:assert/strict";
import { tabTarget } from "../src/dialog-focus-trap.mjs";

const el = id => ({ id });
function fakeDialog(...inside) {
  const set = new Set(inside);
  return { contains: node => set.has(node) };
}

test("tabTarget: wraps last→first and first→last on shift", () => {
  const b1 = el("b1"), b2 = el("b2"), b3 = el("b3");
  const dialog = fakeDialog(b1, b2, b3);
  assert.deepEqual(tabTarget([b1, b2, b3], dialog, b3, false), { wrap: true, target: b1 });
  assert.deepEqual(tabTarget([b1, b2, b3], dialog, b1, true), { wrap: true, target: b3 });
});

test("tabTarget: middle controls let Tab flow naturally", () => {
  const b1 = el("b1"), b2 = el("b2"), b3 = el("b3");
  const dialog = fakeDialog(b1, b2, b3);
  assert.deepEqual(tabTarget([b1, b2, b3], dialog, b2, false), { wrap: false, target: null });
  assert.deepEqual(tabTarget([b1, b2, b3], dialog, b2, true), { wrap: false, target: null });
});

test("tabTarget: focus on a j/k-navigated card heading stays put", () => {
  // The heading is inside the dialog but is not a tabbable control
  // (tabindex=-1); Tab must continue from the card's DOM position instead of
  // teleporting to the first/last control.
  const b1 = el("b1"), b2 = el("b2"), heading = el("card-h4");
  const dialog = fakeDialog(b1, b2, heading);
  assert.deepEqual(tabTarget([b1, b2], dialog, heading, false), { wrap: false, target: null });
  assert.deepEqual(tabTarget([b1, b2], dialog, heading, true), { wrap: false, target: null });
});

test("tabTarget: focus that left the dialog wraps back in", () => {
  const b1 = el("b1"), b2 = el("b2"), outside = el("body");
  const dialog = fakeDialog(b1, b2);
  assert.deepEqual(tabTarget([b1, b2], dialog, outside, false), { wrap: true, target: b1 });
  assert.deepEqual(tabTarget([b1, b2], dialog, outside, true), { wrap: true, target: b2 });
});

test("tabTarget: null active element wraps to the first control", () => {
  const b1 = el("b1"), b2 = el("b2");
  const dialog = fakeDialog(b1, b2);
  assert.deepEqual(tabTarget([b1, b2], dialog, null, false), { wrap: true, target: b1 });
});

test("tabTarget: a dialog with no tabbable controls reports no target", () => {
  const dialog = fakeDialog();
  assert.deepEqual(tabTarget([], dialog, el("body"), false), { wrap: true, target: null });
});
