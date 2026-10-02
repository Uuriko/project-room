// Poll linked pull requests and settle the claims that carry them.
//
// No inbound GitHub webhook is mounted (server/land-queue.mjs). The per-minute
// cron and POST /work-claims/sweep poll instead. applyPullRequestWebhook is
// the same settlement a pull_request webhook would call.
//
// Unauthenticated GitHub allows 60 requests an hour per IP, and Workers share
// that IP. The tick therefore:
//   - polls only live claims whose pull has no outcome yet
//   - sends If-None-Match when it has an ETag (a 304 is not a billed request)
//   - looks up at most one pull per tick without a token, four with one
//   - waits out 403/429 until x-ratelimit-reset or retry-after
//   - reads at most 32 candidate rows and refuses a body over 64 KiB
//   - stops before the next lookup once `deadline` has passed, and aborts
//     the in-flight request at the sooner of 5s and the time remaining
// The token (GITHUB_TOKEN or GH_TOKEN) is never logged or stored. Public
// repositories still answer when it is absent.
import { emitWorkClaimEvent, enqueueClaimWake } from "./work-claim-events.mjs";
import { closeWhenLive, notePullMerged, recordCi } from "./work-claims.mjs";
import { SOURCE_REVISION } from "./version.mjs";
import {
  PULL_CANDIDATE_CAP, PULL_MISSING_BACKOFF_MS, holdForRateLimit, nextPullBackoff,
  pullRequestDue, pullRequestOutcomeFromApi, pullRequestOutcomeFromWebhook,
  rateLimitUntil, rememberPoll, rollupClaimCi, settlePullRequest, usableEtag
} from "./claim-coordination.mjs";

const LOOKUP_LIMIT = 4;
const LOOKUP_LIMIT_NO_TOKEN = 1;
const MAX_BODY_CHARS = 65_536;
// Not a room id (room ids start with a letter or digit). One row remembers
// the shared GitHub reset so the next tick does not call GitHub at all.
const BUDGET_ROOM = "_claim-pr-budget";

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

function responseHeader(response, name) {
  const headers = response?.headers;
  if (!headers) return null;
  if (typeof headers.get === "function") {
    const value = headers.get(name);
    return value == null ? null : String(value);
  }
  const found = Object.keys(headers).find(key => key.toLowerCase() === name.toLowerCase());
  if (!found || headers[found] == null) return null;
  return String(headers[found]);
}

async function readJson(response) {
  const length = responseHeader(response, "content-length");
  if (length && /^\d+$/.test(length) && Number(length) > MAX_BODY_CHARS) return { error: true };
  try {
    if (typeof response.text === "function") {
      const text = await response.text();
      if (text.length > MAX_BODY_CHARS) return { error: true };
      return { body: JSON.parse(text) };
    }
    if (typeof response.json === "function") return { body: await response.json() };
  } catch { /* unreadable body */ }
  return { error: true };
}

