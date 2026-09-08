import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-release-service-"));
  let now = Date.now();
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => now });
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, owner, advance: ms => { now += ms; } };
}

test("account login is bounded by the existing browser slot and still rejects its expiry", t => {
  const { store, owner, advance } = fixture(t);
  const key = store.issueAccountAccessKey(store.authenticate(owner).account.id);
  for (const lifetime of [60000, 30 * 86400000]) {
    const slot = store.createAccountSessionSlot(lifetime);
    const start = store.now();
    const auth = store.loginAccountSession(slot.token, key, slot.session.sessionRevision);
    assert.equal(auth.expiresAt, Math.min(slot.session.expiresAt, start + 8 * 3600000));
    assert.equal(auth.authenticatedUntil, auth.expiresAt);
    if (lifetime === 60000) {
      advance(lifetime);
      assert.throws(() => store.authenticateAccountSession(slot.token), /expired/);
      assert.throws(() => store.loginAccountSession(slot.token, key, auth.sessionRevision), /expired/);
    }
  }
});

test("snapshot and return brief request read-only transactions and never acknowledge", t => {
  const { store, owner } = fixture(t);
  const platform = store.storagePlatform, modes = [];
  store.storagePlatform = { ...platform, transaction(db, fn, readOnly) {
    modes.push(readOnly);
    return platform.transaction(db, fn, readOnly);
  } };
  const snapshot = store.snapshot(owner, "commons");
  const brief = store.returnBrief(owner, "commons");
  assert.deepEqual(modes, [true, true]);
  assert.equal(brief.current.evaluatedThrough, snapshot.sequence);
  assert.equal(store.snapshot(owner, "commons").cursor, 0);
  store.revoke(owner);
  for (const read of [() => store.snapshot(owner, "commons"), () => store.returnBrief(owner, "commons")])
    assert.throws(read, /revoked/);
});
