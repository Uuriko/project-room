# Batch Dispatch — Spec

**Wave:** WAVE-500 (coordination-overhead), worker 4/17.
**Status:** design + prototype (`scripts/batch-dispatch.mjs`). Not wired to any live spawn API.
**Scope:** `scripts/` + `docs/` only.

## 1. Problem

Coordinator dispatch is 23.1% of total wave time. Spawning N workers costs:

- **N coordinator round-trips** — one turn per worker, each turn paying spawn-latency overhead
  (handshake, scheduling, acknowledgement).
- **N copies of shared context** — every worker brief today re-embeds the full coordination
  context (wave goal, conventions, board state, file map), so context bytes scale as
  `N × (shared + brief)`.

## 2. Core mechanism

**Factor the shared context out of the per-worker payload and fan out in one turn.**

A batch dispatch is a single coordinator action carrying one *manifest*. The manifest is
split into exactly two parts:

1. **Shared context** — sent once per batch, content-addressed by a `contextRef`
   (`sha256` of the text). Workers resolve the ref to the full text.
2. **Per-worker deltas** — each worker gets only its own `brief` (the delta from the shared
   context) plus a `contextRef` pointer, its `id`, and its `doneCondition`.

The wire/batch envelope therefore costs `shared + N × brief` context tokens instead of
`N × (shared + brief)`, and the coordinator spends **one turn** instead of N.

In a live coordinator implementation the shared context would be written once to a
shared context store (or broadcast once) and each spawn payload would carry only the
`contextRef`. This spec and its prototype define the manifest, the payload shape, the
receipt contract, and the failure semantics; the transport binding is deliberately out
of scope.

## 3. Manifest schema (v1)

```jsonc
{
  "sharedContext": "string, required, non-empty. Everything every worker needs: wave goal, conventions, board snapshot, file map, style rules.",
  "workers": [
    {
      "id": "string, required, unique, [a-z0-9][a-z0-9-]* (max 64 chars)",
      "brief": "string, required. THE DELTA ONLY — what this worker does beyond the shared context. Size-capped (see §4).",
      "doneCondition": "string, required. Machine-checkable completion test (files committed, tests run, receipt posted)."
    }
  ]
}
```

Unknown extra fields on the manifest or on workers are **ignored** (forward-compatible);
missing or malformed required fields fail validation (see §4).

## 4. Validation (what `scripts/batch-dispatch.mjs` enforces)

| Rule | Default | Rationale |
|---|---|---|
| `sharedContext` present, non-empty string | — | nothing to factor out = no batch |
| `sharedContext` length cap | 200,000 chars | accident guard (a full repo dump is not "shared context") |
| `workers` non-empty array | — | |
| worker count cap | 100 | a batch is a wave, not the whole fleet |
| worker `id` unique, `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`, ≤ 64 chars | — | stable identity for receipts and retries |
| `brief` non-empty, size-capped | 2,000 chars | **briefs are deltas** — overflow means the content belongs in `sharedContext`; validation fails with that hint |
| `doneCondition` non-empty | ≤ 1,000 chars | un-checkable work is un-dispatchable |

Validation failure exits non-zero with the first error (and, with `--strict`, lists all).
No partial payloads are emitted on validation failure.

## 5. Spawn payloads

The prototype emits one **batch envelope**:

```jsonc
{
  "batchId": "batch-<sha256[:12] of manifest>",
  "contextRef": "sha256 hex of sharedContext",
  "sharedContext": { "ref": "<contextRef>", "bytes": 1234, "estTokens": 309, "text": "..." },
  "payloads": [
    {
      "workerId": "w-1",
      "contextRef": "<contextRef>",   // pointer, not a copy
      "brief": "...",                 // delta only
      "doneCondition": "...",
      "schemaVersion": "batch-dispatch/v1"
    }
  ]
}
```

The `sharedContext` block appears **once** in the envelope regardless of N. Each worker
payload carries only the `contextRef` pointer (≈ a few dozen tokens) plus its delta
brief. A coordinator binding this to a real spawn API writes the shared context to the
shared store a single time and fans the N payloads out in one turn.

