// Pairs plaintext backfill migration (the data half left as a named
// residual by the hash-on-write fix, PR 5517): rows written before that
// fix carry live credentials in plaintext in the pairs table. The
// migration rewrites those stored values to the scrypt-hash form the
// dual-read in server/pairing.mjs expects, without destroying data:
//  - user_code and hold_secret are hashed in every legacy row (their
//    authoritative *_hash columns already carry the same digests, and
//    5517's readers authenticate against those, never the copy);
//  - issued_token / identity_secret are hashed only once the row's
//    replay window has passed; a live approved row keeps its plaintext
//    copies so dual-read poll delivery keeps working, and is reported
//    as deferred for a later run;
//  - the run is idempotent, and a malformed row is logged and skipped
//    by id instead of denying the whole migration (one-bad-row shape).
// Fixture credentials only; assertions compare values, never print them.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { PAIR_POLL_INTERVAL_MS, PAIR_REPLAY_MS } from "../server/pairing.mjs";
import { migratePairsPlaintext } from "../server/pairs-backfill.mjs";

const HASH64 = /^[0-9a-f]{64}$/;
const CODE_SHAPE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const T0 = 1_800_000_000_000;

function boot(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-pair-backfill-"));
  let now = T0;
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => now });
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, ownerKey, advance: ms => { now += ms; }, now: () => now };
}

const rowOf = (store, pairId) => store.db.prepare("SELECT * FROM pairs WHERE pair_id=?").get(pairId);
const allRows = store => store.db.prepare("SELECT * FROM pairs ORDER BY pair_id").all();

test("reproduction: a legacy approved row is plaintext at rest and its dumped token authenticates", async t => {
  const { store, ownerKey } = boot(t);
  const started = store.pairing.start({ roomId: "commons", displayName: "Repro Agent", address: "bf-repro" });
  const decided = store.pairing.decide(ownerKey, "commons", { pairId: started.pairId, decision: "approve", profile: "contribute" });
  const row = rowOf(store, started.pairId);
  // Pre-fix storage shape: the row itself is a credential dump.
  assert.ok(CODE_SHAPE.test(row.user_code), "legacy user_code is the plaintext code");
  assert.equal(row.user_code, started.userCode);
  assert.equal(row.issued_token, decided.connection.token, "legacy issued_token is the live token");
  assert.equal(row.identity_secret, decided.connection.identitySecret, "legacy identity_secret is the live secret");
  assert.equal(store.authenticate(row.issued_token, "commons").member.id, decided.memberId,
    "a copied stored token authenticates as the approved member");
});

test("migration hashes an expired-window legacy row; the real holder still authenticates and the copied hash does not", async t => {
  const { store, ownerKey } = boot(t);
  const started = store.pairing.start({ roomId: "commons", displayName: "Expired Agent", address: "bf-exp" });
  const decided = store.pairing.decide(ownerKey, "commons", { pairId: started.pairId, decision: "approve", profile: "contribute" });
  const before = rowOf(store, started.pairId);
  const afterReplay = before.replay_until + 1;

  const report = migratePairsPlaintext(store.db, { now: afterReplay });
  assert.equal(report.skipped.length, 0);
  assert.equal(report.migratedRows, 1);
  assert.equal(report.deferredLive.length, 0);

  const row = rowOf(store, started.pairId);
  assert.ok(HASH64.test(row.user_code), "user_code hashed");
  assert.equal(row.user_code, row.user_code_hash, "user_code now carries the code hash form");
  assert.ok(HASH64.test(row.issued_token), "issued_token hashed");
  assert.ok(HASH64.test(row.identity_secret), "identity_secret hashed");
  // Nothing else about the row was destroyed or rewritten.
  assert.equal(row.member_id, before.member_id);
  assert.equal(row.identity_id, before.identity_id);
  assert.equal(row.status, before.status);
  assert.equal(row.replay_until, before.replay_until);
  assert.equal(allRows(store).length, 1, "no rows added or removed");
  // The legitimate holder's real credentials still authenticate through
  // the authoritative stores; the copied stored values no longer do.
  assert.equal(store.authenticate(decided.connection.token, "commons").member.id, decided.memberId);
  assert.equal(store.authenticate(decided.connection.identitySecret, "commons").member.id, decided.memberId);
  assert.throws(() => store.authenticate(row.issued_token, "commons"));
  assert.throws(() => store.authenticate(row.identity_secret, "commons"));
});

