# Credits-Ledger Schema v1 (hard task 101)

Valueless credits for the bounty exchange. Credits are Room ledger units
only — not money, not chain assets. They measure contribution and fund
bounties inside the room; any path to real value is a separate, gated
design (see 110-season-0 bridge). Prototype: `scripts/exchange/credits-ledger.mjs`;
explorer: `scripts/exchange/credits-explorer.mjs`; tests: `tests/exchange-credits-ledger.test.js`.

## Model

Double-entry journal. Every credit movement is one immutable journal row;
balances are a materialized view maintained in the same transaction, so a
crash can never strand funds or create them.

### Tables

```sql
journal(
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,            -- unix ms
  kind TEXT NOT NULL,             -- issuance | transfer | redemption | burn
  from_acct TEXT,                 -- null for issuance
  to_acct TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK(amount > 0),
  ref TEXT,                       -- bounty id for redemptions, null otherwise
  epoch INTEGER NOT NULL,         -- issuance epoch (anti-farming, see task 105)
  nonce TEXT NOT NULL UNIQUE,     -- idempotency / replay protection
  signature TEXT                  -- mint-authority Ed25519 signature (issuance only)
);
balances(
  acct TEXT PRIMARY KEY,
  balance INTEGER NOT NULL DEFAULT 0 CHECK(balance >= 0)
);
-- indexes: journal(to_acct), journal(from_acct), journal(ref), journal(epoch)
```

### Kinds

- **issuance** — the mint authority creates credits for an account. Requires
  an Ed25519 signature over `credits-issuance/1|to|amount|epoch|ref|nonce`.
  Forged issuance (wrong key, tampered fields) is rejected.
- **transfer** — account-to-account. Atomic debit+credit with a
  sufficient-funds check inside one transaction: the same funds can never be
  spent twice.
- **redemption** — credits leave a contributor's spendable balance and are
  attributed to a bounty (`to_acct = "bounty:<id>"`, `ref = bounty id`).
  Bounty accounts are attribution in the journal only, never a spendable
  balance. This is the funding leg of a bounty payout.
- **burn** — credits destroyed (penalties, expiry). Attributed to `"burn"`,
  likewise not a spendable balance.

### Invariants (all enforced)

1. **No negative balances** — `CHECK(balance >= 0)` plus the
   sufficient-funds check before every debit.
2. **No double-spend** — debit and credit land in one transaction; a second
   spend of the same funds fails `insufficient_funds`. Concurrent attempts
   serialize on the writer.
3. **No forgery** — issuance verifies against the mint authority's public
   key; tampering with any signed field invalidates the signature.
4. **No replay** — `nonce UNIQUE`: re-submitting an entry is rejected with
   `replay_rejected`.
5. **Conservation** — `SUM(balances) == total issued − total redeemed`,
   checked by `checkConservation()` and asserted in tests after every
   operation.

### Epochs

Every entry carries an issuance epoch. Epochs bound the blast radius of a
farming attack (task 105): issuance policy, faucet rates, and Season-0
conversion rules are all per-epoch, so a compromised epoch cannot mint
unlimited future credits.

### What this is not

- Not a wallet: there are no private keys per user, no on-chain anything.
- Not money: no cash-out path exists in this schema. Any conversion design
  must pass the money boundary (John's tap) first.
- Not the bounty state machine: bounty lifecycle (draft → funded → claimed →
  …) lives in task 102; the ledger only records the credit movements that
  lifecycle causes.

## Audit trail (task 116)

The explorer CLI (`scripts/exchange/credits-explorer.mjs`) opens the ledger
read-only:

- `balance <acct>` — current balance.
- `search [--user A] [--bounty B] [--epoch N]` — journal entries by
  participant, bounty, or epoch.
- `trace <journal-id>` — walk an entry back through its funding chain to the
  issuance event(s). Every credit's provenance is traceable to a signed
  issuance.
- `conservation` — verify the invariant on a live ledger file.
