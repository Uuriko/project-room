// tests/lesson-contradictions.test.js
//
// Failing-first tests for the lesson contradiction resolver (backlog W015).
// The script under test: scripts/lesson-contradictions.mjs
// It must export the pure helpers below so the heuristics are unit-testable
// without touching the real corpus files.
//
// The resolver is a heuristic (no LLM) contradiction detector: it normalizes
// lesson entries and flags pairs that oppose each other (never-vs-always on a
// shared topic, preference inversions, unmarked supersession claims) for
// human review. It REPORTS ONLY: it never edits, deletes, resolves, or
// reorders lesson entries.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractDirectives,
  sharedAnchors,
  findContradictions,
  parseLessonBullets,
  renderContradictionReport,
} from "../scripts/lesson-contradictions.mjs";

// ------------------------------------------------------------- fixtures

const NEVER_STASH = {
  id: "a:never-stash",
  text: "Never `git stash` in the shared checkout while parallel slice worktrees are active (2026-09-17: refs/stash is global across worktrees). RULE: commit to the feature branch instead.",
};

const ALWAYS_STASH = {
  id: "b:always-stash",
  text: "Always `git stash` before switching branches in the shared checkout — it keeps your uncommitted work safe while you move between branches.",
};

const FULL_CLONES_A = {
  id: "c:full-clone-a",
  text: "Prefer full clones when rebuilding room-state; never use a shallow clone for the rebuild+push because the shallow tip can't fast-forward.",
};

const FULL_CLONES_B = {
  id: "d:full-clone-b",
  text: "Full clones keep the real history visible, so full clones are the safe default for any rebuild+push workflow.",
};

const REBASE_PR = {
  id: "e:rebase-pr",
  text: "Always rebase onto origin/main before opening a PR; never open a PR from a head more than ~2h behind main.",
};

const SUPERSESSION = {
  id: "wiki:2026-10-06:checkout-note",
  text: "Tried: reading server/store.mjs off a shallow clone. Outcome: ✗. This entry supersedes the 2026-09-14 stale branches entry's guidance about shallow clones for read-only inspection.",
};

const STALE_BRANCHES = {
  id: "wiki:2026-09-14:stale-branches",
  text: "Tried: considering old grok/* branches for merge. Lesson: never merge or cherry-pick stale pre-rebuild branches casually; always inspect diff scale first.",
};

const PREFER_FULL = {
  id: "f:prefer-full",
  text: "When rebuilding ROOM-STATE.md, prefer `git worktree add` over cloning the whole repo fresh: the worktree shares the object store and is faster.",
};

const PREFER_CLONE = {
  id: "g:prefer-clone",
  text: "For a clean rebuild, prefer cloning the whole repo fresh over `git worktree add`: a fresh clone guarantees no leaked state from parallel work.",
};

const PLAIN_SUPERSESSION = {
  id: "h:plain",
  text: "This new runbook replaces our earlier habits around room claims; the old way was too slow. Use the new checklist instead.",
};

function mk(id, text) {
  return { id, text };
}

// ------------------------------------------------------------- tests