async function lookupPull(pullRequest, { fetchImpl, token, nowMs, deadline = Infinity }) {
  const [owner, name] = pullRequest.repo.split("/");
  const endpoint = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${pullRequest.number}`;
  const headers = githubHeaders(token);
  const cached = usableEtag(pullRequest.etag);
  if (cached) headers["If-None-Match"] = cached;
  const budgetMs = deadline - Date.now();
  if (budgetMs <= 0) return { kind: "budget" };
  let response;
  try {
    response = await fetchImpl(endpoint, { headers, signal: AbortSignal.timeout(Math.min(5000, budgetMs)) });
  } catch {
    if (Date.now() > deadline) return { kind: "budget" };
    return { kind: "error" };
  }
  const etag = usableEtag(responseHeader(response, "etag")) || cached;
  if (response.status === 304) return { kind: "notModified", etag };
  if (response.status === 404) return { kind: "missing", etag };
  if (response.status === 401) return { kind: "unconfigured" };
  if (response.status === 403 || response.status === 429) {
    let message = "";
    const remaining = responseHeader(response, "x-ratelimit-remaining");
    if (response.status === 403 && remaining !== "0") {
      const read = await readJson(response);
      message = typeof read.body?.message === "string" ? read.body.message : "";
    }
    const until = rateLimitUntil({
      status: response.status,
      remaining,
      reset: responseHeader(response, "x-ratelimit-reset"),
      retryAfter: responseHeader(response, "retry-after"),
      message
    }, nowMs);
    if (until) return { kind: "rateLimited", rateLimitedUntil: until, etag };
    if (!token) return { kind: "unconfigured" };
    return { kind: "error" };
  }
  if (!response.ok) return { kind: "error" };
  const read = await readJson(response);
  if (read.error) return { kind: "error", etag };
  const outcome = pullRequestOutcomeFromApi(read.body);
  const headSha = typeof read.body?.head?.sha === "string" && /^[0-9a-f]{40}$/.test(read.body.head.sha) ? read.body.head.sha : null;
  const mergedSha = read.body?.merged === true && typeof read.body?.merge_commit_sha === "string" && /^[0-9a-f]{40}$/.test(read.body.merge_commit_sha)
    ? read.body.merge_commit_sha : null;
  return outcome === "open"
    ? { kind: "open", etag, headSha }
    : { kind: outcome, etag, headSha, mergedSha };
}

const SHA = /^[0-9a-f]{40}$/;

function rateLimitResult(response, token, nowMs) {
  const message = "";
  const remaining = responseHeader(response, "x-ratelimit-remaining");
  const until = rateLimitUntil({
    status: response.status,
    remaining,
    reset: responseHeader(response, "x-ratelimit-reset"),
    retryAfter: responseHeader(response, "retry-after"),
    message
  }, nowMs);
  if (until) return { kind: "rateLimited", rateLimitedUntil: until };
  if (!token) return { kind: "unconfigured" };
  return { kind: "error" };
}

// One signal endpoint (combined status or check runs). Counts as one request.
async function fetchCommitDocument(url, { fetchImpl, token, nowMs, deadline = Infinity }) {
  const budgetMs = deadline - Date.now();
  if (budgetMs <= 0) return { kind: "budget" };
  let response;
  try {
    response = await fetchImpl(url, { headers: githubHeaders(token), signal: AbortSignal.timeout(Math.min(5000, budgetMs)) });
  } catch {
    if (Date.now() > deadline) return { kind: "budget" };
    return { kind: "error" };
  }
  if (response.status === 403 || response.status === 429) return rateLimitResult(response, token, nowMs);
  if (!response.ok) return { kind: "error" };
  const read = await readJson(response);
  if (read.error) return { kind: "error" };
  return { kind: "ok", body: read.body };
}

// Combined commit status, then check runs, inside the calls still left in
// this tick. A missing call leaves the cursor where the next tick continues.
async function readCommitCi(pullRequest, headSha, { fetchImpl, token, nowMs, budget, deadline = Infinity }) {
  const [owner, name] = pullRequest.repo.split("/");
  const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commits/${headSha}`;
  let status = null;
  let checkRuns = [];
  let cursor = pullRequest.ciCursor === "checks" ? "checks" : "status";
  if (cursor === "status") {
    if (budget.remaining <= 0 || Date.now() > deadline) return { cursor, partial: true, budget: Date.now() > deadline };
    budget.remaining -= 1;
    const read = await fetchCommitDocument(`${base}/status`, { fetchImpl, token, nowMs, deadline });
    if (read.kind === "budget") return { cursor, partial: true, budget: true, status };
    if (read.kind === "rateLimited" || read.kind === "unconfigured") return read;
    if (read.kind === "ok") status = read.body;
    cursor = "checks";
  }
  if (cursor === "checks") {
    if (budget.remaining <= 0 || Date.now() > deadline) return { cursor, partial: true, status, budget: Date.now() > deadline };
    budget.remaining -= 1;
    const read = await fetchCommitDocument(`${base}/check-runs`, { fetchImpl, token, nowMs, deadline });
    if (read.kind === "budget") return { cursor, partial: true, budget: true, status };
    if (read.kind === "rateLimited" || read.kind === "unconfigured") return { ...read, status, cursor };
    if (read.kind === "ok") checkRuns = Array.isArray(read.body?.check_runs) ? read.body.check_runs : [];
    cursor = "done";
  }
  const rollup = rollupClaimCi({ status, checkRuns, pullUrl: pullRequest.url });
  return { cursor, ci: { state: rollup.state, url: rollup.url, headSha } };
}

