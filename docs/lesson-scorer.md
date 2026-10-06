# Lesson quality scorer (W014)

A heuristic, lint-like tool for the lessons corpus: it scores lesson entries
on signal vs noise and reports the low-signal ones **for human review**.
It never edits, deletes, or reorders lessons — pruning is always a human call.

Sources scored by default:

- `docs/ROOM-WIKI.md` — the swarm's append-only experience log (schema sections)
- `docs/WEEKLY-LEARNINGS.md` — the weekly learnings queue (bullets under week headings)

## Usage

```sh
node scripts/lesson-scorer.mjs [--json] [--threshold N] [--fail-under N] \
    [--top N] [--files f1 f2 ...]
```

- Default prints a ranked text report; entries below `--threshold` (default 40)
  are listed in the REVIEW section.
- `--json` emits machine-readable output (`{ threshold, entries: [...] }`).
- `--fail-under N` exits 1 if any entry scores below N (optional CI gate —
  not wired into CI by default, since scoring is advisory).
- `--files` scores explicit files instead of the defaults.

## Scoring (0–100, heuristic — not an LLM judge)

| Dimension     | Range | What earns it |
|---------------|-------|---------------|
| evidence      | 0–30  | file:line refs, PR/issue refs (`#203`), commit SHAs, dates, room seqs, URLs, outcome markers (✓/✗/Verified), measured numbers |
| actionability | 0–30  | never/always, `RULE:`, don't/must, imperative verbs, numbered steps, prefer-X-over-Y phrasing |
| concreteness  | 0–20  | code identifiers, paths, quoted strings, numbers — not abstractions |
| shape         | 0–20  | length sweet spot (~80–600 chars); essays and one-liners lose points |
| vagueness     | −0–24 | penalty for "be careful", "make sure", "in general", "maybe", … |

Flags: `too-short`, `long`, `essay`, `no-evidence`, `no-action`, `vague`,
`dup-of:<id>`.

**Duplicates.** Near-duplicates are found by token-overlap (Jaccard ≥ 0.55,
stopwords dropped); the later entry gets a `dup-of:` flag so a reviewer can
consolidate. The scorer never merges them itself.

## Interpreting a report

- Score ≥ 60: solid signal.
- 40–59: thin but acceptable — worth a look when the corpus is pruned.
- < 40: REVIEW — vague, evidence-free, essay-length, or one-liner.

The point of the flags is to explain *why* an entry scored low, so the
reviewer knows whether to add evidence, sharpen the rule, or drop it.

## API (for tests and other scripts)

`scripts/lesson-scorer.mjs` exports `scoreLesson`, `scoreEntry`,
`scoreCorpus`, `findDuplicates`, `tokenize`, `parseWikiEntries`,
`parseQueueEntries`, `loadCorpus`, `renderReport`, plus the constants
`REVIEW_THRESHOLD` (40), `HIGH_SIGNAL_BAR` (60), `DUP_THRESHOLD` (0.55).

Tests: `tests/lesson-scorer.test.js` — failing-first fixtures of known
high-signal and low-signal lessons; the scorer must rank them correctly.
