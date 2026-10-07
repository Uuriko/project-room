// Ledger chaos tests — hard task 117.
// Proves the incident-runbook rollback path: snapshot/restore returns the
// ledger to a known-good state, replay after restore is rejected, and a
// corrupted DB file fails loudly instead of serving wrong balances.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, copyFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openCreditsLedger, generateMintKeypair,
} from "../scripts/exchange/credits-ledger.mjs";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "ledger-chaos-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { publicKey, privateKey } = generateMintKeypair();
  const path = join(dir, "ledger.sqlite");
  const ledger = openCreditsLedger(path, { mintPublicKey: publicKey });
  return { dir, path, ledger, keys: { publicKey, privateKey } };
}

function seed(ledger, keys) {
  ledger.issue({ to: "alice", amount: 1000, epoch: 1, ref: "genesis" }, { privateKey: keys.privateKey });
  ledger.transfer({ from: "alice", to: "bob", amount: 300, epoch: 1, ref: "t1" });
}

test("snapshot/restore rollback: restoring a snapshot returns exact prior balances", t => {
  const { dir, path, ledger, keys } = fixture(t);
  seed(ledger, keys);
  assert.equal(ledger.balanceOf("alice"), 700);
  assert.equal(ledger.balanceOf("bob"), 300);

  // Snapshot the known-good state (runbook Scenario 1, step 2).
  copyFileSync(path, join(dir, "ledger-snap.sqlite"));
  ledger.close();

  // More activity happens, then disaster: the DB is replaced by a copy
  // missing the last transactions (simulating restore of a stale file is
  // tested below; here we simulate post-snapshot writes then rollback).
  const live = openCreditsLedger(path, { mintPublicKey: keys.publicKey });
  live.transfer({ from: "bob", to: "carol", amount: 100, epoch: 2, ref: "t2" });
  live.issue({ to: "mallory", amount: 9999, epoch: 2, ref: "forged?" }, { privateKey: keys.privateKey });
  assert.equal(live.balanceOf("mallory"), 9999, "the bad state exists before rollback");
  live.close();

  // Rollback: restore the snapshot, reopen, verify.
  copyFileSync(join(dir, "ledger-snap.sqlite"), path);
  const restored = openCreditsLedger(path, { mintPublicKey: keys.publicKey });
  t.after(() => restored.close());
  assert.equal(restored.balanceOf("alice"), 700, "alice rolled back to snapshot");
  assert.equal(restored.balanceOf("bob"), 300, "bob rolled back to snapshot");
  assert.equal(restored.balanceOf("carol"), 0, "carol's post-snapshot receipt is gone");
  assert.equal(restored.balanceOf("mallory"), 0, "the suspicious issuance is gone");

  // Conservation still holds on the restored state.
  const row = restored.db.prepare(
    "SELECT (SELECT COALESCE(SUM(amount),0) FROM journal WHERE kind='issuance') issued, " +
    "(SELECT COALESCE(SUM(balance),0) FROM balances) held").get();
  assert.equal(row.held, row.issued, "conservation: every issued credit is accounted for");
});

test("replay after restore: a pre-snapshot nonce cannot be re-applied", t => {
  const { dir, path, ledger, keys } = fixture(t);
  const first = ledger.issue({ to: "alice", amount: 500, epoch: 1, ref: "genesis", nonce: "nonce-abc" },
    { privateKey: keys.privateKey });
  assert.equal(first.nonce, "nonce-abc");
  copyFileSync(path, join(dir, "ledger-snap.sqlite"));
  ledger.close();

  copyFileSync(join(dir, "ledger-snap.sqlite"), path);
  const restored = openCreditsLedger(path, { mintPublicKey: keys.publicKey });
  t.after(() => restored.close());
  let error = null;
  try {
    restored.issue({ to: "mallory", amount: 500, epoch: 1, ref: "replay", nonce: "nonce-abc" },
      { privateKey: keys.privateKey });
  } catch (err) { error = err; }
  assert.ok(error, "re-applying a recorded nonce throws");
  assert.equal(error.code, "replay_rejected", "re-applying a recorded nonce is rejected, not double-credited");
  assert.equal(restored.balanceOf("mallory"), 0);
});

test("corrupted DB file fails loudly on open, never serves wrong balances", t => {
  const { dir, path, ledger, keys } = fixture(t);
  seed(ledger, keys);
  ledger.close();
  writeFileSync(path, Buffer.from("this is not a sqlite database at all, just garbage bytes"));
  assert.throws(
    () => openCreditsLedger(path, { mintPublicKey: keys.publicKey }),
    /not a database|file is not a database|SQLITE/i,
    "a corrupted ledger file must fail on open, not serve fabricated balances"
  );
  void keys; void dir;
});
