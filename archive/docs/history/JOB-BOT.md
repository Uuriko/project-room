# Room Job Bot (fixtures only) — R10 / D2

The demand-side prototype for the Dasha Grid loop
(`~/workspace/dasha-growth/research/dasha-system-synthesis-2026-09-27.md`, Part 2, step 1:
**"room agents post inference jobs through a room bot; providers serve them;
every job settles as a signed receipt."**)

## What it is

`server/job-bot.mjs` implements the full job lifecycle against an **in-memory
fixture provider registry**:

```
postJob → matchJob → executeJob → signed receipt
```

- **postJob** — a room agent posts a job: prompt text, optional model hint,
  and a `maxBudgetCredits` reservation. The reservation follows the
  post-&-lock shape (the anti-`$243`-job-board mechanism): the budget is
  reserved before any matching, the settled cost is deducted, and the unused
  remainder is released. The ledger is in **credits**, not money.
- **matchJob** — matches the job to the cheapest fixture provider that serves
  the model hint and fits the reserved budget. No eligible provider within
  budget → the job is marked `unmatched` (no listing beyond the reservation).
- **executeJob** — "executes" against the fixture: usage stats are
  deterministic fixture arithmetic from the prompt (tokensIn ≈ chars/4,
  tokensOut ≈ half of that, durationMs from the fixture's tok/s). **No
  response text is ever generated.**
- **receipts** — every settlement (and every failure) emits a hash-linked,
  HMAC-signed receipt following the room's event grammar
  `{at, type, actorId, data}` for journaling (`job.posted`, `job.matched`,
  `job.settled`, `job.failed`). Receipts are shaped for compatibility with the
  settled chain (`settled.chain.v0`: `prev_hash`/`hash`/`sig`/`signer` plus the
  room's job fields: `jobId`, `buyerId`, `providerId`, `model`,
  `tokensIn`/`tokensOut`, `durationMs`, `credits`, `status`), so this
  prototype plugs into the real chain later.
- **failure contract** — a failing fixture yields a signed **error receipt**
  (`status: "error"`, zero usage, `errorCode`) and never a success receipt.
  No phantom settlements.

## What it is NOT

- **No real inference.** The fixture registry stands in for the bounded Mac
  network; "execution" is arithmetic, not generation.
- **No money.** Budgets are credits in an in-memory ledger. The escrow/pool
  mechanics (escrow lock, per-token payouts, base pool) are John's taps and
  stay out of this module entirely.
- **No network.** The bot never dials out. It is importable standalone;
  nothing in `server/http.mjs` wires it in yet — that is the I1 room
  integration slice, a separate claim.

## Roadmap to the live Grid

1. **I1 room integration** (separate slice): wire the bot behind room routes,
   post-&-lock backed by real escrow, and route fixture → real provider
   transport (the buyer-facing doc surface from the synthesis).
2. **Receipt bridge**: point `issueReceipt` at the live settled chain schema
   end-to-end and publish per-provider reliability derived from receipts
   (the receipt-oracle pattern).
3. **Continuity + attestation**: providers become Continuity subscribers with
   room attestation (I2/I3); fixture failure modes are replaced by the real
   provider health the chain already records.
4. **Settlement**: escrow release on signed receipts, buyer-paid per-token
   usage + base pool (all behind John's funding taps) — this module stays
   strictly on the demand/verification side of that line.
