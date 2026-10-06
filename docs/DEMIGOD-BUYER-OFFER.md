# Demigod buyer offers, contracts, and the revision loop

**Status:** buyer-facing layer above the Demigod jobs integration
(`docs/DEMIGOD-JOBS-INTEGRATION.md`). **Record-only**: no money moves —
amounts are bookkeeping rehearsal until Demigod enables a real payout path.

The fulfillment dry run (`~/workspace/upwork-pipeline/fulfillment-dryrun-2026-10-06.md`)
found four missing buyer-facing pieces. This is the build that closes three
of them:

| Dry-run gap | What this builds |
|---|---|
| No buyer-facing offer surface | Offer template: scope, deliverables, price type, timeline — plus a presentable Markdown document (`GET …/demigod-offers/{id}/document`) |
| No contract record | Contract structure: parties, byte-exact terms snapshot, acceptance flow |
| No revision loop, no buyer acceptance step | Sign-off loop: submission → buyer review → revision request → re-delivery → sign-off |

## The pieces and how they compose

```
project_offers (existing)            the room's generic, owner-authored offer surface
        │ offerRef
        ▼
demigod-offers (new)                 Demigod buyer-offer profile: trial scope,
                                     pinned rubric, price type, timeline,
                                     revision terms. draft → presented →
                                     accepted | declined | expired | withdrawn
        │ accept (buyer, exact revision)
        ▼
demigod-contracts (new)              Record-only agreement: parties, frozen
                                     terms snapshot, acceptance flow.
                                     pending → active → completed | terminated
        │ revisionTerms.maxRounds
        ▼
trial task (#1624, open)             The work itself: proposed → funded →
   submitted ─────────────────────── claimed → submitted → verdict → receipted
        │                     ▲
        │ trialTaskId         │ buyer accepts BEFORE the verdict
        ▼                     │
signoff-loops (new)                  open → submitted → under_review →
                                     changes_requested → submitted (round++) →
                                     accepted | cancelled
        │
        ▼ accepted
vetting receipt (#1623, open)        The trial-task lane issues the signed
                                     receipt; the contract's completion cites
                                     the receipt ref — it never fabricates it.
```

The sign-off loop is an **overlay**: it never edits the trial-task state
machine. While the trial task sits in `submitted`, the loop records the
buyer's side — each delivery round (deliverable ref + sha256 + summary),
each buyer review, and the final sign-off. The documented handoff: the
buyer accepts in the loop *before* the evaluator posts the trial verdict.

## The offer template

A buyer offer profile carries:

- **Scope**: `trialScope.hours` (positive integer string) and
  `trialScope.deliverableShape` (`code-pr`, `markdown-report`, `design-mock`,
  `data-set`, `automation-run`, …), plus the base offer's summary and
  acceptance criteria.
- **Deliverables**: the base `project_offers` offer's acceptance criteria —
  the concrete "done" list the buyer reads.
- **Price type**: `fixed` | `hourly` | `trial_management_fee`, with
  `priceMilli` as a positive integer string (record-only milli-units).
- **Timeline shape**: `timeline.estimateDays` + `timeline.deadline`.
- **Revision terms**: `revisionTerms.maxRounds` (1–10) and
  `revisionTerms.turnaroundDays` — enforced, not advisory.
- **Vetting rubric**: pinned at creation (1–50 criteria); later edits cannot
  rewrite what the buyer accepted.
- **Fee policy ref**: defaults to `demigod:placement-10pct/v1`.

The presentable document (`GET /api/rooms/{roomId}/demigod-offers/{id}/document`)
renders all of this as Markdown in plain language, ending with the honest
line:

> Record-only: no payment is collected or moved by this document. Amounts
> are bookkeeping rehearsal until Demigod enables a real payout path.

## The contract

Minted from an **accepted** offer by naming its exact accepted revision —
a stale revision is a 409, so the buyer can never accept terms the room
changed after they read them. The contract freezes the terms as byte-exact
canonical JSON: later offer edits cannot rewrite the deal.

Acceptance flow:

1. `pending` — minted. The worker acknowledges → `active`.
2. `active` — work proceeds (trial task + sign-off loop run alongside).
3. `completed` — the buyer (or owner) completes **only with** a
   `trialTaskId` and `receiptRef`. Completion cites the vetting receipt; it
   never self-asserts. (This is the direct fix for the dry run's
   "I completed my own claim with no counterparty".)
4. `terminated` — buyer or owner, with a recorded reason. Terminal states
   are immutable.

## The revision / sign-off loop

The loop the dry run found structurally missing, closed end to end:

1. **Submission** — the worker delivers a round: deliverable ref, sha256,
   plain-language summary. (`POST …/signoff-loops/{id}/submit`)
2. **Buyer review** — only the recorded buyer may review (the worker cannot
   self-accept). Three decisions: `begin` (I'm looking at it),
   `request_changes` (with a note), `accept` (sign-off).
   (`POST …/signoff-loops/{id}/review`)
3. **Revision request** — `changes_requested` sends the round back; the
   worker re-delivers (`submit` again, round++). Resubmitting past
   `maxRounds` is a 422 `revision_rounds_exhausted`.
4. **Re-delivery** — every round is journaled: who delivered what, when,
   with which sha256, and what the buyer said.
5. **Sign-off** — `accepted`. The buyer accepted *before* the trial
   verdict, so the evaluator scores work the buyer already signed off on.

Buyer-visible status (`GET …/signoff-loops/{id}/status`) shows state,
round, maxRounds, the current deliverable summary, and the last review —
no room internals. This is the status surface the dry run found missing
(gap #5: "a buyer without room access sees nothing").

## API

All routes live under `/api/rooms/{roomId}/` and are documented in
`docs/openapi.yaml` (extension `x-demigod-buyer-offer`):

- `/demigod-offers` — create (POST) / list (GET)
- `/demigod-offers/{id}` — read
- `/demigod-offers/{id}/document` — presentable Markdown
- `/demigod-offers/{id}/{present,accept,decline,expire,withdraw}` — transitions
- `/demigod-contracts` — mint (POST) / list (GET)
- `/demigod-contracts/{id}` — read
- `/demigod-contracts/{id}/{acknowledge,complete,terminate}` — transitions
- `/signoff-loops` — open (POST) / list (GET)
- `/signoff-loops/{id}` — read
- `/signoff-loops/{id}/status` — buyer-visible status
- `/signoff-loops/{id}/{submit,review,cancel}` — loop transitions

All mutating routes take `requestId` (idempotency) and, for transitions,
`expectedRevision` (compare-and-swap). Guests may read but never write.
API keys need `rooms:read` / `rooms:write`.

## Money discipline

- Amounts are positive integer **strings** (milli-units); no JSON numbers
  in money fields.
- Every record carries `recordOnly: true` and
  `paymentStatus: 'not_configured'`.
- The settlement router's custody branch stays fail-closed
  (`CUSTODY_ENABLED = false`); this layer never calls it.
- Nothing here touches Stripe, Connects, charges, payouts, or sends.

## Files

- `server/demigod-offers.mjs` — offer profiles + presentable document
- `server/demigod-contracts.mjs` — record-only contracts
- `server/buyer-signoff.mjs` — revision/sign-off loops
- `server/buyer-offer-routes.mjs` — HTTP routes (mounted by `server/http.mjs`)
- `tests/demigod-offers.test.js`, `tests/demigod-contracts.test.js`,
  `tests/buyer-signoff.test.js`, `tests/buyer-offer-http.test.js`
