// SEC-14: a magic sign-in code redeems at most once, even when another
// consumer claims the row between the lookup and the consume transaction.
//
// Contract: consumeMagicCode claims the row with a guarded UPDATE
// (consumed_at IS NULL, not expired) and returns 401 when it lost.
// Regression caught: an unguarded UPDATE re-stamps an already consumed row
// and mints a second session from one code. The email-verify and password
// reset paths already carry this guard; this pins the sign-in path.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";

function setup() {
  const directory = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "magic-race-"));
  const now = 1_700_000_000_000;
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => now });
  store.createAccount("acct-1", "test");
  return { store, logins: store.accountLogins, now };
}

// Run `interleave` just before the consume transaction body, as a second
// consumer on a shared database would.
function interleaveBeforeTransaction(store, interleave) {
  const original = store.transaction.bind(store);
  let fired = false;
  store.transaction = fn => original(() => {
    if (!fired) { fired = true; interleave(); }
    return fn();
  });
  return () => { store.transaction = original; };
}

test("a code consumed by another caller after lookup is refused, not redeemed twice", () => {
  const { store, logins, now } = setup();
  const issued = logins.issueMagicCode({ accountId: "acct-1", email: "ada@example.com" });
  const restore = interleaveBeforeTransaction(store, () =>
    store.db.prepare("UPDATE account_magic_codes SET consumed_at=?").run(now));
  try {
    assert.throws(() => logins.consumeMagicCode({ email: "ada@example.com", code: issued.code }),
      error => error.status === 401 && error.code === "invalid_magic_code");
  } finally { restore(); }
});

test("a code that expires between lookup and consume is refused", () => {
  const { store, logins, now } = setup();
  const issued = logins.issueMagicCode({ accountId: "acct-1", email: "ada@example.com" });
  const restore = interleaveBeforeTransaction(store, () =>
    store.db.prepare("UPDATE account_magic_codes SET expires_at=?").run(now));
  try {
    assert.throws(() => logins.consumeMagicCode({ email: "ada@example.com", code: issued.code }),
      error => error.status === 401 && error.code === "invalid_magic_code");
  } finally { restore(); }
});

test("the normal path still redeems once and then refuses replay", () => {
  const { logins } = setup();
  const issued = logins.issueMagicCode({ accountId: "acct-1", email: "ada@example.com" });
  assert.equal(logins.consumeMagicCode({ email: "ada@example.com", code: issued.code }).accountId, "acct-1");
  assert.throws(() => logins.consumeMagicCode({ email: "ada@example.com", code: issued.code }),
    error => error.status === 401);
});
