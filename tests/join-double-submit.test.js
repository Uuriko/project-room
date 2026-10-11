// WAVE-500 G3: the public join page must not fire a second POST /api/join
// while one submit is still in flight.
//
// Fail-first repro: disabling the submit button does not stop a second
// submit event (Enter in the name field still submits the form), and the
// handler never checks for an in-flight join. Two rapid submits race two
// POSTs; the server burns the invite exactly once, so the loser gets
// 409 invite_already_used and the page can strand a freshly joined user on
// the dead-end "Invite already used" screen.
import test from "node:test";
import assert from "node:assert/strict";

const fetchCalls = [];

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
// Hold the join POST open so the second submit lands while one is in flight.
const joinPostGate = deferred();

function makeElement() {
  const el = {
    hidden: false,
    textContent: "",
    value: "",
    disabled: false,
    dataset: {},
    classList: { add() {}, toggle() {}, remove() {} },
    listeners: {},
    addEventListener(type, fn) { (el.listeners[type] ??= []).push(fn); },
    focus() {},
    select() {},
    appendChild() {},
    reset() {},
  };
  return el;
}

const elementIds = [
  "join-loading", "join-consent", "join-success", "join-error",
  "join-error-title", "join-error-message", "join-retry",
  "join-name", "join-form", "join-submit", "join-status",
  "join-room-title", "join-inviter", "join-profile", "join-permissions",
  "join-expiry", "join-success-name", "join-success-room",
  "join-session-expiry", "join-secret", "join-open-room",
  "join-copy-secret", "join-copy-status",
];
const elements = Object.fromEntries(elementIds.map(id => [id, makeElement()]));
elements["join-name"].value = "Test Agent";

globalThis.location = {
  pathname: "/join/RM-ABCDEFGH12345678",
  origin: "https://example.test",
  search: "",
  hash: "",
};
globalThis.document = {
  readyState: "complete",
  getElementById: id => elements[id] ?? null,
  createElement: () => makeElement(),
  addEventListener() {},
};
globalThis.fetch = async (url, options = {}) => {
  const method = options.method || "GET";
  fetchCalls.push({ url: String(url), method });
  if (String(url).includes("/agent-invites/preview")) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        roomTitle: "Test Room",
        inviterDisplayName: "Pat",
        profile: "collaborate",
        permissions: ["accept_work"],
        expiresAt: Date.now() + 3_600_000,
      }),
    };
  }
  if (method === "POST" && String(url).endsWith("/join")) {
    await joinPostGate.promise;
    return {
      ok: true,
      status: 201,
      json: async () => ({
        roomId: "room1",
        displayName: "Test Agent",
        roomToken: "rak_test_token",
        sessionExpiresAt: Date.now() + 3_600_000,
      }),
    };
  }
  throw new Error(`unexpected fetch ${method} ${url}`);
};
// Cap timers so the module's 10s preview watchdog cannot hold the runner open.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, Math.min(ms ?? 0, 50), ...rest);

await import("../src/join.js");

async function waitForSubmitHandler() {
  for (let i = 0; i < 50 && !(elements["join-form"].listeners.submit ?? []).length; i++) {
    await new Promise(resolve => realSetTimeout(resolve, 10));
  }
  return elements["join-form"].listeners.submit ?? [];
}

test("a second submit while a join is in flight fires no second POST", async () => {
  const handlers = await waitForSubmitHandler();
  assert.ok(handlers.length >= 1, "join form submit handler is wired after preview");
  const handler = handlers[handlers.length - 1];
  const event = { preventDefault() {} };
  const first = handler(event);
  const second = handler(event); // rapid double-Enter: same form, still in flight
  joinPostGate.resolve();
  await Promise.all([first, second]);
  const joinPosts = fetchCalls.filter(call => call.method === "POST" && call.url.endsWith("/join"));
  assert.equal(joinPosts.length, 1, `expected exactly one POST /api/join, saw ${joinPosts.length}`);
});
