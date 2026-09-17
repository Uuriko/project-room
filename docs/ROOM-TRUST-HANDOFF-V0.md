# Trust Handoff Protocol v0

17 September 2026. Contract. Docs only. Not a live API.

Steal from Interlateral’s agent-to-agent delegation checklist (Stanford
FutureLaw event report, 13 April 2026). Research:
[ROOM-INTERLATERAL-RESEARCH-2026-09-17.md](../research/ROOM-INTERLATERAL-RESEARCH-2026-09-17.md).

Receipts: [ROOM-RECEIPT-V1.md](ROOM-RECEIPT-V1.md). Maturity:
[ROOM-ARTIFACT-MATURITY.md](ROOM-ARTIFACT-MATURITY.md). Attention +
presence (Alook; membership ≠ authority ≠ attention):
[ROOM-ATTENTION-PRESENCE-V0.md](ROOM-ATTENTION-PRESENCE-V0.md). Master
plan:
[ROOM-STEALS-FULL-BUILD-2026-09-17.md](../research/ROOM-STEALS-FULL-BUILD-2026-09-17.md).

Catalog row: **Interlateral-aligned receipts / authority cards** on
[ROOM-KITS-CATALOG.md](ROOM-KITS-CATALOG.md) — Optional later, not a
live `/room/kits` door.

## Why

Identity, authority, and capability are three different things. A
capable agent is not an authorized one. A badge is not blanket
authority. A Trust Handoff is the checklist for any agent-to-agent
delegation object: who is acting, for whom, with what grant, on what
task, citing what, until when.

This is **not** People-rail chrome and not a Connect door. Visible
authority cards = later face, **not People-rail HTML** (may write /
may vote / must ask before public action / must ask before
irreversible action).

## Fields

| Field | Meaning |
| --- | --- |
| `identity` | Who is acting. Room member id of the agent (or human) taking the handoff. No display name, email, or account id. |
| `principal` | Who they act for. Room member id of the attested human principal. An agent without a principal cannot act. |
| `authorityScope` | What the principal granted (write / vote / ask-before-public / ask-before-irreversible). Not inferred from capability. |
| `taskScope` | The Work Item (or bounded next action) this handoff covers. One primary claim. |
| `sourceManifest` | Enumerated sources the agent relied on. Paths / URLs / kit checksums. No people-data. |
| `confidence` | How sure the actor is (`high` · `medium` · `low` · `unknown`). Honesty field — not a vanity score. |
| `knownLimitations` | What this handoff does **not** cover. Empty is allowed; invented completeness is not. |
| `humanApprovals` | Human Acts that cleared this delegation (`ask-before-public`, `ask-before-irreversible`, or none). Member ids only. |
| `dataSensitivity` | `none` · `room-shared` · `restricted`. Never `people-data`. People-data is banned, not a sensitivity rung. |
| `reversibility` | `reversible` · `irreversible` · `unknown`. Drafting vs file / sign / transmit / trigger external systems. |
| `expiration` | ISO-8601. When the grant lapses. Missing expiration is `unknown`, not forever. |

## Schema

```json
{
  "kind": "room.trusthandoff.v0",
  "identity": "string",
  "principal": "string",
  "authorityScope": ["write", "vote", "ask-before-public", "ask-before-irreversible"],
  "taskScope": { "workItemId": "string", "note": "string|null" },
  "sourceManifest": [
    { "url": "string|null", "path": "string|null", "sha256": "string|null" }
  ],
  "confidence": "high|medium|low|unknown",
  "knownLimitations": ["string"],
  "humanApprovals": [{ "memberId": "string", "act": "acknowledge|approve", "at": "ISO-8601" }],
  "dataSensitivity": "none|room-shared|restricted",
  "reversibility": "reversible|irreversible|unknown",
  "expiration": "ISO-8601|null"
}
```

## Rules

1. **People-data ban.** No faces, PII, private inbox, emails, account
   ids, or display names in any field or source. Omit rather than post.
2. A capable agent is not an authorized one. `authorityScope` is a
   grant, not a model skill list.
3. Irreversible actions need a different gate than reversible drafting.
   `reversibility: irreversible` without a matching human approval is
   an incomplete handoff, not a Done.
4. Expired handoffs do not authorize new Acts. Record a new handoff.
5. Scorers may read these fields; they never rewrite them
   ([ROOM-SCORER.md](ROOM-SCORER.md)).
6. Compute jobs are not Trust Handoffs
   ([BRIDGE-COMPUTE.md](BRIDGE-COMPUTE.md)).
7. Do not copy Interlateral’s default `--dangerously-skip-permissions`.
   Room keeps Ask every time + Cua dual boundary
   ([#454](https://github.com/Uuriko/project-room/pull/454)).

## Stay-outs

`client/` · `cloudflare/` · `server/` · `src/` · `deploy/` · Connect
door HTML · People rail · Done-chip chrome · Phase 0 #8 / #9 · Quill
trees · Compute Start · people-data · Potter keys · live writer.
