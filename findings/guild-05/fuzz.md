# guild-05 fuzzing — findings/guild-05/fuzz.md

Slice: `scripts/room`, `scripts/herdr-migrate.mjs`, `scripts/runtime-package.mjs` @ origin/main 2f6b609ef.
Date: 2026-10-09. Harness: `findings/guild-05/harness/fuzz.sh`.

Contract under test: hostile input → clean non-zero exit (never 0 on failure), no partial writes, no hangs (every input wrapped in `timeout`).

## scripts/room

| Unit | Input | Result |
|------|-------|--------|
| F1 | malformed args: empty, unknown verb, missing values, bogus flags, pre-verb `--dry-run` | all exit non-zero (or usage); none hung |
| F2 | corrupt ROOM-STATE.md via `_state --file` | **harness miss**: `_state` takes no `--file` flag — unit tested a nonexistent flag path (exit 1 on unknown flag). Corrected by F2b. |
| F2b | binary junk + non-JSON on stdin through `_parse` / `_state` (the real input path) | rc=5 (jq parse error propagates via `pipefail`); no hang; no partial output |
| F3 | `--repo 'x;touch pwned-canary'` command-injection probe | inert — no canary created; clean error exit. No shell interpolation of `--repo`. |
| F4 | 10 MB comment JSON through `_parse` | rc=0, terminates well within timeout; no OOM |
| F5 | `PATH` without `gh` | rc=1, immediate `need` failure (`missing dependency`); no hang, no retry loop |

## scripts/herdr-migrate.mjs

| Unit | Input | Result |
|------|-------|--------|
| F6 | torn journal line, binary journal, blank journal × commands `status`/`plan`/`migrate` | every combination exits 2 (systemic halt); direct contract check: `readJournal` **and** `appendJournalEntry` both throw on a torn line — a torn journal bricks all journal I/O until manual repair (already-filed bug, severity confirmed) |
| F7 | 20 concurrent `appendJournalEntry` on one journal | 20 entries, 0 torn lines (append is atomic); seq duplicates possible without a lock (see reverify R3: 5 dupes in 30 parallel appends) |
| F8 | missing `--markers-file` / `--host-classes-file` / journal in nonexistent dir | exit 2 with clear errors; journal dir auto-created (`mkdirSync recursive`) for new paths |
| F9 | `--batch 0/-1/abc/1000000000`, `force-release` without `--reason`, unknown command | all exit 2; no hangs |
| F10 | journal in read-only dir; journal path is a directory | exit 2 with clear filesystem error; no partial writes |

## scripts/runtime-package.mjs

| Unit | Input | Result |
|------|-------|--------|
| F11 | `create` with deadbeef / short / garbage / empty / `HEAD^{evil}` commits | all exit 1; no hangs |
| F12 | `verify` on empty dir / bad-JSON manifest / `format: 999` manifest | all exit 1 |
| F13 | package dir containing a symlink (`evil-link` → /etc) | exit 1, rejected |
| F14 | `verify` on nonexistent dir / a regular file | exit 1 both |
| F15 | CLI usage errors (no args, `verify` without dir, `create` with 2 args) | exit 1 with usage; no hangs |

## Summary

- **16 fuzz units run (F1–F15 + corrective F2b), 0 hangs, 0 zero-exits on failure, 0 partial writes.**
- No new bugs filed from fuzzing. Two confirmations of already-known issues:
  - torn journal line bricks the tool (filed; fix not landed — see reverify.md R3);
  - concurrent journal appends duplicate `seq` without a lock (filed; fix not landed).
- Note: `scripts/room`'s `_parse`/`_state` propagate jq's exit code (5) through `pipefail` —
  callers must treat any non-zero as failure, not just 1/2.
