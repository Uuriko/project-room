import test from "node:test";
import assert from "node:assert/strict";
import {
  LAST_ROOM_KEY, HAD_ACCOUNT_KEY, AUTH_KIND_KEY, GUIDE_DISMISSED_KEY, SESSION_HINT_COPY,
  rememberLastRoom, rememberAccountHint, readLastRoom, readAccountHint, clearBrowserSessionHints
} from "../src/browser-session.js";

function memoryStore(start = {}) {
  const data = { ...start };
  return {
    getItem(key) { return Object.hasOwn(data, key) ? data[key] : null; },
    setItem(key, value) { data[key] = String(value); },
    removeItem(key) { delete data[key]; },
    _data: data
  };
}

test("rememberLastRoom accepts a room id and rejects lookalikes", () => {
  const storage = memoryStore();
  assert.equal(rememberLastRoom("grok-muse-potter-20260918", storage), true);
  assert.equal(storage.getItem(LAST_ROOM_KEY), "grok-muse-potter-20260918");
  assert.equal(rememberLastRoom("bad id", storage), false);
  assert.equal(rememberLastRoom("../x", storage), false);
  assert.equal(rememberLastRoom("", storage), false);
  assert.equal(storage.getItem(LAST_ROOM_KEY), "grok-muse-potter-20260918");
});

test("readLastRoom returns a valid id or null", () => {
  assert.equal(readLastRoom(memoryStore({ [LAST_ROOM_KEY]: "commons" })), "commons");
  assert.equal(readLastRoom(memoryStore({ [LAST_ROOM_KEY]: "bad id" })), null);
  assert.equal(readLastRoom(memoryStore()), null);
});

test("account hint is a boolean leftover, never a secret", () => {
  const storage = memoryStore();
  assert.equal(readAccountHint(storage), false);
  assert.equal(rememberAccountHint(storage), true);
  assert.equal(storage.getItem(HAD_ACCOUNT_KEY), "1");
  assert.equal(readAccountHint(storage), true);
});

test("clearBrowserSessionHints removes last-room, account hint, auth-kind, and guide leftovers", () => {
  const local = memoryStore({ [LAST_ROOM_KEY]: "commons", [HAD_ACCOUNT_KEY]: "1" });
  const session = memoryStore({ [AUTH_KIND_KEY]: "account", [GUIDE_DISMISSED_KEY]: "1" });
  const cleared = clearBrowserSessionHints({ localStorage: local, sessionStorage: session });
  assert.deepEqual(cleared, [LAST_ROOM_KEY, HAD_ACCOUNT_KEY, AUTH_KIND_KEY, GUIDE_DISMISSED_KEY]);
  assert.equal(local.getItem(LAST_ROOM_KEY), null);
  assert.equal(local.getItem(HAD_ACCOUNT_KEY), null);
  assert.equal(session.getItem(AUTH_KIND_KEY), null);
  assert.equal(session.getItem(GUIDE_DISMISSED_KEY), null);
});

test("session hint copy never names a secret and explains cookie vs localStorage", () => {
  assert.match(SESSION_HINT_COPY, /HttpOnly session cookie/);
  assert.match(SESSION_HINT_COPY, /not localStorage/);
  assert.match(SESSION_HINT_COPY, /8 hours/);
  assert.match(SESSION_HINT_COPY, /Sign out/);
  assert.doesNotMatch(SESSION_HINT_COPY, /pri_|ga1\.|ROOM_AGENT_TOKEN|sk-/);
});