test("migration defers a live approved row's token copies, poll still delivers, and a later run completes it", async t => {
  const { store, ownerKey, advance } = boot(t);
  const started = store.pairing.start({ roomId: "commons", displayName: "Live Agent", address: "bf-live" });
  const decided = store.pairing.decide(ownerKey, "commons", { pairId: started.pairId, decision: "approve", profile: "contribute" });
  const before = rowOf(store, started.pairId);

  const first = migratePairsPlaintext(store.db, { now: before.replay_until - 1 });
  assert.deepEqual(first.deferredLive, [started.pairId], "live row is named as deferred");
  const live = rowOf(store, started.pairId);
  assert.ok(HASH64.test(live.user_code), "user_code is hashed even for a live row");
  assert.equal(live.issued_token, before.issued_token, "live issued_token copy is left for dual-read delivery");
  assert.equal(live.identity_secret, before.identity_secret, "live identity_secret copy is left for dual-read delivery");

  // Dual-read delivery is unbroken for the legitimate holder.
  advance(PAIR_POLL_INTERVAL_MS);
  const polled = store.pairing.poll(started.pairId, started.deviceSecret);
  assert.equal(polled.token, decided.connection.token);
  assert.equal(polled.identitySecret, decided.connection.identitySecret);

  // Once the replay window passes, a re-run hashes the deferred copies.
  const second = migratePairsPlaintext(store.db, { now: before.replay_until + 1 });
  assert.equal(second.deferredLive.length, 0);
  const done = rowOf(store, started.pairId);
  assert.ok(HASH64.test(done.issued_token));
  assert.ok(HASH64.test(done.identity_secret));
  assert.equal(store.authenticate(decided.connection.token, "commons").member.id, decided.memberId);
  assert.throws(() => store.authenticate(done.issued_token, "commons"));
});

test("migration hashes a held row's hold_secret to the digest form pollHeld expects after 5517", async t => {
  const { store } = boot(t);
  const starter = store.identities.create("Backfill Starter");
  const started = store.pairing.start({ roomId: "commons", displayName: "Held Agent", holdFor: starter.identityId, address: "bf-held" });
  const before = rowOf(store, started.pairId);
  assert.equal(before.hold_secret, started.deviceSecret, "legacy hold_secret is the raw device secret");

  const report = migratePairsPlaintext(store.db, { now: T0 + 1 });
  assert.equal(report.skipped.length, 0);
  const row = rowOf(store, started.pairId);
  assert.ok(HASH64.test(row.hold_secret), "hold_secret hashed");
  assert.notEqual(row.hold_secret, started.deviceSecret);
  // The exact predicate the 5517 pollHeld dual-read branches on.
  assert.equal(row.hold_secret, row.device_secret_hash);
  // The pending pair is still findable by its code through the hash lookup.
  const seen = store.pairing.peek(started.userCode);
  assert.equal(seen.pairId, started.pairId);
});

test("migration is idempotent: a second run changes nothing", async t => {
  const { store, ownerKey } = boot(t);
  const started = store.pairing.start({ roomId: "commons", displayName: "Idem Agent", address: "bf-idem" });
  store.pairing.decide(ownerKey, "commons", { pairId: started.pairId, decision: "approve", profile: "chat" });
  const when = rowOf(store, started.pairId).replay_until + 1;
  migratePairsPlaintext(store.db, { now: when });
  const snapshot = JSON.stringify(allRows(store));
  const second = migratePairsPlaintext(store.db, { now: when });
  assert.equal(second.migratedRows, 0);
  assert.equal(second.fieldsHashed.user_code, 0);
  assert.equal(second.fieldsHashed.hold_secret, 0);
  assert.equal(second.fieldsHashed.issued_token, 0);
  assert.equal(second.fieldsHashed.identity_secret, 0);
  assert.equal(JSON.stringify(allRows(store)), snapshot, "rows are byte-identical after a re-run");
});

test("one bad row does not deny the migration: it is logged and skipped by id, other rows migrate", async t => {
  const { store, ownerKey } = boot(t);
  const good = store.pairing.start({ roomId: "commons", displayName: "Good Agent", address: "bf-good" });
  store.pairing.decide(ownerKey, "commons", { pairId: good.pairId, decision: "approve", profile: "chat" });
  // A malformed legacy row: user_code is neither a code nor a hash.
  store.db.prepare(`INSERT INTO pairs(pair_id, room_id, display_name, user_code_hash, user_code, device_secret_hash, status, created_at, expires_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run("pairbadrow000001", "commons", "Bad Row", "a".repeat(64), "not-a-code-or-hash", "b".repeat(64), "pending", T0, T0 + PAIR_REPLAY_MS);
  const badBefore = rowOf(store, "pairbadrow000001");
  const logged = [];
  const when = rowOf(store, good.pairId).replay_until + 1;
  const report = migratePairsPlaintext(store.db, { now: when, log: entry => logged.push(entry) });

  assert.equal(report.skipped.length, 1);
  assert.equal(report.skipped[0].pairId, "pairbadrow000001");
  assert.equal(logged.length, 1);
  assert.equal(logged[0].pairId, "pairbadrow000001");
  assert.deepEqual(rowOf(store, "pairbadrow000001"), badBefore, "the malformed row is left untouched");
  const goodRow = rowOf(store, good.pairId);
  assert.ok(HASH64.test(goodRow.user_code), "the good row still migrated");
  assert.ok(HASH64.test(goodRow.issued_token), "the good row still migrated");
  assert.equal(allRows(store).length, 2, "no rows destroyed");
});
