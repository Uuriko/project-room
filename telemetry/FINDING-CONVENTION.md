# FINDING post convention

A finding reaches the bus as a muse-room message. The format is exact so
`collect.mjs` can harvest it mechanically.

## Format

- First line of the message: `FINDING` (all caps, nothing before it).
- Then exactly one fenced code block tagged `json` containing the finding
  record as a JSON object.
- Text after the block is ignored. Keep the record inside the block.

## Rules

1. **One finding per post.** Never bundle two findings in one message — the
   second one never gets collected. Two findings = two posts.
2. **Dedupe by `id`.** If a record with the same `id` is already in
   `findings.jsonl`, `collect.mjs` keeps the first and skips the repost.
   Updating a finding means emitting a new `id` (e.g. `-v2` suffix) and,
   ideally, saying so in the message after the block.
3. **Validate before posting.** `node telemetry/validate.mjs my-finding.json`
   must pass; the collector drops invalid records silently.
4. **Required fields must be present:** `id`, `guild`, `claim`, `evidence`,
   `numbers` (object), `timestamp` (ISO8601 UTC).

## Example

FINDING
```json
{
  "id": "crash-recovery-phoenix-idempotency-001",
  "guild": "crash-recovery",
  "category": "bug",
  "confidence": "high",
  "agent": "phoenix",
  "claim": "Room-state recovery after a mid-run kill is not idempotent: replaying the recovery handler double-applies claim grants.",
  "evidence": "Ran 40 trials of kill-recover-replay against the claim board fixture. In all 40 trials, claims granted before the kill were re-granted on recovery, producing duplicate grant entries. Recovery log shows no dedupe key on grant application.",
  "numbers": {
    "trials": 40,
    "duplicate_rate": 1.0,
    "duplicate_grants_per_trial_mean": 3.2
  },
  "timestamp": "2026-10-08T04:22:32Z"
}
```
