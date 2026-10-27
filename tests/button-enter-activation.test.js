// UT27 14-1 (lane 14-a11y F1, RENDERED in prod): buttons did not activate
// on Enter — offer cards and the agent-sign-in Continue button fired zero
// requests under synthesized Enter key events, while Space and click
// worked. The buttons are native <button>s; a hardware Enter activates
// them natively, but an Enter that arrives without the native activation
// step (synthesized key events from assistive/automation drivers — the
// shape lane 14 measured) produces no click, and the app binds activation
// to click.
//
// src/button-enter-activation.js is the rescue: after an Enter keydown on
// a button, if no click arrived, it fires click() exactly once; if native
// activation already clicked, it stays inert. These tests model BOTH
// worlds with a fake DOM. On the pre-fix tree the module does not exist,
// so every test here fails at import (fail-first, cf.
// tests/board-keyboard-nav.test.js).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { enterActivatable, installButtonEnterActivation } from "../src/button-enter-activation.js";

// --- Fake DOM -------------------------------------------------------------
// A button's click() dispatches a click event on the document, like a real
// one. dispatchKeydown models the two Enter worlds: native (the browser
// fires click as the keydown default action) and synthesized (no click).
class FakeElement {
  constructor(doc, tagName, { type = "", disabled = false } = {}) {
    this.doc = doc; this.tagName = tagName; this.type = type; this.disabled = disabled;
    this.parent = null; this.clickCount = 0;
  }
  matches(selector) {
    return selector.split(",").some(part => {
      const rule = part.trim();
      if (rule === "button") return this.tagName === "BUTTON";
      const input = /^input\[type='(button|submit|reset)'\]$/.exec(rule);
      if (input) return this.tagName === "INPUT" && this.type === input[1];
      return false;
    });
  }
  closest(selector) {
    for (let el = this; el; el = el.parent) if (el.matches(selector)) return el;
    return null;
  }
  click() { this.clickCount++; this.doc.dispatchClick(this); }
}

class FakeDocument {
  constructor() { this.listeners = { click: [], keydown: [] }; }
  addEventListener(type, fn) { this.listeners[type].push(fn); }
  dispatchClick(target) {
    const event = { target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    for (const fn of this.listeners.click) fn(event);
    return event;
  }
  dispatchKeydown(target, { key = "Enter", nativeActivation = false } = {}) {
    const event = { key, target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    for (const fn of this.listeners.keydown) fn(event);
    // The native default action runs after dispatch, unless refused.
    if (nativeActivation && !event.defaultPrevented) {
      const el = enterActivatable(target);
      if (el) el.click();
    }
    return event;
  }
}

function harness() {
  const doc = new FakeDocument();
  const queue = [];
  const installed = installButtonEnterActivation(doc, { schedule: cb => queue.push(cb) });
  return { doc, installed, flush: () => { while (queue.length) queue.shift()(); } };
}
const button = doc => new FakeElement(doc, "BUTTON");

// --- The defect: synthesized Enter ----------------------------------------

test("synthesized Enter (no native click) activates a button exactly once", () => {
  const { doc, installed, flush } = harness();
  assert.equal(installed, true);
  const el = button(doc);
  doc.dispatchKeydown(el, { nativeActivation: false });
  assert.equal(el.clickCount, 0, "nothing fires during the keydown itself");
  flush();
  assert.equal(el.clickCount, 1, "the rescue fires the missing click exactly once");
});

test("synthesized Enter on a submit input activates it", () => {
  const { doc, flush } = harness();
  const el = new FakeElement(doc, "INPUT", { type: "submit" });
  doc.dispatchKeydown(el, { nativeActivation: false });
  flush();
  assert.equal(el.clickCount, 1);
});

test("Enter aimed at a child of a button activates the button", () => {
  const { doc, flush } = harness();
  const el = button(doc);
  const child = new FakeElement(doc, "SPAN");
  child.parent = el;
  doc.dispatchKeydown(child, { nativeActivation: false });
  flush();
  assert.equal(el.clickCount, 1);
});

// --- The guard: hardware Enter must never double-activate -----------------

test("native Enter activates exactly once — the rescue stays inert", () => {
  const { doc, flush } = harness();
  const el = button(doc);
  doc.dispatchKeydown(el, { nativeActivation: true });
  flush();
  assert.equal(el.clickCount, 1, "one click total, never two");
});

test("an Enter the app refused (preventDefault) is never rescued", () => {
  const { doc, flush } = harness();
  doc.addEventListener("keydown", event => event.preventDefault());
  const el = button(doc);
  doc.dispatchKeydown(el, { nativeActivation: false });
  flush();
  assert.equal(el.clickCount, 0);
});

test("a button disabled after the keydown is not rescued", () => {
  const { doc, flush } = harness();
  const el = button(doc);
  doc.dispatchKeydown(el, { nativeActivation: false });
  el.disabled = true;
  flush();
  assert.equal(el.clickCount, 0);
});

// --- Scope -----------------------------------------------------------------

test("non-Enter keys, disabled buttons, links and text inputs are untouched", () => {
  const { doc, flush } = harness();
  const el = button(doc);
  doc.dispatchKeydown(el, { key: " " });
  doc.dispatchKeydown(el, { key: "a" });
  flush();
  assert.equal(el.clickCount, 0, "Space and letters are not the rescue's business");
  const disabled = new FakeElement(doc, "BUTTON", { disabled: true });
  doc.dispatchKeydown(disabled, {});
  const link = new FakeElement(doc, "A");
  doc.dispatchKeydown(link, {});
  const text = new FakeElement(doc, "INPUT", { type: "text" });
  doc.dispatchKeydown(text, {});
  flush();
  assert.equal(disabled.clickCount, 0);
  assert.equal(link.clickCount, 0, "links activate natively on Enter and are left alone");
  assert.equal(text.clickCount, 0, "Enter in a text field belongs to the form, not the rescue");
});

test("installing twice on one document installs once", () => {
  const { doc } = harness();
  const queue = [];
  assert.equal(installButtonEnterActivation(doc, { schedule: cb => queue.push(cb) }), false);
  const el = button(doc);
  doc.dispatchKeydown(el, { nativeActivation: false });
  while (queue.length) queue.shift()();
  assert.equal(el.clickCount, 0, "the refused second install added no listener of its own");
});

test("enterActivatable resolves only enabled button-like controls", () => {
  const doc = new FakeDocument();
  assert.equal(enterActivatable(button(doc))?.tagName, "BUTTON");
  assert.equal(enterActivatable(new FakeElement(doc, "INPUT", { type: "button" }))?.type, "button");
  assert.equal(enterActivatable(new FakeElement(doc, "INPUT", { type: "text" })), null);
  assert.equal(enterActivatable(new FakeElement(doc, "BUTTON", { disabled: true })), null);
  assert.equal(enterActivatable(null), null);
  assert.equal(enterActivatable({}), null);
});

// --- Wiring pins -------------------------------------------------------------

test("the button-bearing entry points install the rescue and the asset ships", () => {
  const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  for (const entry of ["src/project-offers-ui.js", "src/agent-signin-page.js", "src/app.js"]) {
    const source = read(entry);
    assert.match(source, /from "\.\/button-enter-activation\.js"/, `${entry} imports the rescue`);
    assert.match(source, /installButtonEnterActivation\(\)/, `${entry} installs the rescue`);
  }
  assert.ok(read("server/public-assets.mjs").includes("button-enter-activation"),
    "the module is a registered public asset");
  assert.ok(read("scripts/runtime-package.mjs").includes("src/button-enter-activation.js"),
    "the module is in the runtime package asset list");
});
