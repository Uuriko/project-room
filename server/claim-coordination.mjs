// Room-native claim coordination: exclusive file leases, dependency readiness,
// and the pull-request outcome a claim settles on.
//
// There is no inbound GitHub webhook receiver in this service (see
// server/land-queue.mjs). A closed pull_request webhook payload and a polled
// pull API body both reduce to the same outcome, and the scheduled tick polls.
// This module does no I/O.

const LIVE_CLAIM_STATES = new Set(["claimed", "in_progress", "blocked"]);
const PULL_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9]\d{0,9})$/;

export const PULL_POLL_BACKOFF_MS = 60_000;
export const PULL_MISSING_BACKOFF_MS = 60 * 60_000;

// Canonical https://github.com/{owner}/{repo}/pull/{number}. Query strings,
// fragments, and credentials are refused so a lease cannot point at a tracker.
export function parsePullRequestUrl(value) {
  if (typeof value !== "string" || value.length > 300) return null;
  let url;
  try { url = new URL(value.trim()); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
  if (url.hostname !== "github.com") return null;
  const path = url.pathname.length > 1 && url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  const match = PULL_URL.exec(`https://github.com${path}`);
  if (!match) return null;
  const [, owner, repo, number] = match;
  return Object.freeze({
    url: `https://github.com/${owner}/${repo}/pull/${number}`,
    repo: `${owner}/${repo}`,
    number: Number(number)
  });
}

// GitHub pull_request webhook: only a close settles a claim. merged completes
// it; a close without a merge releases it. Every other action is ignored.
export function pullRequestOutcomeFromWebhook(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  if (payload.action !== "closed") return null;
  const pull = payload.pull_request;
  if (!pull || typeof pull !== "object" || Array.isArray(pull)) return null;
  const parsed = parsePullRequestUrl(pull.html_url);
  if (!parsed) return null;
  return Object.freeze({ ...parsed, outcome: pull.merged === true ? "merged" : "closed" });
}

// Polled GET /repos/{owner}/{repo}/pulls/{n} body. An open pull settles nothing.
export function pullRequestOutcomeFromApi(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "open";
  if (body.merged === true) return "merged";
  if (body.state === "closed") return "closed";
  return "open";
}

const stamp = (atMs, agentId, action, note) => Object.freeze({
  at: new Date(atMs).toISOString(), agentId, action, note
});

// Apply a merged or closed outcome to a live claim. Merged completes the claim
// (deliveryMode merged). Closed releases it the same way a holder release does:
// owner, lease, files, and attestations clear so the files can be claimed again.
// Returns null when the claim is not live or already settled.
export function settlePullRequest(item, outcome, nowMs) {
  if (!item?.pullRequest || item.pullRequest.outcome) return null;
  if (!LIVE_CLAIM_STATES.has(item.state)) return null;
  if (outcome !== "merged" && outcome !== "closed") return null;
  const at = new Date(nowMs).toISOString();
  const pullRequest = Object.freeze({
    ...item.pullRequest, outcome, syncedAt: at, nextPollAt: null
  });
  const agentId = item.owner ?? "system";
  if (outcome === "merged") {
    const note = `pull request merged: ${item.pullRequest.url}`;
    return {
      action: "pr_merged",
      previousOwnerId: null,
      paths: [...(item.files ?? [])],
      item: {
        ...item,
        state: "done",
        deliveryMode: "merged",
        pullRequest,
        history: Object.freeze([...(item.history ?? []), stamp(nowMs, agentId, "pr_merged", note)])
      }
    };
  }
  const note = `pull request closed: ${item.pullRequest.url}`;
  return {
    action: "pr_closed",
    previousOwnerId: item.owner ?? null,
    paths: [...(item.files ?? [])],
    item: {
      ...item,
      state: "unclaimed",
      owner: null,
      leaseStartAt: null,
      leaseExpiresAt: null,
      files: Object.freeze([]),
      attestations: Object.freeze([]),
      pullRequest,
      history: Object.freeze([...(item.history ?? []), stamp(nowMs, agentId, "pr_closed", note)])
    }
  };
}

// Remember a poll that did not settle the claim, so the next tick waits.
export function rememberPoll(item, nowMs, delayMs) {
  if (!item?.pullRequest) return item;
  return {
    ...item,
    pullRequest: Object.freeze({
      ...item.pullRequest,
      syncedAt: new Date(nowMs).toISOString(),
      nextPollAt: nowMs + delayMs
    })
  };
}

export function pullRequestDue(item, nowMs) {
  const pull = item?.pullRequest;
  if (!pull || pull.outcome) return false;
  if (!LIVE_CLAIM_STATES.has(item.state)) return false;
  return pull.nextPollAt == null || pull.nextPollAt <= nowMs;
}

// Live claims whose declared files intersect. One entry per holding claim.
// Paths are compared as already stored (the claim machine normalizes them).
export function fileLeaseConflicts(items, claimed) {
  const wanted = new Set(claimed?.files ?? []);
  if (wanted.size === 0) return [];
  const conflicts = [];
  for (const item of items ?? []) {
    if (!item || item.id === claimed.id || !LIVE_CLAIM_STATES.has(item.state)) continue;
    const files = [...new Set((item.files ?? []).filter(file => wanted.has(file)))].sort();
    if (files.length === 0) continue;
    conflicts.push(Object.freeze({
      holder: Object.freeze({ claimId: item.id, owner: item.owner ?? null }),
      files: Object.freeze(files),
      leaseExpiresAt: item.leaseExpiresAt ?? null
    }));
  }
  conflicts.sort((a, b) => (a.holder.claimId < b.holder.claimId ? -1 : a.holder.claimId > b.holder.claimId ? 1 : 0));
  return conflicts;
}

export function fileLeaseConflictBody(claimed, conflicts) {
  const first = conflicts[0];
  const files = [...new Set(conflicts.flatMap(conflict => conflict.files))].sort();
  const expiry = first.leaseExpiresAt ?? "no expiry";
  const message = `Work "${claimed.id}" overlaps files leased to ${first.holder.owner ?? "nobody"} (${first.holder.claimId}) until ${expiry}: ${files.join(", ")}`;
  return {
    error: { code: "file_lease_conflict", message },
    holder: first.holder,
    files,
    leaseExpiresAt: first.leaseExpiresAt ?? null,
    conflicts
  };
}

// Unheld claims whose dependencies are all done. A missing dependency is not
// done. An empty dependency list is ready: nobody is waiting on it.
export function readyClaims(items) {
  const byId = new Map((items ?? []).map(item => [item.id, item]));
  return (items ?? []).filter(item => {
    if (!item || item.state !== "unclaimed" || item.owner) return false;
    const deps = Array.isArray(item.dependsOn) ? item.dependsOn : [];
    return deps.every(id => byId.get(id)?.state === "done");
  }).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