function delayFor(item, kind, token) {
  if (kind === "missing") return PULL_MISSING_BACKOFF_MS;
  return nextPullBackoff(item?.pullRequest?.pollBackoffMs, Boolean(token));
}

// Look up due claims. Pull, combined status, and check runs share one request
// budget (one call without a token, four with one). A claim whose status
// read is unfinished stays due so the next tick spends the budget there.
// Stops on a rate limit, a rejected token, or the cron deadline. Does not write.
export async function collectPullRequestLookups(items, { fetchImpl = fetch, token = null, nowMs = Date.now(), limit = null, deadline = Infinity, yieldBetween = null } = {}) {
  const budget = { remaining: limit ?? (token ? LOOKUP_LIMIT : LOOKUP_LIMIT_NO_TOKEN) };
  const due = (items ?? []).filter(item => pullRequestDue(item, nowMs) || ciReadDue(item, nowMs));
  const results = [];
  const seen = new Map();
  let rateLimitedUntil = null;
  let budgetExceeded = false;
  for (const item of due) {
    const url = item.pullRequest.url;
    const prior = seen.get(url);
    if (prior) {
      results.push({ ...prior, claimId: item.id });
      continue;
    }
    if (budget.remaining <= 0 || rateLimitedUntil) break;
    if (Date.now() > deadline) { budgetExceeded = true; break; }
    const continuing = (item.pullRequest.ciCursor === "status" || item.pullRequest.ciCursor === "checks") && SHA.test(item.ci?.headSha ?? "");
    let looked;
    if (continuing) {
      looked = { kind: "open", etag: item.pullRequest.etag, headSha: item.ci.headSha, continued: true };
    } else {
      budget.remaining -= 1;
      looked = await lookupPull(item.pullRequest, { fetchImpl, token, nowMs, deadline });
      if (looked.kind === "budget") { budgetExceeded = true; break; }
    }
    if (looked.kind === "open" && SHA.test(looked.headSha ?? "") && looked.kind !== "rateLimited") {
      const signals = await readCommitCi(
        { ...item.pullRequest, ciCursor: continuing ? item.pullRequest.ciCursor : "status" },
        looked.headSha,
        { fetchImpl, token, nowMs, budget, deadline }
      );
      if (signals.budget) budgetExceeded = true;
      if (signals.kind === "rateLimited") {
        looked = { ...looked, kind: "rateLimited", rateLimitedUntil: signals.rateLimitedUntil, ciCursor: signals.cursor };
      } else if (signals.kind === "unconfigured") {
        looked = { ...looked, kind: "unconfigured" };
      } else if (signals.ci) {
        looked = { ...looked, ci: signals.ci, ciCursor: signals.cursor };
      } else if (signals.cursor) {
        looked = { ...looked, ciCursor: signals.cursor };
      }
      if (signals.budget) {
        const result = {
          claimId: item.id, url,
          delayMs: looked.ciCursor && looked.ciCursor !== "done" ? 0 : delayFor(item, looked.kind, token),
          ...looked
        };
        seen.set(url, result);
        results.push(result);
        break;
      }
    }
    const result = {
      claimId: item.id,
      url,
      delayMs: looked.ciCursor && looked.ciCursor !== "done" ? 0 : delayFor(item, looked.kind, token),
      ...looked
    };
    seen.set(url, result);
    results.push(result);
    if (typeof yieldBetween === "function") await yieldBetween();
    if (looked.kind === "rateLimited") {
      rateLimitedUntil = looked.rateLimitedUntil;
      break;
    }
    if (looked.kind === "unconfigured") break;
  }
  return { results, rateLimitedUntil, budgetExceeded };
}

