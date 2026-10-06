// Agent first-run mount fallbacks (src/agent-first-run.js).
// tests/agent-signin-onboarding.test.js owns the card content and step
// behavior with an explicit container; this file owns the uncovered
// branches: mounting without a container (#main, then body) and mounting
// with no arguments at all (every step handler optional).
import test from "node:test";
import assert from "node:assert/strict";
import { mountAgentFirstRun, agentFirstRunSeen } from "../src/agent-first-run.js";

function installDom(t, { main = false } = {}) {
  const storage = new Map();
  function fakeElement(tag) {
    const el = {
      tagName: String(tag).toUpperCase(),
      children: [], texts: [], handlers: {}, dataset: {}, removed: false,
      id: "", className: "", innerHTML: "", textContent: "", hidden: false, type: "",
      href: "", target: "", rel: "",
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute() {},
      appendChild(child) { el.children.push(child); return child; },
      append(...kids) { for (const k of kids) (typeof k === "string" ? el.texts : el.children).push(k); },
      addEventListener(type, fn) { el.handlers[type] = fn; },
      remove() { el.removed = true; },
      querySelector() { return null; },
      fireClick(step) {
        el.handlers.click?.({ target: { closest: (sel) => sel === "[data-step]" ? { dataset: { step } } : null } });
      }
    };
    return el;
  }
  const body = fakeElement("body");
  const mainEl = main ? fakeElement("main") : null;
  const globals = {
    document: {
      createElement: fakeElement,
      body,
      querySelector: (sel) => (sel === "#main" ? mainEl : null),
    },
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k)
    }
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  return { body, mainEl, storage };
}

test("mount falls back to #main when no container is given", (t) => {
  const { body, mainEl } = installDom(t, { main: true });
  const card = mountAgentFirstRun({ actions: {} });
  assert.ok(card, "mounts");
  assert.ok(mainEl.children.includes(card), "card lands in #main");
  assert.ok(!body.children.includes(card));
});

test("mount falls back to body when #main is absent", (t) => {
  const { body } = installDom(t);
  const card = mountAgentFirstRun({ actions: {} });
  assert.ok(card, "mounts");
  assert.ok(body.children.includes(card), "card lands in body");
});

test("mount with no arguments works; every step handler is optional", (t) => {
  installDom(t);
  const card = mountAgentFirstRun();
  assert.ok(card, "mounts without container or actions");
  card.fireClick("greet"); // actions?.[step]?.() must not throw
  assert.equal(card.removed, true, "greet dismisses");
  assert.equal(agentFirstRunSeen(), true, "dismissal marks seen");
});
