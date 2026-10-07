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
// Authenticated polls grow 1, 2, 4, 8, then 10 minutes. Unauthenticated
// GitHub allows 60 requests an hour per IP, and Workers share that IP with
// the land queue, so an unchanged pull waits 10 minutes (at most 6/hour).
const PULL_BACKOFF_STEPS_MS = Object.freeze([60_000, 120_000, 240_000, 480_000, 600_000]);
const PULL_BACKOFF_ANON_MS = 600_000;
export const PULL_CANDIDATE_CAP = 32;

export function nextPullBackoff(currentMs, token) {
  if (!token) return PULL_BACKOFF_ANON_MS;
  const current = Number(currentMs) || 0;
  for (const step of PULL_BACKOFF_STEPS_MS) {
    if (step > current) return step;
  }
  return PULL_BACKOFF_STEPS_MS[PULL_BACKOFF_STEPS_MS.length - 1];
}

// GitHub conditional requests use a short quoted token. Anything else is ignored.
export function usableEtag(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && /^[\x21-\x7E]+$/.test(value)
    ? value : null;
}

// x-ratelimit-reset is a UTC epoch in seconds. retry-after is a delta in
// seconds. A 403 counts only when the budget is exhausted or the message
// says so; a bare 403 is not a rate limit. A missing reset waits one minute
// so the tick does not hammer the same refusal.
export function rateLimitUntil({ status, remaining, reset, retryAfter, message } = {}, nowMs) {
  const limited = status === 429 || (status === 403 && (remaining === "0" || /rate limit/i.test(message ?? "")));
  if (!limited) return null;
  let until = null;
  if (typeof reset === "string" && /^\d+$/.test(reset.trim())) {
    const value = Number(reset.trim());
    until = value > 1e12 ? value : value * 1000;
  } else if (typeof retryAfter === "string" && /^\d+$/.test(retryAfter.trim())) {
    until = nowMs + Number(retryAfter.trim()) * 1000;
  }
  if (!until || until <= nowMs) until = nowMs + PULL_POLL_BACKOFF_MS;
  return until;
}

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
  if (!LIVE_CLAIM_STATES.has(item.state)) return null;
  if (!pullsReadyToSettle(item)) return null;
  if (outcome !== "merged" && outcome !== "closed") return null;
  const at = new Date(nowMs).toISOString();
  const links = pullLinks(item);
  // The settled record must name the PR the outcome was decided on: the
  // merged link when the batch settled merged (a later closed link must not
  // stand in for it), otherwise the last recorded link as before.
  const decided = outcome === "merged" ? links.find(pull => pull.outcome === "merged") ?? null : null;
  const current = decided ?? item.pullRequest ?? links.at(-1);
  const pullRequest = Object.freeze({
    ...current, outcome: current.outcome ?? outcome, syncedAt: current.syncedAt ?? at, nextPollAt: null, rateLimitedUntil: null
  });
  const agentId = item.owner ?? "system";
  if (outcome === "merged") {
    const note = `pull request merged: ${current.url}`;
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
  const note = `pull request closed: ${current.url}`;
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
      fileBlocks: Object.freeze({}),
      attestations: Object.freeze([]),
      reviews: Object.freeze([]),
      pullRequest,
      history: Object.freeze([...(item.history ?? []), stamp(nowMs, agentId, "pr_closed", note)])
    }
  };
}

// Remember a poll that did not settle the claim, so the next tick waits.
function withCurrentPull(item, pullRequest) {
  const pullRequests = Array.isArray(item.pullRequests) && item.pullRequests.length
    ? Object.freeze(item.pullRequests.map(entry => entry.url === pullRequest.url ? pullRequest : entry))
    : item.pullRequests;
  return { ...item, pullRequest, pullRequests };
}
export function rememberPoll(item, nowMs, delayMs, { etag, rateLimitedUntil = null } = {}) {
  if (!item?.pullRequest) return item;
  const previous = usableEtag(item.pullRequest.etag);
  return withCurrentPull(item, Object.freeze({
    ...item.pullRequest,
    syncedAt: new Date(nowMs).toISOString(),
    nextPollAt: nowMs + delayMs,
    pollBackoffMs: delayMs,
    etag: etag === undefined ? previous : usableEtag(etag),
    rateLimitedUntil
  }));
}

// Hold every still-open link until GitHub's reset. The stored ETag stays so
// the next poll can be a conditional request.
export function holdForRateLimit(item, nowMs, until) {
  if (!item?.pullRequest || item.pullRequest.outcome) return item;
  const scheduled = Number(item.pullRequest.nextPollAt);
  const nextPollAt = Number.isFinite(scheduled) ? Math.max(scheduled, until) : until;
  return withCurrentPull(item, Object.freeze({
    ...item.pullRequest,
    syncedAt: new Date(nowMs).toISOString(),
    nextPollAt,
    rateLimitedUntil: until
  }));
}

