// The push soft ask is mounted into the Notifications panel and supersedes
// the standalone opt-in button while visible (lane D2 mobile/PWA audit: the
// ask was built and tested but never mounted, so opt-in was undiscoverable).
// mountPushAsk is DOM-backed; these tests run it against a minimal stub
// document. applyPushAskVisibility is pure and tested with plain stubs.
import test from "node:test";
import assert from "node:assert/strict";
import { mountPushAsk, applyPushAskVisibility } from "../src/push-ask.js";

function makeElement() {
  const listeners = {};
  return {
    children: [],
    hidden: false,
    className: "",
    textContent: "",
    type: "",
    id: "",
    append(...nodes) { this.children.push(...nodes); },
    insertBefore(node, ref) {
      const at = this.children.indexOf(ref);
      this.children.splice(at === -1 ? this.children.length : at, 0, node);
    },
    addEventListener(type, fn) { listeners[type] = fn; },
    _listeners: listeners,
  };
}

function stubDocument() {
  const created = [];
  const document = { createElement: () => { const el = makeElement(); created.push(el); return el; } };
  const previous = globalThis.document;
  globalThis.document = document;
  return { created, restore() { globalThis.document = previous; } };
}

test("applyPushAskVisibility hides the standalone button only while the ask shows", () => {
  const shown = { showFor: () => ({ show: true }), root: { hidden: false } };
  const button = { hidden: false };
  const decision = applyPushAskVisibility({ ask: shown, button, needsMe: true });
  assert.equal(decision.show, true);
  assert.equal(button.hidden, true);

  const hidden = { showFor: () => ({ show: false }), root: { hidden: true } };
  const button2 = { hidden: false };
  applyPushAskVisibility({ ask: hidden, button: button2, needsMe: false });
  assert.equal(button2.hidden, false, "the standalone button stays when the ask stays hidden");

  const button3 = { hidden: false };
  const fallback = applyPushAskVisibility({ ask: null, button: button3, needsMe: true });
  assert.deepEqual(fallback, { show: false });
  assert.equal(button3.hidden, false);
});

test("applyPushAskVisibility passes needsMe through as a boolean", () => {
  const seen = [];
  const ask = { showFor: options => { seen.push(options); return { show: false }; } };
  applyPushAskVisibility({ ask, button: null, needsMe: 1 });
  assert.deepEqual(seen, [{ needsMe: true }]);
});

test("mountPushAsk inserts before the anchor when one is given", () => {
  const { restore } = stubDocument();
  try {
    const dock = makeElement();
    const anchor = makeElement();
    dock.append(anchor);
    const { root } = mountPushAsk({ dock, before: anchor, permission: () => "default" });
    assert.deepEqual(dock.children, [root, anchor]);
  } finally { restore(); }
});

test("mountPushAsk appends when no anchor is given, with panel button classes", () => {
  const { created, restore } = stubDocument();
  try {
    const dock = makeElement();
    const { root } = mountPushAsk({ dock, permission: () => "default" });
    assert.equal(dock.children.at(-1), root);
    const buttons = created.filter(el => el.type === "button");
    assert.deepEqual(buttons.map(button => button.className), ["button ghost", "text-button"]);
  } finally { restore(); }
});

test("Turn on requests permission then delegates to the existing subscribe flow", async () => {
  const { created, restore } = stubDocument();
  const calls = [];
  try {
    mountPushAsk({
      dock: makeElement(),
      permission: () => "default",
      requestPermission: async () => { calls.push("permission"); return "granted"; },
      subscribe: async () => { calls.push("subscribe"); },
    });
    const turnOn = created.find(el => el.textContent === "Turn on");
    await turnOn._listeners.click();
    assert.deepEqual(calls, ["permission", "subscribe"]);
  } finally { restore(); }
});
