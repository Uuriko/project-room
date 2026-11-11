#!/usr/bin/env node
// Weekly pull-request hygiene, run by .github/workflows/pr-hygiene.yml.
//
//   node scripts/pr-hygiene.mjs            dry run, prints what it would do
//   node scripts/pr-hygiene.mjs --apply    labels and closes
//
// Rules (decide() below is the whole policy):
// - A PR idle for STALE_DAYS gets the `stale` label.
// - A maintainer-branch PR that already carries `stale`, has stayed idle for
//   another CLOSE_DAYS and conflicts with its base is closed with
//   `stale-closed`. The branch is kept, so reopening restores everything.
// - A pull request from a fork is never closed automatically. It gets `stale`
//   and one comment asking whether the author wants to continue.
// - `keep-open` exempts a PR from everything here.
// Labelling a PR updates it, so the close clock restarts at that point.

export const STALE_DAYS = 7;
export const CLOSE_DAYS = 7;

const DAY = 86_400_000;

export function decide(pr, { now = Date.now(), repo }) {
  const labels = new Set((pr.labels ?? []).map(label => label.name));
  if (labels.has("keep-open")) return { action: "skip", reason: "keep-open" };
  const idleDays = Math.floor((now - Date.parse(pr.updated_at)) / DAY);
  const fromFork = pr.head?.repo?.full_name !== repo;
  if (idleDays < STALE_DAYS) return { action: "skip", reason: "active" };
  if (!labels.has("stale")) return { action: fromFork ? "ask" : "label", reason: `idle ${idleDays}d` };
  if (fromFork) return { action: "skip", reason: "fork PRs are never auto-closed" };
  if (idleDays < CLOSE_DAYS) return { action: "skip", reason: "stale, waiting" };
  if (pr.mergeable !== false) return { action: "skip", reason: "stale but mergeable" };
  return { action: "close", reason: `stale, conflicting, idle ${idleDays}d` };
}

const ASK = "This pull request has been quiet for a week. If you still want it, push an update or reply here and a maintainer will pick it up. Nothing will be closed without a person deciding.";

async function main() {
  const apply = process.argv.includes("--apply");
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !token) throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN are required");
  const api = async (path, init = {}) => {
    const response = await fetch(`https://api.github.com/repos/${repo}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json", ...init.headers },
    });
    if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${response.status}`);
    return response.status === 204 ? null : response.json();
  };
  // Writes are paced to stay well under GitHub's content-creation limits.
  const pause = () => new Promise(resolve => setTimeout(resolve, 1500));
  const open = [];
  for (let page = 1; ; page++) {
    const batch = await api(`/pulls?state=open&per_page=100&page=${page}`);
    open.push(...batch);
    if (batch.length < 100) break;
  }
  const counts = {};
  for (const listed of open) {
    let pr = listed;
    let verdict = decide(pr, { repo });
    if (verdict.action === "skip" && verdict.reason === "stale but mergeable") {
      // The list endpoint omits mergeability; read the PR before deciding to close.
      pr = await api(`/pulls/${listed.number}`);
      verdict = decide(pr, { repo });
    }
    counts[verdict.action] = (counts[verdict.action] ?? 0) + 1;
    if (verdict.action === "skip") continue;
    console.log(`#${pr.number} ${verdict.action}: ${verdict.reason}`);
    if (!apply) continue;
    const labels = pr.labels.map(label => label.name);
    if (verdict.action === "label") await api(`/issues/${pr.number}/labels`, { method: "POST", body: JSON.stringify({ labels: ["stale"] }) });
    if (verdict.action === "ask") {
      await api(`/issues/${pr.number}/labels`, { method: "POST", body: JSON.stringify({ labels: ["stale"] }) });
      await api(`/issues/${pr.number}/comments`, { method: "POST", body: JSON.stringify({ body: ASK }) });
    }
    if (verdict.action === "close") {
      await api(`/issues/${pr.number}`, { method: "PATCH", body: JSON.stringify({ state: "closed", state_reason: "not_planned", labels: [...new Set([...labels, "stale-closed"])] }) });
    }
    await pause();
  }
  console.log(`${apply ? "applied" : "dry run"}: ${JSON.stringify(counts)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => { console.error(error.message); process.exit(1); });
}