describe("lesson-contradictions (W015)", () => {
  it("extractDirectives finds negative directives with their target tokens", () => {
    const ds = extractDirectives(NEVER_STASH.text);
    assert.ok(ds.length >= 1, "expected at least one directive");
    const neg = ds.find((d) => d.polarity === "neg");
    assert.ok(neg, "expected a negative directive");
    assert.ok(neg.targets.has("stash"), "target should include 'stash'");
    assert.ok(neg.targets.has("checkout"), "target should include 'checkout'");
  });

  it("extractDirectives finds positive directives with their target tokens", () => {
    const ds = extractDirectives(REBASE_PR.text);
    const pos = ds.filter((d) => d.polarity === "pos");
    assert.ok(pos.length >= 1, "expected at least one positive directive");
    assert.ok(pos.some((d) => d.targets.has("rebase")), "target should include 'rebase'");
  });

  it("flags a never-vs-always pair on a shared topic", () => {
    const hits = findContradictions([NEVER_STASH, ALWAYS_STASH]);
    assert.strictEqual(hits.length, 1, `expected exactly one contradiction, got ${hits.length}`);
    assert.strictEqual(hits[0].type, "opposing-directive");
    const ids = new Set([hits[0].a, hits[0].b]);
    assert.ok(ids.has(NEVER_STASH.id) && ids.has(ALWAYS_STASH.id));
    assert.ok(hits[0].evidence.length >= 1, "evidence sentences should be included");
  });

  it("does NOT flag two complementary same-topic positive lessons", () => {
    const hits = findContradictions([FULL_CLONES_A, FULL_CLONES_B]);
    const opposing = hits.filter((h) => h.type === "opposing-directive");
    assert.strictEqual(opposing.length, 0, `unexpected opposing directives: ${JSON.stringify(opposing)}`);
  });

  it("does NOT flag pairs on unrelated topics", () => {
    const hits = findContradictions([NEVER_STASH, REBASE_PR]);
    assert.strictEqual(hits.length, 0, `unexpected contradictions: ${JSON.stringify(hits)}`);
  });

  it("does NOT flag a single entry against itself", () => {
    const hits = findContradictions([NEVER_STASH, NEVER_STASH]);
    assert.strictEqual(hits.length, 0);
  });

  it("flags a prefer-X-over-Y vs prefer-Y-over-X inversion", () => {
    const hits = findContradictions([PREFER_FULL, PREFER_CLONE]);
    const inv = hits.filter((h) => h.type === "preference-inversion");
    assert.strictEqual(inv.length, 1, `expected one preference inversion, got ${JSON.stringify(hits)}`);
  });

  it("does NOT flag two aligned prefer-X-over-Y statements", () => {
    const hits = findContradictions([PREFER_FULL, PREFER_FULL]);
    const inv = hits.filter((h) => h.type === "preference-inversion");
    assert.strictEqual(inv.length, 0);
  });

  it("flags an unmarked supersession that references a corpus entry", () => {
    const hits = findContradictions([SUPERSESSION, STALE_BRANCHES]);
    const sup = hits.filter((h) => h.type === "unmarked-supersession");
    assert.strictEqual(sup.length, 1, `expected one supersession flag, got ${JSON.stringify(hits)}`);
    assert.strictEqual(sup[0].a, SUPERSESSION.id);
  });

  it("does NOT flag a vague 'replaces our habits' statement with no entry reference", () => {
    const hits = findContradictions([PLAIN_SUPERSESSION, STALE_BRANCHES]);
    const sup = hits.filter((h) => h.type === "unmarked-supersession");
    assert.strictEqual(sup.length, 0, `unexpected supersession flag: ${JSON.stringify(hits)}`);
  });

  it("sharedAnchors finds shared file paths and topic tokens", () => {
    const { paths, tokens } = sharedAnchors(
      "Repair server/claim-coordination.mjs before merging. See server/claim-coordination.mjs:42.",
      "The bug is in server/claim-coordination.mjs; do not touch server/claim-coordination.mjs without a claim."
    );
    assert.ok(paths.includes("server/claim-coordination.mjs"), `paths: ${paths}`);
    assert.ok(tokens.includes("coordination"), `tokens: ${tokens}`);
  });

  it("parseLessonBullets splits top-level bullets under ## Lessons", () => {
    const md = [
      "# title",
      "",
      "## Lessons",
      "- First lesson: never do the thing. RULE: do the other thing instead.",
      "  continued detail about the first lesson.",
      "- Second lesson: always prefer full clones.",
      "",
      "## Other",
      "- Not a lesson bullet.",
    ].join("\n");
    const entries = parseLessonBullets(md);
    assert.strictEqual(entries.length, 2);
    assert.ok(entries[0].text.includes("never do the thing"));
    assert.ok(entries[0].text.includes("continued detail"));
    assert.ok(entries[1].text.includes("full clones"));
  });

  it("report renders pairs for human review and states report-only", () => {
    const hits = findContradictions([NEVER_STASH, ALWAYS_STASH, PREFER_FULL, PREFER_CLONE]);
    const text = renderContradictionReport(hits);
    assert.ok(text.includes("opposing-directive"));
    assert.ok(text.includes("preference-inversion"));
    assert.ok(text.includes("report-only"), "report must say it is report-only");
    assert.ok(!text.toLowerCase().includes("resolved"), "report must not claim resolution");
  });

  it("entries with no directives at all produce no contradictions", () => {
    const hits = findContradictions([
      mk("x1", "Good communication is important for the team."),
      mk("x2", "Ship something visible every week."),
    ]);
    assert.strictEqual(hits.length, 0);
  });
});
