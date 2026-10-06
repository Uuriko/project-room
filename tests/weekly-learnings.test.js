// tests/weekly-learnings.test.js
//
// Failing-first tests for the weekly learnings auto-post (backlog W007).
// The script under test: scripts/weekly-learnings.mjs
// It must export the pure helpers below so the cron's gathering/rendering
// logic is unit-testable without gh or the room API.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  weekId,
  lessonFromPr,
  extractRoomSignal,
  parseQueue,
  isMaterial,
  weekAlreadySent,
  renderDigest,
} from "../scripts/weekly-learnings.mjs";

const SAMPLE_PRS = [
  {
    number: 1642,
    title: "mime-fuzz harness",
    body: "Adds a fuzz harness for MIME parsing.\n\nLesson: fuzz the boundary, not the happy path.",
    mergedAt: "2026-10-06T08:00:00Z",
  },
  {
    number: 1639,
    title: "PR size discipline CI check (warn mode)",
    body: "Warn-only check, 300-line budget.",
    mergedAt: "2026-10-05T09:00:00Z",
  },
  {
    number: 1638,
    title: "error shapes teach",
    body: "413 too_large now names the limit.\n\nLESSON: teachable errors name the limit and the actual.",
    mergedAt: "2026-10-04T09:00:00Z",
  },
];

const SAMPLE_EVENTS = [
  { sequence: 1, body: "DONE #1617 (G16b mention fan-out) merged as 13091f85" },
  { sequence: 2, body: "DONE #1613 magic-link-cta merged" },
  {
    sequence: 3,
    body: "BUG CONFIRMED: join.html watchdog missing from runtime-package allowlist — owner landed identical fix",
  },
  { sequence: 4, body: "PROGRESS #1617 rebased onto main — should be ignored" },
  { sequence: 5, body: "CLAIM backlog-w007-learnings-post files: a, b — ignored" },
  { sequence: 6, body: "DONE: jill/plan-dir-card rebased onto origin/main" },
];

const SAMPLE_QUEUE = `# Weekly learnings queue

## 2026-W41
- [jill] Never \`git stash\` in the shared checkout while parallel worktrees are active.
- scripts/room flags are GLOBAL — they must precede the verb.

## 2026-W40
- old week, should be ignored.

## unfiled
- a lane lesson waiting for a week home.
`;

describe("weekId", () => {
  it("formats an ISO week id", () => {
    assert.equal(weekId(new Date("2026-10-06T12:00:00Z")), "2026-W41");
    assert.equal(weekId(new Date("2026-01-01T00:00:00Z")), "2026-W01");
  });
});

describe("lessonFromPr", () => {
  it("extracts a Lesson: line from the PR body", () => {
    assert.equal(
      lessonFromPr(SAMPLE_PRS[0]),
      "fuzz the boundary, not the happy path."
    );
  });
  it("matches LESSON: case-insensitively", () => {
    assert.equal(
      lessonFromPr(SAMPLE_PRS[2]),
      "teachable errors name the limit and the actual."
    );
  });
  it("falls back to the PR title when no Lesson: line exists", () => {
    assert.equal(
      lessonFromPr(SAMPLE_PRS[1]),
      "PR size discipline CI check (warn mode)"
    );
  });
});

