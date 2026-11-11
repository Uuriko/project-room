// Offline, read-only triage of a gh pr list JSON snapshot. Never merge/close.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function triagePull(pr, now = new Date()) {
  const labels = (pr.labels || []).map(label => typeof label === "string" ? label : label.name);
  const checks = (pr.statusCheckRollup || []).map(check => ({
    name: check.name || check.context || "unnamed",
    state: String(check.conclusion || check.state || check.status || "UNKNOWN").toUpperCase(),
    url: check.detailsUrl || check.targetUrl || null,
  }));
  const failed = checks.filter(check => ["FAILURE", "ERROR", "TIMED_OUT", "ACTION_REQUIRED", "CANCELLED"].includes(check.state));
  const pending = checks.filter(check => ["PENDING", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED"].includes(check.state));
  const ran = checks.filter(check => check.state === "SUCCESS" && !/NOTHING RAN/i.test(check.name));
  const testPassed = ran.some(check => check.name === "test");
  const checksObserved = Array.isArray(pr.statusCheckRollup);
  let queue = checksObserved ? "needs-ci" : "ci-unobserved";
  if (pr.isDraft) queue = "draft";
  else if (pr.mergeable === "CONFLICTING") queue = "needs-rebase";
  else if (failed.length) queue = "inspect-failures";
  else if (pending.length) queue = "ci-running";
  else if (testPassed && pr.mergeable === "MERGEABLE") queue = "needs-review";
  else if (testPassed) queue = "mergeability-unknown";
  const updated = Date.parse(pr.updatedAt);
  return {
    number: pr.number, title: pr.title, head: pr.headRefOid || null,
    url: pr.url || null, queue, labels,
    daysSinceUpdate: Number.isFinite(updated) ? Math.max(0, Math.floor((now.getTime() - updated) / 86400000)) : null,
    failed, pending,
    checksObserved, testAggregatePassed: checksObserved ? testPassed : null,
    reviewRequests: (pr.reviewRequests || []).map(request => request.login || request.name || request.slug || "unknown"),
    // A successful aggregate may represent affected tests only. Inspect logs.
    mergeAuthorized: false, closureAuthorized: false,
  };
}

export function buildReport(snapshot, { limit, now = new Date() } = {}) {
  if (!Array.isArray(snapshot)) throw new Error("Expected a gh pr list JSON array");
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Supply the positive --limit used for gh pr list");
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid observation time");
  const seen = new Set();
  for (const pr of snapshot) {
    if (!Number.isSafeInteger(pr.number) || pr.number < 1 || seen.has(pr.number)) throw new Error("Invalid or duplicate PR number");
    if (!/^[0-9a-f]{40}$/.test(pr.headRefOid || "")) throw new Error(`Missing exact head for PR ${pr.number}`);
    seen.add(pr.number);
  }
  const pulls = snapshot.map(pr => triagePull(pr, now)).sort((a, b) => a.number - b.number);
  return {
    generatedAt: now.toISOString(), observedCount: pulls.length,
    possiblyTruncated: snapshot.length >= limit,
    caveats: [
      "Snapshot only; re-read current head and checks before acting.",
      "No bucket authorizes merging or closing. Age never establishes supersession.",
      "Failed/cancelled duplicate runs are conservative review flags, not causal attribution.",
      "Successful test aggregate does not establish full-suite execution; inspect selected jobs.",
    ],
    counts: pulls.reduce((counts, pr) => ({ ...counts, [pr.queue]: (counts[pr.queue] || 0) + 1 }), {}),
    pulls,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [snapshotPath, flag, rawLimit, ...extra] = process.argv.slice(2);
  if (!snapshotPath || flag !== "--limit" || !rawLimit || extra.length) {
    console.error("Usage: node scripts/contributor-triage.mjs snapshot.json --limit 1000");
    process.exitCode = 1;
  } else {
    try {
      console.log(JSON.stringify(buildReport(JSON.parse(readFileSync(snapshotPath, "utf8")), { limit: Number(rawLimit) }), null, 2));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
