// Credits-ledger schema v1 tests — hard tasks 101 + 116.
//
// Proves the ledger's guarantees: no double-spend, no forged issuance, no
// replay, conservation always holds — and that the audit-trail explorer can
// trace every credit back to its signed issuance.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  openCreditsLedger, generateMintKeypair, signIssuance, verifyIssuance,
} from "../scripts/exchange/credits-ledger.mjs";

function ledger(t) {
  const dir = mkdtempSync(join(tmpdir(), "credits-ledger-"));
  const mint = generateMintKeypair();
  const l = openCreditsLedger(join(dir, "ledger.sqlite"), { mintPublicKey: mint.publicKey });
  t.after(() => { l.close(); rmSync(dir, { recursive: true, force: true }); });
  return { l, mint, dir };
}

const issue = (l, mint, to, amount, epoch = 1) =>
  l.issue({ to, amount, epoch, ref: `epoch-${epoch}-grant` }, { privateKey: mint.privateKey });

test("issuance credits the account and conservation holds", t => {
  const { l, mint } = ledger(t);
  issue(l, mint, "alice", 100);
  assert.equal(l.balanceOf("alice"), 100);
  const c = l.checkConservation();
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.deepEqual([c.issued, c.redeemed, c.circulating], [100, 0, 100]);
});

test("transfers conserve credits and cannot overdraw", t => {
  const { l, mint } = ledger(t);
  issue(l, mint, "alice", 100);
  l.transfer({ from: "alice", to: "bob", amount: 40, epoch: 1 });
  assert.equal(l.balanceOf("alice"), 60);
  assert.equal(l.balanceOf("bob"), 40);
  assert.throws(() => l.transfer({ from: "alice", to: "bob", amount: 61, epoch: 1 }),
    err => err.code === "insufficient_funds");
  assert.equal(l.balanceOf("alice"), 60, "failed transfer changes nothing");
  assert.equal(l.checkConservation().ok, true);
});

test("double-spend: racing two transfers of the same funds, exactly one wins", async t => {
  const { l, mint } = ledger(t);
  issue(l, mint, "alice", 100);
  const attempt = to => Promise.resolve().then(() => {
    try { return { ok: true, v: l.transfer({ from: "alice", to, amount: 100, epoch: 1 }) }; }
    catch (error) { return { ok: false, code: error.code }; }
  });
  const [a, b] = await Promise.all([attempt("bob"), attempt("carol")]);
  const wins = [a, b].filter(r => r.ok);
  const losses = [a, b].filter(r => !r.ok);
  assert.equal(wins.length, 1, "exactly one transfer of the full balance succeeds");
  assert.equal(losses.length, 1);
  assert.equal(losses[0].code, "insufficient_funds", "the loser is rejected, not double-spent");
  assert.equal(l.balanceOf("alice"), 0);
  assert.equal(l.checkConservation().ok, true);
});

test("forged issuance is rejected: wrong key, tampered fields", t => {
  const { l, mint } = ledger(t);
  const attacker = generateMintKeypair();
  // Wrong signing key.
  assert.throws(() => l.issue({ to: "mallory", amount: 1000, epoch: 1 }, { privateKey: attacker.privateKey }),
    err => err.code === "forged_issuance");
  // Tampered fields after signing: the signature is over (to, amount, epoch,
  // ref, nonce), so changing any of them invalidates it. Exercised through
  // the same verifyIssuance() the issue() path uses.
  const nonce = "tamper-nonce-1";
  const fields = { to: "mallory", amount: 10, epoch: 1, ref: null, nonce };
  const signature = signIssuance(fields, mint.privateKey);
  assert.equal(verifyIssuance({ ...fields, signature }, mint.publicKey), true, "honest issuance verifies");
  assert.equal(verifyIssuance({ ...fields, amount: 1000, signature }, mint.publicKey), false, "tampered amount fails");
  assert.equal(verifyIssuance({ ...fields, to: "mallory2", signature }, mint.publicKey), false, "tampered recipient fails");
  assert.equal(verifyIssuance({ ...fields, signature }, attacker.publicKey), false, "wrong mint key fails");
  assert.equal(l.balanceOf("mallory"), 0, "no forged credits exist");
  assert.equal(l.checkConservation().ok, true);
});

test("replay: the same nonce cannot be journaled twice", t => {
  const { l, mint } = ledger(t);
  issue(l, mint, "alice", 100);
  const nonce = "fixed-nonce-1";
  l.transfer({ from: "alice", to: "bob", amount: 10, epoch: 1, nonce });
  assert.throws(() => l.transfer({ from: "alice", to: "carol", amount: 10, epoch: 1, nonce }),
    err => err.code === "replay_rejected");
  assert.equal(l.balanceOf("carol"), 0);
  assert.equal(l.checkConservation().ok, true);
});

test("redemption locks credits to a bounty and burns destroy", t => {
  const { l, mint } = ledger(t);
  issue(l, mint, "alice", 100);
  l.redeem({ from: "alice", amount: 50, epoch: 1, bountyId: "bounty-7" });
  assert.equal(l.balanceOf("alice"), 50);
  assert.equal(l.balanceOf("bounty:bounty-7"), 0, "bounty accounts are attribution only, not spendable");
  l.burn({ from: "alice", amount: 10, epoch: 1 });
  assert.equal(l.balanceOf("alice"), 40);
  const c = l.checkConservation();
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.deepEqual([c.issued, c.redeemed, c.circulating], [100, 60, 40]);
  const bountyEntries = l.entriesForBounty("bounty-7");
  assert.equal(bountyEntries.length, 1);
  assert.equal(bountyEntries[0].kind, "redemption");
});

test("explorer: every credit's provenance traces back to its issuance", t => {
  const { l, mint, dir } = ledger(t);
  const issued = issue(l, mint, "alice", 100);
  const t1 = l.transfer({ from: "alice", to: "bob", amount: 40, epoch: 1 });
  const explorer = join("scripts", "exchange", "credits-explorer.mjs");
  const db = join(dir, "ledger.sqlite");
  const run = (...a) => execFileSync(process.execPath, [explorer, "--db", db, ...a], { encoding: "utf8" });
  assert.match(run("balance", "bob"), /bob: 40cr/);
  assert.match(run("search", "--user", "bob"), new RegExp(`#${t1.id} transfer`));
  assert.match(run("search", "--epoch", "1"), /issuance/);
  const traceOut = run("trace", String(t1.id));
  assert.match(traceOut, new RegExp(`#${t1.id} transfer alice → bob 40cr`));
  assert.match(traceOut, new RegExp(`#${issued.id} issuance`), "the trace reaches the signed issuance");
  assert.match(run("conservation"), /balanced=true/);
});
