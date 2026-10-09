// Service worker registration for every visitor (PRODUCT-200 M-06).
// Push opt-in (src/human-push.js) registers push-sw.js, but the offline
// navigation fallback only exists while a worker controls the page. Without
// a boot-time registration, everyone who never enabled push gets the
// browser's dead network-error page instead of /offline.html.
import test from "node:test";
import assert from "node:assert/strict";
import { registerPwaWorker } from "../src/pwa-register.js";

function fakeNavigator({ registerImpl, supported = true } = {}) {
  if (!supported) return {};
  return { serviceWorker: { register: registerImpl ?? (async () => ({ scope: "https://room.example/" })) } };
}

test("registers the worker at the root scope when supported", async () => {
  const calls = [];
  const nav = fakeNavigator({
    registerImpl: async (url, options) => { calls.push([url, options]); return { scope: "https://room.example/" }; }
  });
  const result = await registerPwaWorker({ navigator: nav });
  assert.equal(result.registered, true);
  assert.deepEqual(calls, [["/push-sw.js", { scope: "/" }]]);
});

test("no-ops without throwing when service workers are unsupported", async () => {
  const result = await registerPwaWorker({ navigator: fakeNavigator({ supported: false }) });
  assert.equal(result.registered, false);
});

test("a failed registration never breaks app boot", async () => {
  const nav = fakeNavigator({ registerImpl: async () => { throw new Error("denied"); } });
  const result = await registerPwaWorker({ navigator: nav });
  assert.equal(result.registered, false);
});
