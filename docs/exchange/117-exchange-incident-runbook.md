# Exchange Incident Runbook (hard task 117)

When something goes wrong with the credits exchange. Read the scenario,
run the diagnosis, apply the fix, verify. Chaos test:
`tests/exchange-ledger-chaos.test.js` (on the ledger branch) proves
snapshot/restore rollback works.

## Scenario 1: Ledger DB corrupted or unreadable

**Symptoms:** explorer or ledger calls throw "file is not a database" /
SQLITE_CORRUPT; balances unreadable.

**Diagnosis:**
1. Confirm it's the file, not the code: `sqlite3 ledger.sqlite "PRAGMA integrity_check;"`
2. Check the journal tail: the last N journal rows are the blast radius.

**Fix:**
1. Stop all writers (close ledger handles; halt the exchange process).
2. Restore the last known-good snapshot: `cp snapshots/ledger-<ts>.sqlite ledger.sqlite`.
3. Replay: re-apply journal entries that came after the snapshot from the
   write-ahead log or the operator's replay log. Nonce uniqueness makes
   replay idempotent — re-applying an entry that survived is a no-op
   rejection, not a double-credit.
4. Run `PRAGMA integrity_check;` — must return `ok`.
5. Run the conservation check (explorer `trace`): total issued == total
   balances + total redeemed/burned. Any mismatch → do not reopen; escalate.

**Rollback:** the snapshot itself is the rollback. Snapshots are taken
before every deploy and hourly by cron. Never restore over the corrupted
file without copying it aside first (`ledger-corrupt-<ts>.sqlite`) — the
corrupted file is evidence.

## Scenario 2: Suspected double-spend / replay attack

**Symptoms:** the same nonce appears twice in the journal; a balance grew
without a matching issuance.

**Diagnosis:** query the journal for duplicate nonces:
`SELECT nonce, count(*) FROM journal GROUP BY nonce HAVING count(*) > 1;`

**Fix:** the ledger rejects replays at insert time (UNIQUE on nonce), so a
duplicate in the journal means the constraint was bypassed — treat as
Scenario 1 (restore from snapshot, the journal is the source of truth for
what's legitimate). Identify the bypass vector before reopening.

## Scenario 3: Escrow stuck (bounty funded but never pays out)

**Symptoms:** bounty in `funded`/`claimed` past its deadline; contributor
unpaid; sponsor confused.

**Diagnosis:** check the lifecycle state and the timeout policy (task 112):
`applyTimeouts` is idempotent — run it. If the state machine says the
bounty should have transitioned, the timeout job isn't running.

**Fix:** run `applyTimeouts(now)`; verify the transition in the journal;
notify both parties (task 115 templates 11/12). No manual state edits —
the state machine is the only writer.

## Scenario 4: Mint key suspected compromised

**Symptoms:** issuance entries with valid signatures that no operator
recognizes; balance spikes from unknown issuance.

**Diagnosis:** every issuance carries `ref` + `epoch` + signer. List
issuance not attributable to a known operator action.

**Fix:**
1. Rotate the mint keypair immediately (generate new, update the ledger's
   mint authority config).
2. Freeze issuance (refuse new `issue` calls) until rotation completes.
3. Illegitimate issuance is clawed back by operator-signed burn entries
   referencing the forged nonces — recorded in the journal, never by
   editing history.

## Scenario 5: Runaway faucet (issuance velocity spike)

**Symptoms:** analytics (task 111) shows credit velocity 10× normal;
epoch cap about to bind.

**Diagnosis:** check issuance by `ref` — which faucet is hot? Welcome
grants (sybil farm) or stipends (wash cluster)?

**Fix:** freeze the hot faucet (not the whole exchange), apply the
anti-farming defenses (task 105): identity tiering, diversity weighting.
Claw back unspent farmed credits via burn entries. Do not punish honest
users — the epoch cap already bounds per-identity damage.

## General rules

- The journal is append-only. Never edit history; correct with new entries.
- Every fix ends with the conservation check. If it doesn't balance, you're
  not done.
- Snapshot before you touch anything. The chaos test proves the restore
  path; trust it, but verify after every real restore.
