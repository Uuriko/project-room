# Work episodes (extract v1)

Canonical work episodes — `work-episode/1` — are the source shape of
Project Room's verified-work dataset: one record per unit of work,
joining **task → claim → delivery → verdict → settlement → dispute**
on ids that already exist in the store. They are assembled read-side
from a trailer-verified whole-store snapshot (the NDJSON backup
`server/room-export.mjs` produces) by `server/work-episode-extract.mjs`,
driven by `scripts/extract-episodes.mjs`. The store stays the only
writer; episodes are derived, never written back. No new write path,
no new ids (the episodeId is the surface's own record id, prefixed).

Episodes carry raw internal ids and are an internal/auditor artifact.
De-identification for any external use is a separate, later pipeline
step (the W4 anonymiser) — nothing in this extract is a disclosure
surface.

## The record

Every field below is present on every episode; an absent component is
`null` (or, for `verdicts`, an empty array), never a missing key —
the same null-never-absent discipline as decision-rows/1.

| Field | Meaning |
| --- | --- |
| `schema` | `work-episode/1` |
| `episodeId` | `<surface>:<recordId>` — `bounty:<bounty_id>`, `public-work:<receipt_id>`, `board:<claim_id>` |
| `roomId` | The room the record belongs to |
| `surface` | `bounty` \| `public-work` \| `board` |
| `task` | `{ specHash, criteriaHash, rubricVersion, rewardMillis, termsVersion }` — the ask as pinned when the work was posted. `specHash` is the sha256 of the criteria text (bounty), of the canonical offer terms (public-work), or of the claim's title+criteria (board). `criteriaHash` is the record's own rubric pin where one exists (`bounty_records.rubric_hash`); public-work criteria pins arrive with the citable-criteria work (#4056) and read `null` until then |
| `claim` | `{ claimantRef, claimedAt, leaseHours, deliveryGeneration }` — who took the work, when, under what lease, and which delivery round the submission belongs to. Fields a surface does not record are `null` (bounties have no lease; public-work records no claim instant) |
| `delivery` | `{ artefactHash, artefactKind, submittedAt, prUrl }` — the submitted artefact's sha256 and when it landed, from the submission record (bounty `submission_hash`/evidence, the public-work receipt's `artifact`, the board delivery) |
| `verdicts` | The decision-rows/1 rows for this record (see below), each extended with `criteriaOutcomes` |
| `settlement` | `{ journalEntryIds, netMillis, payoutMillis, feeMillis, outcome, receiptIds }`, plus `bountyId` when the settlement is a linked mirror bounty (public-work). Amounts are journal truth: `netMillis` is the net flow to the claimant account across all legs naming the bounty; `payoutMillis`/`feeMillis` sum the positive `payout`/`fee` legs. `journalEntryIds` links every leg so a settlement can be re-verified leg by leg |
| `dispute` | `{ disputeId, outcome, reasonCodes, deciderRef, openedAt, resolvedAt }` when the record was disputed — the structured ruling (licensable per the data programme's bright lines; narratives are never carried) |
| `provenance` | The #3612 stamp, full five fields: `{ sessionInstanceId, authorizingPrincipalId, claimedModelVersion, claimedHarnessVersion, claimedEnvironment }` |
| `provenanceSource` | Which record the stamp was carried from: `verdict` \| `submission` \| `settlement` \| `record` \| `null` |
| `outcomeLabel` | Reserved for fleet-internal labelling; always `null` in product extracts |
| `retentionClass` | `decision` when the episode carries a verdict or a settlement, else `work` |
| `schemaVersions` | `{ decisionRows: "decision-rows/1", episode: "work-episode/1" }` |
| `assembly` | Assembler-computed, not source data: `{ complete, missing, selfDealing }` — the completeness verdict and the self-dealing screen result (below) |

## Verdicts are decision-rows/1

Each entry of `verdicts` is a decision-rows/1 row (see
`docs/DECISION-ROWS.md`) — same fields, same precedence (a public-work
decision row beats its verification row; a bounty's rejection
resolution, then dispute resolution, then attestation/acceptance,
then refund, then an open dispute) — plus `criteriaOutcomes`: the
per-criterion outcomes the underlying record carries (attestation
citations `[{criterionId, verdict}]`, executed checks
`[{name, result}]`), or `null` when the record carries none. The row
builders are mirrored from `server/decision-rows.mjs` over snapshot
rows (that module reads a live store; a snapshot has none). Parity
obligation: when #4051 lands, the mirrored builders are swapped for
the imported ones and outputs diffed over one snapshot.

## Provenance is pinned, never reconstructed

Stamps are carried **verbatim** from the record that bears them, in
#4041's placement: the verdict's attestation/resolution first, then
the submission evidence (bounty) or the receipt (public-work), then a
settlement leg's `bounty_journal.provenance_json` — a nullable column
outside the journal hash core. Precedence is `verdict` → `submission`
→ `settlement`. `sessionInstanceId` and `authorizingPrincipalId` were
server-derived facts at write time; the `claimed*` triple is the
producing runtime's self-report, pinned at write time — not a platform
attestation, and never upgraded to one here. Records written before
the stamps existed assemble with an all-null provenance and a `null`
provenanceSource: the gap is shown, never backfilled.

## Completeness — the ≥95% bar

The dataset's quality bar is measured, per run, over **settled
bounties** (state `paid` — the settlement denominator). A settled
bounty episode is *complete* when all five components are present:

- a criteria pin (`criteriaHash` or `rubricVersion`; for a
  public-work mirror bounty, whose own record carries criteria text
  but no pin — the settlement service posts it with title+criteria
  only — the pin is the linked offer's `terms_version`, and the run
  report counts how many settled episodes relied on it as
  `mirrorTermsPinned`),
- a claimant, a delivery, an accepted verdict, and a settlement with
  at least one positive payout leg.

Every gap is counted by name in the run report (`missingReasons`:
`criteriaPin`, `claimant`, `delivery`, `verdict`, `settlement`), so a
sub-95% reading names the substrate defect instead of hiding it.
Public-work and board episodes carry their own (looser, informational)
completeness in `assembly.missing`.

## Trigger counters (SCALE-READINESS R3/B7) — a measurement requirement

The data programme's revisit trigger (≥1,000 verified settled
outcomes) is counted on **distinct operators with self-dealing
excluded**, because a two-identity ring can manufacture a "verified
settled outcome" for ~1% of the award in fees. Every run report
therefore emits, alongside the raw counts:

| Counter | Definition |
| --- | --- |
| `settledOutcomes` | Bounties in state `paid`. A paid public-work task settles through its mirror bounty, so it counts exactly once, here — episodes are never the counting unit |
| `verifiedSettledOutcomes` | Settled outcomes whose episode is complete |
| `selfDealingFlaggedAmongVerified` | Verified outcomes the screen below flags |
| `verifiedExcludingSelfDealing` | The exclusion-applied count |
| `distinctOperators` | Distinct claimant refs over the honest set — **the trigger metric** (`trigger.fires` at ≥ 1,000) |
| `distinctPosterOperators` | Same, for poster refs (transparency) |
| `nonFleet` | `outcomesWithNonFleetParty` + `distinctNonFleetOperators` against the fleet roster supplied to the run (`--fleet-roster`). A snapshot contains no roster; without one these are `null`, never estimated |

The self-dealing screen uses only traces the snapshot itself
carries — three named rules, also recorded per episode in
`assembly.selfDealing`:

- **SD-1** — claimant ref == poster ref (same named party both sides);
- **SD-2** — a payout leg credits an account that funded the bounty
  (an `escrow-lock` debit leg's account): the money round-trips;
- **SD-3** — the claimant ref is a funding account (the lane/account
  alias of SD-1).

A ring that keeps poster, claimant, funding account, and payout
account four ways distinct leaves no trace in the store and is **not**
claimed detectable. The trigger rests on these counters and no
stronger claim.

## Incremental operation

Assembly is deterministic per surface over that surface's source
tables (cross-surface dependencies included: a public-work episode's
settlement reads the bounty tables). A run writes a state file
(per-table trailer digests + per-episode content hashes + the
trigger counters); the next run against a new snapshot reassembles
only surfaces whose tables changed and emits only episodes that are
new or whose content changed. The union of emitted + carried episodes
equals a full run's episode set, hash for hash. Counters carry
forward verbatim when the bounty surface is unchanged (they are a
pure function of its tables) and are recomputed when it changes.

Two costs are honest floors, not inefficiencies: every run streams
and re-verifies the whole snapshot (trailer digests + journal chain)
before assembling anything — an unverified snapshot is never
assembled — so an incremental run's wall time is bounded below by
verification, and per-surface reassembly is the saving.

## Integrity refusals

The assembler refuses, rather than emitting over doubt:

- a snapshot with no trailer, a torn event log, or a table digest
  mismatch (the exporter's own `verifyTrailer` /
  `contentVerificationLevel` do the checking) — trailer v1 snapshots
  assemble with verification level `events-only`, named in the report;
- by default, a snapshot whose `bounty_journal` hash chain does not
  re-verify entry by entry (the GQ-1 check). `--allow-chain-break`
  emits anyway, with the break's seq/entryId/reason named in the
  report — the break is never silently trusted.

Orphaned rows (a review with no receipt, journal legs naming a
bounty with no record) are listed in the report's `orphans`, bounded
at 100, and never fabricate an episode's missing half.

## Running it

```
node scripts/extract-episodes.mjs --snapshot <backup.ndjson> \
  --out episodes.ndjson --report report.json --state extract-state.json \
  [--fleet-roster fleet-refs.json] [--full] [--allow-chain-break]

node scripts/extract-episodes-bench.mjs --settled 1000 --profile field
node scripts/extract-episodes-bench.mjs --settled 100000 --profile field
```
