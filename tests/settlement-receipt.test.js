// Signed settlement receipt + CLI tests (200-hard-tasks #4).
// Contract guarded: the verifier checks signature, amount, job id, chain and
// timestamp, and the nonce journal rejects replays. The 10 fixtures are
// real signed receipts (valid, forged, expired, replayed, ...) — a verifier
// regression (e.g. skipping the amount check) fails the corresponding
// fixture. Credible regression: if verifySettlementReceipt ever stopped
// checking `amountRaw`, the wrong-amount fixture would pass as VALID.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { verifySettlementReceipt } from "../server/settlement-receipt.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIX = join(ROOT, "tests", "fixtures", "settlement-receipts");
// Test keypair pubkey (seed not stored; fixtures were signed at task time).
const PUBKEY = "214cb1889aa6792c4cbdbfaca0a28e0301c50b33477133cc8271973ca387d955";
const load = (n) => JSON.parse(readFileSync(join(FIX, `${n}.json`), "utf8"));
const EXPECTED = { jobId: "job-settle-1", amountRaw: "50000", chainId: "monad-mock-10143" };

describe("settlement receipt verifier", () => {
  it("accepts the valid fixture", () => {
    const r = verifySettlementReceipt(load("valid"), { expectedPubkey: PUBKEY, ...EXPECTED });
    assert.equal(r.ok, true);
    assert.equal(r.body.jobId, "job-settle-1");
  });

  it("rejects a forged signature", () => {
    const r = verifySettlementReceipt(load("forged-signature"), { expectedPubkey: PUBKEY, ...EXPECTED });
    assert.equal(r.ok, false);
    assert.equal(r.code, "bad_signature");
  });

  it("rejects a wrong amount", () => {
    const r = verifySettlementReceipt(load("wrong-amount"), { expectedPubkey: PUBKEY, ...EXPECTED });
    assert.equal(r.ok, false);
    assert.equal(r.code, "amount_mismatch");
  });

  it("rejects a wrong job id", () => {
    const r = verifySettlementReceipt(load("wrong-job"), { expectedPubkey: PUBKEY, ...EXPECTED });
    assert.equal(r.ok, false);
    assert.equal(r.code, "job_mismatch");
  });

  it("rejects an expired receipt", () => {
    const r = verifySettlementReceipt(load("expired"), { expectedPubkey: PUBKEY, ...EXPECTED });
    assert.equal(r.ok, false);
    assert.equal(r.code, "expired");
  });

  it("rejects a replayed nonce via the seen-set", () => {
    const seen = new Set();
    const first = verifySettlementReceipt(load("valid"), { expectedPubkey: PUBKEY, ...EXPECTED, seen });
    assert.equal(first.ok, true);
    const second = verifySettlementReceipt(load("replayed"), { expectedPubkey: PUBKEY, ...EXPECTED, seen });
    assert.equal(second.ok, false);
    assert.equal(second.code, "replay");
  });

  it("rejects a wrong chain", () => {
    const r = verifySettlementReceipt(load("wrong-chain"), { expectedPubkey: PUBKEY, ...EXPECTED });
    assert.equal(r.ok, false);
    assert.equal(r.code, "chain_mismatch");
  });

  it("rejects a future timestamp", () => {
    const r = verifySettlementReceipt(load("future"), { expectedPubkey: PUBKEY, ...EXPECTED });
    assert.equal(r.ok, false);
    assert.equal(r.code, "future_timestamp");
  });

  it("rejects a tampered provider id (signature no longer matches)", () => {
    const r = verifySettlementReceipt(load("tampered-provider"), { expectedPubkey: PUBKEY, ...EXPECTED });
    assert.equal(r.ok, false);
    assert.equal(r.code, "bad_signature");
  });

  it("rejects a receipt signed by the wrong key", () => {
    const r = verifySettlementReceipt(load("wrong-key"), { expectedPubkey: PUBKEY, ...EXPECTED });
    assert.equal(r.ok, false);
    assert.equal(r.code, "bad_signature");
  });
});

describe("dasha-verify-receipt CLI", () => {
  const cli = (...a) => spawnSync("node", [join(ROOT, "scripts", "dasha-verify-receipt.mjs"), ...a], { encoding: "utf8" });

  it("exits 0 with VALID on the valid fixture", () => {
    const p = cli("--pubkey", PUBKEY, "--job", "job-settle-1", "--amount", "50000", "--chain", "monad-mock-10143", join(FIX, "valid.json"));
    assert.equal(p.status, 0);
    assert.match(p.stdout, /^VALID:/);
  });

  it("exits 1 with INVALID on the forged fixture", () => {
    const p = cli("--pubkey", PUBKEY, join(FIX, "forged-signature.json"));
    assert.equal(p.status, 1);
    assert.match(p.stdout, /^INVALID: bad signature/);
  });

  it("exits 1 on amount mismatch", () => {
    const p = cli("--pubkey", PUBKEY, "--amount", "50000", join(FIX, "wrong-amount.json"));
    assert.equal(p.status, 1);
    assert.match(p.stdout, /amount mismatch/);
  });

  it("exits 2 on usage errors", () => {
    assert.equal(cli(join(FIX, "valid.json")).status, 2); // missing --pubkey
    assert.equal(cli("--pubkey", PUBKEY).status, 2); // missing file
  });

  it("records nonces in the seen journal and rejects replays", () => {
    const journal = join(FIX, ".test-seen-journal.json");
    try {
      const first = cli("--pubkey", PUBKEY, "--seen", journal, join(FIX, "valid.json"));
      assert.equal(first.status, 0);
      const second = cli("--pubkey", PUBKEY, "--seen", journal, join(FIX, "valid.json"));
      assert.equal(second.status, 1);
      assert.match(second.stdout, /replayed nonce/);
    } finally {
      try {
        unlinkSync(journal);
      } catch {}
    }
  });
});
