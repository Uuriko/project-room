// BU-14: board keyboard + power-user flow. Fail-first tests for
// src/board-keyboard.mjs — j/k card navigation on the work-claims board.
//
// The module does not exist yet, so every import below must fail RED before
// the implementation lands; all tests must pass GREEN after.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cardNavIndex,
  isEditableTarget,
  shouldHandleBoardKey,
  attachBoardKeyboard,
} from "../src/board-keyboard.mjs";

// --- cardNavIndex: pure navigation math, no DOM ---

test("cardNavIndex: j from nothing focused lands on the first card", () => {
  assert.equal(cardNavIndex(5, -1, 1), 0);
  assert.equal(cardNavIndex(5, undefined, 1), 0);
});

test("cardNavIndex: j advances, k retreats", () => {
  assert.equal(cardNavIndex(5, 0, 1), 1);
  assert.equal(cardNavIndex(5, 3, -1), 2);
  assert.equal(cardNavIndex(1, 0, 1), 0);
});

test("cardNavIndex: clamps at both ends instead of wrapping", () => {
  assert.equal(cardNavIndex(5, 0, -1), 0);
  assert.equal(cardNavIndex(5, 4, 1), 4);
});

test("cardNavIndex: empty board is a no-op", () => {
  assert.equal(cardNavIndex(0, -1, 1), -1);
  assert.equal(cardNavIndex(0, 2, -1), -1);
});

// --- isEditableTarget: typing must never trigger navigation ---

test("isEditableTarget flags text-entry controls", () => {
  for (const tag of ["INPUT", "TEXTAREA", "SELECT"]) {
    assert.equal(isEditableTarget({ tagName: tag, isContentEditable: false }), true, tag);
  }
  assert.equal(isEditableTarget({ tagName: "DIV", isContentEditable: true }), true);
});

test("isEditableTarget leaves buttons and plain containers alone", () => {
  // Focus on a Claim button + j = jump to next card: the power-user flow.
  assert.equal(isEditableTarget({ tagName: "BUTTON", isContentEditable: false }), false);
  assert.equal(isEditableTarget({ tagName: "DIV", isContentEditable: false }), false);
  assert.equal(isEditableTarget(null), false);
});

// --- shouldHandleBoardKey: the guard the listener consults ---

const keyEvent = (over = {}) => ({
  key: "j", ctrlKey: false, metaKey: false, altKey: false, isComposing: false,
  defaultPrevented: false, target: { tagName: "DIV", isContentEditable: false },
  preventDefault() { this.defaultPrevented = true; },
  ...over,
});

test("shouldHandleBoardKey accepts plain j/k outside editable targets", () => {
  assert.equal(shouldHandleBoardKey(keyEvent()), true);
  assert.equal(shouldHandleBoardKey(keyEvent({ key: "k" })), true);
});

test("shouldHandleBoardKey rejects modifiers, composing, and other keys", () => {
  assert.equal(shouldHandleBoardKey(keyEvent({ ctrlKey: true })), false);
  assert.equal(shouldHandleBoardKey(keyEvent({ metaKey: true })), false);
  assert.equal(shouldHandleBoardKey(keyEvent({ altKey: true })), false);
  assert.equal(shouldHandleBoardKey(keyEvent({ isComposing: true })), false);
  assert.equal(shouldHandleBoardKey(keyEvent({ key: "Enter" })), false);
  assert.equal(shouldHandleBoardKey(keyEvent({ key: "J" })), false);
});

test("shouldHandleBoardKey rejects editable targets", () => {
  assert.equal(shouldHandleBoardKey(keyEvent({ target: { tagName: "INPUT", isContentEditable: false } })), false);
  assert.equal(shouldHandleBoardKey(keyEvent({ target: { tagName: "TEXTAREA", isContentEditable: false } })), false);
});

// --- attachBoardKeyboard: wiring against a minimal fake DOM ---

function fakeCards(count, log) {
  // A fake DOM where focusing a heading updates activeElement the way a
  // browser does: activeElement.closest("article.claim-card").querySelector("h4").
  const state = { focused: null };
  const headings = [];
  for (let i = 0; i < count; i += 1) {
    const heading = { id: `h${i}`, focus() { state.focused = heading; log.push(heading.id); }, scrollIntoView() {} };
    headings.push(heading);
  }
  const doc = { get activeElement() {
    if (!state.focused) return null;
    return { closest: () => ({ querySelector: () => state.focused }) };
  } };
  return { headings, doc };
}
function fakeRoot(headings) {
  const listeners = new Map();
  return {
    dataset: {},
    querySelectorAll: selector => (selector === "article.claim-card h4" ? headings : []),
    addEventListener: (type, fn) => listeners.set(type, fn),
    emit: (type, event) => listeners.get(type)?.(event),
    listenerCount: () => listeners.size,
  };
}

test("attachBoardKeyboard: j/k move focus across card headings and clamp at the ends", () => {
  const log = [];
  const { headings, doc } = fakeCards(3, log);
  const root = fakeRoot(headings);
  assert.equal(attachBoardKeyboard(root, doc), true);
  root.emit("keydown", keyEvent());
  assert.deepEqual(log, ["h0"]);
  root.emit("keydown", keyEvent());
  assert.deepEqual(log, ["h0", "h1"]);
  root.emit("keydown", keyEvent({ key: "k" }));
  assert.deepEqual(log, ["h0", "h1", "h0"]);
  root.emit("keydown", keyEvent({ key: "k" }));
  assert.deepEqual(log, ["h0", "h1", "h0", "h0"]); // clamped at the first card
});

test("attachBoardKeyboard: is idempotent — repaints and reinstalls add no listener", () => {
  const log = [];
  const { headings, doc } = fakeCards(1, log);
  const root = fakeRoot(headings);
  assert.equal(attachBoardKeyboard(root, doc), true);
  assert.equal(attachBoardKeyboard(root, doc), false);
  assert.equal(root.listenerCount(), 1);
});

test("attachBoardKeyboard: ignores keydown inside text inputs", () => {
  const log = [];
  const { headings, doc } = fakeCards(1, log);
  const root = fakeRoot(headings);
  attachBoardKeyboard(root, doc);
  const event = keyEvent({ target: { tagName: "INPUT", isContentEditable: false } });
  root.emit("keydown", event);
  assert.deepEqual(log, []);
  assert.equal(event.defaultPrevented, false);
});

test("attachBoardKeyboard: no-op without a board root", () => {
  const { doc } = fakeCards(0, []);
  assert.equal(attachBoardKeyboard(null, doc), false);
});

// --- CSS: the programmatically focused heading must show a visible ring ---

test("public-a11y.css gives claim-card headings a visible keyboard focus ring", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const css = readFileSync(join(here, "..", "src", "public-a11y.css"), "utf8");
  assert.match(css, /\.claim-card h4:focus-visible\s*\{[^}]*outline:/,
    "claim-card h4 (tabindex=-1 focus target after re-render and for j/k nav) needs a :focus-visible outline");
});