function ciReadDue(item, nowMs) {
  const pull = item?.pullRequest;
  if (!["claimed", "in_progress", "blocked"].includes(item?.state)) return false;
  if (!pull?.url || pull.outcome) return false;
  if (pull.ciCursor !== "status" && pull.ciCursor !== "checks") return false;
  if (Number.isFinite(pull.rateLimitedUntil) && pull.rateLimitedUntil > nowMs) return false;
  return true;
}

// Write one lookup onto the current claim row. Returns true when the claim
// was settled (completed or released). A rate limit is not written here;
// the caller holds every due claim until the reset.
export function commitPullRequestLookup(store, registry, roomId, item, result, nowMs) {
  if (!item?.pullRequest || item.pullRequest.url !== result.url || item.pullRequest.outcome) return false;
  if (result.kind === "merged" && (item.kind === "land" || item.kind === "deploy")) {
    const noted = notePullMerged(item, result.mergedSha, nowMs);
    if (!noted) return false;
    registry.set(roomId, noted);
    return false;
  }
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
  if (result.kind === "open" || result.kind === "notModified" || result.kind === "missing" || result.kind === "error" || result.kind === "unconfigured") {
    let next = item;
    let changed = false;
    if (result.ci) {
      const recorded = recordCi(next, { ...result.ci, checkedAt: new Date(nowMs).toISOString() }, nowMs);
      next = recorded.item;
      changed = recorded.changed;
    }
    if (result.ciCursor) {
      next = { ...next, pullRequest: { ...next.pullRequest, ciCursor: result.ciCursor } };
    }
    const delay = result.ciCursor && result.ciCursor !== "done"
      ? 0
      : (result.kind === "missing" ? PULL_MISSING_BACKOFF_MS : (result.delayMs ?? nextPullBackoff(item.pullRequest.pollBackoffMs, false)));
    const stored = rememberPoll(next, nowMs, delay, { etag: result.etag });
    registry.set(roomId, stored);
    if (changed) {
      emitWorkClaimEvent(store, roomId, {
        actorId: item.owner ?? "system",
        item: stored,
        action: "ci_changed",
        atMs: nowMs,
        reason: "ci_changed",
        ciState: result.ci.state
      });
      if (result.ci.state === "success" || result.ci.state === "failure") {
        enqueueClaimWake(store, roomId, item.owner, `work-claim:${item.id}:ci:${result.ci.state}:${result.ci.headSha ?? "none"}`);
      }
    }
    return changed;
  }
  return false;
}

export function readClaimPullBudget(store) {
  if (!store?.db || typeof store.db.prepare !== "function") return 0;
  try {
    const row = store.db.prepare("SELECT config_json FROM work_claim_config WHERE room_id=?").get(BUDGET_ROOM);
    if (!row) return 0;
    const parsed = JSON.parse(row.config_json);
    const until = Number(parsed?.rateLimitedUntil);
    return Number.isFinite(until) ? until : 0;
  } catch {
    return 0;
  }
}

export function writeClaimPullBudget(store, until, nowMs) {
  if (!store?.db || typeof store.db.prepare !== "function" || !Number.isFinite(until)) return;
  store.db.prepare(`INSERT INTO work_claim_config(room_id, config_json, updated_at) VALUES(?,?,?)
    ON CONFLICT(room_id) DO UPDATE SET config_json=excluded.config_json, updated_at=excluded.updated_at`)
    .run(BUDGET_ROOM, JSON.stringify({ rateLimitedUntil: until }), nowMs);
}

function holdDue(registry, roomId, items, until, nowMs) {
  for (const item of items) {
    const current = registry.get(roomId, item.id);
    if (!current?.pullRequest?.url || current.pullRequest.outcome) continue;
    if (!["claimed", "in_progress", "blocked"].includes(current.state)) continue;
    registry.set(roomId, holdForRateLimit(current, nowMs, until));
  }
}

