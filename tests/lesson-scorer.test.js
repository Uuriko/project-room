// tests/lesson-scorer.test.js
//
// Failing-first tests for the lesson quality scorer (backlog W014).
// The script under test: scripts/lesson-scorer.mjs
// It must export the pure helpers below so the heuristics are unit-testable
// without touching the real corpus files.
//
// The scorer is a lint-like heuristic tool: it scores lesson entries on
// signal vs noise (concreteness, actionability, evidence cited, shape) and
// reports low-signal entries for review. It never prunes or edits lessons.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  scoreLesson,
  scoreEntry,
  scoreCorpus,
  findDuplicates,
  parseWikiEntries,
  parseQueueEntries,
  renderReport,
} from "../scripts/lesson-scorer.mjs";

// ---------------------------------------------------------------- fixtures

const HIGH_SIGNAL = [
  {
    id: "h1",
    text: "Never `git stash` in the shared checkout while parallel slice worktrees are active (2026-09-17: slice-4 popped slice-2's \"WIP on quill/login-password\" stash; refs/stash is global across worktrees). RULE: commit to the feature branch instead, or `git diff > /tmp/rescue.patch` before any risky operation.",
  },
  {
    id: "h2",
    text: "Lesson: the Live-app/Schema line in README.md is load-bearing; repair it, never fight it. Tried letting PR #203's README edits stand as-is — Outcome: ✗ the PR removed the deployment contract line, restored by commit 6641218.",
  },
  {
    id: "h3",
    text: "Testing a bash script's $0-dependent behavior: `exec -a <name> bash script.sh` does NOT set $0 inside script.sh (bash resets $0 to the script path); it only works for `bash -c`. For node:test drivers use spawnSync's argv0 option with a `bash -c` body instead. Verified on tests/runtime-package.test.js:412.",
  },
  {
    id: "h4",
    text: "First room claim wins — on collision, stand down the duplicate. 2026-10-05: Instinct claimed server/claim-reputation.mjs at room seq 2974 while I was mid-investigation; I shipped duplicate PR #1503 before re-reading the room. RULE: re-fetch the live muse-room event log (last ~100 events) and the work-claim board before writing the first line of a fix; treat ownership knowledge older than ~15 min as expired.",
  },
];

const LOW_SIGNAL = [
  {
    id: "l1",
    text: "Keep code quality high and be careful when merging.",
  },
  {
    id: "l2",
    text: "Always do your best and make sure everything is fine.",
  },
  {
    id: "l3",
    text: "We should consider thinking about maybe improving the process in general.",
  },
  {
    id: "l4",
    text: "Good communication is important for the team.",
  },
];

const DUPES = [
  {
    id: "d1",
    text: "Never `git stash` in the shared checkout while parallel worktrees are active — refs/stash is global across worktrees. RULE: commit to the feature branch instead.",
  },
  {
    id: "d2",
    text: "Never git stash in the shared checkout while parallel worktrees are active: refs/stash is global across worktrees, so commit to the feature branch instead.",
  },
];

const ESSAY =
  "Lesson about merges. " +
  "Merging is an important part of the workflow and there are many considerations to keep in mind when you merge branches together in a shared repository with many contributors working at the same time on different features. ".repeat(
    30
  );

const WIKI_FIXTURE = `# Room Wiki

## 2026-09-14 · README contract line · quill
- Tried: letting PR #203's README edits stand as-is.
- Outcome: ✗ — the PR removed the deployment contract line.
- Lesson: the Live-app/Schema line is load-bearing; repair it, never fight it (restored by commit 6641218).
- Rejected: rewording the line — its exact form is the contract.

## 2026-09-15 · stale branches · quill
- Tried: considering the old \`grok/*\` branches for merge.
- Outcome: ✗ — diffing against rebuilt main showed ~46k-line destructive diffs.
- Lesson: never merge stale pre-rebuild branches casually; always inspect diff scale first.
- Rejected: cherry-picking "just the one commit".
`;

const QUEUE_FIXTURE = `# Weekly learnings queue

## 2026-W41

- [jill] Never \`git stash\` in the shared checkout while parallel worktrees are active.
- [grok] Be careful with stuff.

## unfiled

- [fo] Always test on a fresh checkout before claiming done.
`;

