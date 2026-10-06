#!/usr/bin/env node
// scripts/review-state.mjs — per-PR review-state surface + single-lane review
// assignment routing.
//
// Companion to #1585's review-parallelization protocol
// (docs/REVIEW-PARALLELISM.md): #1585 runs the cheap-first mechanical pass
// per PR (diff size, claim-scope match via scripts/review-scope-check.mjs,
// lint/test conclusions) and defines the clean-context judgment pass. This
// module is the cross-PR coordination layer #1585 did not cover: for every
// open PR, which reviewer(s) posted verdicts, the head SHA each verdict
// covered, and whether each verdict is stale (head moved since) — plus
// deterministic single-lane assignment routing so reviewers neither block
// each other nor re-review stale heads.
//
// A verdict's provenance (reviewer + exact head SHA + timestamp) binds the
// judgment to the version inspected, consistent with the claim-provenance
// model in #1614 (parentClaimId/evidenceRefs freeze evidence onto a
// version; here the version is the PR head).
//
// Pure analysis lives in analyzeReviewState() / routeReviews() so tests run
// offline against fixtures. Live reads use the read-only gh CLI.
//
// Usage:
//   node scripts/review-state.mjs [--repo Uuriko/project-room]
//       [--lanes fo,instinct] [--assign-file assignments.json]
//       [--input fixture.json] [--format json|md]
// GITHUB_TOKEN is used when set (higher rate limit); not required.
//
// Fixture shape (--input): {
//   prs: [{ number, title, author, headSha, draft, additions, deletions,
//           changedFiles }],
//   reviews: [{ prNumber, reviewer, verdict: APPROVE|CHANGES|COMMENT,
//               headSha, at }] }

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const REPO = argValue("--repo") || "Uuriko/project-room";

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

// --- pure analysis -----------------------------------------------------------

// One review row per verdict; `stale` means the PR head moved since the
// verdict was posted, so the verdict no longer covers the current head.
export function analyzeReviewState({ prs, reviews = [] }) {
  const byPr = new Map();
  for (const r of reviews || []) {
    if (!byPr.has(r.prNumber)) byPr.set(r.prNumber, []);
    byPr.get(r.prNumber).push(r);
  }
  return (prs || []).map((pr) => {
    const prReviews = (byPr.get(pr.number) || []).map((r) => ({
      reviewer: r.reviewer,
      verdict: r.verdict,
      headSha: r.headSha,
      at: r.at ?? null,
      stale: r.headSha !== pr.headSha,
    }));
    const verdicts = prReviews.filter((r) => r.verdict !== "COMMENT");
    const latest = verdicts.length ? verdicts[verdicts.length - 1] : null;
    let status;
    if (!latest) status = "awaiting_review";
    else if (latest.stale) status = "stale_verdict";
    else if (latest.verdict === "APPROVE") status = "approved_fresh";
    else status = "changes_requested";

    // Diff size is free from the PR payload; claim-scope match belongs to
    // #1585's mechanical pass (scripts/review-scope-check.mjs), not here.
    return {
      number: pr.number,
      title: pr.title,
      author: pr.author,
      headSha: pr.headSha,
      draft: pr.draft === true,
      mechanical: {
        additions: pr.additions ?? null,
        deletions: pr.deletions ?? null,
        changedFiles: pr.changedFiles ?? null,
      },
      reviews: prReviews,
      verdict: {
        status,
        reviewer: latest ? latest.reviewer : null,
        verdict: latest ? latest.verdict : null,
        headSha: latest ? latest.headSha : null,
        stale: latest ? latest.stale : null,
      },
      needsReview: status !== "approved_fresh",
    };
  });
}

// Assign each review-needing, non-draft PR to exactly one lane:
//   - sticky: a prior assignment survives head moves so the same lane
//     re-reviews (no duplicate-lane treadmill after rebases);
//   - deterministic: open slots rotate by PR number, so independent runners
//     compute the same routing without coordinating;
//   - author is never assigned their own PR;
//   - PRs with no eligible lane land in `unrouted`, never silently dropped.
export function routeReviews(states, lanes, prior = {}) {
  const roster = (lanes || []).map((l) => (typeof l === "string" ? l : l.name));
  const assignments = {};
  const unrouted = [];
  for (const s of states) {
    if (!s.needsReview || s.draft) continue;
    const priorLane = prior[s.number];
    if (priorLane && roster.includes(priorLane) && priorLane !== s.author) {
      assignments[s.number] = priorLane;
      continue;
    }
    const eligible = roster.filter((l) => l !== s.author);
    if (eligible.length === 0) {
      unrouted.push(s.number);
      continue;
    }
    assignments[s.number] = eligible[s.number % eligible.length];
  }
  return { assignments, unrouted };
}

// --- live reads (gh CLI, read-only) -----------------------------------------

function ghApi(path, paginate = false) {
  const args = ["api", path];
  if (paginate) args.push("--paginate");
  try {
    return JSON.parse(
      execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    );
  } catch (e) {
    const msg = (e.stderr || e.message || "").toString().split("\n")[0];
    console.error(`gh api ${path} failed: ${msg}`);
    process.exit(2);
  }
}

function fetchLive() {
  const pulls = ghApi(`repos/${REPO}/pulls?state=open&per_page=100`);
  const prs = pulls.map((p) => ({
    number: p.number,
    title: p.title,
    author: p.user?.login,
    headSha: p.head?.sha,
    draft: p.draft === true,
    additions: p.additions ?? null,
    deletions: p.deletions ?? null,
    changedFiles: p.changed_files ?? null,
  }));
  const reviews = [];
  for (const p of pulls) {
    const rs = ghApi(`repos/${REPO}/pulls/${p.number}/reviews`, true);
    for (const r of Array.isArray(rs) ? rs : []) {
      const verdict =
        r.state === "APPROVED" ? "APPROVE"
        : r.state === "CHANGES_REQUESTED" ? "CHANGES"
        : "COMMENT";
      reviews.push({
        prNumber: p.number,
        reviewer: r.user?.login,
        verdict,
        headSha: r.commit_id,
        at: r.submitted_at,
      });
    }
  }
  return { prs, reviews };
}

// --- cli ---------------------------------------------------------------------

function asMarkdown(states, routing) {
  const rows = states.map((s) => {
    const r = routing.assignments[s.number];
    return `| #${s.number} | ${s.title} | ${s.author} | \`${String(s.headSha).slice(0, 7)}\` | ${r || (routing.unrouted.includes(s.number) ? "UNROUTED" : "—")} | ${s.verdict.status} | ${s.draft ? "draft" : "ready"} |`;
  });
  return [
    "| PR | title | author | head | assigned | verdict | state |",
    "|----|-------|--------|------|----------|---------|-------|",
    ...rows,
  ].join("\n");
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const input = argValue("--input");
  const fixture = input ? JSON.parse(readFileSync(input, "utf8")) : fetchLive();
  const lanes = (argValue("--lanes") || "").split(",").map((s) => s.trim()).filter(Boolean).map((name) => ({ name }));
  const assignFile = argValue("--assign-file");
  const prior = assignFile ? JSON.parse(readFileSync(assignFile, "utf8")) : {};

  const states = analyzeReviewState(fixture);
  const routing = routeReviews(states, lanes, prior);
  const format = argValue("--format") || "json";
  if (format === "md") {
    console.log(asMarkdown(states, routing));
  } else {
    console.log(JSON.stringify({ states, routing }, null, 2));
  }
  if (assignFile) writeFileSync(assignFile, JSON.stringify(routing.assignments, null, 2) + "\n");
}