// Live claims with an unsettled pull. SQL keeps the tick off the rest of the
// registry. The cap is the CPU bound: at most 32 rows are decoded.
function loadDueClaims(store, nowMs) {
  let rows = [];
  try {
    rows = store.db.prepare(`
      SELECT room_id AS roomId, claim_id AS claimId
      FROM work_claims
      WHERE (
        json_extract(item_json, '$.data.state') IN ('claimed', 'in_progress', 'blocked')
        AND typeof(json_extract(item_json, '$.data.pullRequest.url')) = 'text'
        AND json_extract(item_json, '$.data.pullRequest.outcome') IS NULL
        AND (json_extract(item_json, '$.data.pullRequest.nextPollAt') IS NULL
             OR json_extract(item_json, '$.data.pullRequest.nextPollAt') <= ?)
        AND (json_extract(item_json, '$.data.pullRequest.rateLimitedUntil') IS NULL
             OR json_extract(item_json, '$.data.pullRequest.rateLimitedUntil') <= ?)
      ) OR (
        json_extract(item_json, '$.state') IN ('claimed', 'in_progress', 'blocked')
        AND typeof(json_extract(item_json, '$.pullRequest.url')) = 'text'
        AND json_extract(item_json, '$.pullRequest.outcome') IS NULL
        AND (json_extract(item_json, '$.pullRequest.nextPollAt') IS NULL
             OR json_extract(item_json, '$.pullRequest.nextPollAt') <= ?)
        AND (json_extract(item_json, '$.pullRequest.rateLimitedUntil') IS NULL
             OR json_extract(item_json, '$.pullRequest.rateLimitedUntil') <= ?)
      )
      ORDER BY COALESCE(
        json_extract(item_json, '$.data.pullRequest.nextPollAt'),
        json_extract(item_json, '$.pullRequest.nextPollAt'),
        0
      ) ASC
      LIMIT ?
    `).all(nowMs, nowMs, nowMs, nowMs, PULL_CANDIDATE_CAP);
  } catch (error) {
    if (/no such table/i.test(error?.message ?? "")) return [];
    throw error;
  }
  const due = [];
  for (const row of rows) {
    const item = store.workClaims.get(row.roomId, row.claimId);
    if (pullRequestDue(item, nowMs)) due.push({ roomId: row.roomId, item });
  }
  return due;
}

// Poll every room that has an open pull link. A shared reset skips the tick
// before any request. A missing token does not fail the tick.
export async function syncClaimPullRequests(store, { env = null, fetchImpl = fetch, nowMs = Date.now(), token = undefined, deadline = Infinity, yieldBetween = null } = {}) {
  if (!store?.db || !store.workClaims) return { checked: 0, updated: 0 };
  closeDeployedClaims(store, nowMs);
  const access = token === undefined ? githubToken(env ?? process.env) : token;
  if (Date.now() > deadline) return { checked: 0, updated: 0, budgetExceeded: 1 };
  if (readClaimPullBudget(store) > nowMs) return { checked: 0, updated: 0, rateLimited: true };
  const due = loadDueClaims(store, nowMs);
  if (due.length === 0) return { checked: 0, updated: 0 };
  const batch = await collectPullRequestLookups(due.map(entry => entry.item), {
    fetchImpl, token: access, nowMs, deadline, yieldBetween
  });
  const roomOf = new Map(due.map(entry => [entry.item.id, entry.roomId]));
  let checked = 0;
  let updated = 0;
  const rateLimited = batch.rateLimitedUntil != null;
  store.workClaims.transaction(() => {
    for (const result of batch.results) {
      if (result.kind === "rateLimited") continue;
      const roomId = roomOf.get(result.claimId);
      const current = store.workClaims.get(roomId, result.claimId);
      checked += 1;
      if (commitPullRequestLookup(store, store.workClaims, roomId, current, result, nowMs)) updated += 1;
    }
    if (batch.rateLimitedUntil) {
      const byRoom = new Map();
      for (const entry of due) {
        const list = byRoom.get(entry.roomId) ?? [];
        list.push(entry.item);
        byRoom.set(entry.roomId, list);
      }
      for (const [roomId, items] of byRoom) holdDue(store.workClaims, roomId, items, batch.rateLimitedUntil, nowMs);
      writeClaimPullBudget(store, batch.rateLimitedUntil, nowMs);
    }
  });
  return { checked, updated, ...(rateLimited ? { rateLimited: true } : {}), ...(batch.budgetExceeded ? { budgetExceeded: 1 } : {}) };
}

