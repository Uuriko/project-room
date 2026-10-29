// F1: the GitHub/Google sign-in anchors are static HTML whose start routes
// answer 503 on a deployment where the provider is not configured. The
// signin-options feed already reports providers.*.configured; the host
// relays a positive "configured: false" answer to the navigation owner,
// which keeps that anchor hidden in every view. Fail-open: no answer, no
// hiding — the historical behavior is untouched.
import test from "node:test";
import assert from "node:assert/strict";
import { createSigninNavigation } from "../src/signin-navigation.js";

function stubElement() {
  return {
    hidden: false, open: false, textContent: "",
    prepend() {}, append() {}, remove() {}, focus() {},
    classList: { toggle() {} }
  };
}

function mountNavigation(t, { missing = [] } = {}) {
  const nodes = new Map();
  const absent = new Set(missing);
  const node = selector => {
    if (absent.has(selector)) return null;
    if (!nodes.has(selector)) nodes.set(selector, stubElement());
    return nodes.get(selector);
  };
  const previous = { document: globalThis.document, window: globalThis.window, history: globalThis.history, location: globalThis.location };
  globalThis.document = { querySelector: node, activeElement: null };
  globalThis.window = { addEventListener() {} };
  globalThis.history = { state: null, replaceState() {}, pushState() {} };
  globalThis.location = { href: "https://example.invalid/" };
  t.after(() => Object.assign(globalThis, previous));
  const navigation = createSigninNavigation({ getUI: () => null, active: () => true });
  return { navigation, node };
}

test("an unavailable provider stays hidden across view syncs while the other anchor follows the view", t => {
  const { navigation, node } = mountNavigation(t);
  navigation.sync("password-login");
  assert.equal(node("#github-signin").hidden, false, "no feed answer yet: historical behavior");
  navigation.setProviderUnavailable("github");
  assert.equal(node("#github-signin").hidden, true, "hidden as soon as the feed answers");
  assert.equal(node("#google-signin").hidden, false, "the configured provider is untouched");
  navigation.sync("password-login");
  assert.equal(node("#github-signin").hidden, true, "still hidden after a re-sync to the methods view");
  navigation.sync("welcome");
  assert.equal(node("#google-signin").hidden, true, "welcome hides both anchors as before");
  assert.equal(node("#github-signin").hidden, true);
  navigation.sync("password-login");
  assert.equal(node("#google-signin").hidden, false, "back to methods: Google returns");
  assert.equal(node("#github-signin").hidden, true, "GitHub stays hidden — its route would 503");
});

test("sync still runs when the served page has no GitHub sign-in anchor", t => {
  const { navigation, node } = mountNavigation(t);
  const query = globalThis.document.querySelector;
  globalThis.document.querySelector = selector => selector === "#github-signin" ? null : query(selector);
  assert.doesNotThrow(() => navigation.sync("password-login"));
  assert.equal(node("#google-signin").hidden, false);
  assert.doesNotThrow(() => navigation.sync("welcome"));
  assert.equal(node("#google-signin").hidden, true);
});

test("a stripped GitHub anchor does not throw, and the rest of the sign-in view still syncs", t => {
  const { navigation, node } = mountNavigation(t, { missing: ["#github-signin"] });
  assert.doesNotThrow(() => navigation.sync("password-login"));
  assert.equal(node("#google-signin").hidden, false);
  assert.equal(node("#signin-methods").hidden, false);
  assert.doesNotThrow(() => navigation.setProviderUnavailable("github"));
  assert.doesNotThrow(() => navigation.sync("welcome"));
  assert.equal(node("#google-signin").hidden, true);
  assert.equal(node("#signin-methods").hidden, false);
});
