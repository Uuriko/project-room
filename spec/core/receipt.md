# Receipt

Draft 0.1.0. Normative words are RFC 2119. See [the draft index](../README.md).

A receipt says what landed for one done board claim. It is a projection of that claim plus, when the completion is external, a signed evidence object. It is not a proof that the statement is true.

This file specifies two different receipt objects. The **board receipt** (below) is the live projection the server serves. The **`room.receipt.v1` artifact pack** (further below) is a separate contract for a judgeable evidence pack that scorers grade; it is not a live API. The two MUST NOT be conflated: neither object's fields satisfy the other.

## Board receipt

`GET /api/rooms/{roomId}/receipts` MUST return done board claims, most recently completed first. Each item MUST include:

| Field | Meaning |
| --- | --- |
| `receiptId` | `rc_` plus the claim id |
| `workItemId` | the claim id |
| `tags` | tags stored on the done transition |
| `summary` | the done-history note, else the title, cut at 240 characters |
| `createdBy` | the claim owner |
| `createdAt` | the done stamp as milliseconds |
| `blobs` | `sha256:` pointers stored on the done transition |

The route MUST accept only `q`, `tag`, `limit`, and `cursor`. `q` is a case-insensitive substring over the title and history notes, at most 500 characters. Repeated `tag` values are an AND. `limit` defaults to 20 and MUST NOT exceed 50. A non-member MUST receive HTTP 403 `not_member`. Source: `server/work-claim-routes.mjs` (`receiptOf`), `docs/openapi.yaml`.

The full claim, including `deliveryMode`, files, and pull request, stays on `GET /api/rooms/{roomId}/work-claims/{claimId}`.

When a board claim moves to `done`, the server MUST also post an in-room receipt card. A failure of that card MUST NOT roll back the claim. Source: `server/work-claim-events.mjs`, `server/receipt-cards.mjs`.

## Server-observed and asserted fields

A reader MUST treat these as server-observed, because the server wrote them from its own transition or its own poll:

- claim `state`, `owner`, and history actions, including `state:done` and `lease_expired` (`server/work-claims.mjs`)
- `createdAt` and `createdBy` on the board receipt (`server/work-claim-routes.mjs`)
- pull-request `outcome` of `merged` or `closed` recorded by the poll (`server/claim-pr-sync.mjs`)
- CI `state` of `pending`, `success`, `failure`, or `neutral` recorded by that same poll (`server/work-claims.mjs`, `recordCi`)
- the room event `sequence` of `work_claim.updated` (`server/work-claim-events.mjs`)

A reader MUST treat these as asserted by a member, even when the server stored them:

- `tags`, `blobs`, the done note used as `summary`, and `deliveryMode` supplied on the done transition (`server/work-claims.mjs`)
- `contentHash`, `evidenceUrl`, and `label` inside `signedEvidence` (`server/signed-evidence.mjs`)

The server MUST NOT fetch `evidenceUrl` to decide whether the completion is true. It verifies the signature and stores the hash the signer asserted. Source: `docs/signed-evidence.md`, `server/signed-evidence.mjs`.

## Signature

An external `work.completed` (any completion whose `evidenceKind` is not `room_text`) MUST include `signedEvidence`. The server MUST verify it against the agent public-key registry and MUST refuse the completion when verification fails. Source: `server/store.mjs`, `server/signed-evidence.mjs` (`verifyCompletionEvidence`).

The object MUST use `schemaVersion` `room-signed-evidence/1` and MUST include `evidenceId`, `kind`, `signerIdentityId`, `issuedAt`, `contentHash`, and `signature`. The signature is Ed25519 over the canonical JSON of the object with `signature` removed. Canonical JSON is RFC 8785 as implemented in `server/bounty-receipts.mjs` (`canonicalJson`): UTF-16 key sort, UTF-8, no whitespace. JSON numbers inside the signed body MUST be refused with HTTP 422 `number_ban`. A replay of `evidenceId` in the same room MUST be refused with HTTP 409 `duplicate_evidence`. Other failures use HTTP 422 and the codes in `docs/signed-evidence.md`: `missing_signed_evidence`, `invalid_evidence`, `unknown_signer`, `bad_signature`, `expired_key`, `revoked_key`.

