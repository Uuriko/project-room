// Quality-run RC-2026-09-18-007: invitation context survives OAuth.
// The #invite/<token> fragment never reaches the server, so a Google/GitHub
// OAuth round-trip would drop the invitation. These tests pin the stash /
// one-shot restore contract of src/invite-context.js.
import test from "node:test";
import assert from "node:assert/strict";
import {
  PENDING_INVITE_KEY,
  stashPendingInvite,
  clearPendingInvite,
  takeRestoredInvite,
  PENDING_JOIN_KEY,
  stashPendingJoin,
  clearPendingJoin,
  takeRestoredJoin,
  accessRequestStorageKey,
  stashAccessRequest,
  readAccessRequest,
  clearAccessRequest,
} from "../src/invite-context.js";

const SECRET = "a".repeat(43);
const FRAGMENT = `#invite/${SECRET}`;

function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: key => { data.delete(key); },
    _has: key => data.has(key),
  };
}

test("stash stores the invite fragment; non-secrets are ignored", () => {
  const storage = fakeStorage();
  stashPendingInvite(storage, SECRET);
  assert.equal(storage.getItem(PENDING_INVITE_KEY), FRAGMENT);
  stashPendingInvite(storage, "short");
  stashPendingInvite(storage, null);
  stashPendingInvite(storage, 42);
  assert.equal(storage.getItem(PENDING_INVITE_KEY), FRAGMENT);
});

test("clear removes the stash", () => {
  const storage = fakeStorage({ [PENDING_INVITE_KEY]: FRAGMENT });
  clearPendingInvite(storage);
  assert.equal(storage._has(PENDING_INVITE_KEY), false);
});

test("restore returns the secret on an account landing and consumes the stash", () => {
  const storage = fakeStorage({ [PENDING_INVITE_KEY]: FRAGMENT });
  const first = takeRestoredInvite({ storage, hash: "", search: "?account=1" });
  assert.deepEqual(first, { valid: true, secret: SECRET });
  const second = takeRestoredInvite({ storage, hash: "", search: "?account=1" });
  assert.equal(second, null);
});

// The Google/GitHub callback lands a returning member who already has a room
// on /?room=<first room>; only a brand-new account lands on /?account=1. The
// stash is written only at OAuth start and consumed by the next boot, so that
// ?room= landing IS the OAuth return and must not drop the friend's link.
test("restore returns the secret on the OAuth landing of a returning member (?room=)", () => {
  const storage = fakeStorage({ [PENDING_INVITE_KEY]: FRAGMENT });
  const result = takeRestoredInvite({ storage, hash: "", search: "?room=lobby" });
  assert.deepEqual(result, { valid: true, secret: SECRET });
  // One-shot: a second boot in the same tab does not re-open it.
  assert.equal(storage._has(PENDING_INVITE_KEY), false);
  assert.equal(takeRestoredInvite({ storage, hash: "", search: "?room=lobby" }), null);
});

test("restore is skipped when landing on #room/{roomId}", () => {
  const storage = fakeStorage({ [PENDING_INVITE_KEY]: FRAGMENT });
  const result = takeRestoredInvite({ storage, hash: "#room/commons", search: "" });
  assert.equal(result, null);
  assert.equal(storage._has(PENDING_INVITE_KEY), false);
});

test("restore is skipped when an invite hash is already present", () => {
  const storage = fakeStorage({ [PENDING_INVITE_KEY]: FRAGMENT });
  const result = takeRestoredInvite({ storage, hash: FRAGMENT, search: "" });
  assert.equal(result, null);
});

test("restore ignores malformed or missing stashes", () => {
  for (const pending of [null, "", "#invite/short", "#invite/" + "b".repeat(44), "https://evil.example/#invite/" + SECRET]) {
    const storage = fakeStorage(pending == null ? {} : { [PENDING_INVITE_KEY]: pending });
    assert.equal(
      takeRestoredInvite({ storage, hash: "", search: "?account=1" }),
      null,
      `pending=${JSON.stringify(pending)}`
    );
  }
});

