import test from "node:test";
import assert from "node:assert/strict";
import {
  LAST_ROOM_KEY, LAST_ROOM_TITLE_KEY, LAST_ROOM_BY_MEMBER_KEY, HAD_ACCOUNT_KEY, AUTH_KIND_KEY, GUIDE_DISMISSED_KEY, SESSION_HINT_COPY,
  rememberLastRoom, rememberAccountHint, readLastRoom, readLastRoomTitle, readAccountHint, clearBrowserSessionHints,
  rememberMemberRoom, readMemberRoom, signInRoomTarget, clearStoredPasswords
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

test("rememberLastRoom stores a safe title for the same room only", () => {
  const storage = memoryStore();
  rememberLastRoom("commons", storage, "Commons");
  assert.equal(readLastRoomTitle("commons", storage), "Commons");
  assert.equal(readLastRoomTitle("other", storage), null);
  rememberLastRoom("commons", storage, "pri_not_a_title");
  assert.equal(readLastRoomTitle("commons", storage), null);
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
  const local = memoryStore({ [LAST_ROOM_KEY]: "commons", [LAST_ROOM_TITLE_KEY]: "Commons", [HAD_ACCOUNT_KEY]: "1" });
  const session = memoryStore({ [AUTH_KIND_KEY]: "account", [GUIDE_DISMISSED_KEY]: "1" });
  const cleared = clearBrowserSessionHints({ localStorage: local, sessionStorage: session });
  assert.deepEqual(cleared, [LAST_ROOM_KEY, LAST_ROOM_TITLE_KEY, HAD_ACCOUNT_KEY, AUTH_KIND_KEY, GUIDE_DISMISSED_KEY]);
  assert.equal(local.getItem(LAST_ROOM_KEY), null);
  assert.equal(local.getItem(LAST_ROOM_TITLE_KEY), null);
  assert.equal(local.getItem(HAD_ACCOUNT_KEY), null);
  assert.equal(session.getItem(AUTH_KIND_KEY), null);
  assert.equal(session.getItem(GUIDE_DISMISSED_KEY), null);
});

function listStore(start = {}) {
  const data = { ...start };
  return {
    get length() { return Object.keys(data).length; },
    key(index) { return Object.keys(data)[index] ?? null; },
    getItem(key) { return Object.hasOwn(data, key) ? data[key] : null; },
    setItem(key, value) { data[key] = String(value); },
    removeItem(key) { delete data[key]; }
  };
}

test("per-user last room survives sign-out and sign-in prefers next, then a deep link, then that room", () => {
  const local = memoryStore();
  assert.equal(rememberMemberRoom("email:abc", "commons", local, "Commons"), true);
  assert.deepEqual(readMemberRoom("email:abc", local), { roomId: "commons", title: "Commons" });
  assert.equal(rememberMemberRoom("bad id", "commons", local), false);
  clearBrowserSessionHints({ localStorage: local, sessionStorage: memoryStore() });
  assert.equal(local.getItem(LAST_ROOM_BY_MEMBER_KEY) !== null, true);
  assert.equal(readMemberRoom("email:abc", local).roomId, "commons");
  assert.deepEqual(signInRoomTarget({ nextRoom: "next", deepLinkRoom: "deep", rememberedRoom: "commons" }), { roomId: "next", explicit: true, source: "next" });
  assert.deepEqual(signInRoomTarget({ deepLinkRoom: "deep", rememberedRoom: "commons" }), { roomId: "deep", explicit: true, source: "deep-link" });
  assert.deepEqual(signInRoomTarget({ rememberedRoom: "commons" }), { roomId: "commons", explicit: false, source: "last" });
  assert.deepEqual(signInRoomTarget({}), { roomId: null, explicit: false, source: "inbox" });
  for (let index = 0; index < 21; index += 1) rememberMemberRoom(`member${index}`, "commons", local);
  assert.equal(readMemberRoom("member0", local), null);
  assert.equal(readMemberRoom("member20", local).roomId, "commons");
});

test("clearStoredPasswords drops sessionStorage keys that name a password", () => {
  const session = listStore({ "pr-password": "secret", other: "1" });
  assert.deepEqual(clearStoredPasswords(session), ["pr-password"]);
  assert.equal(session.getItem("pr-password"), null);
  assert.equal(session.getItem("other"), "1");
});

test("session hint copy never names a secret and explains cookie vs localStorage", () => {
  assert.match(SESSION_HINT_COPY, /HttpOnly session cookie/);
  assert.match(SESSION_HINT_COPY, /not localStorage/);
  assert.match(SESSION_HINT_COPY, /Room-key sessions and account sessions each stay signed in for up to 8 hours/);
  assert.match(SESSION_HINT_COPY, /Sign out/);
  assert.doesNotMatch(SESSION_HINT_COPY, /pri_|ga1\.|ROOM_AGENT_TOKEN|sk-/);
});
