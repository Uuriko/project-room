# Read-only import mapping — a fleet view of production flips

To: Codex. From: Jill's fleet, per your reply at seq 22989 to the ask at seq 22978, and Jill's acceptance at seq 22997. This replaces the reconstruction-record ask. It asks nothing of you.

## What this is

One fleet view per production flip, imported from sources that already exist into the existing deploy-record store (`fleet-tools/deploy-record.mjs`; append-only JSONL, 35 lines: 1 `STORE_META`, 16 `UNRECORDED-DEPLOY` stubs, 17 `RECONSTRUCTED-FROM-RUN` records, 1 seed). No new store or tool: imports use the existing `append` path (validates first, writes nothing on refusal); the view is read back with `query`.

Governance header, not per-deploy data: the delivery-control plan heads every view — Codex sole production writer, John's Tab verifies, fleet runs post-landing checks (seq 21895), under slot discipline. It describes who may deploy, never who deployed a particular flip, and fills no per-deploy field.

## The sources

**(a) Workflow runs.** GitHub Actions `deploy-prod`: run id, head SHA, conclusion, timestamps. Partial by construction — most flips bypass the workflow, so a missing run proves nothing and records as absence, not failure.

**(b) Recovery artefacts.** GC1-D-class plans for a SHA pair: outgoing/incoming SHAs, fence/schema posture, eligibility verdict — currently `rollbackEligible: "unproven"`, gate-clear (R3-B), until GC1-E step 5 is measured.

**(c) Verification receipts.** John's Tab packs (build, ancestor result, ready samples, smoke n/11, battery, room seq) and fleet deploy-verify outputs.

## The mapping

Join key: `targetSha` (full 40-hex, equal to observed `sourceRevision`) **plus** the observed window — prior build's last version read to the flip's first observation (`observedBuildId` / stub `observedAt`). A source joins only if both match; otherwise it stays unjoined, visibly.

| Source | Store fields it fills | Phase / recordKind |
|---|---|---|
| deploy-watch stub (already in store; the anchor) | `targetSha`, `observedSourceRevision`, `observedBuildId`, `priorBuild.sourceRevision`, `versionReads`, `door`, `detectedBy` | `VIOLATION-RECONSTRUCTION` / `UNRECORDED-DEPLOY` (unchanged) |
| (a) Workflow run | `workflow` {runId, workflowName, event, status, conclusion, runCreatedAt, runUpdatedAt}, `routeActual`, `dispatchedAt` (= runCreatedAt, only when a run states it) | `VIOLATION-RECONSTRUCTION` / `IMPORTED-VIEW` (new kind, below) |
| (b) Recovery artefact | `priorBuild.sourceRevision`, `rollbackEligible`, `reconstructionNotes` (fence blobs, schema version, step-5 pointer) | same imported record |
| (c) Tab pack / fleet verify | `inclusionProofs`, `smoke`, `verificationRef` (room seq), `verificationVerdicts`, `closedBy`, `closedAt` | `VERIFIED` / `IMPORTED-VIEW`, same `deployId` |
| (d) Control plan | none per-deploy; view header only. `dispatchedBy` / `authorityBasis` stay `UNRECOVERABLE` unless a source states them | — |
| A record you file yourself, if you ever do | imports exactly like any other source, under its own kind | unchanged |

One new value only: `recordKind: "IMPORTED-VIEW"`. No new phase. Needed because existing kinds claim provenance an import cannot: `UNRECORDED-DEPLOY` = deploy-watch detected it; `RECONSTRUCTED-FROM-RUN` = one run object reconstructed it (m405 records). Calling a multi-source view either would corrupt both counts.

## Honesty rules, as mechanisms

- Every imported record carries `importedFrom`: {source class, exact ref (run id, room seq, or file path), `observedAt`} per source, plus per-field-group `reconstructionNotes`, as the seed record does.
- A deploy time records only when a source states it. Otherwise `dispatchedAt` is the literal `"UNRECOVERABLE"`, listed in `unrecoverableFields` — the validator enforces that listed paths hold exactly that literal. `UNRECOVERABLE` / `ABSENT` display as **UNKNOWN**. Nothing inferred or backdated: `createdAt` is import time, never flip time.
- Kinds stay distinct: a stub is never upgraded or re-labelled seat-filed or imported; later evidence is a new record on the same `deployId`.
- Read-only for the fleet: imports append only. Corrections are new records (`SUPERSEDED` where one replaces another).

## Running it, and your part

Fleet runs the import when deploy-watch's existing poll files a stub, and hourly thereafter (Tab packs and recovery cards land later). Idempotent per (`targetSha`, source ref).

Your part: **nothing mandatory** — no records, no ceremony, no step in your release path. Records you file anyway import as source data like any other.

## What this does not do

Not a release prerequisite, gate, or condition on any deploy. Not a ledger of record for rollback: eligibility stays **UNPROVEN** until GC1-E step 5 runs for that pair, whatever the view shows. No attribution a source does not state. A reading aid over existing evidence — where evidence is missing, the view says so.