## 6. Completion: structured receipts (v1, minimal)

Each worker's completion arrives as a receipt — not free text:

```jsonc
{
  "workerId": "w-1",
  "status": "done | error | timeout | cancelled",
  "summary": "≤ 280 chars, human-readable outcome",
  "filesChanged": ["docs/X.md", "scripts/y.mjs"],
  "testsRun": "how verification was done, e.g. 'node --test tests/y.test.js → 14/14 pass'",
  "openQuestions": ["anything the coordinator must resolve"]
}
```

The coordinator aggregates the N receipts into one **batch receipt** (per-worker status
table + roll-up counts). `summary` over 280 chars fails receipt validation — receipts
are for the coordinator's next turn, not an essay.

## 7. Failure semantics

- **Fail-isolated:** one worker's `error`/`timeout` does not affect the others. There is no
  batch-wide abort by default; siblings run to their own `doneCondition`.
- **Per-worker status always reported:** the batch receipt contains exactly one entry per
  dispatched `workerId`, even for workers that never reported (marked `timeout` after the
  batch deadline, `cancelled` if withdrawn).
- **Retries are safe:** re-dispatching a failed worker reuses the identical payload —
  `contextRef` is content-addressed, so the shared context is never re-sent on retry, and
  briefs must be written idempotently (re-running a brief must converge, not duplicate).
- **No silent drops:** a missing receipt is a `timeout` entry, not an absence. The
  coordinator never has to guess whether a worker ran.

## 8. Savings model

Token estimate uses `ceil(chars / 4)` per string (documented approximation; the ratio is
what matters, not the absolute count).

- Independent spawns: `Σᵢ (tok(shared) + tok(briefᵢ))` = `N × tok(shared) + Σ tok(briefᵢ)`
- Batched: `tok(shared) + Σ (tok(briefᵢ) + tok(contextRef))`
- **Savings = N × tok(shared) + Σ tok(briefᵢ) − tok(shared) − Σ tok(briefᵢ) − N × tok(ref)**
  ≈ `(N − 1) × tok(shared)` — the savings grow linearly with N and with shared-context size.

Turn savings are orthogonal and larger in wall-clock terms: N sequential coordinator
turns → 1 batch turn (see §9).

## 9. Latency note

`docs/SPAWN-LATENCY.md` (worker 3's output) was **not present** in the worktree at the
time of writing, so this spec addresses the dominant components visible from the brief
itself:

1. **Round-trip count (dominant).** N workers = N coordinator turns today. Each turn pays
   spawn handshake + scheduling latency that no context trick removes — only fan-out
   does. Batch dispatch collapses this to one turn; per-worker spawn latency then runs
   in parallel rather than in series.
2. **Context re-transmission.** Re-sending the shared context N times is pure duplicated
   bytes on the coordinator's output path. Factoring it out (§2) removes `(N−1)` copies.
3. **Receipt fan-in.** N unstructured completion messages cost the coordinator N parse
   turns. Structured receipts (§6) make fan-in one aggregation pass.

When worker 3's measurements land, the right follow-up is to re-run the §8 model with
their measured per-turn spawn latency and confirm the batch envelope's single-turn cost
is ≤ one independent spawn turn (it must be — the envelope is strictly smaller than N
independent payloads).

## 10. Constraints

- **No secrets in manifests.** Briefs and shared context are coordinator-visible text;
  credentials never ride a dispatch payload (standing secrets rule).
- **Briefs are deltas, enforced by the cap** (§4). A brief that needs the cap raised is
  almost always shared context in disguise.
- **Deterministic ids.** `batchId` and `contextRef` derive from content hashes, so
  re-dispatching an unchanged manifest is a no-op at the transport layer.

## 11. Out of scope (future)

Transport binding to a real spawn API; worker-to-worker messaging; `dependsOn`
ordering between workers; priority/preemption; receipt signature/verification;
streaming partial receipts. None of these change the manifest or receipt shape above.