describe("lesson-scorer (W014)", () => {
  it("ranks known high-signal lessons above known low-signal lessons", () => {
    const high = HIGH_SIGNAL.map((f) => scoreLesson(f.text).score);
    const low = LOW_SIGNAL.map((f) => scoreLesson(f.text).score);
    assert.ok(
      Math.min(...high) > Math.max(...low),
      `min high (${Math.min(...high)}) must exceed max low (${Math.max(...low)})`
    );
  });

  it("scores high-signal fixtures above the review threshold (>= 60)", () => {
    for (const f of HIGH_SIGNAL) {
      const r = scoreLesson(f.text);
      assert.ok(r.score >= 60, `${f.id} scored ${r.score}, expected >= 60`);
    }
  });

  it("scores low-signal fixtures below the flag threshold (< 40)", () => {
    for (const f of LOW_SIGNAL) {
      const r = scoreLesson(f.text);
      assert.ok(r.score < 40, `${f.id} scored ${r.score}, expected < 40`);
    }
  });

  it("detects cited evidence (file:line, PR ref, sha) and drops the no-evidence flag", () => {
    const r = scoreLesson(HIGH_SIGNAL[2].text);
    assert.ok(r.dims.evidence > 0, "evidence dim should be positive");
    assert.ok(!r.flags.includes("no-evidence"), `flags were ${r.flags}`);
  });

  it("flags evidence-free vague entries with no-evidence and vague", () => {
    const r = scoreLesson(LOW_SIGNAL[0].text);
    assert.ok(r.flags.includes("no-evidence"), `flags were ${r.flags}`);
    assert.ok(r.flags.includes("vague"), `flags were ${r.flags}`);
  });

  it("rewards imperative rule language (never/always/RULE:) in actionability", () => {
    const r = scoreLesson(HIGH_SIGNAL[0].text);
    assert.ok(
      r.dims.actionability >= 15,
      `actionability was ${r.dims.actionability}`
    );
  });

  it("penalizes essays and one-liners in the shape dimension", () => {
    const essay = scoreLesson(ESSAY);
    assert.ok(essay.flags.includes("essay"), `flags were ${essay.flags}`);
    const short = scoreLesson("Be careful.");
    assert.ok(short.flags.includes("too-short"), `flags were ${short.flags}`);
    assert.ok(
      essay.score < 45,
      `essay scored ${essay.score}, expected < 45 despite concrete content`
    );
  });

  it("detects near-duplicate entries by token overlap", () => {
    const pairs = findDuplicates(DUPES);
    assert.equal(pairs.length, 1);
    assert.ok(
      pairs[0].similarity >= 0.55,
      `similarity was ${pairs[0].similarity}`
    );
    assert.ok(pairs[0].a === "d1" && pairs[0].b === "d2");
  });

  it("does not flag clearly distinct entries as duplicates", () => {
    const entries = [HIGH_SIGNAL[0], HIGH_SIGNAL[2]].map((f) => ({
      id: f.id,
      source: "t",
      text: f.text,
    }));
    assert.deepEqual(findDuplicates(entries), []);
  });

  it("scoreCorpus attaches a dup-of flag to the later duplicate", () => {
    const entries = DUPES.map((f) => ({ id: f.id, source: "t", text: f.text }));
    const scored = scoreCorpus(entries);
    const later = scored.find((e) => e.id === "d2");
    assert.ok(
      later.flags.some((f) => f.startsWith("dup-of:")),
      `flags were ${later.flags}`
    );
    const earlier = scored.find((e) => e.id === "d1");
    assert.ok(
      !earlier.flags.some((f) => f.startsWith("dup-of:")),
      `flags were ${earlier.flags}`
    );
  });

  it("parses wiki entries from schema sections", () => {
    const entries = parseWikiEntries(WIKI_FIXTURE);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].id, "wiki:2026-09-14:README contract line");
    assert.equal(entries[0].agent, "quill");
    assert.ok(entries[0].text.includes("PR #203"));
    assert.equal(entries[1].date, "2026-09-15");
  });

  it("parses queue bullets under week headings", () => {
    const entries = parseQueueEntries(QUEUE_FIXTURE);
    assert.equal(entries.length, 3);
    assert.equal(entries[0].week, "2026-W41");
    assert.ok(entries[0].text.includes("git stash"));
    assert.equal(entries[2].week, "unfiled");
  });

  it("renders a report listing low-signal entries for review", () => {
    const entries = [...HIGH_SIGNAL, ...LOW_SIGNAL].map((f) => ({
      id: f.id,
      source: "t",
      text: f.text,
    }));
    const scored = scoreCorpus(entries);
    const report = renderReport(scored, { threshold: 40 });
    assert.ok(report.includes("REVIEW"), "report should have a REVIEW section");
    for (const f of LOW_SIGNAL) {
      assert.ok(
        report.includes(f.id),
        `report should list low-signal entry ${f.id}`
      );
    }
  });

  it("scoreEntry preserves the entry identity and adds the score", () => {
    const r = scoreEntry({ id: "x1", source: "wiki", text: HIGH_SIGNAL[1].text });
    assert.equal(r.id, "x1");
    assert.equal(r.source, "wiki");
    assert.ok(typeof r.score === "number");
    assert.ok(r.dims && r.flags);
  });
});