function closeDeployedClaims(store, nowMs) {
  let roomIds = [];
  try {
    roomIds = store.db.prepare("SELECT DISTINCT room_id AS roomId FROM work_claims").all().map(row => row.roomId);
  } catch (error) {
    if (/no such table/i.test(error?.message ?? "")) return;
    throw error;
  }
  for (const roomId of roomIds) {
    for (const item of store.workClaims.list(roomId)) {
      const closed = closeWhenLive(item, SOURCE_REVISION, nowMs);
      if (!closed) continue;
      store.workClaims.set(roomId, closed);
      emitWorkClaimEvent(store, roomId, {
        actorId: item.owner ?? "system", item: closed, action: "state_changed", atMs: nowMs
      });
    }
  }
}

// Settle every live claim linked to a closing pull_request webhook payload.
export function applyPullRequestWebhook(store, payload, { nowMs = Date.now() } = {}) {
  const decision = pullRequestOutcomeFromWebhook(payload);
  if (!decision || !store?.db || !store.workClaims) return { applied: [] };
  const applied = [];
  let roomIds = [];
  try {
    roomIds = store.db.prepare("SELECT DISTINCT room_id AS roomId FROM work_claims").all().map(row => row.roomId);
  } catch (error) {
    if (/no such table/i.test(error?.message ?? "")) return { applied: [] };
    throw error;
  }
  for (const roomId of roomIds) {
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

const MAIN_ROOM = "_claim-main-head";

function readMainCache(store) {
  if (!store?.db || typeof store.db.prepare !== "function") return null;
  try {
    const row = store.db.prepare("SELECT config_json FROM work_claim_config WHERE room_id=?").get(MAIN_ROOM);
    if (!row) return null;
    const parsed = JSON.parse(row.config_json);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeMainCache(store, value, nowMs) {
  if (!store?.db || typeof store.db.prepare !== "function") return;
  store.db.prepare(`INSERT INTO work_claim_config(room_id, config_json, updated_at) VALUES(?,?,?)
    ON CONFLICT(room_id) DO UPDATE SET config_json=excluded.config_json, updated_at=excluded.updated_at`)
    .run(MAIN_ROOM, JSON.stringify(value), nowMs);
}

// Live revision against the last known GitHub main head. One commits/main
// read, inside the same rate-limit hold as pull polling. behind is 0 when
// the two shas match, and null when this server is unstamped or the compare
// is not known yet.
export async function readRoomDeployStatus(store, { fetchImpl = fetch, token = null, nowMs = Date.now(), repo = null } = {}) {
  const live = SOURCE_REVISION;
  const cached = readMainCache(store);
  const fallback = {
    live,
    main: typeof cached?.sha === "string" ? cached.sha : null,
    behind: Number.isInteger(cached?.behind) ? cached.behind : null,
    checkedAt: typeof cached?.checkedAt === "string" ? cached.checkedAt : null
  };
  if (readClaimPullBudget(store) > nowMs) return fallback;
  const repository = repo || process.env.GITHUB_REPOSITORY || "Uuriko/project-room";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) return fallback;
  const [owner, name] = repository.split("/");
  let response;
  try {
    response = await fetchImpl(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commits/main`,
      { headers: githubHeaders(token), signal: AbortSignal.timeout(5000) }
    );
  } catch {
    return fallback;
  }
  if (response.status === 403 || response.status === 429) {
    const limited = rateLimitResult(response, token, nowMs);
    if (limited.rateLimitedUntil) writeClaimPullBudget(store, limited.rateLimitedUntil, nowMs);
    return fallback;
  }
  if (!response.ok) return { live, main: fallback.main, behind: fallback.behind, checkedAt: new Date(nowMs).toISOString() };
  const read = await readJson(response);
  const sha = typeof read.body?.sha === "string" && SHA.test(read.body.sha) ? read.body.sha : null;
  const behind = sha && live === sha ? 0 : null;
  const checkedAt = new Date(nowMs).toISOString();
  const next = { sha, behind, checkedAt };
  writeMainCache(store, next, nowMs);
  return { live, main: sha, behind, checkedAt };
}
