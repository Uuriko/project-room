#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { evaluateGithubReview, readGithubReviewRecipe } from "../client/github-review-recipe.mjs";

const requiredFields = "{repository:.base.repo.full_name,number,state,draft,merged,head:.head.sha}";

function github(args) {
  return JSON.parse(execFileSync("gh", ["api", "--hostname", "github.com", ...args], {
    timeout: 20000, maxBuffer: 2 * 1024 * 1024, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]
  }));
}

export function observeGithubPull(repository, number, read = github) {
  if (!Number.isSafeInteger(number) || number < 1) throw new Error("Choose a positive pull request number");
  const pull = [`repos/${repository}/pulls/${number}`, "--jq", requiredFields];
  const first = read(pull);
  if (first.repository?.toLowerCase() !== repository || first.number !== number || !/^[a-f0-9]{40}$/.test(first.head))
    throw new Error("GitHub pull request binding changed");
  const checks = first.state === "open" ? read([
    `repos/${repository}/commits/${first.head}/check-runs?filter=all&per_page=100`,
    "--paginate", "--slurp",
  ]).flatMap(page => page.check_runs.map(check => ({ id: check.id, name: check.name, app: check.app?.slug,
    head: check.head_sha, status: check.status, conclusion: check.conclusion }))) : [];
  if (checks.length > 3000) throw new Error("GitHub returned too many check runs for a bounded observation");
  const latest = read(pull);
  if (Object.keys(first).some(key => first[key] !== latest[key])) throw new Error("Pull request changed during observation; retry");
  return { ...latest, checks, observedAt: Date.now() };
}


// Delivery data selects a candidate to refresh. GitHub's current API read,
// not the delivery body, supplies the head and check evidence.
export function githubEventAffectsPull(recipe, number, kind, payload) {
  const repository = payload?.repository?.full_name;
  if (typeof repository !== "string" || repository.toLowerCase() !== recipe.repository) return false;
  if (kind === "pull_request" || kind === "pull_request_review") return payload.pull_request?.number === number;
  const source = kind === "check_run" ? payload.check_run : kind === "check_suite" ? payload.check_suite : null;
  return Array.isArray(source?.pull_requests) && source.pull_requests.some(pr => pr?.number === number);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const [configuration, pullNumber, ...arguments_] = process.argv.slice(2);
    const eventIndex = arguments_.indexOf("--event");
    const delivery = eventIndex === -1 ? [] : arguments_.splice(eventIndex);
    if (!configuration || !/^\d+$/.test(pullNumber ?? "") || arguments_.length > 1 || delivery.length && delivery.length !== 3)
      throw new Error("Usage: node scripts/github-review-recipe.mjs <recipe.json> <PR number> [previous decision.json] [--event <kind> <delivery.json>]");
    const [previousFile] = arguments_, [, kind, eventFile] = delivery;
    const recipe = readGithubReviewRecipe(JSON.parse(readFileSync(configuration, "utf8")));
    const prior = previousFile ? JSON.parse(readFileSync(previousFile, "utf8")).checkpoint : null;
    const number = Number(pullNumber);
    const relevant = !recipe || !kind || githubEventAffectsPull(recipe, number, kind, JSON.parse(readFileSync(eventFile, "utf8")));
    const decision = relevant ? evaluateGithubReview(recipe, recipe ? observeGithubPull(recipe.repository, number) : null, prior)
      : { action: "ignored", reason: "unrelated_delivery", checkpoint: prior };
    console.log(JSON.stringify(decision));
  } catch (error) {
    console.error(error.code === "ENOENT" ? "A recipe file or the GitHub CLI is missing" : error.message);
    process.exitCode = 1;
  }
}
