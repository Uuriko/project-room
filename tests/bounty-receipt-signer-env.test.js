// Receipt signer arming: the production construction path must be able to
// receive an Ed25519 receipt signer from operator configuration.
//
// Before this slice there was NO configuration surface at all: the signer
// existed only as the BountyEscrow `receipts` constructor option, and the
// sole production construction site (RoomStore) never passed it, so every
// production movement returned `signed: []` no matter what an operator set.
// These tests pin the arming surface:
//   - receiptSignerFromEnv(env) builds a validated signer from
//     ROOM_RECEIPT_SIGNER_SEED / ROOM_RECEIPT_SIGNER_REF, returns null when
//     the seed is unset, and THROWS on a present-but-invalid seed (a
//     misconfigured key must fail boot, never silently disable signing).
//   - RoomStore passes its configured signer into BountyEscrow, so a
//     movement through store.bountyEscrow is signed and verifiable.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  createReceiptSigner,
  receiptSignerFromEnv,
  verifyBountyReceipt,
  RECEIPT_SIGNER_SEED_ENV,
  RECEIPT_SIGNER_REF_ENV,
} from "../server/bounty-receipts.mjs";
import { BountyEscrow } from "../server/bounty-escrow.mjs";
import { RoomStore } from "../server/store.mjs";

// The dasha-receipt/1 reference-vector key (tests/bounty-receipts.test.js):
// a published TEST seed, never a production key.
const TEST_SEED = "9d61b19deffd5a60ba844af492ec2af44449c5697b326919703bac031cae7f60";
const TEST_PUBKEY = "b9ce0f24f866c0fa02ab7c1ff345f9bb7c73205b4c2ec76a77295ef16592dc0d";

test("env names are the documented ROOM_ operator surface", () => {
  assert.equal(RECEIPT_SIGNER_SEED_ENV, "ROOM_RECEIPT_SIGNER_SEED");
  assert.equal(RECEIPT_SIGNER_REF_ENV, "ROOM_RECEIPT_SIGNER_REF");
});

test("receiptSignerFromEnv: unset seed leaves signing inert (null)", () => {
  assert.equal(receiptSignerFromEnv({}), null);
  assert.equal(receiptSignerFromEnv({ [RECEIPT_SIGNER_SEED_ENV]: "" }), null);
  assert.equal(receiptSignerFromEnv({ [RECEIPT_SIGNER_SEED_ENV]: "   " }), null);
});

test("receiptSignerFromEnv: valid seed yields the signer for that key", () => {
  const signer = receiptSignerFromEnv({ [RECEIPT_SIGNER_SEED_ENV]: TEST_SEED });
  assert.equal(signer.pubkeyHex, TEST_PUBKEY);
  assert.equal(signer.seedHex, TEST_SEED);
  assert.equal(typeof signer.ref, "string");
  assert.ok(signer.ref.length >= 1, "a default ref is supplied when none is configured");
});

test("receiptSignerFromEnv: configured ref is carried into the signer", () => {
  const signer = receiptSignerFromEnv({
    [RECEIPT_SIGNER_SEED_ENV]: TEST_SEED,
    [RECEIPT_SIGNER_REF_ENV]: "prod-escrow-keeper-1",
  });
  assert.equal(signer.ref, "prod-escrow-keeper-1");
});

test("receiptSignerFromEnv: present-but-invalid seed fails loud, never silently inert", () => {
  assert.throws(
    () => receiptSignerFromEnv({ [RECEIPT_SIGNER_SEED_ENV]: "not-a-seed" }),
    /seed must be 64 lowercase hex/,
  );
  assert.throws(
    () => receiptSignerFromEnv({ [RECEIPT_SIGNER_SEED_ENV]: TEST_SEED.toUpperCase() }),
    /seed must be 64 lowercase hex/,
  );
});

test("env-configured signer signs an escrow movement end to end", () => {
  const db = new DatabaseSync(":memory:");
  const transaction = fn => {
    db.exec("SAVEPOINT signer_env_test");
    try { const out = fn(); db.exec("RELEASE signer_env_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO signer_env_test"); db.exec("RELEASE signer_env_test"); throw error; }
  };
  const store = { db, transaction, readTransaction: transaction };
  const signer = receiptSignerFromEnv({ [RECEIPT_SIGNER_SEED_ENV]: TEST_SEED });
  const escrow = new BountyEscrow(store, {
    now: () => 1_786_000_000_000, allowLegacyStringLanes: true, receipts: signer,
  });
  escrow.ensureGenesis("room-test");
  const bounty = escrow.postBounty("room-test", {
    poster: "id:agent/jill", title: "T", criteria: "C", amount: 5,
    deadline: new Date(1_786_000_000_000 + 3_600_000).toISOString(),
  }).bounty;
  const { receipt } = escrow.fundBounty("room-test", bounty.bountyId, { funder: "id:agent/jill" });
  assert.equal(receipt.signed.length, 1, "fund movement must carry exactly one signed receipt");
  const journal = { entryHash: id => db.prepare("SELECT hash FROM bounty_journal WHERE entry_id=?").get(id)?.hash ?? null };
  const verdict = verifyBountyReceipt(receipt.signed[0], { expectedPubkey: TEST_PUBKEY, journal });
  assert.equal(verdict.ok, true, `receipt must verify: ${JSON.stringify(verdict)}`);
  assert.equal(receipt.signed[0].issuer.ref, signer.ref);
});

test("RoomStore wires its configured receipt signer into the production escrow", () => {
  const signer = createReceiptSigner({ seedHex: TEST_SEED, ref: "test-operator" });
  const store = new RoomStore(null, { database: new DatabaseSync(":memory:"), receiptSigner: signer });
  try {
    assert.equal(store.receiptSigner, signer);
    assert.equal(store.bountyEscrow._receipts, signer,
      "store.bountyEscrow is the production escrow: it must hold the configured signer");
  } finally { store.close(); }

  const unsigned = new RoomStore(null, { database: new DatabaseSync(":memory:") });
  try {
    assert.equal(unsigned.bountyEscrow._receipts, null,
      "no configured signer keeps the historical inert default");
  } finally { unsigned.close(); }
});
