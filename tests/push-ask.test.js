// Push soft ask display bugs (wave500 g3d10). mountPushAsk is DOM-backed;
// these tests run it against a minimal stub document.
import test from "node:test";
import assert from "node:assert/strict";
import { mountPushAsk, pushAskDecision, PUSH_ASK_COPY } from "../src/push-ask.js";

function makeElement(tag) {
  const listeners = new Map();
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    parent: null,
    id: "",
    hidden: false,
    textContent: "",
    type: "",
    append(...nodes) { for (const n of nodes) { n.parent = el; el.children.push(n); } },
    remove() {
      if (el.parent) {
        el.parent.children = el.parent.children.filter(c => c !== el);
        el.parent = null;
      }
    },
    addEventListener(name, fn) { listeners.set(name, fn); },
    fire(name) { return listeners.get(name)?.(); },
    count(id) { return el.children.filter(c => c.id === id).length; }
  };
  return el;
}

function stubDocument() {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true, writable: true,
    value: { createElement: tag => makeElement(tag) }
  });
  return { restore() {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else delete globalThis.document;
  } };
}

function stubNotification(present) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "Notification");
  if (present) {
    Object.defineProperty(globalThis, "Notification", {
      configurable: true, writable: true, value: { permission: "default" }
    });
  } else {
    delete globalThis.Notification;
  }
  return { restore() {
    if (previous) Object.defineProperty(globalThis, "Notification", previous);
    else delete globalThis.Notification;
  } };
}

const storage = () => {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); }
  };
};

test("mounting twice leaves exactly one ask prompt in the dock", () => {
  const { restore } = stubDocument();
  try {
    const dock = makeElement("div");
    const opts = () => ({ dock, storage: storage(), permission: () => "default" });
    const first = mountPushAsk(opts());
    const second = mountPushAsk(opts());
    assert.equal(first.root.children[0].textContent, PUSH_ASK_COPY);
    assert.equal(dock.count("push-soft-ask"), 1, "a second mount must not stack a duplicate prompt");
    assert.equal(dock.children[0], second.root);
    assert.equal(first.root.parent, null, "the replaced mount is detached, not lingering");
  } finally { restore(); }
});

test("a throwing subscribe still clears the ask after the tap", async () => {
  const { restore } = stubDocument();
  const { restore: restoreNotif } = stubNotification(true);
  try {
    const dock = makeElement("div");
    const ask = mountPushAsk({
      dock,
      storage: storage(),
      permission: () => "default",
      requestPermission: async () => "granted",
      subscribe: async () => { throw new Error("push backend down"); }
    });
    ask.showFor({ needsMe: true });
    assert.equal(ask.root.hidden, false);
    const turnOn = ask.root.children[1];
    assert.equal(turnOn.textContent, "Turn on");
    await turnOn.fire("click").catch(() => {});
    assert.equal(ask.root.hidden, true, "the handled ask clears even when subscribe throws");
  } finally { restoreNotif(); restore(); }
});

test("the ask never shows when the Notification API is absent", () => {
  const { restore: restoreDoc } = stubDocument();
  const { restore: restoreNotif } = stubNotification(false);
  try {
    const dock = makeElement("div");
    // Default permission getter: `globalThis.Notification?.permission ?? "default"`.
    const ask = mountPushAsk({ dock, storage: storage() });
    const decision = ask.showFor({ needsMe: true });
    assert.deepEqual(decision, { show: false });
    assert.equal(ask.root.hidden, true, "asking on a browser that can never grant would loop forever");
  } finally { restoreNotif(); restoreDoc(); }
});

test("pushAskDecision stays silent without notification support, defaults to supported", () => {
  const now = Date.now();
  assert.deepEqual(pushAskDecision({ now, needsMe: true, supported: false }), { show: false });
  assert.deepEqual(pushAskDecision({ now, needsMe: true }), { show: true });
});