describe("extractRoomSignal", () => {
  it("picks DONE posts and BUG CONFIRMED posts, ignores the rest", () => {
    const { done, bugs } = extractRoomSignal(SAMPLE_EVENTS);
    assert.equal(done.length, 3);
    assert.equal(bugs.length, 1);
    assert.match(done[0], /#1617/);
    assert.match(bugs[0], /watchdog/);
    assert.ok(!/PROGRESS|CLAIM/.test(done.join("\n") + bugs.join("\n")));
  });
  it("strips DONE/BUG prefixes and one-lines the text", () => {
    const { done, bugs } = extractRoomSignal(SAMPLE_EVENTS);
    assert.ok(!done[0].startsWith("DONE"));
    assert.ok(!bugs[0].startsWith("BUG"));
    assert.ok(!/[\n\r]/.test(done[0]));
  });
});

describe("parseQueue", () => {
  it("returns current-week entries plus unfiled, ignoring other weeks", () => {
    const entries = parseQueue(SAMPLE_QUEUE, "2026-W41");
    assert.equal(entries.length, 3);
    assert.match(entries[0].text, /git stash/);
    assert.equal(entries[0].source, "week");
    assert.equal(entries[2].source, "unfiled");
    assert.ok(!entries.some((e) => /old week/.test(e.text)));
  });
  it("returns an empty list when neither section exists", () => {
    assert.deepEqual(parseQueue("# empty\n", "2026-W41"), []);
  });
});

describe("isMaterial", () => {
  it("skips an empty week", () => {
    assert.equal(
      isMaterial({ prs: [], done: [], bugs: [], lessons: [] }),
      false
    );
  });
  it("skips a thin week (one PR, one lesson)", () => {
    assert.equal(
      isMaterial({ prs: [SAMPLE_PRS[0]], done: [], bugs: [], lessons: [{ text: "x" }] }),
      false
    );
  });
  it("posts a normal week", () => {
    assert.equal(
      isMaterial({
        prs: SAMPLE_PRS,
        done: ["a", "b", "c"],
        bugs: ["d"],
        lessons: [{ text: "e", source: "week" }],
      }),
      true
    );
  });
});

describe("weekAlreadySent", () => {
  it("detects a week already in the sent log", () => {
    const log = "2026-W40\t2026-10-01T00:00:01Z\tposted\n2026-W41\t2026-10-06T09:00:00Z\tposted\n";
    assert.equal(weekAlreadySent(log, "2026-W41"), true);
    assert.equal(weekAlreadySent(log, "2026-W42"), false);
  });
  it("handles an empty or missing log", () => {
    assert.equal(weekAlreadySent("", "2026-W41"), false);
    assert.equal(weekAlreadySent(null, "2026-W41"), false);
  });
});

describe("renderDigest", () => {
  const signal = {
    weekLabel: "2026-09-29 → 2026-10-06",
    prs: SAMPLE_PRS,
    totalPrs: 42,
    done: extractRoomSignal(SAMPLE_EVENTS).done,
    bugs: extractRoomSignal(SAMPLE_EVENTS).bugs,
    lessons: parseQueue(SAMPLE_QUEUE, "2026-W41").map((e) => e.text),
  };

  it("renders the expected post format", () => {
    const out = renderDigest(signal);
    assert.match(out, /^🪔 Weekly learnings — 2026-09-29 → 2026-10-06/);
    assert.match(out, /^SHIPPED — 42 merged PRs$/m);
    assert.match(out, /^BROKE & FIXED$/m);
    assert.match(out, /^LEARNED$/m);
    assert.match(out, /^DONE THIS WEEK — 3$/m);
    assert.match(out, /• #1642 mime-fuzz harness — fuzz the boundary, not the happy path\./);
    assert.match(out, /• #1639 PR size discipline CI check \(warn mode\)$/m);
    assert.match(out, /\(…\+34 more\)/); // overflow counts against the honest total, not the fetched page
    assert.match(out, /• join\.html watchdog missing from runtime-package allowlist/);
    assert.match(out, /• \[jill\] Never `git stash` in the shared checkout/);
    assert.match(out, /docs\/WEEKLY-LEARNINGS\.md/);
  });

  it("falls back to the fetched list length when no total is given", () => {
    const out = renderDigest({ ...signal, totalPrs: undefined });
    assert.match(out, /^SHIPPED — 3 merged PRs$/m);
  });

  it("caps each section and notes the overflow", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      number: 1000 + i,
      title: `pr ${i}`,
      body: "",
      mergedAt: "2026-10-06T00:00:00Z",
    }));
    const out = renderDigest({ ...signal, prs: many, totalPrs: undefined });
    assert.match(out, /^SHIPPED — 20 merged PRs$/m);
    assert.match(out, /\(…\+12 more\)/);
    assert.ok(!out.includes("• #1019"));
  });

  it("hard-caps the post length", () => {
    const huge = Array.from({ length: 60 }, (_, i) => ({
      number: 2000 + i,
      title: "x".repeat(200),
      body: `Lesson: ${"y".repeat(200)}`,
      mergedAt: "2026-10-06T00:00:00Z",
    }));
    const out = renderDigest({
      ...signal,
      prs: huge,
      done: Array.from({ length: 6 }, () => "d".repeat(200)),
      bugs: Array.from({ length: 6 }, () => "b".repeat(200)),
      lessons: Array.from({ length: 10 }, () => "z".repeat(200)),
    });
    assert.ok(out.length <= 4000, `length ${out.length} exceeds cap`);
    assert.match(out, /… \(trimmed for length\)$/);
  });

  it("returns null when there is nothing material", () => {
    assert.equal(
      renderDigest({ weekLabel: "x", prs: [], done: [], bugs: [], lessons: [] }),
      null
    );
  });
});
