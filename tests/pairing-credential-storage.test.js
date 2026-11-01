// T2-L10c-C1 regression: the pairs table must store only hashes of the
// credentials it handles (user code, device secret, issued room token,
// identity secret, held device secret). A database read of a pairs row
// must never yield a working credential, while poll / pollHeld delivery
// and legacy plaintext rows (dual-read) keep working.
// Fixture credentials only; assertions compare values, never print them.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { PAIR_POLL_INTERVAL_MS } from "../server/pairing.mjs";

const HASH64 = /^[0-9a-f]{64}$/;
const CODE_SHAPE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;

function boot(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-pair-storage-"));
  let now = 1_800_000_000_000;
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => now });
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, ownerKey, advance: ms => { now += ms; } };
}

const rowOf = (store, pairId) => store.db.prepare("SELECT * FROM pairs WHERE pair_id=?").get(pairId);

test("new pairs rows store hashes only, poll still delivers, and a dumped hash does not authenticate", async t => {
  const { store, ownerKey, advance } = boot(t);
  const started = store.pairing.start({ roomId: "commons", displayName: "Ada Agent", address: "storage-1" });
  const pending = rowOf(store, started.pairId);
  assert.ok(!CODE_SHAPE.test(pending.user_code), "stored user_code must not be the plaintext code");
  assert.ok(HASH64.test(pending.user_code), "stored user_code must be a hash for new rows");
  assert.ok(HASH64.test(pending.user_code_hash), "user_code_hash stays a hash");
  assert.ok(HASH64.test(pending.device_secret_hash), "device_secret_hash stays a hash");

  const decided = store.pairing.decide(ownerKey, "commons", { pairId: started.pairId, decision: "approve", profile: "contribute" });
  const { token, identitySecret } = decided.connection;
  assert.equal(typeof token, "string");
  assert.equal(typeof identitySecret, "string");
  const approved = rowOf(store, started.pairId);
  assert.equal(approved.issued_token === token, false, "stored issued_token must not be the live token");
  assert.ok(HASH64.test(approved.issued_token), "stored issued_token must be a hash for new rows");
  assert.equal(approved.identity_secret === identitySecret, false, "stored identity_secret must not be the live secret");
  assert.ok(HASH64.test(approved.identity_secret), "stored identity_secret must be a hash for new rows");

  // The real credentials still work; the dumped stored values do not.
  assert.equal(store.authenticate(token, "commons").member.id, decided.memberId);
  assert.equal(store.authenticate(identitySecret, "commons").member.id, decided.memberId);
  assert.throws(() => store.authenticate(approved.issued_token, "commons"), /unauthenticated|Sign in|No credential/);
  assert.throws(() => store.authenticate(approved.identity_secret, "commons"), /unauthenticated|Sign in|No credential/);

  // Poll delivery is unchanged: same connection, duplicate flag on replay.
  advance(PAIR_POLL_INTERVAL_MS);
  const first = store.pairing.poll(started.pairId, started.deviceSecret);
  assert.equal(first.token, token);
  assert.equal(first.identitySecret, identitySecret);
  assert.equal(first.duplicate, undefined);
  advance(PAIR_POLL_INTERVAL_MS);
  const again = store.pairing.poll(started.pairId, started.deviceSecret);
  assert.equal(again.token, token);
  assert.equal(again.duplicate, true);
});

test("held pairs store no device secret, and pollHeld delivers for new and legacy rows", async t => {
  const { store, ownerKey, advance } = boot(t);
  const starter = store.identities.create("Starter Person");
  const started = store.pairing.start({ roomId: "commons", displayName: "Held Agent", holdFor: starter.identityId, address: "storage-2" });
  const held = rowOf(store, started.pairId);
  assert.equal(held.hold_secret === started.deviceSecret, false, "hold_secret must not be the device secret itself");
  assert.ok(HASH64.test(held.hold_secret), "hold_secret must be a hash for new rows");
  const decided = store.pairing.decide(ownerKey, "commons", { pairId: started.pairId, decision: "approve", profile: "chat" });
  advance(PAIR_POLL_INTERVAL_MS);
  const joined = store.pairing.pollHeld(started.pairId, starter.identityId);
  assert.equal(joined.token, decided.connection.token);
  assert.equal(store.authenticate(joined.token, "commons").member.id, decided.memberId);

  // Legacy dual-read: a pre-fix row whose hold_secret is the raw device
  // secret still polls through pollHeld.
  const starter2 = store.identities.create("Second Starter");
  const legacy = store.pairing.start({ roomId: "commons", displayName: "Legacy Held", holdFor: starter2.identityId, address: "storage-3" });
  store.pairing.decide(ownerKey, "commons", { pairId: legacy.pairId, decision: "approve", profile: "chat" });
  store.db.prepare("UPDATE pairs SET hold_secret=? WHERE pair_id=?").run(legacy.deviceSecret, legacy.pairId);
  advance(PAIR_POLL_INTERVAL_MS);
  const legacyJoined = store.pairing.pollHeld(legacy.pairId, starter2.identityId);
  assert.equal(typeof legacyJoined.token, "string");
  assert.equal(store.authenticate(legacyJoined.token, "commons").member.id, legacyJoined.memberId);
});

test("a legacy plaintext approved row still polls its stored token (dual-read)", async t => {
  const { store, ownerKey, advance } = boot(t);
  const started = store.pairing.start({ roomId: "commons", displayName: "Legacy Agent", address: "storage-4" });
  const decided = store.pairing.decide(ownerKey, "commons", { pairId: started.pairId, decision: "approve", profile: "contribute" });
  // Simulate a row written before the fix: live values stored in plaintext.
  const legacyToken = store.mintAccessKey("commons", decided.memberId);
  const fixtureIdentity = store.identities.create("Fixture Identity");
  store.db.prepare("UPDATE pairs SET issued_token=?, identity_secret=? WHERE pair_id=?")
    .run(legacyToken, fixtureIdentity.secret, started.pairId);
  advance(PAIR_POLL_INTERVAL_MS);
  const polled = store.pairing.poll(started.pairId, started.deviceSecret);
  assert.equal(polled.token, legacyToken);
  assert.equal(polled.identitySecret, fixtureIdentity.secret);
  assert.equal(store.authenticate(legacyToken, "commons").member.id, decided.memberId);
});

test("peek returns the presented code and list works without a stored plaintext code", async t => {
  const { store, ownerKey } = boot(t);
  const started = store.pairing.start({ roomId: "commons", displayName: "Peek Agent", address: "storage-5" });
  const seen = store.pairing.peek(started.userCode);
  assert.equal(seen.pairId, started.pairId);
  assert.equal(seen.userCode, started.userCode);
  assert.equal(seen.displayName, "Peek Agent");
  const listed = store.pairing.list(ownerKey, "commons");
  assert.equal(listed.pairs.length, 1);
  assert.equal(listed.pairs[0].pairId, started.pairId);
  // A legacy pending row that does carry its code in plaintext views the same.
  store.db.prepare("UPDATE pairs SET user_code=? WHERE pair_id=?").run(started.userCode, started.pairId);
  const legacySeen = store.pairing.peek(started.userCode);
  assert.equal(legacySeen.userCode, started.userCode);
});