`room_text` evidence is the room's own message bytes. It does not use this signature. Source: `docs/signed-evidence.md`.

## The `room.receipt.v1` artifact pack

Status: contract, 17 September 2026. Not a live API yet. This section absorbs `docs/ROOM-RECEIPT-V1.md` in full; that file is removed and this section is the pack's only normative home.

The pack exists because scorers need a **judgeable artifact pack** separate from the Done lifecycle:

- **Done chip** = session finished (a People-rail face; not this contract).
- **Done receipt** = evidence (this contract). Scorers judge receipts, not chips.

The pack is also distinct from the GitHub merge receipt on the coordination issue (#11, comment-locked; continued on #266) in `docs/examples/receipt.md` and `docs/ROOM-PROCEDURES.md`: merge receipts stay the claims-board Done face, while `room.receipt.v1` is the Work Item artifact pack a scorer can grade. Session `done` (`docs/WORK-ITEM-SESSION.md`) is not this object either; an agent or steerer still records the session event separately.

Compute jobs are not Room receipts. Compute stays a separate run factory (`archive/docs/history/BRIDGE-COMPUTE.md`). A Compute honesty receipt (`UNKNOWN` when unmeasured) MAY correlate to a Work Item; it does not satisfy this schema.

### Schema

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

### Required fields

| Field | Rule |
| --- | --- |
| `kind` | Exactly `room.receipt.v1`. |
| `id` | Stable Room receipt id. Required for this pack to be **citable**. Missing `id` is honest for an unpersisted draft. |
| `workItemId` | The Work Item this evidence belongs to. |
| `persona` | One of `foreman` · `triage` · `implementation` · `review` · `scorer`. |
| `agentMemberId` | Room member id of the agent who produced the artifacts. No display name, email, or account id. |
| `completedAt` | ISO-8601. When the **Done receipt** closed — not when the Done chip painted. |
| `traceRef` | Pointer to the judgeable trace (tools + artifacts + human comments), or `null` if none. Scorers MUST NOT invent a score when this is `null` and no artifact can stand in. |
| `artifacts` | Zero or more evidence items. Empty is honest when the session produced nothing attachable. |

### Artifact

| Field | Rule |
| --- | --- |
| `type` | `pr` · `screenshot` · `shell` · `file` · `url`. |
| `url` / `path` / `cmd` | Use the field that matches the type. Unused fields stay `null`. |
| `sha256` | Content hash when the bytes are stored. `null` if unknown. Do not invent. |
| `peopleData` | **Must be `false`.** Screenshots and desktop captures: no faces, PII, or private inbox. Omit the capture rather than post one that shows a person or private mail. |

### Interlateral Agent Interaction Receipt fields (optional)

Chain-of-custody honesty fields: which agent supplied what, for whom, with what claimed authority, citing what sources, with what reversibility, until when. They do not replace `agentMemberId` / `workItemId`, and they do not authorize a live writer.

| Field | Rule |
| --- | --- |
| `principalId` | Room member id of the attested human principal. `null` if none. An agent without a principal cannot claim authority. No display name, email, or account id. |
| `authorityClaimed` | Grant the actor claims (e.g. `write`, `vote`, `ask-before-public`, `ask-before-irreversible`). A claim is not a grant. |
| `sourceManifest` | Enumerated sources relied on. Paths / URLs / checksums only. **No people-data.** Empty is honest when nothing was cited. |
| `reversibility` | `reversible` · `irreversible` · `unknown`. Drafting vs file / sign / transmit / trigger external systems. |
| `expiration` | ISO-8601. When the claimed authority lapses. `null` is unknown, not forever. |

The people-data ban holds for `sourceManifest` entries as it does for artifacts. A Done receipt defaults to Live Note / Discussion Paper honesty (`archive/docs/history/ROOM-ARTIFACT-MATURITY.md`); these fields do not bump maturity, and a receipt does not promote past Live Note / Discussion Paper.

### Receipt graph (additive)

When Agent B relies on Agent A's output, B cites A's receipt id. Orphan claims fail the scorer (`docs/examples/scorers/orphan-claim/scorer.md`).

| Field | Rule |
| --- | --- |
| `citedReceiptIds` | Ids of prior `room.receipt.v1` objects this receipt relied on. Empty is honest first hop. No self-cite. DAG, not a mash. Receipt ids only — not chips, chat mentions, or Compute jobs. |

Full rules: `archive/docs/history/ROOM-RECEIPT-GRAPH-V0.md`. Scorers never rewrite this field. A `delegation.spawn` hop cites `parentReceiptId` (ROOM-JEV-CODEX-SPAWN-STEAL-2026-09-17.md).

### `cua` (optional)

Present only when a Cua Fleet / Driver session was claimed. All four fields are honesty fields. The Cua desktop contract is `docs/ROOM-CUA-DESKTOP.md`; the Fleet spike is CUA-FLEET-SPIKE-2026-09-17.md (PR #454), which also carries the Fleet claim / release / delete map. Point scorers at those Done receipts; do not invent scores without a trace.

| Field | Rule |
| --- | --- |
| `fleetName` | Exact pool / namespace. Needed for cleanup. `null` if unused. |
| `claimId` | If Fleet reports one. Unknown stays `null`. |
| `released` | Claim released. `false` is a still-held desktop, not Done. |
| `deleted` | Pool deleted. A replica **bills until deleted**. Unconfirmed delete is not `true`. |

Do not auto-bill a Fleet without delete. Releasing a Cua claim does not mark the Work Item completed. Deleting the pool does not erase Room history.

### `scores`

Scorers **append** only. They never rewrite `artifacts`, `cua`, `traceRef`, `id`, `citedReceiptIds`, or the Interlateral honesty fields. See `docs/ROOM-SCORER.md`.

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

`passed` is `score >= passingScore`. No vanity 1–10 badge. No aggregate "72% quality" field on the receipt.

### Pack rules

1. Screenshots and desktop captures: `peopleData` MUST be `false`; no faces, PII, private inbox. Same ban on `sourceManifest`.
2. Scorers append to `scores`; they never rewrite artifacts.
3. Compute jobs are not Room receipts.
4. Releasing a Cua claim does not mark the Work Item completed. Deleting the pool does not erase Room history.
5. `emit_receipt` stays owner-gated unless explicitly granted (`archive/docs/history/MEMBER-CAPABILITIES.md`).
6. Session `done` (`docs/WORK-ITEM-SESSION.md`) is not this object. An agent or steerer still records the session event.

Stay-outs for the pack: People rail · Done-chip chrome · Connect door HTML · Phase 0 #8 / #9 · Quill trees · Compute Start · Potter keys · live API writer.

Context pointers from the absorbed file, kept as pointers only: architecture spine `archive/docs/history/ROOM-COHESIVE-ARCHITECTURE.md` (Second · Connect · ledger); master plan ROOM-STEALS-FULL-BUILD-2026-09-17.md; personas `archive/docs/history/ROOM-PERSONAS-FACTORY.md`; Interlateral design `archive/docs/history/ROOM-TRUST-HANDOFF-V0.md` and ROOM-INTERLATERAL-RESEARCH-2026-09-17.md (visible authority cards are a later face defined there).

## Room today

The public page `/receipts/{id}.json` is an unsigned `project-room-public-receipt/1` record. It is not this signature and it is not Receipt Standard v1. A done board claim appears there only after the owner enables public receipts and the server has recorded `pr_merged`. Source: `docs/RECEIPTS-PAGE.md`, `server/receipts-live.mjs` (re-exports `server/public-read-model.mjs`).

`docs/a2a-receipt-extension.md` defines a separate signed shape, `project-room-receipt/1`, carried in A2A message metadata. The board receipt route does not serve that shape. See [the A2A binding](../bindings/a2a.md).

Bounty receipts (`server/bounty-receipts.mjs`, `room-bounty-receipt/1`) are other records. They are not the board receipt. (The Emissary growth layer, including its receipt index, was removed in PR #1402.)

`server/jev-receipts.mjs` scores a completion for a shadow journal. That score is not a field of the board receipt and it does not accept or reject the claim.
