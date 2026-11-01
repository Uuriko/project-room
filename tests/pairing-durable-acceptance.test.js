// Acceptance pack for the durable pair-delivery cure (PR #5517 held at
// 8fed505e + dependent #5537; Root hold seq 24801; semantics in
// W2-5517-SPEC.md; sealed-delivery contract from the executed q5608
// qualification prototype: PAIR_DELIVERY_KEY env key, AES-256-GCM,
// pair id as AAD, additive pair_delivery_sealed table, v45 schema fence).
//
// These tests are the acceptance gate for WHOEVER builds the cure
// (Codex's lane, or Jill's fleet to his design). They are written
// against the SPEC, not against any implementation: at the held head
// the defect-catching tests FAIL for the spec's stated reasons, and
// the two GUARD tests (marked as such) pass there because they pin
// properties the cure must not break. Fixture credentials only; the
// only key material is the fixed test keys below, in this file only.
// Assertions compare values, never print them.
//
// Keying convention: the durability legs run with the fixture key
// configured in the process environment, because the cured deployment
// holds the key server-side (Codex seq 25343) — deliverability across
// restart is a property of that deployment. With no key configured,
// delivery MUST stay exactly as unpatched; the no-key guard pins it.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { PAIR_POLL_INTERVAL_MS, PAIR_REPLAY_MS } from "../server/pairing.mjs";
import { STORE_SCHEMA_VERSION, writerVersions } from "../server/writer-fence.mjs";

const KEY_ENV = "PAIR_DELIVERY_KEY";
// Fixed fixture keys (32 bytes each, base64). Test-only; never a real key.
const TEST_KEY_1 = Buffer.alloc(32, 0x51).toString("base64");
const TEST_KEY_2 = Buffer.alloc(32, 0x97).toString("base64");

