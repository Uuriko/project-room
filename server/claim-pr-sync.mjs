// Poll linked pull requests and settle the claims that carry them.
//
// No inbound GitHub webhook is mounted (server/land-queue.mjs). The per-minute
// cron and POST /work-claims/sweep poll instead. applyPullRequestWebhook is
// the same settlement a pull_request webhook would call, so a future receiver
// does not grow a second outcome rule. The token is never logged or stored.
import { emitWorkClaimEvent } from "./work-claim-events.mjs";
import {
  PULL_MISSING_BACKOFF_MS, PULL_POLL_BACKOFF_MS, pullRequestDue, pullRequestOutcomeFromApi,
  pullRequestOutcomeFromWebhook, rememberPoll, settlePullRequest
} from "./claim-coordination.mjs";

const LOOKUP_LIMIT = 4;
const LOOKUP_LIMIT_NO_TOKEN = 1;

function githubToken(env) {
  if (!env || typeof env !== "object") return null;
  for (const key of ["GITHUB_TOKEN", "GH_TOKEN"]) {
    const value = env[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function githubHeaders(token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "project-room-claim-pr",
    "X-GitHub-Api-Version": "2022-11-28"
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function lookupPull(pullRequest, { fetchImpl, token }) {
  const [owner, name] = pullRequest.repo.split("/");
  const endpoint = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${pullRequest.number}`;
  let response;
  try {
    response = await fetchImpl(endpoint, {
      headers: githubHeaders(token),
      signal: AbortSignal.timeout(5000)
    });
  } catch {
    return { kind: "error" };
  }
  if (response.status === 404) return { kind: "missing" };
  if (response.status === 401) return { kind: "unconfigured" };
  if (response.status === 403 || response.status === 429) return { kind: "rateLimited" };
  if (!response.ok) return { kind: "error" };
  let body;
  try { body = await response.json(); } catch { return { kind: "error" }; }
  const outcome = pullRequestOutcomeFromApi(body);
  return outcome === "open" ? { kind: "open" } : { kind: outcome };
}

// Look up due claims. Stops the batch on a rate limit or a missing token so
// one shared budget cannot be spent by a single room. Does not write.
export async function collectPullRequestLookups(items, { fetchImpl = fetch, token = null, nowMs = Date.now(), limit = null } = {}) {
  const cap = limit ?? (token ? LOOKUP_LIMIT : LOOKUP_LIMIT_NO_TOKEN);
  const due = (items ?? []).filter(item => pullRequestDue(item, nowMs)).slice(0, cap);
  const results = [];
  for (const item of due) {
    const looked = await lookupPull(item.pullRequest, { fetchImpl, token });
    results.push({ claimId: item.id, url: item.pullRequest.url, ...looked });
    if (looked.kind === "rateLimited" || looked.kind === "unconfigured") break;
  }
  return results;
}

// Write one lookup onto the current claim row. Re-reads nothing; the caller
// passes the row it just loaded inside the claim transaction. Returns true
// when the claim was settled (completed or released).
export function commitPullRequestLookup(store, registry, roomId, item, result, nowMs) {
  if (!item?.pullRequest || item.pullRequest.url !== result.url || item.pullRequest.outcome) return false;
  if (result.kind === "merged" || result.kind === "closed") {
    const settled = settlePullRequest(item, result.kind, nowMs);
    if (!settled) return false;
    registry.set(roomId, settled.item);
    emitWorkClaimEvent(store, roomId, {
      actorId: settled.previousOwnerId ?? settled.item.owner ?? item.owner,
      item: settled.item,
      action: settled.action,
      previousOwnerId: settled.previousOwnerId,
      atMs: nowMs,
      paths: settled.paths,
      pullRequest: { url: item.pullRequest.url, outcome: result.kind }
    });
    return true;
  }
  if (result.kind === "open" || result.kind === "missing" || result.kind === "error") {
    const delay = result.kind === "missing" ? PULL_MISSING_BACKOFF_MS : PULL_POLL_BACKOFF_MS;
    registry.set(roomId, rememberPoll(item, nowMs, delay));
  }
  return false;
}

function roomIds(store) {
  try {
    return store.db.prepare("SELECT DISTINCT room_id AS roomId FROM work_claims").all().map(row => row.roomId);
  } catch (error) {
    if (/no such table/i.test(error?.message ?? "")) return [];
    throw error;
  }
}

// Poll every room that has claims. A missing token does not fail the tick;
// public repositories still answer, one at a time.
export async function syncClaimPullRequests(store, { env = null, fetchImpl = fetch, nowMs = Date.now(), token = undefined } = {}) {
  if (!store?.db || !store.workClaims) return { checked: 0, updated: 0 };
  const access = token === undefined ? githubToken(env ?? process.env) : token;
  let checked = 0;
  let updated = 0;
  let rateLimited = false;
  for (const roomId of roomIds(store)) {
    const lookups = await collectPullRequestLookups(store.workClaims.list(roomId), {
      fetchImpl, token: access, nowMs
    });
    if (lookups.length === 0) continue;
    const wrote = store.workClaims.transaction(() => {
      let settled = 0;
      for (const result of lookups) {
        if (result.kind === "rateLimited" || result.kind === "unconfigured") {
          rateLimited = result.kind === "rateLimited";
          continue;
        }
        const current = store.workClaims.get(roomId, result.claimId);
        checked += 1;
        if (commitPullRequestLookup(store, store.workClaims, roomId, current, result, nowMs)) settled += 1;
      }
      return settled;
    });
    updated += wrote;
    if (rateLimited) break;
  }
  return { checked, updated, ...(rateLimited ? { rateLimited: true } : {}) };
}

// Settle every live claim linked to a closing pull_request webhook payload.
export function applyPullRequestWebhook(store, payload, { nowMs = Date.now() } = {}) {
  const decision = pullRequestOutcomeFromWebhook(payload);
  if (!decision || !store?.db || !store.workClaims) return { applied: [] };
  const applied = [];
  for (const roomId of roomIds(store)) {
    store.workClaims.transaction(() => {
      for (const item of store.workClaims.list(roomId)) {
        if (item.pullRequest?.url !== decision.url) continue;
        const settled = commitPullRequestLookup(store, store.workClaims, roomId, item, {
          claimId: item.id, url: decision.url, kind: decision.outcome
        }, nowMs);
        if (settled) applied.push({ roomId, claimId: item.id, outcome: decision.outcome });
      }
    });
  }
  return { applied };
}
