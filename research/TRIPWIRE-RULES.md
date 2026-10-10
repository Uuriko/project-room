# Kill Criteria & Tripwire Dashboard Spec (200-hard-tasks #20)

Machine-checkable kill criteria: `research/tripwire-rules.yaml` (the rules)
+ `scripts/evaluate-tripwires.mjs` (the evaluator). The evaluator takes a
metrics snapshot JSON and outputs **GO / PAUSE / KILL** with reasons, fired
rule ids, and runbook actions. Zero dependencies (includes a tested YAML
subset parser).

## The rules file

12 signals (each with its data source and window) and 12 rules:

**KILL** (halt the affected subsystem, page on-call, open incident):

| rule | fires when | why |
|---|---|---|
| kill-double-payout | settlement.doublePayouts > 0 | any confirmed double payout is critical |
| kill-insolvency | liabilitiesRaw > bondedRaw | open escrows exceed bonded backing |
| kill-receipt-forgery | forgedReceiptRate > 0.01 | signature trust root compromised |
| kill-unauthorized-mint | unauthorizedMints > 0 | settlement touched an unregistered mint |

**PAUSE** (stop new funding/traffic, investigate):

| rule | fires when |
|---|---|
| pause-high-divergence | meanAbsDivergence > 0.10 |
| pause-dispute-storm | disputeRate > 0.05 |
| pause-attestation-delay | attestationDelaySec > 1800 |
| pause-compute-failures | jobFailRate > 0.10 |
| pause-queue-blowout | p95WaitSec > 120 |
| pause-cheat-confirmed | cheatConfirmed > 0 |

**WARN** (reported, no traffic change): divergence > 5%, suspensions > 0.

## Condition language

`<dotted.path> <op> <number | dotted.path>`, ops `> >= < <= == !=`.
Clauses combine with `all:` (AND) / `any:` (OR). Paths resolve against the
snapshot; numeric strings coerce (raw-unit amounts are strings by
convention). A condition on a **missing signal does not fire** — and the
missing path is reported in `missingSignals`, never silently treated as
zero (a missing `doublePayouts` must not read as "no double payouts").

Severity order: KILL > PAUSE > WARN > GO. Every firing rule is reported
with its reason and runbook action; the verdict is the highest severity.

## Usage

```sh
node scripts/evaluate-tripwires.mjs research/tripwire-rules.yaml snapshot.json [--json]
```

Exit codes: 0 = GO, 1 = PAUSE or WARN, 2 = KILL.

Snapshot shape (all 12 signals; numbers or numeric strings):

```json
{
  "settlement": { "doublePayouts": 0, "forgedReceiptRate": 0.0, "unauthorizedMints": 0,
    "liabilitiesRaw": "1000000", "bondedRaw": "5000000",
    "meanAbsDivergence": 0.02, "disputeRate": 0.01, "attestationDelaySec": 60 },
  "compute": { "jobFailRate": 0.02, "p95WaitSec": 10 },
  "providers": { "cheatConfirmed": 0, "suspendedCount": 0 }
}
```

## Adding a rule

1. Add the signal under `signals:` with `source:` (which module/report
   produces it) and `window:` (what the snapshot value must cover).
2. Add the rule under `rules:` with `id:`, `verdict:` (WARN/PAUSE/KILL),
   `when:` (`all:`/`any:` list of conditions), `reason:`, and `action:`
   (the runbook step).
3. Add a synthetic-snapshot case in `tests/tripwire-evaluator.test.js`.

Rules are evaluated in file order; verdict is by severity, not order.

## Dashboard wiring (not built here)

The evaluator is the rules engine; the dashboard is a thin shell around it:
cron the evaluator every 5 minutes against a snapshot assembled from the
signal sources, render verdict + fired rules + 24h history. The snapshot
assembler is the only unwritten piece — each signal's `source:` field says
exactly where its value comes from.
