#!/usr/bin/env node
// scripts/lander-gate.mjs — the lander rule as a required GitHub check run.
//
// The lander rule: a PR merges only after a reviewer's explicit APPROVE on
// the EXACT head SHA. This script enforces it as a check run named exactly
// `lander-gate`, on two events:
//
//   pull_request (opened/synchronize/reopened/ready_for_review) — early
//       signal: one completed check run on the PR head SHA.
//   merge_group (checks_requested) — the enforcement point: heads move
//       while a PR sits in the queue, so the gate is re-verified against the
//       exact prospective merge state. One completed check run named
//       `lander-gate` is posted on the group's head SHA; it passes only when
//       EVERY queued PR has an exact-head APPROVE.
//
// Verdict: PASS iff at least one review from a reviewer with write access
// (author_association OWNER/MEMBER/COLLABORATOR) has state APPROVED and
// review.commit_id equals the PR's current head SHA. The reviewer's latest
// non-dismissed review is the one that counts; a stale approval (pushed or
// rebased after the review) fails the gate until re-approved.
//
// Deliberate limitation: a patch-id-identical carry (head moved but the
// content hash is byte-identical) is NOT auto-accepted — re-approval is
// required. Patch-id would need the base+diff of both the reviewed and the
// current head; the queue already re-runs the full CI matrix on the merge
// group, so the marginal cost of a re-approval is a human click, not a CI
// cycle. If cheap patch-id verification is ever wired in, it belongs in
// landerVerdict as an additional pass condition, not a replacement.
//
// Usage (CI; driven by GITHUB_* env, see .github/workflows/lander-gate.yml):
//   node scripts/lander-gate.mjs
//
// Read/write against the GitHub REST API: GET pulls/{n}/reviews (paginated),
// GET pulls/{n} (head SHA when the event doesn't carry one), POST
// repos/{o}/{r}/check-runs. Requires a token with pull-requests:read and
// checks:write. On fork pull_request events the token cannot create check
// runs — the script prints the verdict and exits 1 instead of pretending.
//
// Exit codes: 0 = gate passed, 1 = gate failed or could not report.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const CHECK_NAME = "lander-gate";
// Reviewers who can satisfy the gate: write access or higher. GitHub reports
// this per review as author_association; FIRST_TIME_CONTRIBUTOR etc. never
// count, even if they somehow submit an approving review.
const ELIGIBLE_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

// Latest non-dismissed, non-pending review per user wins; APPROVED must sit
// on the exact head SHA.
export function landerVerdict({ reviews, headSha }) {
  if (!Array.isArray(reviews)) throw new TypeError("reviews must be an array");
  if (typeof headSha !== "string" || !/^[0-9a-f]{40}$/i.test(headSha)) {
    throw new TypeError("headSha must be a 40-char SHA");
  }
  const head = headSha.toLowerCase();
  const latest = new Map();
  for (const r of reviews) {
    if (!r || typeof r !== "object") continue;
    if (r.state === "PENDING") continue; // in-progress review, not a verdict
    const login = r.user?.login;
    if (typeof login !== "string" || !ELIGIBLE_ASSOCIATIONS.has(String(r.author_association).toUpperCase())) continue;
    const prev = latest.get(login);
    if (!prev || String(r.submitted_at ?? "") >= String(prev.submitted_at ?? "")) latest.set(login, r);
  }
  const approved = [...latest.values()].filter((r) => r.state === "APPROVED");
  const exact = approved.filter((r) => String(r.commit_id ?? "").toLowerCase() === head);
  if (exact.length > 0) {
    const names = exact.map((r) => r.user.login).join(", ");
    return { pass: true, reason: `APPROVE on exact head ${head.slice(0, 7)} by ${names}` };
  }
  if (approved.length > 0) {
    const stale = approved
      .map((r) => `${r.user.login}@${String(r.commit_id ?? "").slice(0, 7)}`)
      .join(", ");
    return {
      pass: false,
      reason: `no APPROVE on exact head ${head.slice(0, 7)}; stale approvals: ${stale} — push after approval invalidates it; re-approve required`,
    };
  }
  return { pass: false, reason: `no APPROVE on exact head ${head.slice(0, 7)} from an eligible reviewer` };
}

