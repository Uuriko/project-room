// QAX-001 (RC-2026-09-19-073) magic-link invalidation tests: requesting a
// fresh magic link burns ALL prior unconsumed codes for that email — siblings
// die at request time, not only on consume, so only the newest code is live.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";

const makeStore = (now = 1700000000000) => {
  const directory = mkdtempSync(join(tmpdir(), "magic-invalidation-"));
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => now });
  return store;
};

const liveCount = (store, email) => store.db.prepare(
  "SELECT count(*) AS n FROM account_magic_codes WHERE email=? AND consumed_at IS NULL").get(email).n;

test("a fresh request burns prior unconsumed codes for the same email", async t => {
  const store = makeStore();
  t.after(() => store.close());
  const email = "sibling@example.com";
  const first = store.accountLogins.issueMagicCode({ email });
  assert.equal(liveCount(store, email), 1);
  const second = store.accountLogins.issueMagicCode({ email });
  assert.notEqual(second.code, first.code);
  assert.equal(liveCount(store, email), 1, "only the newest code is live");

  // The burned sibling no longer verifies.
  assert.throws(() => store.accountLogins.consumeMagicCode({ email, code: first.code }),
    { code: "invalid_magic_code" });
  // The newest code still works.
  const consumed = store.accountLogins.consumeMagicCode({ email, code: second.code });
  assert.equal(consumed.email, email);
});

test("repeated requests keep exactly one live code, newest wins", async t => {
  const store = makeStore();
  t.after(() => store.close());
  const email = "churn@example.com";
  const codes = [];
  for (let i = 0; i < 4; i += 1) codes.push(store.accountLogins.issueMagicCode({ email }).code);
  assert.equal(liveCount(store, email), 1);
  for (const code of codes.slice(0, 3)) {
    assert.throws(() => store.accountLogins.consumeMagicCode({ email, code }),
      { code: "invalid_magic_code" }, "every older sibling is dead");
  }
  assert.ok(store.accountLogins.consumeMagicCode({ email, code: codes[3] }), "newest consumes");
});

test("codes for other emails are untouched by a new request", async t => {
  const store = makeStore();
  t.after(() => store.close());
  const aliceOld = store.accountLogins.issueMagicCode({ email: "alice@example.com" });
  const bob = store.accountLogins.issueMagicCode({ email: "bob@example.com" });
  store.accountLogins.issueMagicCode({ email: "alice@example.com" });
  assert.equal(liveCount(store, "bob@example.com"), 1, "bob's code survives alice's re-request");
  assert.throws(() => store.accountLogins.consumeMagicCode({ email: "alice@example.com", code: aliceOld.code }),
    { code: "invalid_magic_code" }, "alice's older sibling is burned");
  const consumed = store.accountLogins.consumeMagicCode({ email: "bob@example.com", code: bob.code });
  assert.equal(consumed.email, "bob@example.com", "bob's untouched code still consumes");
});
