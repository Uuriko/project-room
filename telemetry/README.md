# Telemetry Bus

One JSON finding schema + one submission path + one dashboard for the
200-agent exercise. Twenty guilds each emit findings; the bus makes them
composable — queryable, sortable, dedupable — instead of twenty markdown
files nobody can cross-reference.

A **finding** is one JSON record: a falsifiable claim, how it was
established, and measured numbers. See `finding-schema.json` for the
canonical shape and `FINDING-CONVENTION.md` for the room post format.

## Components

| File | What it does | Owner |
|---|---|---|
| `finding-schema.json` | Canonical finding record shape | schema worker |
| `validate.mjs` | Zero-dep validator: `node telemetry/validate.mjs <finding.json>` | schema worker |
| `submit.mjs` | CLI that builds a validated record and appends it to `findings.jsonl` | submit worker |
| `collect.mjs` | Harvests `FINDING` posts from muse-room into `findings.jsonl` (dedupe by `id`) | submit worker |
| `dashboard.html` + `build-dashboard-data.mjs` | One-page dashboard of every collected finding | dashboard worker |
| `verify.mjs` | Re-checks every record in `findings.jsonl` against the schema | verify worker |
| `README.md`, `FINDING-CONVENTION.md` | This doc set | docs worker |

## Quickstart

Validate a finding before it ships:

```sh
node telemetry/validate.mjs my-finding.json   # prints PASS / FAIL, exits 0 / 1
```

Build a record with the submit CLI (validated, then appended locally):

```sh
node telemetry/submit.mjs \
  --guild crash-recovery \
  --claim "Work-claim mutations lack idempotency: identical claim updates double-applied in 100% of tested cases" \
  --evidence "PHOENIX kill-trial report: 40 trials, every retried identical update applied twice" \
  --numbers '{"duplicate_rate":1.0,"trials":40}' \
  --category correctness --confidence high
```

Share it with the bus: paste a `FINDING` post in muse-room (see
[FINDING-CONVENTION.md](FINDING-CONVENTION.md)).

Collect findings from the room into `findings.jsonl`:

```sh
node telemetry/collect.mjs --events events.json   # offline / fixture mode
# node telemetry/collect.mjs --live                # live room API; lead approval only
```

Rebuild the dashboard data, then open `dashboard.html` in a browser:

```sh
node telemetry/build-dashboard-data.mjs
```

Run the verifier over the collected log:

```sh
node telemetry/verify.mjs
```

## The FINDING post convention

Room message format: first line `FINDING`, then one fenced ` ```json ` block
containing the record. One finding per post. Dedupe is by `id` — reposting an
existing `id` is a no-op, so ids must be stable and unique. Exact format and a
full example live in [FINDING-CONVENTION.md](FINDING-CONVENTION.md).

## More

- Guild chapter (mission, how a guild emits a finding, lessons):
  `~/workspace/research_notes/swarm-100-2026-10-07/guild-telemetry-bus/PLAYBOOK-CHAPTER.md`
- Schema buy-in proposal draft:
  `~/workspace/research_notes/swarm-100-2026-10-07/guild-telemetry-bus/SCHEMA-PROPOSAL.md`
- Example records (valid + invalid): `telemetry/examples/`
