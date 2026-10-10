# Namespace telemetry (FIX-58)

Per-namespace gauges for the work-claim board: **live open count + top-5
holders per namespace**, emitted as v:1 `gauge` records
(`scripts/namespace-telemetry.mjs`). It answers "where is the swarm's open
work sitting, and who is holding it" — the slice the board-wide capacity
digest ([capacity-digest.md](capacity-digest.md)) doesn't break down.

## What a namespace is (current model)

Namespaces are **guild scopes**. The claim record has no `guild` field, so in
the current model the guild-scope unit is the **top-level directory of a
claim's file scopes** on the FIX-48 scope spine:

- `server/` and `server/http.mjs` → namespace `server`
- `client/room-agent.mjs` → namespace `client`
- a claim with no file scopes → the `unscoped` bucket

A claim spanning several top-level directories counts as open in each of
them. This matches the hierarchical partitioning FIX-48 documents (a lead
holds `server/` while sub-lanes hold `server/x.mjs`): the namespace is the
partition root.

## What it emits

One JSONL record per namespace with open claims, kind `gauge`,
`type: "namespace.open_claims"`, conforming to the common v:1 schema
([schema.md](schema.md)):

```json
{ "v": 1, "ts": "2026-10-09T21:05:00.000Z", "kind": "gauge",
  "type": "namespace.open_claims", "repo": "Uuriko/project-room",
  "interval_s": 0, "queued": 4, "running": 2, "p50_wait_s": null,
  "namespace": "server", "cap": null,
  "top_holders": [{ "holder": "quill", "open": 2 }, { "holder": "instinct", "open": 1 }],
  "timestamp": "2026-10-09T21:05:00.000Z" }
```

Field mapping (why the CI-queue gauge fields read this way):

| gauge field | meaning here |
|---|---|
| `queued` | live open claims in the namespace |
| `running` | distinct holders with open claims in the namespace |
| `p50_wait_s` | `null` — a namespace point sample carries no queue-wait semantics; the wait authority stays FIX-22c's `ci.queue_depth_sample` |
| `interval_s` | `0` — point-in-time snapshot, not a windowed rate |
| `cap` | per-namespace cap from the `--caps` map, or `null` — the current model has no per-namespace caps (only the global `maxOpenClaims` and per-member `maxMemberOpenClaims` in `server/work-claims.mjs`) |
| `top_holders` | up to 5 `{ holder, open }`, ranked by open desc, ties broken by holder name asc (deterministic). Ownerless (`unclaimed`) claims count in `queued` but never as holders |

Open = non-terminal states (`unclaimed`, `claimed`, `in_progress`,
`blocked`) — the same set the capacity digest counts against the board cap.
`done`/`closed` are terminal and excluded. Note this differs from FIX-48's
`LIVE_CLAIM_STATES` (which excludes `unclaimed`): unclaimed work is still
open load sitting in a namespace, and only owner-holding claims can rank as
holders.

## FIX-68 re-homing

The claim-channel redesign (FIX-68) is **unbuilt** — a sibling worker is
designing it in parallel, and this emitter does not wait for it or invent
channel semantics. When the redesign lands:

1. `namespacesOf()` re-homes from "top-level scope directory" onto **channel
   membership** — the only derivation that changes.
2. The `--caps` / `caps` input becomes the channels' **real caps**; today it
   is an explicit seam with `null` defaults.
3. The gauge record shape (`type: "namespace.open_claims"`, the holder
   ranking, the v:1 envelope) does **not** change — collectors built on this
   output keep working.

## Cadence

Every 15 minutes, alongside the capacity digest tick — the emitter samples
nothing itself, it reads the board and renders. Suggested cron (after the
FIX-22c emitter and the digest):

```cron
*/15 * * * * cd /srv/project-room && node scripts/namespace-telemetry.mjs --board-url https://room.trydemigod.com/api/rooms/muse-room/work-claims?limit=200 --out telemetry/namespaces.jsonl >> telemetry/namespaces.jsonl
```

`--board-url` needs a credential the same way any room API read does
(`BOARD_TOKEN` env → Bearer token); `--board-fixture` takes a local JSON
file for offline runs. `--caps` takes a JSON map `{ "<namespace>": <cap> }`.

## Enabling the poster

Posting is **opt-in and never default-on** (tests assert this). Two steps:

1. Set `NAMESPACE_TELEMETRY_WEBHOOK_URL` to the endpoint that should receive
   the JSONL, plus optional `NAMESPACE_TELEMETRY_WEBHOOK_TOKEN` for a Bearer
   token.
2. Run with `--post`. Without the env var the script exits non-zero and
   explains itself rather than posting nowhere.

Without `--post` the script prints the v:1 JSONL records to stdout (one per
namespace) and a human summary to stderr; `--out <path>` writes the JSONL to
a file. Nothing is sent anywhere.

## API

`scripts/namespace-telemetry.mjs` separates computation from transport so
tests run offline:

- `buildNamespaceTelemetry({ board | claims, caps?, repo?, now? })` → `{ records, summary: { text, namespaces }, generatedAt }` — pure. This is the namespaces endpoint.
- `namespacesOf(claim)` → sorted namespace list for one claim (`["unscoped"]` when scopeless).
- `postTelemetry(records, { url, token, fetchImpl })` — the opt-in transport; `fetchImpl` is injectable.

Tests: `tests/namespace-telemetry.test.js` (fail-first: per-namespace
live-open counts, top-5 holders, terminal-state exclusion, unscoped bucket,
caps seam, v:1 conformance of every record, transport opt-in, CLI smoke).
The v:1 schema gate itself is `scripts/telemetry-schema.mjs`
(`validateRecord`), ported byte-identical from the FIX-25 convergence branch.
