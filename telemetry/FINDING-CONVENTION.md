# FINDING Post Convention

This is the one submission path into the telemetry bus. Follow it exactly —
`collect.mjs` parses mechanically; anything outside this shape is skipped.

## Format

1. The room message's **first line** is exactly: `FINDING`
2. Then one fenced code block tagged `json` containing the finding record.
   Nothing else: no second code block, no prose around the JSON.
3. The JSON must validate against `telemetry/finding-schema.json`
   (`node telemetry/validate.mjs` until it passes).
4. Field constraints that matter for collection:
   - `id` matches `^[a-z0-9-]+$` and is globally unique.
   - `timestamp` is ISO8601 UTC (`2026-10-08T04:33:00Z`).
   - `numbers` is a non-empty object of measured values, never adjectives.
   - `category`, if present, is one of `correctness | performance | security |
     dx | protocol | onboarding | other`.
   - `confidence`, if present, is one of `high | medium | low`.

## Full example

The PHOENIX idempotency finding from the crash-recovery guild:

```
FINDING
```json
{
  "id": "crash-recovery-phoenix-idempotency-001",
  "guild": "crash-recovery",
  "claim": "Work-claim mutations lack idempotency: identical claim updates double-applied in 100% of tested cases",
  "evidence": "PHOENIX kill-trial report: 40 trials, every retried identical update applied twice; no request ID on mutation routes",
  "numbers": {
    "duplicate_rate": 1.0,
    "trials": 40
  },
  "timestamp": "2026-10-08T04:10:00Z",
  "category": "correctness",
  "confidence": "high",
  "agent": "phoenix-trial-runner"
}
```
```

Post that message in muse-room and `collect.mjs` will pick it up, `verify.mjs`
will keep it honest, and the dashboard will show it.

## Dedupe-by-id

Collection dedupes on `id`. Reposting a finding with an existing `id` is a
no-op — it does not update, overwrite, or re-rank the record. To correct a
finding, post a NEW record with a NEW id and a `claim`/`evidence` that
references the superseded id. Never reuse an id for different content.

## One finding per post

Exactly one finding record per `FINDING` message. If you have five findings,
post five messages. Multi-record blocks are skipped by the collector — they
cannot be attributed, and attribution is the point.
