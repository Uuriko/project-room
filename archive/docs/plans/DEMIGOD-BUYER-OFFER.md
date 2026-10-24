# Record-only buyer offers and trials

These are private room records. Nothing collects, holds, refunds, settles or pays money. Every agreement reports `recordOnly: true` and `paymentStatus: not_configured`. Policy quotes are hypothetical calculations, not a financial ledger or proof that a fee was paid.

The owner creates an offer profile anchored to an existing `project_offers` record. The named buyer accepts the pinned revision. A contract snapshots those exact terms and names a distinct active worker; that worker acknowledges it. A submitted trial has a contract-linked delivery loop: the candidate delivers, the buyer can request revisions within the agreed limit, and only the buyer accepts.

Completion requires an accepted contract-linked delivery and a stored successful signed vetting receipt. Matching a receipt reference string alone cannot complete a contract. The receipt, trial and contract must agree on candidate, buyer, requisition, hours, deliverable shape and pinned rubric weights.

## Access

All routes require an active room credential. Browser writes require the current session binding and CSRF. API keys require `rooms:read` or `rooms:write` for the corresponding verb; account sessions cannot be sent as bearer credentials. Agent writes also require `accept_work`.

Private records are readable only by the owner or their bound parties. Only the owner can enumerate buyer offer, contract and delivery records. Trial lists are bounded to 100 recent records and filtered to the caller's parties. Another room credential or arbitrary identity does not grant access. Deactivated members and revoked credentials lose access, including retries. Archived rooms reject writes.

## Trial commands

`POST /api/rooms/{roomId}/trial-tasks` takes a strict action envelope. Every action requires a unique `requestId`. Exact retries return the committed outcome; another actor or changed input under that ID receives a conflict. IDs cannot overwrite a trial. State transitions require `taskId` and the last `expectedRevision`.

- `create`: owner supplies `taskId`, active distinct `candidateId` and `buyerId`, `demigodReqId`, `title`, `trialScope` (`hoursMax`, `deliverableShape`), `vettingRubric` (`criterion`, `weightBps` strings totaling 10000), `feePolicyRef`, and optionally `budgetRecord`. A recorded budget does not mean funds exist.
- `fund`: owner/buyer supplies a budget note; attribution comes from the authenticated actor.
- `claim`, `submit`: only the bound candidate can claim or submit; candidate identity cannot be supplied on transitions. Submit includes `deliverableRef`.
- `block`, `resume`, `release`: owner/buyer controls the lifecycle.
- `configure`: owner establishes an Ed25519 issuer public key with `pubkey` and `expectedRevision`. The service never generates or stores an issuer private key. An issuer key cannot be assigned to another room after it has been recorded.
- `verdict`: owner/buyer supplies `verdict`, `rubricScores`, and the externally signed `receipt`. Buyer acceptance must already exist. The trusted signature must bind the exact task, candidate, requisition, scope, scores, verdict and authenticated evaluator. Successful ingestion stores the signed receipt, issuer provenance and acceptance time, then moves the task to `receipted`. A failed verdict is receipted too, but cannot complete a contract. Receipt IDs are unique across the service.
- `quote`: owner supplies decimal-string `placementValueMinor`, `trialHoursMax`, `hourlyRateMinor` and a three-letter `currency`. The durable retry result illustrates the fee policy and possible credit; every entry is hypothetical and settlement remains record-only.

Read a trial at `GET /api/rooms/{roomId}/trial-tasks/{recordId}`. Read its accepted signed receipt and issuer provenance at the same path plus `/receipt`. Consumers must independently trust the configured issuer public key and verify the expected candidate/task; a public key returned alongside an arbitrary receipt is not proof of trust.

## Buyer routes

Under `/api/rooms/{roomId}`:

- `/demigod-offers`: GET owner list, POST create. `/{recordId}` reads; `/document` returns private Markdown; POST `/present`, `/accept`, `/decline`, `/expire`, `/withdraw` records lifecycle decisions.
- `/demigod-contracts`: GET owner list, POST create from an accepted offer revision. `/{recordId}` reads; POST `/acknowledge`, `/complete`, `/terminate` records party decisions.
- `/signoff-loops`: GET owner list, POST create against an actual submitted trial. `/{recordId}` and `/status` read; POST `/submit`, `/review`, `/cancel` records deliveries and buyer decisions.

Buyer actions retain the strict shapes documented in their domain modules. Writes use durable exact request IDs. Offer transitions also fence the pinned revision. Workers cannot self-accept their delivery or complete the buyer's contract.

## Storage, recovery and limits

The ten additive room tables are `room_trial_tasks`, `room_trial_requests`, `room_vetting_keys`, `room_vetting_receipts`, `demigod_offer_profiles`, `demigod_offer_requests`, `demigod_contracts`, `demigod_contract_requests`, `buyer_signoff_loops`, and `buyer_signoff_requests`. Existing indexed-message schema version 38 stays unchanged. Fresh schema stamps include all ten tables.

SQLite transactions atomically commit transitions and retry outcomes. Online backup and NDJSON recovery include these records; room purge removes them and personal-room account deletion strips their private text. There is no migration from the insecure, unshipped process-global trial registry.

There is no public trial endpoint, automatic execution, paid-fee ledger, provider integration or enabled custody. External signing and issuer-key custody remain the evaluator's responsibility. This API records decisions and evidence only.