function harness(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-pair-durable-"));
  const file = join(directory, "room.sqlite");
  let now = 1_800_000_000_000;
  let store = new RoomStore(file, { now: () => now });
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const savedKey = process.env[KEY_ENV];
  t.after(() => {
    if (savedKey === undefined) delete process.env[KEY_ENV];
    else process.env[KEY_ENV] = savedKey;
    try { store.close(); } catch {}
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    get store() { return store; },
    ownerKey,
    advance: ms => { now += ms; },
    reopen() { store.close(); store = new RoomStore(file, { now: () => now }); },
    setKey(key) { if (key === null) delete process.env[KEY_ENV]; else process.env[KEY_ENV] = key; }
  };
}

const pairRow = (store, pairId) => store.db.prepare("SELECT * FROM pairs WHERE pair_id=?").get(pairId);

function sealedRow(store, pairId) {
  const table = store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pair_delivery_sealed'").get();
  assert.ok(table, "pair_delivery_sealed table must exist at the cured head");
  return store.db.prepare("SELECT * FROM pair_delivery_sealed WHERE pair_id=?").get(pairId);
}

function assertPollThrows(fn, code) {
  let error = null;
  try { fn(); } catch (caught) { error = caught; }
  assert.ok(error, `poll must throw ${code}`);
  assert.equal(error.code, code);
}

// Design-neutral delivery invariants (SPEC sections 2 and 5): they hold
// for a sealed-delivery cure (values identical) and for a re-issuance
// cure (delivered value works, predecessor revoked, ids unchanged).
function assertDeliveryInvariants(h, decided, polled) {
  assert.equal(polled.memberId, decided.memberId, "member id must never change across a restart");
  assert.equal(polled.identityId, decided.connection.identityId, "identity id must never change across a restart");
  assert.equal(h.store.authenticate(polled.token, "commons").member.id, decided.memberId,
    "the delivered token must authenticate for the approved member");
  if (polled.token !== decided.connection.token) {
    assert.throws(() => h.store.authenticate(decided.connection.token, "commons"),
      /unauthenticated|Sign in|No credential/,
      "a re-issued token must revoke its undelivered predecessor");
  }
  if (polled.identitySecret) {
    assert.equal(h.store.authenticate(polled.identitySecret, "commons").member.id, decided.memberId,
      "the delivered identity secret must be that identity's operative secret");
    if (decided.connection.identitySecret && polled.identitySecret !== decided.connection.identitySecret) {
      assert.throws(() => h.store.authenticate(decided.connection.identitySecret, "commons"),
        /unauthenticated|Sign in|No credential/,
        "a rotated identity secret must leave exactly one operative secret");
    }
  }
}

function startAndApprove(h, name, address) {
  const started = h.store.pairing.start({ roomId: "commons", displayName: name, address });
  const decided = h.store.pairing.decide(h.ownerKey, "commons", { pairId: started.pairId, decision: "approve", profile: "contribute" });
  return { started, decided };
}

// --- SPEC acceptance cases (Root seq 24801): close/reopen durability ---

test("headline: approve -> close/reopen -> poll delivers a working connection", async t => {
  const h = harness(t);
  h.setKey(TEST_KEY_1);
  const { started, decided } = startAndApprove(h, "Durable One", "durable-1");
  h.reopen();
  h.advance(PAIR_POLL_INTERVAL_MS);
  const polled = h.store.pairing.poll(started.pairId, started.deviceSecret);
  assertDeliveryInvariants(h, decided, polled);
});

// GUARD-COMPANION (passes at the held head): the spec's literal
// companion case. It passes pre-cure because approve runs in the new
// process and repopulates the process-local buffer; it belongs in the
// pack because a cure must not break approve-after-restart. Its
// defect-catching sibling is the next test.
test("close/reopen between start and approve still delivers (spec companion)", async t => {
  const h = harness(t);
  h.setKey(null);
  const started = h.store.pairing.start({ roomId: "commons", displayName: "Durable Two", address: "durable-2" });
  h.reopen();
  const decided = h.store.pairing.decide(h.ownerKey, "commons", { pairId: started.pairId, decision: "approve", profile: "contribute" });
  h.advance(PAIR_POLL_INTERVAL_MS);
  const polled = h.store.pairing.poll(started.pairId, started.deviceSecret);
  assert.equal(polled.token, decided.connection.token);
});

test("approve after a restart is itself durable: approve -> close/reopen -> poll delivers", async t => {
  const h = harness(t);
  h.setKey(TEST_KEY_1);
  const started = h.store.pairing.start({ roomId: "commons", displayName: "Durable Three", address: "durable-3" });
  h.reopen();
  const decided = h.store.pairing.decide(h.ownerKey, "commons", { pairId: started.pairId, decision: "approve", profile: "contribute" });
  h.reopen();
  h.advance(PAIR_POLL_INTERVAL_MS);
  const polled = h.store.pairing.poll(started.pairId, started.deviceSecret);
  assertDeliveryInvariants(h, decided, polled);
});

test("close/reopen between first poll and replay poll: replay still duplicate:true and working", async t => {
  const h = harness(t);
  h.setKey(TEST_KEY_1);
  const { started, decided } = startAndApprove(h, "Durable Four", "durable-4");
  h.advance(PAIR_POLL_INTERVAL_MS);
  const first = h.store.pairing.poll(started.pairId, started.deviceSecret);
  assert.equal(first.token, decided.connection.token);
  h.reopen();
  h.advance(PAIR_POLL_INTERVAL_MS);
  const again = h.store.pairing.poll(started.pairId, started.deviceSecret);
  assert.equal(again.duplicate, true, "a replay poll inside the window must report duplicate:true");
  assertDeliveryInvariants(h, decided, again);
});

test("pollHeld headline: held approve -> close/reopen -> pollHeld delivers", async t => {
  const h = harness(t);
  h.setKey(TEST_KEY_1);
  const starter = h.store.identities.create("Starter Person");
  const started = h.store.pairing.start({ roomId: "commons", displayName: "Durable Held", holdFor: starter.identityId, address: "durable-5" });
  const decided = h.store.pairing.decide(h.ownerKey, "commons", { pairId: started.pairId, decision: "approve", profile: "chat" });
  h.reopen();
  h.advance(PAIR_POLL_INTERVAL_MS);
  const joined = h.store.pairing.pollHeld(started.pairId, starter.identityId);
  assert.equal(joined.memberId, decided.memberId);
  assert.equal(h.store.authenticate(joined.token, "commons").member.id, decided.memberId,
    "the pollHeld-delivered token must authenticate for the approved member");
  if (joined.token !== decided.connection.token) {
    assert.throws(() => h.store.authenticate(decided.connection.token, "commons"),
      /unauthenticated|Sign in|No credential/,
      "a re-issued token must revoke its undelivered predecessor");
  }
});

test("deliverability survives any number of restarts inside the window (sealed, keyed)", async t => {
  const h = harness(t);
  h.setKey(TEST_KEY_1);
  const { started, decided } = startAndApprove(h, "Durable Six", "durable-6");
  h.reopen();
  h.reopen();
  h.reopen();
  h.advance(PAIR_POLL_INTERVAL_MS);
  const polled = h.store.pairing.poll(started.pairId, started.deviceSecret);
  assertDeliveryInvariants(h, decided, polled);
});

// --- Sealed delivery (q5608 prototype contract) ---

test("sealed round-trip: approval with an env key persists a sealed record; post-restart poll recovers it", async t => {
  const h = harness(t);
  h.setKey(TEST_KEY_1);
  const { started, decided } = startAndApprove(h, "Sealed One", "sealed-1");
  const sealed = sealedRow(h.store, started.pairId);
  assert.ok(sealed, "a sealed delivery record must be persisted at approval when a key is configured");
  assert.match(sealed.sealed, /^v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/,
    "the sealed record must carry the v1 envelope (iv, tag, ciphertext)");
  assert.equal(sealed.sealed.includes(decided.connection.token), false, "the sealed record must not contain the token");
  assert.equal(sealed.sealed.includes(decided.connection.identitySecret), false, "the sealed record must not contain the identity secret");
  h.reopen();
  h.advance(PAIR_POLL_INTERVAL_MS);
  const polled = h.store.pairing.poll(started.pairId, started.deviceSecret);
  assert.equal(polled.token, decided.connection.token, "sealed recovery must deliver the approved token, not a substitute");
  assert.equal(polled.identitySecret, decided.connection.identitySecret, "sealed recovery must deliver the approved identity secret");
  assertDeliveryInvariants(h, decided, polled);
});

test("sealed records are bound to their pair: a transplanted record does not unseal for another pair", async t => {
  const h = harness(t);
  h.setKey(TEST_KEY_1);
  const a = startAndApprove(h, "Sealed Alpha", "sealed-2a");
  const b = startAndApprove(h, "Sealed Beta", "sealed-2b");
  const sealedA = sealedRow(h.store, a.started.pairId);
  assert.ok(sealedA, "control pair must have a sealed record");
  assert.ok(sealedRow(h.store, b.started.pairId), "victim pair must have a sealed record");
  h.store.db.prepare("UPDATE pair_delivery_sealed SET sealed=? WHERE pair_id=?").run(sealedA.sealed, b.started.pairId);
  h.reopen();
  h.advance(PAIR_POLL_INTERVAL_MS);
  assertPollThrows(() => h.store.pairing.poll(b.started.pairId, b.started.deviceSecret), "expired_token");
  // Control: the donor pair's own record still unseals for the donor.
  const polledA = h.store.pairing.poll(a.started.pairId, a.started.deviceSecret);
  assert.equal(polledA.token, a.decided.connection.token);
});

test("key loss fails closed and is recoverable: no key and wrong key serve nothing, the right key still delivers", async t => {
  const h = harness(t);
  h.setKey(TEST_KEY_1);
  const { started, decided } = startAndApprove(h, "Sealed Three", "sealed-3");
  assert.ok(sealedRow(h.store, started.pairId), "a sealed record must exist before key loss is meaningful");
  h.reopen();
  h.setKey(null);
  h.advance(PAIR_POLL_INTERVAL_MS);
  assertPollThrows(() => h.store.pairing.poll(started.pairId, started.deviceSecret), "expired_token");
  h.setKey(TEST_KEY_2);
  h.advance(PAIR_POLL_INTERVAL_MS);
  assertPollThrows(() => h.store.pairing.poll(started.pairId, started.deviceSecret), "expired_token");
  // Fail-closed is about delivery, not revocation: the approved
  // credential itself was never revoked by the failed polls.
  assert.equal(h.store.authenticate(decided.connection.token, "commons").member.id, decided.memberId);
  // A transient key outage must not destroy the delivery: with the key
  // restored inside the window, the same connection is delivered.
  h.setKey(TEST_KEY_1);
  h.advance(PAIR_POLL_INTERVAL_MS);
  const polled = h.store.pairing.poll(started.pairId, started.deviceSecret);
  assert.equal(polled.token, decided.connection.token);
  assertDeliveryInvariants(h, decided, polled);
});

test("replay expiry still binds with a key: a poll after replay_until returns expired_token", async t => {
  const h = harness(t);
  h.setKey(TEST_KEY_1);
  const { started } = startAndApprove(h, "Sealed Four", "sealed-4");
  assert.ok(sealedRow(h.store, started.pairId), "a sealed record must exist for the expiry leg to be meaningful");
  h.reopen();
  h.advance(PAIR_REPLAY_MS + PAIR_POLL_INTERVAL_MS);
  assertPollThrows(() => h.store.pairing.poll(started.pairId, started.deviceSecret), "expired_token");
});

// GUARD (passes at the held head): with NO key configured the cure must
// be behaviour-identical to the unpatched code — no sealed rows are
// written, no durability appears from nowhere, and the pairs row is
// untouched by a failed post-restart poll. Its teeth face the cure: an
// implementation that writes sealed rows keylessly, or makes no-key
// deployments durable via a plaintext path, fails here.
test("no key configured: unpatched behaviour is preserved exactly (guard)", async t => {
  const h = harness(t);
  h.setKey(null);
  const { started } = startAndApprove(h, "Plain One", "plain-1");
  const before = pairRow(h.store, started.pairId);
  const table = h.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pair_delivery_sealed'").get();
  if (table) {
    const rows = h.store.db.prepare("SELECT count(*) AS n FROM pair_delivery_sealed WHERE pair_id=?").get(started.pairId).n;
    assert.equal(rows, 0, "no sealed record may be written without a key");
  }
  h.reopen();
  h.advance(PAIR_POLL_INTERVAL_MS);
  assertPollThrows(() => h.store.pairing.poll(started.pairId, started.deviceSecret), "expired_token");
  const after = pairRow(h.store, started.pairId);
  assert.equal(after.issued_token, before.issued_token, "a failed no-key poll must not rewrite the stored token hash");
  assert.equal(after.identity_secret, before.identity_secret, "a failed no-key poll must not rewrite the stored identity-secret hash");
  assert.equal(after.status, "approved");
});

// GUARD (passes at the held head): SPEC section 3 under the cure. With
// a key configured and a sealed record persisted, a full database dump
// still yields no working credential — not the token, not the identity
// secret, and never the key itself.
test("hash-only at rest holds with a key configured: no database read yields a working credential (guard)", async t => {
  const h = harness(t);
  h.setKey(TEST_KEY_1);
  const { started, decided } = startAndApprove(h, "Sealed Five", "sealed-5");
  // Look the sealed record up without requiring it: at the held head
  // there is no sealed table and this guard passes on the dump
  // assertions alone (that is #5517's existing property). At the cured
  // head the record exists (the round-trip test proves it must) and
  // the sealed value is held to the same standard below.
  const sealedTable = h.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pair_delivery_sealed'").get();
  const sealed = sealedTable
    ? h.store.db.prepare("SELECT * FROM pair_delivery_sealed WHERE pair_id=?").get(started.pairId)
    : null;
  const tables = h.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
  let dump = "";
  for (const name of tables) {
    for (const row of h.store.db.prepare(`SELECT * FROM "${name}"`).all()) dump += JSON.stringify(row) + "\n";
  }
  assert.equal(dump.includes(decided.connection.token), false, "no table may contain the live token");
  assert.equal(dump.includes(decided.connection.identitySecret), false, "no table may contain the live identity secret");
  assert.equal(dump.includes(TEST_KEY_1), false, "the delivery key must never be written to the database");
  if (sealed) {
    assert.throws(() => h.store.authenticate(sealed.sealed, "commons"),
      /unauthenticated|Sign in|No credential/, "the sealed value itself must not authenticate");
  }
});

// --- The v45 fence (Codex seq 25343) ---

test("v45 fence shape: schema version 45, fenced version history, sealed table registered, pairs shape preserved", async t => {
  const h = harness(t);
  assert.equal(STORE_SCHEMA_VERSION, 45, "the cure bumps the store schema to version 45");
  assert.ok(writerVersions.includes(45), "the writer-fence version history must include 45");
  assert.equal(Math.max(...writerVersions), 45, "45 must be the latest fenced version");
  const userVersion = h.store.db.prepare("PRAGMA user_version").get().user_version;
  assert.equal(userVersion, 45, "an opened store must report PRAGMA user_version 45");
  const sealedInfo = h.store.db.prepare("PRAGMA table_info(pair_delivery_sealed)").all();
  assert.ok(sealedInfo.length > 0, "pair_delivery_sealed must exist at the cured head");
  assert.ok(sealedInfo.some(column => column.name === "pair_id" && column.pk === 1),
    "pair_delivery_sealed must be keyed by pair_id");
  // Additive-only: every pairs column the held head writes is still
  // there, under the same name (the migration may add, never drop or
  // rename, on the fence step).
  const pairsColumns = h.store.db.prepare("PRAGMA table_info(pairs)").all().map(column => column.name);
  for (const expected of ["pair_id", "room_id", "display_name", "user_code_hash", "user_code",
    "device_secret_hash", "status", "public_key", "duplicate_member_id", "member_id", "identity_id",
    "issued_token", "identity_secret", "hold_secret", "starter_identity_id", "created_at",
    "expires_at", "approved_at", "replay_until", "last_poll_at", "decided_by"]) {
    assert.ok(pairsColumns.includes(expected), `pairs.${expected} must survive the v45 fence`);
  }
});
