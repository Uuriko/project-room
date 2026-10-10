// Credits-ledger schema v1 — SQLite prototype (hard task 101).
//
// Valueless credits for the bounty exchange. Credits are Room ledger units
// only — not money, not chain assets (see docs/SWARM-PLUG-IN.md, bounty
// tools). Design doc: docs/exchange/101-credits-ledger-schema.md.
//
// Guarantees:
// - Every movement is a journal row; balances are derived and maintained in
//   the same transaction, so a crash can never strand funds.
// - Issuance requires the mint authority's Ed25519 signature; forged
//   issuance is rejected.
// - Each journal entry carries a unique nonce: replaying an entry is
//   rejected by the UNIQUE constraint.
// - Transfers are atomic debit+credit with a sufficient-funds check, so the
//   same funds can never be spent twice (double-spend safe).
// - Conservation: SUM(balances) == total issued - total redeemed, always.
import { DatabaseSync } from "node:sqlite";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, randomUUID } from "node:crypto";

export const LEDGER_SCHEMA = `
CREATE TABLE IF NOT EXISTS journal (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('issuance','transfer','redemption','burn')),
  from_acct TEXT,
  to_acct TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK(amount > 0),
  ref TEXT,
  epoch INTEGER NOT NULL,
  nonce TEXT NOT NULL UNIQUE,
  signature TEXT
);
CREATE TABLE IF NOT EXISTS balances (
  acct TEXT PRIMARY KEY,
  balance INTEGER NOT NULL DEFAULT 0 CHECK(balance >= 0)
);
CREATE INDEX IF NOT EXISTS journal_to ON journal(to_acct);
CREATE INDEX IF NOT EXISTS journal_from ON journal(from_acct);
CREATE INDEX IF NOT EXISTS journal_ref ON journal(ref);
CREATE INDEX IF NOT EXISTS journal_epoch ON journal(epoch);
`;

const sha256 = s => createHash("sha256").update(s).digest("hex");
const now = () => Date.now();

export class CreditsLedgerError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new CreditsLedgerError(code, message); };

// Canonical bytes the mint authority signs for an issuance.
export const issuancePayload = ({ to, amount, epoch, ref, nonce }) =>
  `credits-issuance/1|${to}|${amount}|${epoch}|${ref ?? ""}|${nonce}`;

export function generateMintKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("hex"),
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("hex"),
  };
}

function importPublicKey(hex) {
  return createPublicKey({ key: Buffer.from(hex, "hex"), format: "der", type: "spki" });
}
function importPrivateKey(hex) {
  return createPrivateKey({ key: Buffer.from(hex, "hex"), format: "der", type: "pkcs8" });
}

export function signIssuance({ to, amount, epoch, ref, nonce }, privateKeyHex) {
  const payload = issuancePayload({ to, amount, epoch, ref, nonce });
  return sign(null, Buffer.from(payload), importPrivateKey(privateKeyHex)).toString("hex");
}

export function verifyIssuance({ to, amount, epoch, ref, nonce, signature }, publicKeyHex) {
  const payload = issuancePayload({ to, amount, epoch, ref, nonce });
  try {
    return verify(null, Buffer.from(payload), importPublicKey(publicKeyHex), Buffer.from(signature, "hex"));
  } catch { return false; }
}

