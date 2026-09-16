# F025 — Multi-region read replica design

**Status:** Design doc only. No build until John asks.

## Goal

Reduce read latency for geographically distributed Project Room users by
serving reads from regional replicas while keeping writes on the primary.

## Non-goals

- Multi-region writes / active-active (out of scope).
- Automatic failover (operator-driven only in this design).

## Architecture

```
              ┌─────────────┐
              │   Primary   │  (writes + reads)
              │  us-west-2  │
              └──────┬──────┘
                     │ replication (async)
        ┌────────────┼────────────┐
        ▼            ▼            ▼
   ┌─────────┐ ┌─────────┐ ┌─────────┐
   │Replica  │ │Replica  │ │Replica  │
   │eu-west-1│ │ap-east-1│ │sa-east-1│
   │(reads)  │ │(reads)  │ │(reads)  │
   └─────────┘ └─────────┘ └─────────┘
```

## Consistency model

- **Writes:** Primary only. Strong consistency.
- **Reads:** Regional replica. Eventual consistency (replication lag < 5s
  target, < 30s SLO).
- **Read-your-write:** After a write, the writer's session is pinned to the
  primary for 30 seconds (or until the replica acknowledges the write).

## Replication

- Change-data-capture from the primary's Durable Objects / KV.
- Replica applies changes in order; exposes a `replica_lag_seconds` metric.
- Lag alerts fire at > 30s sustained.

## Routing

- Edge (Cloudflare) routes `GET` requests to the nearest replica.
- `POST/PUT/PATCH/DELETE` always route to the primary.
- Health checks remove lagging replicas from rotation automatically.

## Open questions for John

1. Which regions first? (Proposal: eu-west-1, then ap-east-1.)
2. Acceptable replication lag SLO?
3. Budget for cross-region egress?