test("helpers tolerate missing or throwing storage", () => {
  assert.doesNotThrow(() => stashPendingInvite(null, SECRET));
  assert.doesNotThrow(() => clearPendingInvite(null));
  assert.equal(takeRestoredInvite({ storage: null, hash: "", search: "" }), null);
  const throwing = {
    getItem: () => { throw new Error("denied"); },
    setItem: () => { throw new Error("denied"); },
    removeItem: () => { throw new Error("denied"); },
  };
  assert.doesNotThrow(() => stashPendingInvite(throwing, SECRET));
  assert.doesNotThrow(() => clearPendingInvite(throwing));
  assert.equal(takeRestoredInvite({ storage: throwing, hash: "", search: "" }), null);
});

// [QA-Join]: the #join/ share-link fragment needs the same OAuth round-trip
// survival as #invite/. Without it a signed-out invitee who signs in via
// Google/GitHub loses the invitation and lands in the default-room flow.
const JOIN_TOKEN = "c".repeat(43);
const JOIN_FRAGMENT = `#join/${JOIN_TOKEN}`;
const JOIN_FOCUS_FRAGMENT = `#join/${JOIN_TOKEN}/work/w-123`;

test("join stash stores the fragment; non-join hashes are ignored", () => {
  const storage = fakeStorage();
  stashPendingJoin(storage, JOIN_FRAGMENT);
  assert.equal(storage.getItem(PENDING_JOIN_KEY), JOIN_FRAGMENT);
  stashPendingJoin(storage, JOIN_FOCUS_FRAGMENT);
  assert.equal(storage.getItem(PENDING_JOIN_KEY), JOIN_FOCUS_FRAGMENT);
  for (const bad of ["#join/short", "#join/" + "d".repeat(44), "#invite/" + SECRET, "https://evil.example/" + JOIN_FRAGMENT, "", null, 42]) {
    stashPendingJoin(storage, bad);
    assert.equal(storage.getItem(PENDING_JOIN_KEY), JOIN_FOCUS_FRAGMENT, `bad=${JSON.stringify(bad)}`);
  }
});

test("join clear removes the stash", () => {
  const storage = fakeStorage({ [PENDING_JOIN_KEY]: JOIN_FRAGMENT });
  clearPendingJoin(storage);
  assert.equal(storage._has(PENDING_JOIN_KEY), false);
});

test("join restore returns the fragment on an account landing and consumes the stash", () => {
  const storage = fakeStorage({ [PENDING_JOIN_KEY]: JOIN_FOCUS_FRAGMENT });
  const first = takeRestoredJoin({ storage, hash: "", search: "?account=1" });
  assert.deepEqual(first, { valid: true, fragment: JOIN_FOCUS_FRAGMENT });
  const second = takeRestoredJoin({ storage, hash: "", search: "?account=1" });
  assert.equal(second, null);
});

test("join restore returns the fragment on the OAuth landing of a returning member (?room=)", () => {
  const storage = fakeStorage({ [PENDING_JOIN_KEY]: JOIN_FOCUS_FRAGMENT });
  assert.deepEqual(takeRestoredJoin({ storage, hash: "", search: "?room=lobby" }), { valid: true, fragment: JOIN_FOCUS_FRAGMENT });
  assert.equal(storage._has(PENDING_JOIN_KEY), false);
  assert.equal(takeRestoredJoin({ storage, hash: "", search: "?room=lobby" }), null);
});

test("join restore is skipped over a fresh join/invite hash or a #room/ deep link", () => {
  for (const landing of [
    { hash: JOIN_FRAGMENT, search: "" },
    { hash: FRAGMENT, search: "" },
    { hash: "#room/commons", search: "" },
    { hash: "#room/commons", search: "?room=lobby" },
  ]) {
    const storage = fakeStorage({ [PENDING_JOIN_KEY]: JOIN_FRAGMENT });
    assert.equal(takeRestoredJoin({ storage, ...landing }), null, JSON.stringify(landing));
    // One-shot: the stash is consumed even when skipped.
    assert.equal(storage._has(PENDING_JOIN_KEY), false);
  }
});