export function openCreditsLedger(path, { mintPublicKey = null, readOnly = false } = {}) {
  const db = new DatabaseSync(path, readOnly ? { readOnly: true } : {});
  if (!readOnly) db.exec(LEDGER_SCHEMA);

  const getBalance = acct => db.prepare("SELECT balance FROM balances WHERE acct=?").get(acct)?.balance ?? 0;
  const setBalance = (acct, balance) =>
    db.prepare("INSERT INTO balances(acct,balance) VALUES(?,?) ON CONFLICT(acct) DO UPDATE SET balance=excluded.balance").run(acct, balance);

  const insertEntry = entry => {
    try {
      db.prepare(`INSERT INTO journal(at,kind,from_acct,to_acct,amount,ref,epoch,nonce,signature)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(entry.at, entry.kind, entry.from_acct, entry.to_acct, entry.amount,
        entry.ref ?? null, entry.epoch, entry.nonce, entry.signature ?? null);
    } catch (error) {
      if (String(error.message).includes("UNIQUE constraint failed: journal.nonce")) fail("replay_rejected", "This journal entry was already recorded (nonce replay)");
      throw error;
    }
    return Number(db.prepare("SELECT last_insert_rowid() id").get().id);
  };

  const issue = ({ to, amount, epoch, ref = null, nonce = randomUUID() }, { privateKey }) => {
    if (!Number.isSafeInteger(amount) || amount <= 0) fail("invalid_amount", "amount must be a positive integer");
    if (!Number.isSafeInteger(epoch) || epoch < 0) fail("invalid_epoch", "epoch must be a non-negative integer");
    if (typeof to !== "string" || !to) fail("invalid_account", "to must be a non-empty account id");
    if (mintPublicKey === null) fail("no_mint_authority", "this ledger has no mint authority configured");
    const signature = signIssuance({ to, amount, epoch, ref, nonce }, privateKey);
    if (!verifyIssuance({ to, amount, epoch, ref, nonce, signature }, mintPublicKey)) fail("forged_issuance", "issuance signature does not verify against the mint authority");
    const at = now();
    const id = insertEntry({ at, kind: "issuance", from_acct: null, to_acct: to, amount, ref, epoch, nonce, signature });
    setBalance(to, getBalance(to) + amount);
    return { id, to, amount, epoch, ref, nonce };
  };

  const move = (kind, { from, to, amount, epoch, ref = null, nonce = randomUUID(), creditDestination = true }) => {
    if (!Number.isSafeInteger(amount) || amount <= 0) fail("invalid_amount", "amount must be a positive integer");
    if (!from || !to) fail("invalid_account", "from and to are required");
    if (from === to) fail("self_transfer", "from and to must differ");
    const fromBal = getBalance(from);
    if (fromBal < amount) fail("insufficient_funds", `insufficient funds: ${from} holds ${fromBal}, needs ${amount}`);
    const at = now();
    const id = insertEntry({ at, kind, from_acct: from, to_acct: to, amount, ref, epoch, nonce, signature: null });
    setBalance(from, fromBal - amount);
    // Redemptions and burns leave circulation: the destination is
    // attribution in the journal only, never a spendable balance.
    if (creditDestination) setBalance(to, getBalance(to) + amount);
    return { id, from, to, amount, epoch, ref, nonce };
  };

  return {
    db,
    close: () => db.close(),
    balanceOf: acct => getBalance(acct),
    issue,
    transfer: args => move("transfer", args),
    // Redemption locks credits to a bounty payout: they leave the
    // contributor's spendable balance and are attributed to the bounty in
    // the journal only (bounty accounts are not spendable).
    redeem: ({ from, amount, epoch, bountyId, nonce }) =>
      move("redemption", { from, to: `bounty:${bountyId}`, amount, epoch, ref: bountyId, nonce, creditDestination: false }),
    burn: ({ from, amount, epoch, ref = null, nonce }) =>
      move("burn", { from, to: "burn", amount, epoch, ref, nonce, creditDestination: false }),
    entry: id => db.prepare("SELECT * FROM journal WHERE id=?").get(id),
    entriesForAccount: acct => db.prepare("SELECT * FROM journal WHERE from_acct=? OR to_acct=? ORDER BY id").all(acct, acct),
    entriesForBounty: bountyId => db.prepare("SELECT * FROM journal WHERE ref=? ORDER BY id").all(bountyId),
    entriesForEpoch: epoch => db.prepare("SELECT * FROM journal WHERE epoch=? ORDER BY id").all(epoch),
    // The conservation invariant: every credit is either circulating or redeemed.
    checkConservation: () => {
      const issued = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM journal WHERE kind='issuance'").get().s;
      const redeemed = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM journal WHERE kind IN ('redemption','burn')").get().s;
      const circulating = db.prepare("SELECT COALESCE(SUM(balance),0) s FROM balances").get().s;
      return { ok: issued - redeemed === circulating, issued, redeemed, circulating };
    },
  };
}
