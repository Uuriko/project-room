// scripts/merge-review-gate.mjs — shared review-verdict primitives for the
// merge-queue eligibility gates.
//
// Both `mergehold-gate` (no open CHANGES_REQUESTED on the current head) and
// `lander-gate` (exact-head reviewer APPROVE) read the same GitHub PR reviews
// API. This module owns the fetch and the per-reviewer latest-non-comment
// verdict computation so the two gates share one implementation and one set
// of conventions instead of duplicating review-fetching logic.
//
// Review verdict semantics (the room's merge-hold rule):
//   - Only reviews submitted on the PR's CURRENT head SHA count. A
//     CHANGES_REQUESTED left on an older commit is superseded by the push;
//     counting it would freeze the queue on already-addressed feedback.
//   - Per reviewer, the latest non-comment review on this head decides.
//     COMMENTED is never a verdict and never supersedes one. A later APPROVE
//     or dismissal on the same head clears an earlier CHANGES_REQUESTED; a
//     later CHANGES_REQUESTED re-blocks after an APPROVE.
//
// Pure functions are exported for fixture tests; network stays in the fetch
// helpers. Read-only against the GitHub API.
import { pathToFileURL } from "node:url";

const API = "https://api.github.com";

// Merge-queue temp refs look like
// gh-readonly-queue/<base>/pr-<number>-<sha> (or with a refs/heads/ prefix).
const QUEUE_REF_PR = /pr-(\d+)(?![\d])/;

export function prNumberFromMergeGroupRef(headRef) {
  const match = QUEUE_REF_PR.exec(String(headRef ?? ""));
  return match ? Number(match[1]) : null;
}

async function apiGet(path, { token }) {
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "project-room-merge-review-gate",
    "x-github-api-version": "2022-11-28",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${API}${path}`, { headers, signal: AbortSignal.timeout(15000) });
  if (!response.ok) {
    throw new Error(`GitHub ${response.status} GET ${path.split("?")[0]}`);
  }
  return response.json();
}

// GET /repos/{owner}/{repo}/pulls/{pull_number} — the fresh source of the
// PR's current head; event payloads can be stale at land time.
export async function fetchPullRequest({ owner, repo, pullNumber, token }) {
  const pull = await apiGet(`/repos/${owner}/${repo}/pulls/${pullNumber}`, { token });
  const headSha = pull?.head?.sha;
  if (typeof headSha !== "string" || !/^[0-9a-f]{40}$/i.test(headSha)) {
    throw new Error(`PR #${pullNumber} has no usable head SHA`);
  }
  return { number: pull.number, headSha, baseRef: pull?.base?.ref ?? null };
}

// GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews, oldest first, all
// pages. Fails closed past maxPages rather than silently truncating the
// verdict set.
export async function fetchPullReviews({ owner, repo, pullNumber, token, maxPages = 10 }) {
  const reviews = [];
  for (let page = 1; page <= maxPages; page++) {
    const rows = await apiGet(
      `/repos/${owner}/${repo}/pulls/${pullNumber}/reviews?per_page=100&page=${page}`,
      { token },
    );
    if (!Array.isArray(rows)) throw new Error("Malformed GitHub reviews response");
    reviews.push(...rows);
    if (rows.length < 100) return reviews;
  }
  throw new Error(`PR #${pullNumber} has more than ${maxPages * 100} reviews; refusing to judge a truncated set`);
}

const VERDICT_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);

// Map of reviewer login -> their latest review on headSha that carries a
// verdict. Reviews on older commits are excluded (superseded by the push);
// COMMENTED/PENDING never count as verdicts and never clear one.
export function latestNonCommentByReviewer(reviews, { headSha }) {
  const byReviewer = new Map();
  for (const review of reviews ?? []) {
    if (review?.commit_id !== headSha) continue;
    if (!VERDICT_STATES.has(review.state)) continue;
    const login = review?.user?.login;
    if (typeof login !== "string" || !login) continue;
    const prev = byReviewer.get(login);
    if (!prev || String(review.submitted_at ?? "") > String(prev.submitted_at ?? "") ||
        (review.submitted_at === prev.submitted_at && Number(review.id) > Number(prev.id))) {
      byReviewer.set(login, review);
    }
  }
  return byReviewer;
}

function verdictEntries(reviewMap, state) {
  const out = [];
  for (const [login, review] of reviewMap) {
    if (review.state !== state) continue;
    out.push({
      login,
      state: review.state,
      reviewId: review.id ?? null,
      htmlUrl: review.html_url ?? null,
      submittedAt: review.submitted_at ?? null,
    });
  }
  out.sort((a, b) => String(a.submittedAt ?? "").localeCompare(String(b.submittedAt ?? "")));
  return out;
}

// Reviewers whose open verdict is CHANGES_REQUESTED on this head.
export function openChangesRequested(reviewMap) {
  return verdictEntries(reviewMap, "CHANGES_REQUESTED");
}

// Reviewers holding an APPROVE on this exact head (lander-gate's input).
export function exactHeadApprovals(reviewMap) {
  return verdictEntries(reviewMap, "APPROVED");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  console.error("merge-review-gate.mjs is a shared helper; run mergehold-gate.mjs instead");
  process.exitCode = 2;
}
