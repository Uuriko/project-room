// PWA boot: the service worker registers on every load (installability),
// never throws, and the install prompt mounts into the account menu.
import test from "node:test";
import assert from "node:assert/strict";
import { registerPwaWorker, isStandaloneDisplay, mountInstallPrompt } from "../src/pwa-boot.js";

test("no service worker support means no registration, no throw", async () => {
  assert.equal(await registerPwaWorker(undefined), null);
  assert.equal(await registerPwaWorker({}), null);
  assert.equal(await registerPwaWorker({ serviceWorker: null }), null);
});

test("registers /push-sw.js at scope / and returns the registration", async () => {
  const calls = [];
  const registration = { scope: "/" };
  const navigatorRef = {
    serviceWorker: {
      register: async (url, options) => { calls.push([url, options]); return registration; }
    }
  };
  assert.equal(await registerPwaWorker(navigatorRef), registration);
  assert.equal(calls.length, 1);
  const [url, options] = calls[0];
  assert.ok(String(url).endsWith("/push-sw.js"), `worker url: ${url}`);
  // Scope is the worker script's own directory: "/" on the deployed origin.
  assert.equal(options.scope, new URL("./", String(url)).pathname);
});

test("a failed registration degrades to null instead of throwing", async () => {
  const rejecting = { serviceWorker: { register: async () => { throw new Error("denied"); } } };
  assert.equal(await registerPwaWorker(rejecting), null);
  const throwing = { serviceWorker: { register: () => { throw new Error("sync boom"); } } };
  assert.equal(await registerPwaWorker(throwing), null);
});

test("standalone display detection", () => {
  assert.equal(isStandaloneDisplay(() => ({ matches: true })), true);
  assert.equal(isStandaloneDisplay(() => ({ matches: false })), false);
  assert.equal(isStandaloneDisplay(null), false);
  assert.equal(isStandaloneDisplay(undefined), false);
});

test("no account container means no install prompt", () => {
  let mounted = 0;
  assert.equal(mountInstallPrompt({ mount: () => { mounted += 1; } }), null);
  assert.equal(mountInstallPrompt({ account: null, mount: () => { mounted += 1; } }), null);
  assert.equal(mounted, 0);
});

test("mounts the install prompt with first value still pending", () => {
  const seen = [];
  const appended = [];
  const handle = { markFirstValue() {} };
  const account = { append: (...nodes) => appended.push(...nodes) };
  const storage = { getItem: () => null, setItem: () => {} };
  const result = mountInstallPrompt({
    account,
    mount: (options) => { seen.push(options); return handle; },
    storage,
    now: () => 1234,
    userAgent: "test-ua",
    standalone: true,
  });
  assert.equal(result, handle);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].account, account);
  assert.equal(seen[0].standalone, true);
  assert.equal(seen[0].firstValue, false);
  assert.equal(seen[0].userAgent, "test-ua");
  assert.equal(seen[0].storage, storage);
  assert.equal(seen[0].now(), 1234);
});

test("standalone defaults to the display-mode media query", () => {
  const seen = [];
  const account = { append: () => {} };
  mountInstallPrompt({ account, mount: (options) => { seen.push(options); return {}; } });
  assert.equal(seen.length, 1);
  assert.equal(typeof seen[0].standalone, "boolean");
});
