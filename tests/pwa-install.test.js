// When the install control and the push soft ask may appear. Mounting is
// covered by scripts/pwa-browser-check.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { installDecision, isIosSafari, noteInstalled, INSTALL_RECORD_KEY } from "../src/pwa-install.js";
import { pushAskDecision, PUSH_ASK_COPY } from "../src/push-ask.js";

const DAY = 24 * 60 * 60 * 1000;
const now = 1_700_000_000_000;

test("Install Room waits for first value and a browser prompt", () => {
  assert.deepEqual(installDecision({ now, firstValue: false, prompted: true }), { showButton: false, showIosSheet: false });
  assert.deepEqual(installDecision({ now, firstValue: true, prompted: false }), { showButton: false, showIosSheet: false });
  assert.deepEqual(installDecision({ now, firstValue: true, prompted: true }), { showButton: true, showIosSheet: false });
  assert.deepEqual(installDecision({ now, firstValue: true, prompted: true, standalone: true }), { showButton: false, showIosSheet: false });
});

test("iOS Safari gets the Share sheet after first value, at most once every 14 days", () => {
  assert.equal(isIosSafari("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"), true);
  assert.equal(isIosSafari("Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126.0.0.0 Mobile Safari/537.36"), false);
  assert.deepEqual(installDecision({ now, firstValue: true, ios: true }), { showButton: false, showIosSheet: true });
  assert.deepEqual(installDecision({ now, firstValue: true, ios: true, dismissedAt: now - DAY }), { showButton: false, showIosSheet: false });
  assert.deepEqual(installDecision({ now, firstValue: true, ios: true, dismissedAt: now - 15 * DAY }), { showButton: false, showIosSheet: true });
  assert.deepEqual(installDecision({ now, firstValue: false, ios: true }), { showButton: false, showIosSheet: false });
});

test("a standalone launch can record pwa_installed locally", () => {
  const saved = new Map();
  const record = noteInstalled({
    platform: "ios", source: "pwa", now, storage: { setItem: (key, value) => saved.set(key, value) }
  });
  assert.equal(record.name, "pwa_installed");
  assert.equal(record.source, "pwa");
  assert.equal(saved.has(INSTALL_RECORD_KEY), true);
});

test("the soft ask stays hidden until a needs-you item, and Not now lasts 7 days", () => {
  assert.equal(PUSH_ASK_COPY.includes("needs you"), true);
  assert.deepEqual(pushAskDecision({ now, needsMe: false }), { show: false });
  assert.deepEqual(pushAskDecision({ now, needsMe: true }), { show: true });
  assert.deepEqual(pushAskDecision({ now, needsMe: true, permission: "granted" }), { show: false });
  assert.deepEqual(pushAskDecision({ now, needsMe: true, dismissedAt: now - DAY }), { show: false });
  assert.deepEqual(pushAskDecision({ now, needsMe: true, dismissedAt: now - 8 * DAY }), { show: true });
  assert.deepEqual(pushAskDecision({ now, needsMe: true, ios: true, standalone: false }), { show: false });
  assert.deepEqual(pushAskDecision({ now, needsMe: true, ios: true, standalone: true }), { show: true });
});
