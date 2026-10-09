# Report Normalizer — `scripts/normalize-report.mjs`

WAVE-500 coord-cost, worker 11/17. Companion to worker 6's receipt schema
([RECEIPT-SCHEMA.md](RECEIPT-SCHEMA.md)): converts verbose free-text worker
completion reports into structured **v1 receipts** via deterministic
heuristics (regex / keyword extraction — no model calls, node stdlib only).

## Usage

```sh
node scripts/normalize-report.mjs report.txt        # file
cat report.txt | node scripts/normalize-report.mjs  # stdin
node scripts/normalize-report.mjs --receipt-only report.txt \
  | node scripts/validate-receipt.mjs               # v1 conformance gate
```

Output (stdout) is JSON:

```json
{
  "receipt": { "v": 1, "workerId": "…", /* v1 fields */ },
  "fieldConfidence": {
    "workerId": { "value": "…", "confidence": "high|medium|low", "evidence": "…" }
  },
  "needsHuman": ["branch", "msElapsed"],
  "inputBytes": 1919,
  "receiptBytes": 437,
  "outputBytes": 2318
}
```

- `receipt` follows the v1 field order/names from RECEIPT-SCHEMA.md, plus
  optional `pr` / `ts` when confidently found (omitted otherwise, never null).
- Fields with **low** confidence become `null` in `receipt` and are listed in
  `needsHuman`; `fieldConfidence` always keeps the best-guess value plus the
  evidence string so a reviewer sees what the heuristic saw.
- Exit codes: `0` = normalized (even with `needsHuman` entries),
  `2` = usage / input error.

## Status vocabulary

v1 allows only `completed | errored | blocked`. Report language maps as:

| Report language | v1 status |
|---|---|
| done, completed, finished, shipped, landed, delivered, succeeded, merged, closed, green | `completed` |
| failed, failure, error, broke, broken, crashed, timed-out, timeout | `errored` (a timeout ends the attempt in failure) |
| blocked, blocker, waiting-on, awaiting | `blocked` |
| in-progress, cancelled | **no v1 status** → `null` + `needsHuman` |

Detection order: explicit `status:`/`result:` label → first-line terminal
suffix (`… — DONE`) → leading `DONE:` prefix → single firing keyword class.
Conflicting classes (or none) → `null` + `needsHuman` with the conflict named
in evidence. Before keyword matching, benign contexts are stripped: code
spans, `SCREAMING_SNAKE` tokens, `0 errors`, `no errors`, `coded errors`,
`error contract(s)`, `error code(s)`, `error budget(s)` (incl. hyphenated
`error-budget.mjs`), `fail-first`, `failed-before`.

## Heuristics per field

