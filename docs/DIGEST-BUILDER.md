# Coordinator Digest Builder

One-shot tool for the WAVE-500 coordination-overhead problem: 25 workers → 25
reports → the coordinator drowns reading them. The digest builder collapses N
structured worker receipts into one ranked, 60-second digest. No LLM calls;
fully deterministic.

- Builder: [`scripts/build-digest.mjs`](../scripts/build-digest.mjs)
- Demo: [`scripts/demo-digest.mjs`](../scripts/demo-digest.mjs)
- Receipt schema it consumes: [`docs/RECEIPT-SCHEMA.md`](./RECEIPT-SCHEMA.md)
  (worker 6's v1 schema; the builder also accepts minimal-field receipts)

## Usage

```sh
node scripts/build-digest.mjs --input <receipts-dir> [--out digest.md] [--json stats.json]
```

- `--input`: directory of receipt JSON files (`.json`, read in sorted order).
- `--out`: write the markdown digest to a file; without it, the digest goes to
  stdout.
- `--json`: write a stats report (`{receiptBytes, digestBytes,
  compressionRatio, receiptReadMin, digestReadMin, minutesSaved, total, pct,
  testsPassed, testsFailed, filesTotal, receipts, rollupChars}`).
- The stats line is also printed to stderr on every run.

Exit codes: `0` = ok; `2` = input dir missing/empty or no parseable receipts.

Receipts that fail to parse or normalize are counted and listed in the digest
under "Headline" (skipped), never silently dropped.

## Input tolerance

The v1 schema (`docs/RECEIPT-SCHEMA.md`) is the primary input, but the builder
also accepts minimal receipts — anything shaped like:

```json
{ "workerId": "w12", "status": "completed", "summary": "did the thing",
  "filesChanged": ["a.mjs"], "tests": { "passed": 12, "failed": 0 } }
```

Normalization rules (see `normalizeReceipt` in the source):

- Envelope-wrapped receipts (`{ receipt: {...} }`) are unwrapped.
- Status synonyms map to the canonical three: `done`/`success`/`ok` →
  `completed`; `failed`/`fail` → `errored`; `waiting`/`stuck` → `blocked`.
  Unrecognized statuses become `unknown` and are listed, not ranked.
- Tests are accepted as `{passed, failed}`, flat `testsPassed`/`testsFailed`,
  `totalTests`, or `"12/2"` strings.
- Optional fields (`openQuestions`, `blockers`, `blockersResolved`, `error`,
  `durationMs`, `tokensUsed`) are picked up when present and ignored otherwise.

## Ranking rules (deterministic)

**Completions** (`completed` receipts) are ranked by a significance score,
highest first:

| Rule | Weight |
|---|---|
| Base: the work finished | +100 |
| Files changed (capped at 10) | +10 each |
| Tests ran, all green | +20 |
| Tests ran, some failing (needs coordinator eyes) | +40 |
| Summary keyword: `security` | +25 |
| Summary keyword: `breaking` | +20 |
| Summary keyword: `deploy` | +15 |
| Summary keyword: `bug` | +10 |
| Summary keyword: `feature` | +10 |
| Summary keyword: `perf` | +8 |
| Summary keyword: `refactor` | +5 |
| Summary keyword: `docs` | +5 |
| Summary keyword: `test` | +3 |
| Blockers resolved during the run | +15 |

Tie-break: `workerId` ascending. Identical inputs always produce
byte-identical output — verified by the demo (build twice, diff).

**Needs-attention** (`errored` / `blocked`) receipts are ranked separately by
(open questions + blockers) count, descending, then `workerId` ascending.
They appear in their own section with `openQuestions` quoted **verbatim** —
never paraphrased, never dropped — because that's the coordinator's action
list.

**Deliberate choice:** failing tests on a *completed* receipt keep it in the
completions section (ranked high — +40) rather than moving it to attention.
The status field is the worker's truth; the score is the coordinator's
attention signal.

## Digest sections

1. **Headline** — counts: completed / errored / blocked (+ unknown statuses and
   skipped files if any).
2. **Completions (ranked by significance)** — one line per worker:
   `[workerId] one-line summary — N files, X/Y tests passed`.
3. **Needs attention: errored / blocked** — per worker: status, one-line
   summary, error text, blockers, then each open question verbatim.
4. **Aggregate metrics** — workers reporting, files changed, test totals,
   tokens (when reported), total/avg worker time, count of receipts with open
   questions.
5. **Room roll-up (post as single DONE)** — a ≤500-char roll-up:
   `DONE digest: N receipts (A ok / B err / C blocked). Top: … . Attention:
   … . Tests X/Y pass.` Ready to paste as one room DONE post.

## Coordinator-loop usage

The digest is the coordinator's inbox processor. Typical loop:

1. Workers drop receipts into a per-wave directory as they finish
   (one `.json` per worker, `worker-<id>.json`).
2. When the wave settles (or on a schedule), the coordinator runs
   `node scripts/build-digest.mjs --input <wave-dir> --out wave-<n>-digest.md
   --json wave-<n>-stats.json`.
3. The coordinator reads the digest (top section first), works the
   verbatim open questions, and posts the roll-up block as the wave's DONE
   to the room — one message instead of 25.
4. `stats.json` feeds the overhead model (worker 14): receipt bytes vs digest
   bytes are the measured reading-cost reduction for the wave.

Practical notes:

- Collect receipts under one directory even if workers report on different
  schedules — the digest is a snapshot tool, not a live watcher. Re-run on
  arrival if you need freshness.
- If a worker reports without the schema (free text, chat message), run it
  through `scripts/normalize-report.mjs` (worker 11) first, then feed the
  directory to the digest builder.
- The roll-up's 500-char cap targets a single chat message; if your venue has
  a stricter cap, trim the "Top:" list from the tail.

## Demo and measured savings

`scripts/demo-digest.mjs` generates 25 deterministic synthetic receipts
(seeded PRNG — byte-identical across runs), builds the digest, and checks
invariants: 25 loaded, every worker id present in the digest, roll-up ≤ 500
chars, digest byte-identical across runs, attention section non-empty.

Measured (2026-10-08, 25 receipts):

| Metric | Value |
|---|---|
| Receipt bytes (total) | 19,739 |
| Digest bytes | 6,388 |
| Compression ratio | **3.09x** |
| Reading time, all receipts @ 200 wpm | 19.7 min |
| Reading time, digest @ 200 wpm | 6.4 min |
| **Minutes saved per 25-worker wave** | **~13.4 min** |

Real receipts with fuller summaries compress better (more redundancy); these
are conservative figures.
