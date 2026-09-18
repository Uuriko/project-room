# room.receipt.v1 — Artifacts receipt

17 September 2026. Contract. Not a live API yet.

Architecture spine:
[ROOM-COHESIVE-ARCHITECTURE.md](ROOM-COHESIVE-ARCHITECTURE.md)
(Second · Connect · ledger).

Master plan:
[ROOM-STEALS-FULL-BUILD-2026-09-17.md](../research/ROOM-STEALS-FULL-BUILD-2026-09-17.md).

Scorers: [ROOM-SCORER.md](ROOM-SCORER.md). Personas:
[ROOM-PERSONAS-FACTORY.md](ROOM-PERSONAS-FACTORY.md).

Cua Fleet fields below are optional. The Cua desktop contract and Fleet
spike live on [ROOM-CUA-DESKTOP.md](ROOM-CUA-DESKTOP.md) and
[CUA-FLEET-SPIKE-2026-09-17.md](../research/CUA-FLEET-SPIKE-2026-09-17.md)
([#454](https://github.com/Uuriko/project-room/pull/454)). Point scorers
at those **Done receipts**. Do not invent scores without a trace.

Interlateral Agent Interaction Receipt fields
(`principalId`, `authorityClaimed`, `sourceManifest[]`,
`reversibility`, `expiration`) are optional honesty fields. See
[ROOM-TRUST-HANDOFF-V0.md](ROOM-TRUST-HANDOFF-V0.md) and
[ROOM-INTERLATERAL-RESEARCH-2026-09-17.md](../research/ROOM-INTERLATERAL-RESEARCH-2026-09-17.md).
Maturity labels live on [ROOM-ARTIFACT-MATURITY.md](ROOM-ARTIFACT-MATURITY.md);
a receipt does not promote past Live Note / Discussion Paper.

Receipt graph (additive): `id` + `citedReceiptIds[]`. When Agent B
relies on Agent A’s output, B cites A’s receipt id. Orphan claims
fail the scorer. See [ROOM-RECEIPT-GRAPH-V0.md](ROOM-RECEIPT-GRAPH-V0.md)
and [examples/scorers/orphan-claim/scorer.md](examples/scorers/orphan-claim/scorer.md).

## Why

Warp Scorers + Cua need a **judgeable artifact pack** separate from the
Done lifecycle.

- **Done chip** = session finished (People-rail face; not this contract).
- **Done receipt** = evidence (this contract). Scorers judge receipts,
  not chips.

This is not the GitHub issue-#11 merge receipt in
[examples/receipt.md](examples/receipt.md) and
[ROOM-PROCEDURES.md](ROOM-PROCEDURES.md). Merge receipts stay the
claims-board Done face. `room.receipt.v1` is the Work Item artifact pack
a scorer can grade.

Compute jobs are not Room receipts. Compute stays a separate run factory
([BRIDGE-COMPUTE.md](BRIDGE-COMPUTE.md)). A Compute honesty receipt
(`UNKNOWN` when unmeasured) may *correlate* to a Work Item; it does not
satisfy this schema.

## Schema

```json
{
  "kind": "room.receipt.v1",
  "id": "string",
  "workItemId": "string",
  "persona": "foreman|triage|implementation|review|scorer",
  "agentMemberId": "string",
  "completedAt": "ISO-8601",
  "traceRef": "string|null",
  "artifacts": [
    {
      "type": "pr|screenshot|shell|file|url",
      "url": "string|null",
      "path": "string|null",
      "cmd": "string|null",
      "sha256": "string|null",
      "peopleData": false
    }
  ],
  "principalId": "string|null",
  "authorityClaimed": "string|null",
  "sourceManifest": [
    {
      "url": "string|null",
      "path": "string|null",
      "sha256": "string|null"
    }
  ],
  "reversibility": "reversible|irreversible|unknown",
  "expiration": "ISO-8601|null",
  "cua": {
    "fleetName": "string|null",
    "claimId": "string|null",
    "released": true,
    "deleted": true
  },
  "citedReceiptIds": [],
  "scores": []
}
```

### Required

| Field | Rule |
| --- | --- |
| `kind` | Exactly `room.receipt.v1`. |
| `id` | Stable Room receipt id. Required for this pack to be **citable**. Missing `id` is honest for an unpersisted draft. See [ROOM-RECEIPT-GRAPH-V0.md](ROOM-RECEIPT-GRAPH-V0.md). |
| `workItemId` | The Work Item this evidence belongs to. |
| `persona` | One of `foreman` · `triage` · `implementation` · `review` · `scorer`. |
| `agentMemberId` | Room member id of the agent who produced the artifacts. No display name, email, or account id. |
| `completedAt` | ISO-8601. When the **Done receipt** closed — not when the Done chip painted. |
| `traceRef` | Pointer to the judgeable trace (tools + artifacts + human comments), or `null` if none. Scorers must not invent a score when this is `null` and no artifact can stand in. |
| `artifacts` | Zero or more evidence items. Empty is honest when the session produced nothing attachable. |

### Artifact

| Field | Rule |
| --- | --- |
| `type` | `pr` · `screenshot` · `shell` · `file` · `url`. |
| `url` / `path` / `cmd` | Use the field that matches the type. Unused fields stay `null`. |
| `sha256` | Content hash when the bytes are stored. `null` if unknown. Do not invent. |
| `peopleData` | **Must be `false`.** Screenshots and desktop captures: no faces, PII, or private inbox. Omit the capture rather than post one that shows a person or private mail. |

### Interlateral Agent Interaction Receipt (optional)

Chain-of-custody honesty fields. Which agent supplied what, for whom,
with what claimed authority, citing what sources, with what
reversibility, until when. They do not replace `agentMemberId` /
`workItemId`. They do not authorize a live writer.

| Field | Rule |
| --- | --- |
| `principalId` | Room member id of the attested human principal. `null` if none. An agent without a principal cannot claim authority. No display name, email, or account id. |
| `authorityClaimed` | Grant the actor claims (e.g. `write`, `vote`, `ask-before-public`, `ask-before-irreversible`). A claim is not a grant. Visible authority cards are a later face — [ROOM-TRUST-HANDOFF-V0.md](ROOM-TRUST-HANDOFF-V0.md). |
| `sourceManifest` | Enumerated sources relied on. Paths / URLs / checksums only. **No people-data.** Empty is honest when nothing was cited. |
| `reversibility` | `reversible` · `irreversible` · `unknown`. Drafting vs file / sign / transmit / trigger external systems. |
| `expiration` | ISO-8601. When the claimed authority lapses. `null` is unknown, not forever. |

People-data ban still holds: screenshots, shell excerpts, and
`sourceManifest` entries must not include faces, PII, or a private
inbox. `peopleData` on every artifact remains `false`.

A Done receipt defaults to Live Note / Discussion Paper honesty
([ROOM-ARTIFACT-MATURITY.md](ROOM-ARTIFACT-MATURITY.md)). These fields
do not bump maturity.

### Receipt graph (additive)

Trust Handoff made structural. B cites A when B relied on A’s Done
pack. Orphan claims fail
[orphan-claim](examples/scorers/orphan-claim/scorer.md).

| Field | Rule |
| --- | --- |
| `citedReceiptIds` | Ids of prior `room.receipt.v1` objects this receipt relied on. Empty is honest first hop. No self-cite. DAG, not a mash. Receipt ids only — not chips, chat mentions, or Compute jobs. |

Full rules: [ROOM-RECEIPT-GRAPH-V0.md](ROOM-RECEIPT-GRAPH-V0.md).
Scorers never rewrite this field. A `delegation.spawn` hop cites
`parentReceiptId` — [ROOM-JEV-CODEX-SPAWN-STEAL-2026-09-17.md](../research/ROOM-JEV-CODEX-SPAWN-STEAL-2026-09-17.md).

### `cua` (optional)

Present only when a Cua Fleet / Driver session was claimed. All four
fields are honesty fields, not a slideshow.

| Field | Rule |
| --- | --- |
| `fleetName` | Exact pool / namespace. Needed for cleanup. `null` if unused. |
| `claimId` | If Fleet reports one. Unknown stays `null`. |
| `released` | Claim released. `false` is a still-held desktop, not Done. |
| `deleted` | Pool deleted. A replica **bills until deleted**. Unconfirmed delete is not `true`. |

See [#454](https://github.com/Uuriko/project-room/pull/454) for the
Fleet claim / release / delete map. Do not auto-bill a Fleet without
delete.

### `scores`

Scorers **append** only. They never rewrite `artifacts`, `cua`,
`traceRef`, `id`, `citedReceiptIds`, or the Interlateral honesty
fields. See [ROOM-SCORER.md](ROOM-SCORER.md).

Each entry:

```json
{
  "slug": "task-compliance",
  "label": "pass",
  "score": 1.0,
  "passingScore": 1.0,
  "passed": true,
  "model": "fast-default",
  "reason": "string",
  "scoredAt": "ISO-8601",
  "scorerMemberId": "string"
}
```

`passed` is `score >= passingScore`. No vanity 1–10 badge. No
aggregate “72% quality” field on the receipt.

## Rules

1. Screenshots and desktop captures: `peopleData` must be `false`; no
   faces, PII, private inbox. Same ban on `sourceManifest`.
2. Scorers append to `scores`; they never rewrite artifacts.
3. Compute jobs are not Room receipts.
4. Releasing a Cua claim does not mark the Work Item completed.
   Deleting the pool does not erase Room history.
5. `emit_receipt` stays owner-gated unless explicitly granted
   ([MEMBER-CAPABILITIES.md](MEMBER-CAPABILITIES.md)).
6. Session `done` ([WORK-ITEM-SESSION.md](WORK-ITEM-SESSION.md)) is not
   this object. An agent or steerer still records the session event.

## Stay-outs

People rail · Done-chip chrome · Connect door HTML · Phase 0 #8 / #9 ·
Quill trees · Compute Start · people-data · Potter keys · live API
writer.