// Resolve which PRs the gate must evaluate from the Actions event.
// pull_request -> the one PR (head SHA from the payload).
// merge_group  -> every PR in the group (numbers from payload.pull_requests,
//   falling back to the gh-readonly-queue temp ref when absent); each entry
//   carries groupHeadSha so the single check run lands on the merge_group
//   commit, which is the SHA branch protection evaluates for the queue.
export function targetsFromEvent(eventName, event) {
  if (eventName === "pull_request") {
    const pr = event?.pull_request;
    if (!Number.isInteger(pr?.number) || typeof pr?.head?.sha !== "string") {
      throw new Error("pull_request event missing pull_request.number/head.sha");
    }
    return [{ pr: pr.number, headSha: pr.head.sha }];
  }
  if (eventName === "merge_group") {
    const group = event?.merge_group;
    if (typeof group?.head_sha !== "string" || typeof group?.head_ref !== "string") {
      throw new Error("merge_group event missing merge_group.head_sha/head_ref");
    }
    const fromPayload = Array.isArray(event.pull_requests)
      ? event.pull_requests.map((p) => p?.number).filter(Number.isInteger)
      : [];
    const numbers = fromPayload.length > 0 ? fromPayload : parsePrRef(group.head_ref);
    if (numbers.length === 0) throw new Error(`cannot resolve PR numbers from merge_group ref ${group.head_ref}`);
    return numbers.map((pr) => ({ pr, headSha: null, groupHeadSha: group.head_sha }));
  }
  throw new Error(`unsupported event ${eventName}; lander-gate runs on pull_request and merge_group only`);
}

// gh-readonly-queue/{base}/pr-{N}-{headsha} — parse every pr-{N} segment.
// Docs show {base}/pr-<N> as the shape; the group branch also carries one
// entry per queued PR in order.
export function parsePrRef(headRef) {
  const out = [];
  for (const m of String(headRef).matchAll(/\/pr-(\d+)(?:-|$)/g)) out.push(Number(m[1]));
  return out;
}

// --- GitHub API -------------------------------------------------------------
function apiHeaders(token) {
  const headers = { accept: "application/vnd.github+json", "user-agent": "project-room-lander-gate" };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

async function ghGetJson(url, token) {
  const response = await fetch(url, { headers: apiHeaders(token), signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`GitHub ${response.status} GET ${new URL(url).pathname}`);
  return response.json();
}

async function fetchReviews(repo, pr, token) {
  const reviews = [];
  for (let page = 1; page <= 10; page++) {
    const rows = await ghGetJson(
      `https://api.github.com/repos/${repo}/pulls/${pr}/reviews?per_page=100&page=${page}`,
      token
    );
    if (!Array.isArray(rows)) throw new Error("malformed reviews response");
    reviews.push(...rows);
    if (rows.length < 100) break;
  }
  return reviews;
}

async function postCheckRun(repo, headSha, conclusion, summary, token) {
  const response = await fetch(`https://api.github.com/repos/${repo}/check-runs`, {
    method: "POST",
    headers: { ...apiHeaders(token), "content-type": "application/json" },
    body: JSON.stringify({
      name: CHECK_NAME,
      head_sha: headSha,
      status: "completed",
      conclusion,
      output: {
        title: conclusion === "success" ? "lander rule satisfied" : "lander rule violated",
        summary,
      },
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`GitHub ${response.status} creating ${CHECK_NAME} check run: ${text.slice(0, 200)}`);
  }
}

// --- main -------------------------------------------------------------------
async function main() {
  const eventName = process.env.GITHUB_EVENT_NAME;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!eventName || !eventPath || !repo) throw new Error("GITHUB_EVENT_NAME/GITHUB_EVENT_PATH/GITHUB_REPOSITORY are required");
  const event = JSON.parse(readFileSync(eventPath, "utf8"));
  const targets = targetsFromEvent(eventName, event);

  const verdicts = [];
  for (const target of targets) {
    let headSha = target.headSha;
    if (!headSha) {
      const pr = await ghGetJson(`https://api.github.com/repos/${repo}/pulls/${target.pr}`, token);
      headSha = pr?.head?.sha;
      if (typeof headSha !== "string") throw new Error(`PR #${target.pr}: no head SHA from API`);
    }
    const reviews = await fetchReviews(repo, target.pr, token);
    const verdict = landerVerdict({ reviews, headSha });
    verdicts.push({ pr: target.pr, headSha, verdict });
    process.stdout.write(`#${target.pr} ${headSha.slice(0, 7)}: ${verdict.pass ? "PASS" : "FAIL"} — ${verdict.reason}\n`);
  }

  const pass = verdicts.every((v) => v.verdict.pass);
  const summary = verdicts
    .map((v) => `#${v.pr}: ${v.verdict.pass ? "PASS" : "FAIL"} — ${v.verdict.reason}`)
    .join("\n");
  const reportSha =
    eventName === "merge_group" ? event.merge_group.head_sha : verdicts[0].headSha;
  try {
    await postCheckRun(repo, reportSha, pass ? "success" : "failure", summary, token);
    process.stdout.write(`posted ${CHECK_NAME} check run (${pass ? "success" : "failure"}) on ${reportSha.slice(0, 7)}\n`);
  } catch (error) {
    // Fork PRs: the token cannot write check runs. Print the verdict so the
    // workflow log still shows it, and fail loudly rather than reporting
    // nothing — a silently missing required check blocks merges forever.
    process.stderr.write(`could not post ${CHECK_NAME} check run: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = pass ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