const RED_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out", "action_required"]);
const NEUTRAL_CONCLUSIONS = new Set(["neutral", "skipped"]);

// Combined commit status plus check runs, reduced to the claim's ci.state.
// A failure wins. Anything still running stays pending. All-success is
// success. Only neutral or skipped signals, or no signal at all, is neutral.
export function rollupClaimCi({ status = null, checkRuns = [], pullUrl = null } = {}) {
  let failure = false;
  let pending = false;
  let success = 0;
  for (const run of Array.isArray(checkRuns) ? checkRuns : []) {
    const conclusion = run?.conclusion ?? null;
    if (RED_CONCLUSIONS.has(conclusion)) failure = true;
    else if (conclusion === "success") success += 1;
    else if (NEUTRAL_CONCLUSIONS.has(conclusion)) continue;
    else pending = true;
  }
  const total = status && typeof status === "object" ? Number(status.total_count) : 0;
  if (Number.isFinite(total) && total > 0) {
    if (status.state === "failure" || status.state === "error") failure = true;
    else if (status.state === "success") success += 1;
    else pending = true;
  }
  let state = "neutral";
  if (failure) state = "failure";
  else if (pending) state = "pending";
  else if (success > 0) state = "success";
  const statuses = Array.isArray(status?.statuses) ? status.statuses : [];
  const target = statuses.find(entry => typeof entry?.target_url === "string" && entry.target_url.startsWith("https://"));
  const url = target?.target_url || (typeof pullUrl === "string" ? pullUrl : null);
  return { state, url };
}

export function pullRequestDue(item, nowMs) {
  const pull = item?.pullRequest;
  if (!pull?.url || pull.outcome) return false;
  if (!LIVE_CLAIM_STATES.has(item.state)) return false;
  if (Number.isFinite(pull.rateLimitedUntil) && pull.rateLimitedUntil > nowMs) return false;
  return pull.nextPollAt == null || pull.nextPollAt <= nowMs;
}

// Live claims whose declared files intersect. One entry per holding claim.
// Paths are compared as already stored (the claim machine normalizes them).
function fileSlots(item) {
  const blocks = item?.fileBlocks && typeof item.fileBlocks === "object" ? item.fileBlocks : {};
  return (item?.files ?? []).filter(file => typeof file === "string").map(path => ({
    path,
    block: typeof blocks[path] === "string" && blocks[path].length > 0 ? blocks[path] : null
  }));
}
function slotsConflict(left, right) {
  if (left.path !== right.path) return false;
  if (!left.block || !right.block) return true;
  return left.block === right.block;
}
function slotLabel(slot) {
  return slot.block ? `${slot.path} (${slot.block})` : slot.path;
}
export function pullLinks(item) {
  if (Array.isArray(item?.pullRequests) && item.pullRequests.length) return item.pullRequests;
  return item?.pullRequest?.url ? [item.pullRequest] : [];
}
export function recordPullOutcome(item, url, outcome, nowMs) {
  const at = new Date(nowMs).toISOString();
  const links = pullLinks(item).map(pull => pull.url === url
    ? Object.freeze({ ...pull, outcome, syncedAt: at, nextPollAt: null, rateLimitedUntil: null })
    : pull);
  const open = links.find(pull => !pull.outcome) ?? null;
  return {
    ...item,
    pullRequests: Object.freeze(links),
    pullRequest: Object.freeze({ ...(open ?? links[links.length - 1]) })
  };
}
export function pullsReadyToSettle(item) {
  const links = pullLinks(item);
  return links.length > 0 && links.every(pull => pull.outcome === "merged" || pull.outcome === "closed");
}
export function batchPullOutcome(item) {
  return pullLinks(item).some(pull => pull.outcome === "merged") ? "merged" : "closed";
}
export function fileLeaseConflicts(items, claimed) {
  const wanted = fileSlots(claimed);
  if (wanted.length === 0) return [];
  const conflicts = [];
  for (const item of items ?? []) {
    if (!item || item.id === claimed.id || !LIVE_CLAIM_STATES.has(item.state)) continue;
    const files = fileSlots(item).filter(held => wanted.some(slot => slotsConflict(slot, held))).map(slotLabel);
    const unique = [...new Set(files)].sort();
    if (unique.length === 0) continue;
    conflicts.push(Object.freeze({
      holder: Object.freeze({ claimId: item.id, owner: item.owner ?? null }),
      files: Object.freeze(unique),
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
