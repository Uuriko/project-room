// F1 + front-door batch B-7 (#3743): the GitHub/Google sign-in anchors
// are static HTML whose start routes answer 503 on a deployment where the
// provider is not configured. The anchors start hidden in the static HTML
// and the navigation owner reveals one only on the signin-options feed's
// positive "configured: true" answer — an unconfigured provider never
// renders, never renders-then-vanishes, and never leads to its 503 route.
// A positive "configured: false" keeps it hidden in every view.
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

function mountNavigation(t) {
  const nodes = new Map();
  const node = selector => {
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

test("a provider stays hidden until positively configured, then follows the view", t => {
  const { navigation, node } = mountNavigation(t);
  navigation.sync("password-login");
  assert.equal(node("#github-signin").hidden, true, "no feed answer yet: the door is not rendered (B-7)");
  assert.equal(node("#google-signin").hidden, true, "both doors wait for a positive answer");
  navigation.setProviderAvailable("google");
  assert.equal(node("#google-signin").hidden, false, "revealed on the feed's configured: true");
  navigation.setProviderUnavailable("github");
  assert.equal(node("#github-signin").hidden, true, "hidden as soon as the feed answers false");
  navigation.sync("password-login");
  assert.equal(node("#github-signin").hidden, true, "still hidden after a re-sync to the methods view");
  navigation.sync("welcome");
  assert.equal(node("#google-signin").hidden, true, "welcome hides both anchors as before");
  assert.equal(node("#github-signin").hidden, true);
  navigation.sync("password-login");
  assert.equal(node("#google-signin").hidden, false, "back to methods: the configured provider returns");
  assert.equal(node("#github-signin").hidden, true, "GitHub stays hidden — its route would 503");
});
