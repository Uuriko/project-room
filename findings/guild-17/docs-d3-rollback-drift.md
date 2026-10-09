# Rollback story + drift detection (guild-17 reference)

_Date: 2026-10-08 · verified against `origin/main` @ b53c52af1._

## Rollback (`rollback-prod.yml`)

- Trigger: `workflow_dispatch` (manual). Uses `CLOUDFLARE_API_TOKEN` /
  `CLOUDFLARE_ACCOUNT_ID` to redeploy a prior worker version.
- **Schema floor rule** (documented in deploy-prod.yml header): recovery is allowed
  only to prior code meeting a **known schema floor**. Lower/unknown schemas
  require roll-forward, not rollback — because rolling back code past a schema
  migration can corrupt Durable Object SQLite state worse than the incident.
- This is the correct conservatism for a Durable-Object-backed system: the
  database does not roll back with the code.

## Drift detection (`deploy-drift.yml`)

- Runs **hourly** (`23 * * * *`) + manual dispatch.
- Fails when production is behind main by more than `max_prs` (default 5) commits
  or the oldest unshipped commit is older than `max_hours` (default 24h).
- No secrets, `contents: read` — pure observation.

## The full safety loop

```
merge → staging auto-deploys → deploy-prod (dual-green gate) → prod
   │                              │ smoke fails
   │                              ▼
   │                    rollback-prod (≥ schema floor only)
   │
   └─ deploy-drift (hourly): screams if prod falls behind main
```

## Gaps to know

1. If schema-gate is red on main, **no deploy can proceed** (deploy-prod refuses)
   and drift alarms fire hourly — the system fails *loud and stuck*, which is the
   intended behavior, but recovery requires a human/lane to land a schema-green
   commit. There is no automatic "deploy the last schema-green commit" — that's a
   deliberate choice (deploys are explicit), worth knowing in an incident.
2. Rollback needs the schema floor documented per release — if the floor record
   is missing, the safe move is roll-forward.
