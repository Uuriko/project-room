// F1 + #3548, composed: the GitHub/Google sign-in anchors are static HTML
// whose start routes answer 503 on a deployment where the provider is not
// configured. The signin-options feed reports providers.*.configured; the
// host relays a positive "configured: false" answer to the navigation
// owner, which keeps that anchor hidden in every view (F1, fail-open: no
// answer, no hiding). The GitHub door carries a second, stricter gate
// (#3548): it stays hidden until the deployment is verified — configured
// AND a real sign-in on record — and that gate fails closed, so for
// GitHub the gate wins over the fail-open default. Once verified, the
// GitHub anchor follows the view like any configured provider, and an
// unavailable mark still keeps it hidden.
import test from "node:test";
import assert from "node:assert/strict";
import { createSigninNavigation } from "../src/signin-navigation.js";
import { setGithubSigninVerified } from "../src/provider-gate.js";

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
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.history = { state: null, replaceState() {}, pushState() {} };
  globalThis.location = { href: "https://example.invalid/" };
  t.after(() => { setGithubSigninVerified(false); Object.assign(globalThis, previous); });
  const navigation = createSigninNavigation({ getUI: () => null, active: () => true });
  return { navigation, node };
}

test("an unavailable provider stays hidden across view syncs while the other anchor follows the view", t => {
  const { navigation, node } = mountNavigation(t);
  navigation.sync("password-login");
  assert.equal(node("#google-signin").hidden, false, "no feed answer yet: Google follows the view (F1 fail-open)");
  assert.equal(node("#github-signin").hidden, true, "GitHub starts closed: the #3548 gate fails closed until verified");
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
  assert.equal(node("#github-signin").hidden, true, "GitHub stays hidden — unverified, and its route would 503");
  setGithubSigninVerified(true);
  assert.equal(node("#github-signin").hidden, true, "even once verified, an unavailable mark keeps GitHub hidden");
});

test("once verified, the GitHub anchor follows the view like any configured provider", t => {
  const { navigation, node } = mountNavigation(t);
  setGithubSigninVerified(true);
  navigation.sync("password-login");
  assert.equal(node("#github-signin").hidden, false, "verified and configured: shown on the methods view");
  navigation.sync("welcome");
  assert.equal(node("#github-signin").hidden, true, "welcome still hides it");
  navigation.sync("password-login");
  assert.equal(node("#github-signin").hidden, false, "and it returns with the methods view");
  setGithubSigninVerified(false);
  assert.equal(node("#github-signin").hidden, true, "losing verification closes the door again, live");
});
