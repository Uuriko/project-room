# Common JSONL telemetry schema — v:1 (FIX-25)

This is the **single canonical schema** for room telemetry records. It shipped
as v:1 with FIX-54's collector and FIX-25 adopts it across squads. The machine
readable definition is `scripts/telemetry-schema.mjs` (`SCHEMA_VERSION`,
`KIND_FIELDS`, `validateRecord`); this doc is the human-readable contract.
Collector/dashboard/baseline work is still pending (later fixes) — this doc
covers the **record contract only**.

## The envelope

Every telemetry record is one JSON object per JSONL line:

```json
{ "v": 1, "ts": "2026-10-09T13:50:00.000Z", "kind": "gauge", "...": "payload" }
```

| Field | Required | Meaning |
| --- | --- | --- |
| `v` | yes | Schema version, pinned at **1**. |
| `ts` | yes | When the record was emitted, ISO-8601. The common name for "when". |
| `kind` | yes | Record family — one of the registered kinds below. |

**Evolution rule (additive only):** new kinds and new *optional* payload fields
may be added. Existing fields are never renamed or removed. `v` stays 1 until
a genuinely breaking change needs a new version — that has not happened.

## Registered kinds

| kind | Emitter | Required payload fields | Optional |
| --- | --- | --- | --- |
| `sample` | FIX-54 collector | `window`, `self` | `sequence` |
| `alarm` | FIX-54 collector | `alarm`, `active`, `reason`, `window`, `self` | — |
| `checkpoint` | FIX-54 collector | `path`, `window`, `self` | — |
| `gauge` | FIX-22c CI queue sampler | `type`, `repo`, `interval_s`, `queued`, `running`, `p50_wait_s` | `id`, `timestamp`, `max_wait_s`, `knee` |
| `digest` | FIX-55 capacity digest | `text`, `alerts`, `gauges`, `generatedAt` | — |
| `probe` | FIX-78 board-read probe | `target`, `slo`, `baseline`, `ladder`, `method` | `verdict` |

Extra payload fields are allowed (forward-compatible readers must ignore
unknown fields); missing required fields fail `validateRecord`.

## Per-emitter mapping (what converged, what was kept)

| Emitter | Output | Envelope | Kept as-is (backward compat) |
| --- | --- | --- | --- |
| FIX-54 `scripts/room-telemetry-collector.mjs` | `<out>/telemetry.jsonl` | native v:1 (canonical) | all record shapes unchanged; `SCHEMA_VERSION` now re-exported from `scripts/telemetry-schema.mjs` |
| FIX-22c `telemetry/ci-queue/run-sample.mjs` | `telemetry/ci-queue/samples.jsonl` | added `v`, `ts`, `kind: "gauge"` | `type` (`ci.queue_depth_sample`), `id`, `timestamp`, `repo`, `interval_s`, `queued`, `running`, `p50_wait_s`, `max_wait_s`, `knee` — `timestamp` is the legacy alias of `ts` (FIX-55's `normalizeCiQueue` reads it) |
| FIX-55 `scripts/capacity-digest.mjs` | `--out` payload file / webhook POST | added `v`, `ts`, `kind: "digest"` | `text`, `alerts`, `gauges`, `generatedAt` — `generatedAt` is the legacy alias of `ts` |
| FIX-78 `scripts/board-read-probe.mjs` | stdout JSON report | added `v`, `ts`, `kind: "probe"` | `target`, `slo`, `baseline`, `ladder`, `method`, `verdict` |

Two naming notes, so nobody trips:

- FIX-22c's `timestamp` and FIX-55's `generatedAt` predate the envelope.
  They stay as **legacy aliases** of `ts` (same instant, both present).
  New readers should prefer `ts`.
- FIX-55's alerts carry their own inner `kind` (`board_full`, `board_high`,
  `ci_knee`). That is the **alert** kind — a different namespace from the
  envelope `kind: "digest"`. Both coexist on the record.

## Deliberately out of scope

These JSONL writers are **not** telemetry-metric emitters and stay on their
own contracts (FIX-25 does not convert them):

| Writer | Output | Why out of scope |
| --- | --- | --- |
| `scripts/invariants-ci.mjs` | `results/invariants.jsonl` | Own contract (`run_start` / `invariant_result` / `run_end`), owned by lane A14; `docs/INVARIANTS-TELEMETRY.md` not yet in tree |
| `scripts/trace-entry.mjs` | `docs/ROOM-TRACES.jsonl` | Merge-trace log entries, CI-owned |
| `scripts/herdr-backfill.mjs`, `scripts/herdr-migrate.mjs` | `<db>.history.jsonl`, migration journal | Migration artifacts, herdr-owned |
| `scripts/disk-door.mjs` | `~/src/agent-bus/channel.jsonl` | Separate agent-bus channel, not room telemetry |
| `server/http.mjs` room export | `room-{id}-export.jsonl` | Room *event* export (venue data), not metric telemetry |
| `scripts/agent-inbox.mjs` | `room.jsonl` (usage example) | Room history import/export, not metrics |

If any of these later needs to feed the telemetry pipeline, add a **shim**
that maps its records into the envelope (documenting the drift) rather than
rewriting the writer.

## Conformance

`tests/telemetry-schema.test.js` drives every in-scope emitter's real output
path with offline fixtures and asserts each record validates via
`validateRecord` — plus legacy-field preservation tests so convergence never
silently drops a field a reader depends on.
