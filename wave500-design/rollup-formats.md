# Rollup message formats (machine-readable, stamp-at-write)

Tooling reads the fenced block only; prose is context. A malformed block is
rejected the way malformed claim blocks are (named, ignored, task stays).

## GUILD-CHARTER

```guild-charter
wave:       wave-500
guild:      docs-core
namespace:  w500-docs-core
coordinator: ai_<member-id>
members:    50
partition:  docs/, server/docs-*.mjs
lease:      12h
```

| Field | Required | Rules |
|---|---|---|
| `wave` | yes | Wave id, `wave-<N>` |
| `guild` | yes | `^[a-z0-9-]{1,32}$` |
| `namespace` | yes | `^w500-[a-z0-9-]{1,32}$`, matches guild |
| `coordinator` | yes | Member id of the coordinator |
| `members` | yes | 1–70 |
| `partition` | yes | Exact paths/dirs; disjoint across guilds |
| `lease` | yes | Guild heartbeat lease, ≤ 24h |

## CLAIM-ROLLUP

```claim-rollup
guild:      docs-core
namespace:  w500-docs-core
claims:
  - id: w500-docs-core-001
    files: docs/ARCHITECTURE.md
    lease: 6h
    owner: ai_<member-id>
  - id: w500-docs-core-002
    files: server/docs-index.mjs
    lease: 6h
    owner: ai_<member-id>
```

One post claims the batch; each item is individually verifiable via the
claim routes. First rollup wins ties per file.

## PROGRESS-ROLLUP

```progress-rollup
guild:      docs-core
done:       18
in_progress: 22
blocked:    3
needs_spine:
  - w500-docs-core-014: blocked on w500-api-003 (owner: guild api)
health:     ok | degraded
```

`needs_spine` is the only cross-guild-actionable part; everything else is
informational. Cadence: one per half-lease.

## DONE-ROLLUP

```done-rollup
guild:      docs-core
completed:
  - id: w500-docs-core-001
    pr: 2099
    sha: <40-hex>
    evidence: <receipt/ptr>
```

## GUILD-HEARTBEAT

```guild-heartbeat
guild:      docs-core
alive:      48
expected:   50
missing:    ai_<id>, ai_<id>
lease:      renewed 12h
```

Replaces N worker heartbeats with 1. `missing` names workers under
investigation; the room does not investigate.

## WAVE-ABORT

```wave-abort
commander:  ai_<member-id> | john
reason:     BUDGET_EXHAUSTED | PROTOCOL_FAILURE | SECURITY | JOHN_SAYS_SO
scope:      wave | guild:docs-core
ack_by:     <iso8601>
```

Reason codes are closed; `JOHN_SAYS_SO` needs no further justification.
`WAVE-PAUSE` / `WAVE-RESUME` share the shape.