test("join restore ignores malformed or missing stashes", () => {
  for (const pending of [null, "", "#join/short", "#join/" + "e".repeat(44), "https://evil.example/" + JOIN_FRAGMENT]) {
    const storage = fakeStorage(pending == null ? {} : { [PENDING_JOIN_KEY]: pending });
    assert.equal(
      takeRestoredJoin({ storage, hash: "", search: "?account=1" }),
      null,
      `pending=${JSON.stringify(pending)}`
    );
  }
});

test("join helpers tolerate missing or throwing storage", () => {
  assert.doesNotThrow(() => stashPendingJoin(null, JOIN_FRAGMENT));
  assert.doesNotThrow(() => clearPendingJoin(null));
  assert.equal(takeRestoredJoin({ storage: null, hash: "", search: "" }), null);
  const throwing = {
    getItem: () => { throw new Error("denied"); },
    setItem: () => { throw new Error("denied"); },
    removeItem: () => { throw new Error("denied"); },
  };
  assert.doesNotThrow(() => stashPendingJoin(throwing, JOIN_FRAGMENT));
  assert.doesNotThrow(() => clearPendingJoin(throwing));
  assert.equal(takeRestoredJoin({ storage: throwing, hash: "", search: "" }), null);
});

// Access-request stash (src/invite-context.js): the stashed record carries the
// minted identity's bearer secret, so it must be clearable — G-LOW-2. The
// read path is deliberately non-consuming (status checks need the record
// after the submit), so the app needs an explicit clear for terminal states.
const ACCESS_RECORD = {
  identityId: "ai_testidentity_123",
  secret: "pri_bearer_secret_that_must_not_linger",
  requestId: "ar_testrequest_456",
  displayName: "Test Requester",
};

test("access request stash round-trips and read does not consume", () => {
  const storage = fakeStorage();
  stashAccessRequest(storage, "room-a", ACCESS_RECORD);
  assert.equal(storage._has(accessRequestStorageKey("room-a")), true);
  const first = readAccessRequest(storage, "room-a");
  assert.equal(first.secret, ACCESS_RECORD.secret);
  // Non-consuming: a second read (status check) still sees the record.
  assert.equal(readAccessRequest(storage, "room-a")?.requestId, ACCESS_RECORD.requestId);
});

test("clearAccessRequest drops the bearer secret from the stash", () => {
  const storage = fakeStorage();
  stashAccessRequest(storage, "room-a", ACCESS_RECORD);
  clearAccessRequest(storage, "room-a");
  assert.equal(storage._has(accessRequestStorageKey("room-a")), false);
  assert.equal(readAccessRequest(storage, "room-a"), null);
});

test("clearAccessRequest is scoped to one room", () => {
  const storage = fakeStorage();
  stashAccessRequest(storage, "room-a", ACCESS_RECORD);
  stashAccessRequest(storage, "room-b", ACCESS_RECORD);
  clearAccessRequest(storage, "room-a");
  assert.equal(readAccessRequest(storage, "room-a"), null);
  assert.equal(readAccessRequest(storage, "room-b")?.requestId, ACCESS_RECORD.requestId);
});

test("access request helpers tolerate missing or throwing storage", () => {
  assert.doesNotThrow(() => stashAccessRequest(null, "room-a", ACCESS_RECORD));
  assert.doesNotThrow(() => clearAccessRequest(null, "room-a"));
  assert.doesNotThrow(() => clearAccessRequest(null, null));
  assert.equal(readAccessRequest(null, "room-a"), null);
  const throwing = {
    getItem: () => { throw new Error("denied"); },
    setItem: () => { throw new Error("denied"); },
    removeItem: () => { throw new Error("denied"); },
  };
  assert.doesNotThrow(() => stashAccessRequest(throwing, "room-a", ACCESS_RECORD));
  assert.doesNotThrow(() => clearAccessRequest(throwing, "room-a"));
  assert.equal(readAccessRequest(throwing, "room-a"), null);
});
