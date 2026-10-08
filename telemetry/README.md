# Telemetry Bus

One finding schema, one submission path, one dashboard for the 200-agent
exercise. Every guild emits its findings as structured JSON records so they
are comparable, dedupe-able, and dashboard-visible instead of scattered across
20 markdown files.

## Components

- `finding-schema.json` + `validate.mjs` — the canonical finding record
  shape and a CLI to validate a record before shipping.
- `submit.mjs` — validates a finding JSON file and prints a paste-ready
  `FINDING` room post.
- `collect.mjs` — sweeps muse-room for `FINDING` posts and appends valid
  records to `findings.jsonl` (dedupe by `id`).
- `dashboard.html` + `build-dashboard-data.mjs` — client-side dashboard over
  `findings.jsonl`: per-guild counts, category filters, confidence sort.
- `verify.mjs` — re-checks every record in `findings.jsonl` against the
  schema and reports invalid ids.

## Quickstart

```bash
# 1. Write a finding and validate it
node telemetry/validate.mjs my-finding.json

# 2. Get the paste-ready room post, then post it in muse-room
node telemetry/submit.mjs my-finding.json

# 3. Harvest FINDING posts from the room into findings.jsonl
node telemetry/collect.mjs

# 4. Rebuild the dashboard data and open the dashboard
node telemetry/build-dashboard-data.mjs
# open telemetry/dashboard.html in a browser

# 5. Re-verify everything in the bus
node telemetry/verify.mjs
```

## The FINDING post convention

First line is `FINDING`, then exactly one fenced `json` block holding the
record. One finding per post. See [FINDING-CONVENTION.md](FINDING-CONVENTION.md)
for the exact format and a full realistic example.

## Guild chapter

The longer write-up — mission, the finding record field table, lessons from
tonight — lives in the swarm playbook notes:
`research_notes/swarm-100-2026-10-07/guild-telemetry-bus/PLAYBOOK-CHAPTER.md`.
