// tests/mergehold-gate.test.js — the merge-hold rule as a required check.
//
// Contract guarded: the `mergehold-gate` check passes a PR exactly when no
// reviewer has an OPEN CHANGES_REQUESTED verdict on the CURRENT head SHA — a
// CHANGES_REQUESTED is open when it is that reviewer's latest non-comment
// review state on this head and not superseded by a later APPROVE or
// dismissal. The check fails closed naming the blocking reviewer(s). On
// 2026-10-06 the room adopted the merge-hold rule ("no merge while a CHANGES
// REQUESTED verdict is open") plus the lander rule; this is the code that
// enforces merge-hold on merge_group at land time instead of by convention.
// The room's #266 prose-hold machinery (tests/merge-hold.test.js) is a
// different contract and does not cover review verdicts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  latestNonCommentByReviewer,
  openChangesRequested,
  prNumberFromMergeGroupRef,
} from "../scripts/merge-review-gate.mjs";
import { verdictFromReviews } from "../scripts/mergehold-gate.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const OLD = "a".repeat(40);
const HEAD = "b".repeat(40);

const review = (id, login, state, commit, at) => ({
  id,
  user: { login },
  state,
  commit_id: commit,
  submitted_at: at,
  html_url: `https://github.com/Uuriko/project-room/pull/1728#pullrequestreview-${id}`,
});

const verdict = (reviews, headSha = HEAD) =>
  verdictFromReviews({ reviews, headSha });

test("passes when there are no reviews", () => {
  const v = verdict([]);
  assert.equal(v.ok, true);
  assert.deepEqual(v.blockers, []);
});

test("blocks on CHANGES_REQUESTED on the current head, naming the reviewer", () => {
  const v = verdict([review(1, "grokbot", "CHANGES_REQUESTED", HEAD, "2026-10-06T20:00:00Z")]);
  assert.equal(v.ok, false);
  assert.deepEqual(v.blockers.map(b => b.login), ["grokbot"]);
  assert.match(v.blockers[0].htmlUrl, /pullrequestreview-1/);
});

test("a CHANGES_REQUESTED on an older commit does not block after a new push", () => {
  // The classic stale-block failure: pushing new code must supersede reviews
  // left on the previous head, or the queue freezes on already-addressed
  // feedback.
  const v = verdict([review(1, "grokbot", "CHANGES_REQUESTED", OLD, "2026-10-06T20:00:00Z")], HEAD);
  assert.equal(v.ok, true);
  assert.deepEqual(v.blockers, []);
});

test("a later APPROVE on the same head clears the block", () => {
  const v = verdict([
    review(1, "grokbot", "CHANGES_REQUESTED", HEAD, "2026-10-06T20:00:00Z"),
    review(2, "grokbot", "APPROVED", HEAD, "2026-10-06T21:00:00Z"),
  ]);
  assert.equal(v.ok, true);
});

test("a later CHANGES_REQUESTED re-blocks after an APPROVE", () => {
  const v = verdict([
    review(1, "grokbot", "APPROVED", HEAD, "2026-10-06T20:00:00Z"),
    review(2, "grokbot", "CHANGES_REQUESTED", HEAD, "2026-10-06T21:00:00Z"),
  ]);
  assert.equal(v.ok, false);
  assert.deepEqual(v.blockers.map(b => b.login), ["grokbot"]);
});

test("a dismissal clears the block", () => {
  const v = verdict([
    review(1, "grokbot", "CHANGES_REQUESTED", HEAD, "2026-10-06T20:00:00Z"),
    review(2, "grokbot", "DISMISSED", HEAD, "2026-10-06T21:00:00Z"),
  ]);
  assert.equal(v.ok, true);
});

test("COMMENTED never counts as a verdict and never clears a block", () => {
  const stillBlocked = verdict([
    review(1, "grokbot", "CHANGES_REQUESTED", HEAD, "2026-10-06T20:00:00Z"),
    review(2, "grokbot", "COMMENTED", HEAD, "2026-10-06T21:00:00Z"),
  ]);
  assert.equal(stillBlocked.ok, false);
  const commentsOnly = verdict([review(3, "tab", "COMMENTED", HEAD, "2026-10-06T21:00:00Z")]);
  assert.equal(commentsOnly.ok, true);
});

test("per-reviewer verdicts are independent; only blockers are named", () => {
  const v = verdict([
    review(1, "grokbot", "CHANGES_REQUESTED", HEAD, "2026-10-06T20:00:00Z"),
    review(2, "codex", "APPROVED", HEAD, "2026-10-06T21:00:00Z"),
  ]);
  assert.equal(v.ok, false);
  assert.deepEqual(v.blockers.map(b => b.login), ["grokbot"]);
});

test("latest-non-comment review per reviewer is shared with lander-gate", () => {
  // The shared helper both gates build on: one pass over the review list,
  // keyed by reviewer, scoped to the current head, comments skipped.
  const map = latestNonCommentByReviewer([
    review(1, "grokbot", "CHANGES_REQUESTED", OLD, "2026-10-06T19:00:00Z"),
    review(2, "grokbot", "CHANGES_REQUESTED", HEAD, "2026-10-06T20:00:00Z"),
    review(3, "grokbot", "COMMENTED", HEAD, "2026-10-06T21:00:00Z"),
    review(4, "codex", "APPROVED", HEAD, "2026-10-06T21:30:00Z"),
  ], { headSha: HEAD });
  assert.equal(map.get("grokbot").state, "CHANGES_REQUESTED");
  assert.equal(map.get("codex").state, "APPROVED");
  assert.deepEqual(openChangesRequested(map).map(b => b.login), ["grokbot"]);
});

test("prNumberFromMergeGroupRef parses the queue temp ref", () => {
  assert.equal(prNumberFromMergeGroupRef("gh-readonly-queue/main/pr-1728-7e1634a1"), 1728);
  assert.equal(prNumberFromMergeGroupRef("refs/heads/gh-readonly-queue/main/pr-12-abcdef"), 12);
  assert.equal(prNumberFromMergeGroupRef("main"), null);
  assert.equal(prNumberFromMergeGroupRef(null), null);
});

test("CLI exits 1 and names the reviewer when blocked, 0 when clean", () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "mergehold-gate-"));
  const blockedFile = join(dir, "blocked.json");
  const cleanFile = join(dir, "clean.json");
  writeFileSync(blockedFile, JSON.stringify([
    review(1, "grokbot", "CHANGES_REQUESTED", HEAD, "2026-10-06T20:00:00Z"),
  ]));
  writeFileSync(cleanFile, JSON.stringify([]));
  const run = (file) => {
    try {
      const out = execFileSync(process.execPath,
        [join(root, "scripts", "mergehold-gate.mjs"), "check", "--reviews", file, "--head", HEAD],
        { stdio: "pipe", encoding: "utf8" });
      return { code: 0, out };
    } catch (error) { return { code: error.status, out: String(error.stdout ?? "") }; }
  };
  const blocked = run(blockedFile);
  assert.equal(blocked.code, 1);
  assert.match(blocked.out, /grokbot/);
  assert.match(blocked.out, /CHANGES_REQUESTED/i);
  const clean = run(cleanFile);
  assert.equal(clean.code, 0);
  assert.match(clean.out, /no open CHANGES_REQUESTED/i);
});
