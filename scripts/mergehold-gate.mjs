#!/usr/bin/env node
// scripts/mergehold-gate.mjs — the merge-hold rule as a GitHub check.
//
// The room's merge-hold rule: no merge while a CHANGES_REQUESTED verdict is
// open on the PR. This script is the `mergehold-gate` required check: it runs
// on merge_group (so the merge queue re-verifies at land time) and on
// pull_request / pull_request_review (so the check is current on the PR
// itself). Verdicts come from the GitHub PR reviews API, scoped to the PR's
// current head SHA — a CHANGES_REQUESTED on an older commit is superseded by
// the push and does not block.
//
// Usage:
//   node scripts/mergehold-gate.mjs check
//     Reads GITHUB_EVENT_PATH / GITHUB_TOKEN / GITHUB_REPOSITORY from the
//     Actions environment, fetches the PR and its reviews, and judges.
//   node scripts/mergehold-gate.mjs check --reviews <file.json> --head <sha>
//     Offline mode for tests: judge a fixture review list, no network.
//
// Exit 0: PASS — no open CHANGES_REQUESTED on the head.
// Exit 1: BLOCKED (names the blocking reviewers) or ERROR — fail closed so an
// unreadable verdict set never silently lets a held PR merge.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  fetchPullRequest,
  fetchPullReviews,
  latestNonCommentByReviewer,
  openChangesRequested,
  prNumberFromMergeGroupRef,
} from "./merge-review-gate.mjs";

// Pure verdict over a review list: the unit under test.
export function verdictFromReviews({ reviews, headSha }) {
  const map = latestNonCommentByReviewer(reviews, { headSha });
  const blockers = openChangesRequested(map);
  return { ok: blockers.length === 0, headSha, blockers, reviewed: reviews?.length ?? 0 };
}

function short(sha) {
  return String(sha ?? "").slice(0, 7) || "(unknown head)";
}

function reportVerdict(verdict, { pr }) {
  const head = short(verdict.headSha);
  if (verdict.ok) {
    return `mergehold-gate: PASS — no open CHANGES_REQUESTED on PR #${pr} head ${head} (${verdict.reviewed} reviews checked)`;
  }
  const lines = verdict.blockers.map(
    b => `mergehold-gate: BLOCKED — open CHANGES_REQUESTED from @${b.login}` +
      (b.submittedAt ? ` (submitted ${b.submittedAt})` : "") +
      (b.htmlUrl ? `: ${b.htmlUrl}` : ""),
  );
  return [...lines, `mergehold-gate: FAIL — ${verdict.blockers.length} blocking reviewer(s) on PR #${pr} head ${head}`].join("\n");
}

// Resolve the PR number from the webhook event, then re-fetch the PR fresh
// from the API so the head SHA is current at check time (event payloads can
// be stale, and merge_group carries no PR number directly).
async function resolvePrNumber(event) {
  if (event?.pull_request?.number) return Number(event.pull_request.number);
  if (event?.issue?.number && event?.issue?.pull_request) return Number(event.issue.number);
  const headRef = event?.merge_group?.head_ref;
  if (headRef) return prNumberFromMergeGroupRef(headRef);
  return null;
}

function option(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function checkLive() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!eventPath) throw new Error("GITHUB_EVENT_PATH is not set");
  if (!token) throw new Error("GITHUB_TOKEN is not set");
  if (!repo || !repo.includes("/")) throw new Error("GITHUB_REPOSITORY is not set");
  const [owner, repoName] = repo.split("/");
  const event = JSON.parse(readFileSync(eventPath, "utf8"));
  const prNumber = await resolvePrNumber(event);
  if (!Number.isSafeInteger(prNumber)) {
    throw new Error("could not determine the PR number from this event (not a pull_request, pull_request_review, or merge_group event)");
  }
  const pull = await fetchPullRequest({ owner, repo: repoName, pullNumber: prNumber, token });
  const reviews = await fetchPullReviews({ owner, repo: repoName, pullNumber: prNumber, token });
  return { pr: pull.number, verdict: verdictFromReviews({ reviews, headSha: pull.headSha }) };
}

function checkFixture(args) {
  const file = option(args, "--reviews");
  const head = option(args, "--head");
  if (!file) throw new Error("--reviews <file.json> is required for fixture mode");
  if (!head) throw new Error("--head <sha> is required for fixture mode");
  const reviews = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(reviews)) throw new Error("fixture reviews must be an array");
  return { pr: option(args, "--pr") ?? "?", verdict: verdictFromReviews({ reviews, headSha: head }) };
}

async function main() {
  const [verb, ...args] = process.argv.slice(2);
  if (verb !== "check") throw new Error("usage: mergehold-gate.mjs check [--reviews file.json --head sha]");
  const { pr, verdict } = option(args, "--reviews") ? checkFixture(args) : await checkLive();
  process.stdout.write(reportVerdict(verdict, { pr }) + "\n");
  if (!verdict.ok) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch(error => { console.error(`mergehold-gate: ERROR — ${error.message}`); process.exitCode = 1; });
}