| Field | high | medium | low → null |
|---|---|---|---|
| `workerId` | `workerId:` label | `wave500-coord-cost-workerN`, leading `[lane]` tag | nothing found |
| `waveId` | `wave-500` | `Wave N done/half done` subject, `qa/product/help/demand-NN` | nothing found |
| `status` | labeled / first-line suffix / leading prefix | single keyword class | conflict / in-progress / cancelled / none |
| `summary` | — | first substantive paragraph (≤3 sentences, ≤280 chars); dotted identifiers (`room.post`) protected from sentence splitting | no usable text |
| `filesChanged` | labeled `files:` list | backtick / bare / `~/workspace/` repo-relative paths (`.github/` included); paths adjacent to `untouched`/`unchanged` in the same clause excluded | none found → `[]` |
| `tests` | `run=/passed=/failed=` triple | `N/M tests pass`, `N/M green`, `N tests, all green`, `N passed, M failed`; bare "tests green" → `{0,0,0}` (schema's "no counted tests") | no signal → `{0,0,0}` |
| `claimsFiled` | `claim.sh claim <id>`, `[lane][claim] <id>`, `#266 comment <id>` | `RC-YYYY-MM-DD-NNNN`, `claim:`/`claimed <id>`, wave-style ids | none → `[]` |
| `branch` | `branch:` label, `on branch X` | `wave500/…` path | none |
| `headSha` | `Merge SHA:`/`SHA:` label, bare 40-hex | keyword (`head`, `commit`, `merged at`) + 7–40 hex | none |
| `openQuestions` | — | labeled `questions:`/`blockers:`/`needs:` lines, `?`-ending ask lines (≤3, ≤140 chars) | none → `[]` |
| `msElapsed` | — | `took/elapsed/duration … N ms|s|min|h` (claim-age lines ignored) | none |
| `pr` (opt) | `PR: #N` label | `/pull/N` URL | omitted |
| `ts` (opt) | — | ISO-8601 in text | omitted |

## Calibration — 5 real reports

Source: live room completion reports (`Uuriko/project-room#266` comments,
2026-09-16). Each report was normalized, then hand-scored field-by-field
against a gold extraction (accuracy = extracted value matches gold).
`fieldConfidence.value` is scored, not the nulled receipt — accuracy measures
extraction correctness; `needsHuman` measures review burden separately.

| # | Source comment | Input → receipt (bytes) | Reduction | Fields right | needsHuman |
|---|---|---|---|---|---|
| R1 | 5703328809 — `[quill-s2][receipt] A021 unified per-contact thread — DONE` (PR #380, 23/23 tests) | 1919 → 437 | 77.2% | 10/11 | 4 |
| R2 | 5703118912 — `[quill-s2][receipt] Task A017 Telegram bot token flow: DONE` (PR #378, 12/12) | 1066 → 414 | 61.2% | 11/11 | 4 |
| R3 | 5702244041 — `[Instinct][CHECKPOINT] 500-task checkpoint GREEN: 3724/3724` | 306 → 511 | −67.0% | 11/11 | 5 |
| R4 | 5697690969 — `[quill-s2][STATUS] Wave 5 done` + 3 new claims (F023/F009/F003) | 761 → 564 | 25.9% | 11/11 | 5 |
| R5 | 5704067981 — `[quill-s2][receipt] B004-2 room.post MCP wiring — DONE` (PR #397, 18/18) | 1347 → 423 | 68.6% | 10/11 | 4 |

**Median byte reduction: 61.2%.** R3 (the already-terse checkpoint) grows —
receipts carry ~430 bytes of fixed structural cost, so ultra-terse reports
gain structure, not bytes. Median `needsHuman` count: 4 (always `branch`,
`msElapsed`, plus whichever of `waveId`/`openQuestions`/`tests`/`headSha`
the report omits).

### Per-field accuracy (53/55 = 96.4%)

| Field | Accuracy | Misses |
|---|---|---|
| workerId | 5/5 | — |
| waveId | 5/5 | — (`wave-1` inside `wave-1 src/…` correctly not taken) |
| status | 5/5 | — |
| summary | 5/5 | — |
| filesChanged | 3/5 | R1, R5: cited-but-unchanged `src/gmail-send-gate.mjs` ("conventions match …") included |
| tests | 5/5 | — |
| claimsFiled | 5/5 | — |
| branch | 5/5 | — (all gold null; reports don't state branches) |
| headSha | 5/5 | — |
| openQuestions | 5/5 | — |
| msElapsed | 5/5 | — (all gold null; never estimate per schema rule) |

### Validation pipeline

`--receipt-only | validate-receipt.mjs`: all 5 calibration receipts are
**INVALID with specific errors** — the nulls from `needsHuman` fields are
rejected one-by-one (e.g. `branch: expected string, got object`). This is the
designed human-in-the-loop: the validator is the machine-ingestion gate, and
`needsHuman` non-empty means "not yet ingestible"; the validator names exactly
what a human must fill. A fully-labeled synthetic report (all 11 fields +
`pr`) validates clean: `VALID (693 bytes)`. Status edge cases verified:
pure timeout → `errored`, `failed` → `errored`, `blocked` → `blocked`,
`in_progress`/`cancelled` → `null` + `needsHuman`, conflicting classes →
`null` + `needsHuman`.

Note for worker 17's `scripts/e2e-trial.mjs` (line ~259): its control smoke
asserts `receipt.status === "done"`; the v1 vocabulary is `"completed"` —
that expectation needs updating to match the schema.

## Failure modes (known)

1. **Reference paths over-extracted** (the 2 misses): a report citing another
   file for conventions ("Conventions match wave-1 src/gmail-send-gate.mjs")
   is indistinguishable from a changed file to the path regexes. Precision
   fix would risk worse recall (dropping real files), so this stays a
   documented `needsHuman`-review item.
2. **Bare parenthesized short SHAs** (`F019 passkey login (2941e7d)`) are not
   extracted — no keyword anchors them, and bare 7-hex is too
   false-positive-prone. Reports should use `SHA:`/`Merge SHA:` labels.
3. **Terse reports grow** (R3: −67%): fixed ~430-byte structural floor.
4. **Status conflicts go null**: reports mixing done- and error-language
   ("done, but 3 errors in the log") land in `needsHuman` rather than
   guessing — by design.
5. **`branch`/`msElapsed` are near-always null** on room comments: workers
   rarely state them in prose. In production the runtime fills `msElapsed`
   (never estimated — schema rule) and the worker knows its branch.
6. **Summary is extractive, not abstractive**: it quotes the report's own
   lead; a rambling lead yields a rambling summary (still ≤280 chars).
