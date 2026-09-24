// Land queue: one list of pull requests per room, refreshed from GitHub so
// agents stop polling the forge while a PR lands.
//
// Any room member can add, list, or remove an item. The claimant defaults to
// the caller. There is no new permission rule.
//
// GitHub access reuses a token already present in the environment
// (GITHUB_TOKEN or GH_TOKEN). Public repositories answer without one. A 401,
// or a 403 that is not a rate limit when no token is set, is 503
// github_unconfigured. A 404 is pr_not_found and is not stored. The token is
// never logged and never copied onto an item or a room event.
//
// There is no inbound GitHub webhook receiver in this service. Refresh runs
// on the existing per-minute scheduled tick (cloudflare/room.mjs scheduled).
// With no token GitHub allows 60 requests an hour, so the tick is gentle:
// merged and closed items are not polled, an unchanged item waits 1, 2, 4,
// 8, then 10 minutes, and each read sends the cached ETag so a 304 is not a
// billed request. A 403 or 429 rate limit records rateLimitedUntil from the
// reset header and the tick skips until then. A missing token does not fail
// the tick. No new secret is added.

import { randomBytes, randomUUID } from "node:crypto";
import { ServiceError } from "./service-error.mjs";
import { event, EVENT_TYPES, applyEvent, validId } from "../src/events.js";

export const LAND_CHECKS = Object.freeze(["pending", "green", "red"]);
export const LAND_MERGEABLE = Object.freeze(["mergeable", "behind", "conflict", "unknown", "merged"]);
export const LAND_CHANGES = Object.freeze(["green", "red", "behind", "merged", "tip"]);
const MAX_ITEMS = 50;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const TIP_MAX = 200;
const TITLE_MAX = 300;
// 1, 2, 4, 8 minutes, then a 10 minute cap. The first look schedules the
// one-minute step; each unchanged look takes the next step.
export const POLL_BACKOFF_STEPS_MS = Object.freeze([60_000, 120_000, 240_000, 480_000, 600_000]);
const REFRESH_LIMIT = 4;
const REFRESH_LIMIT_NO_TOKEN = 1;
const CHECK_RUN_PAGE = 100;
const CHECK_RUN_PAGES = 3;
const RED_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out"]);
const IGNORED_CONCLUSIONS = new Set(["neutral", "skipped"]);

export const landQueueSchema = `
  CREATE TABLE IF NOT EXISTS land_queue (
    room_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    repo TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    claimant_member_id TEXT NOT NULL,
    added_by_member_id TEXT NOT NULL,
    title TEXT,
    head_sha TEXT,
    mergeable TEXT NOT NULL,
    behind INTEGER NOT NULL,
    checks_state TEXT NOT NULL,
    merged_sha TEXT,
    tip_source_revision TEXT,
    tip_build_id TEXT,
    last_error TEXT,
    observed INTEGER NOT NULL DEFAULT 0,
    closed INTEGER NOT NULL DEFAULT 0,
    next_poll_at INTEGER,
    backoff_ms INTEGER NOT NULL DEFAULT 60000,
    poll_etag TEXT,
    rate_limited_until INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, item_id),
    UNIQUE (room_id, repo, pr_number)
  );
  CREATE INDEX IF NOT EXISTS land_queue_due ON land_queue(updated_at);
`;

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };

// A queue created before the check-run poll has no poll columns. The
// statement above already includes them on a fresh database.
export function migrateLandQueueColumns(db) {
  const exists = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='land_queue'").get();
  if (!exists) return;
  const columns = new Set(db.prepare("SELECT name FROM pragma_table_info('land_queue')").all().map(row => row.name));
  if (!columns.has("closed")) db.exec("ALTER TABLE land_queue ADD COLUMN closed INTEGER NOT NULL DEFAULT 0");
  if (!columns.has("next_poll_at")) db.exec("ALTER TABLE land_queue ADD COLUMN next_poll_at INTEGER");
  if (!columns.has("backoff_ms")) db.exec("ALTER TABLE land_queue ADD COLUMN backoff_ms INTEGER NOT NULL DEFAULT 60000");
  if (!columns.has("poll_etag")) db.exec("ALTER TABLE land_queue ADD COLUMN poll_etag TEXT");
  if (!columns.has("rate_limited_until")) db.exec("ALTER TABLE land_queue ADD COLUMN rate_limited_until INTEGER");
}

export function nextPollBackoff(currentMs) {
  const current = Number(currentMs) || 0;
  for (const step of POLL_BACKOFF_STEPS_MS) {
    if (step > current) return step;
  }
  return POLL_BACKOFF_STEPS_MS[POLL_BACKOFF_STEPS_MS.length - 1];
}

export function githubAccessToken(env = {}) {
  if (!env || typeof env !== "object") return null;
  for (const key of ["GITHUB_TOKEN", "GH_TOKEN"]) {
    const value = env[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return null;
}

export function parseRepo(repo) {
  if (typeof repo !== "string" || !REPO_PATTERN.test(repo) || repo.length > 200) {
    fail(422, "invalid_land_item", "repo must be owner/name");
  }
  return repo;
}

export function parsePrNumber(prNumber) {
  if (!Number.isSafeInteger(prNumber) || prNumber < 1 || prNumber > 100_000_000) {
    fail(422, "invalid_land_item", "prNumber must be a positive integer");
  }
  return prNumber;
}

function parseTipField(value, name) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0 || value.length > TIP_MAX) {
    fail(422, "invalid_land_tip", `${name} must be a short non-empty string`);
  }
  return value.trim();
}

// Check runs are the rollup. Neutral and skipped conclusions do not count,
// including a neutral Cursor Approval Agent. The legacy combined status is
// "pending" whenever total_count is 0, so it is merged only when it actually
// lists statuses. Green means every counted signal succeeded. Any failure,
// cancelled, or timed_out run is red. Anything else, including no counted
// signal at all, stays pending.
export function rollupChecks({ status = null, checkRuns = [] } = {}) {
  const runs = (Array.isArray(checkRuns) ? checkRuns : []).filter(run => !IGNORED_CONCLUSIONS.has(run?.conclusion));
  let red = false;
  let pending = false;
  let succeeded = 0;
  for (const run of runs) {
    const conclusion = run?.conclusion;
    if (RED_CONCLUSIONS.has(conclusion)) red = true;
    else if (conclusion === "success") succeeded += 1;
    else pending = true;
  }
  const total = status && typeof status === "object" ? Number(status.total_count) : 0;
  if (Number.isFinite(total) && total > 0) {
    const state = status.state;
    if (state === "failure" || state === "error") red = true;
    else if (state === "success") succeeded += 1;
    else pending = true;
  }
  if (red) return "red";
  if (pending || succeeded === 0) return "pending";
  return "green";
}

export function normalizePull(pr, { status = null, checkRuns = [] } = {}) {
  if (!pr || typeof pr !== "object") fail(502, "github_unavailable", "GitHub returned an unreadable pull request");
  const headSha = typeof pr.head?.sha === "string" && SHA_PATTERN.test(pr.head.sha) ? pr.head.sha : null;
  const merged = pr.merged === true;
  const mergedSha = merged && typeof pr.merge_commit_sha === "string" && SHA_PATTERN.test(pr.merge_commit_sha)
    ? pr.merge_commit_sha : null;
  const behind = !merged && pr.mergeable_state === "behind";
  let mergeable = "unknown";
  if (merged) mergeable = "merged";
  else if (behind) mergeable = "behind";
  else if (pr.mergeable === true) mergeable = "mergeable";
  else if (pr.mergeable === false && pr.mergeable_state === "dirty") mergeable = "conflict";
  const title = typeof pr.title === "string" ? pr.title.slice(0, TITLE_MAX) : null;
  const closed = merged || pr.state === "closed";
  return {
    title,
    headSha,
    mergeable,
    behind,
    checks: rollupChecks({ status, checkRuns }),
    mergedSha,
    closed
  };
}

// Diff a stored row against a GitHub observation. The first observation
// records state and does not wake: nothing has flipped yet.
export function landTransition(previous, next) {
  if (!previous) return [];
  const changed = [];
  if (next.checks === "green" && previous.checks !== "green") changed.push("green");
  if (next.checks === "red" && previous.checks !== "red") changed.push("red");
  if (next.behind === true && previous.behind !== true) changed.push("behind");
  if (next.mergedSha && next.mergedSha !== previous.mergedSha) changed.push("merged");
  return changed;
}

// A tip report wakes when sourceRevision or buildId differs from the stored
// tip, including the first report.
export function tipTransition(previous, tip) {
  const sourceChanged = tip.sourceRevision !== undefined && tip.sourceRevision !== (previous?.tipSourceRevision ?? null);
  const buildChanged = tip.buildId !== undefined && tip.buildId !== (previous?.tipBuildId ?? null);
  return sourceChanged || buildChanged ? ["tip"] : [];
}

export function landWakePayload(item, changed) {
  return {
    pr: item.prNumber,
    head: item.headSha ?? null,
    state: {
      checks: item.checks,
      behind: item.behind === true,
      mergeable: item.mergeable,
      merged: Boolean(item.mergedSha)
    },
    changed: [...changed]
  };
}

function githubHeaders(token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "project-room-land-queue",
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

function usableEtag(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && /^[\x21-\x7E]+$/.test(value)
    ? value : null;
}

async function responseMessage(response) {
  try {
    const body = await response.json();
    return typeof body?.message === "string" ? body.message : "";
  } catch {
    return "";
  }
}

// x-ratelimit-reset is a UTC epoch in seconds. retry-after is a delta. A
// missing or already-passed reset waits one minute so the tick does not
// hammer the same 403.
export function readRateLimitReset(response, now) {
  const reset = responseHeader(response, "x-ratelimit-reset");
  let until = null;
  if (reset != null && /^\d+$/.test(reset.trim())) {
    const value = Number(reset.trim());
    until = value > 1e12 ? value : value * 1000;
  } else {
    const retry = responseHeader(response, "retry-after");
    if (retry != null && /^\d+$/.test(retry.trim())) until = now + Number(retry.trim()) * 1000;
  }
  if (!until || until <= now) until = now + 60_000;
  return until;
}

function isRateLimitResponse(response, message) {
  if (response.status === 429) return true;
  if (response.status !== 403) return false;
  if (responseHeader(response, "x-ratelimit-remaining") === "0") return true;
  return /rate limit/i.test(message);
}

async function githubFetch(fetchImpl, url, token, { etag = null, missingOk = false, now = Date.now() } = {}) {
  const headers = githubHeaders(token);
  const cached = usableEtag(etag);
  if (cached) headers["If-None-Match"] = cached;
  let response;
  try {
    response = await fetchImpl(url, { headers });
  } catch {
    fail(502, "github_unavailable", "GitHub could not be reached");
  }
  const nextEtag = usableEtag(responseHeader(response, "etag")) || cached;
  if (response.status === 304) return { notModified: true, etag: nextEtag, body: null };
  if (response.status === 404 && missingOk) return { missing: true, etag: nextEtag, body: null };
  // The GitHub message is not copied onto the error and is not logged.
  const message = response.ok ? "" : await responseMessage(response);
  if (isRateLimitResponse(response, message)) {
    const error = new ServiceError(503, "github_rate_limited", "GitHub refused the pull request read");
    error.rateLimitedUntil = readRateLimitReset(response, now);
    throw error;
  }
  // 404 is a missing pull request even when no token is configured;
  // private-repo hiding uses the same status, and a real auth failure is
  // 401 or a non-limit 403.
  if (response.status === 401 || (!token && response.status === 403)) {
    fail(503, "github_unconfigured", token
      ? "GitHub rejected the configured token."
      : "GitHub access is not configured. A token is required to read this pull request and none is set.");
  }
  if (response.status === 404) fail(404, "pr_not_found", "Pull request was not found");
  if (response.status === 403 || response.status === 429) {
    fail(503, "github_unavailable", "GitHub refused the pull request read");
  }
  if (!response.ok) fail(502, "github_unavailable", "GitHub could not be read");
  try { return { notModified: false, missing: false, etag: nextEtag, body: await response.json() }; }
  catch { fail(502, "github_unavailable", "GitHub returned an unreadable pull request"); }
}

function readPollCache(raw) {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function slimStatus(status) {
  if (!status || typeof status !== "object") return null;
  const total = Number(status.total_count);
  return {
    state: typeof status.state === "string" ? status.state : null,
    total_count: Number.isFinite(total) ? total : 0
  };
}

function slimRuns(runs) {
  return (Array.isArray(runs) ? runs : []).slice(0, CHECK_RUN_PAGE * CHECK_RUN_PAGES).map(run => ({
    status: typeof run?.status === "string" ? run.status : null,
    conclusion: typeof run?.conclusion === "string" ? run.conclusion : null,
    name: typeof run?.name === "string" ? run.name.slice(0, 200) : null
  }));
}

// Latest attempt of every check run on the head SHA. One page is 100; a
// further page is only requested when the first page says there are more.
// filter=latest is the rollup set: a rerun replaces the earlier attempt.
async function fetchCheckRuns(fetchImpl, base, sha, token, cached, now) {
  const runs = [];
  let etag = null;
  for (let page = 1; page <= CHECK_RUN_PAGES; page += 1) {
    const url = `${base}/commits/${sha}/check-runs?per_page=${CHECK_RUN_PAGE}&page=${page}&filter=latest`;
    const result = await githubFetch(fetchImpl, url, token, {
      etag: page === 1 ? cached?.etag ?? null : null,
      missingOk: true,
      now
    });
    if (page === 1) etag = result.etag ?? null;
    if (page === 1 && result.notModified) {
      return { notModified: true, etag, runs: Array.isArray(cached?.runs) ? cached.runs : [], incomplete: false };
    }
    if (result.missing) return { notModified: false, etag, runs: [], incomplete: false };
    const batch = Array.isArray(result.body?.check_runs) ? result.body.check_runs : [];
    runs.push(...batch);
    const total = Number(result.body?.total_count);
    if (!Number.isFinite(total) || runs.length >= total || batch.length < CHECK_RUN_PAGE) {
      return { notModified: false, etag, runs, incomplete: false };
    }
  }
  return { notModified: false, etag, runs, incomplete: true };
}

export async function fetchPullSnapshot({ repo, prNumber, token = null, fetchImpl = fetch, previous = null, now = Date.now() } = {}) {
  const [owner, name] = parseRepo(repo).split("/");
  const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const cache = previous?.cache && typeof previous.cache === "object" ? previous.cache : null;
  const prResult = await githubFetch(fetchImpl, `${base}/pulls/${parsePrNumber(prNumber)}`, token, {
    etag: cache?.etags?.pr ?? null, now
  });
  let sha = null;
  let prFields = null;
  if (prResult.notModified) {
    sha = typeof cache?.sha === "string" && SHA_PATTERN.test(cache.sha) ? cache.sha : previous?.headSha ?? null;
    prFields = previous;
  } else {
    sha = typeof prResult.body?.head?.sha === "string" && SHA_PATTERN.test(prResult.body.head.sha) ? prResult.body.head.sha : null;
    prFields = normalizePull(prResult.body, {});
  }
  let statusBody = cache?.status ?? null;
  let runs = Array.isArray(cache?.runs) ? cache.runs : [];
  let statusEtag = cache?.etags?.status ?? null;
  let checksEtag = cache?.etags?.checks ?? null;
  let statusNotModified = true;
  let checksNotModified = true;
  let incomplete = false;
  if (sha) {
    const sameSha = cache?.sha === sha;
    const statusResult = await githubFetch(fetchImpl, `${base}/commits/${sha}/status`, token, {
      etag: sameSha ? statusEtag : null, missingOk: true, now
    });
    statusNotModified = statusResult.notModified === true;
    statusEtag = statusResult.etag ?? null;
    if (!statusNotModified) statusBody = statusResult.missing ? null : statusResult.body;
    const checksResult = await fetchCheckRuns(fetchImpl, base, sha, token, sameSha ? { etag: checksEtag, runs } : null, now);
    checksNotModified = checksResult.notModified === true;
    checksEtag = checksResult.etag ?? null;
    incomplete = checksResult.incomplete === true;
    if (!checksNotModified) runs = checksResult.runs;
  }
  const nextCache = {
    sha,
    etags: { pr: prResult.etag ?? null, status: statusEtag, checks: checksEtag },
    status: slimStatus(statusBody),
    runs: slimRuns(runs)
  };
  if (prResult.notModified && statusNotModified && checksNotModified) {
    return { unchanged: true, cache: nextCache };
  }
  let checks = rollupChecks({ status: statusBody, checkRuns: runs });
  if (incomplete && checks !== "red") checks = "pending";
  return {
    unchanged: false,
    cache: nextCache,
    snapshot: {
      title: prFields?.title ?? null,
      headSha: sha,
      mergeable: prFields?.mergeable ?? "unknown",
      behind: prFields?.behind === true,
      checks,
      mergedSha: prFields?.mergedSha ?? null,
      closed: prFields?.closed === true || Boolean(prFields?.mergedSha)
    }
  };
}

const viewFromRow = row => ({
  itemId: row.item_id,
  roomId: row.room_id,
  repo: row.repo,
  prNumber: row.pr_number,
  url: `https://github.com/${row.repo}/pull/${row.pr_number}`,
  title: row.title,
  claimantMemberId: row.claimant_member_id,
  addedByMemberId: row.added_by_member_id,
  headSha: row.head_sha,
  mergeable: row.mergeable,
  behind: row.behind === 1,
  checks: row.checks_state,
  mergedSha: row.merged_sha,
  tip: row.tip_source_revision || row.tip_build_id
    ? { sourceRevision: row.tip_source_revision, buildId: row.tip_build_id }
    : null,
  lastError: row.last_error,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const observedFromRow = row => ({
  checks: row.checks_state,
  behind: row.behind === 1,
  mergedSha: row.merged_sha,
  tipSourceRevision: row.tip_source_revision,
  tipBuildId: row.tip_build_id,
  headSha: row.head_sha
});

export class LandQueue {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.token = null;
    this.fetchImpl = (...args) => fetch(...args);
  }

  configure({ env = null, token = undefined, fetchImpl = undefined } = {}) {
    if (token !== undefined) this.token = token || null;
    else if (env) this.token = githubAccessToken(env);
    if (fetchImpl) this.fetchImpl = fetchImpl;
    return this;
  }

  #member(roomId, memberId) {
    const member = this.store.room(roomId).state.members?.[memberId];
    if (!member || member.active === false) fail(422, "invalid_land_item", "claimant must be an active room member");
    return member;
  }

  #row(roomId, itemId) {
    return this.db.prepare("SELECT * FROM land_queue WHERE room_id=? AND item_id=?").get(roomId, itemId);
  }

  #byPr(roomId, repo, prNumber) {
    return this.db.prepare("SELECT * FROM land_queue WHERE room_id=? AND repo=? AND pr_number=?").get(roomId, repo, prNumber);
  }

  list(roomId, memberId) {
    this.#member(roomId, memberId);
    const items = this.store.readTransaction(() => this.db.prepare(
      "SELECT * FROM land_queue WHERE room_id=? ORDER BY created_at ASC").all(roomId).map(viewFromRow));
    return { roomId, items };
  }

  async add(roomId, memberId, { repo, prNumber, claimantMemberId = null } = {}) {
    this.#member(roomId, memberId);
    const parsedRepo = parseRepo(repo);
    const parsedPr = parsePrNumber(prNumber);
    const claimant = claimantMemberId ?? memberId;
    if (!validId(claimant)) fail(422, "invalid_land_item", "claimant must be a member id");
    this.#member(roomId, claimant);
    const existing = this.#byPr(roomId, parsedRepo, parsedPr);
    if (existing) {
      if (claimant !== existing.claimant_member_id) {
        this.store.transaction(() => {
          this.db.prepare("UPDATE land_queue SET claimant_member_id=?, updated_at=? WHERE room_id=? AND item_id=?")
            .run(claimant, this.store.now(), roomId, existing.item_id);
        });
      }
      const item = viewFromRow(this.#row(roomId, existing.item_id));
      return this.#refreshRow(item, { duplicate: true });
    }
    const count = this.db.prepare("SELECT COUNT(*) AS n FROM land_queue WHERE room_id=?").get(roomId).n;
    if (count >= MAX_ITEMS) fail(409, "land_queue_full", "This room's land queue is full");
    const now = this.store.now();
    const itemId = `lq_${randomBytes(12).toString("base64url")}`;
    this.store.transaction(() => {
      this.db.prepare(`INSERT INTO land_queue
        (room_id, item_id, repo, pr_number, claimant_member_id, added_by_member_id, title, head_sha,
         mergeable, behind, checks_state, merged_sha, tip_source_revision, tip_build_id, last_error, observed,
         created_at, updated_at)
        VALUES (?,?,?,?,?,?,NULL,NULL,'unknown',0,'pending',NULL,NULL,NULL,NULL,0,?,?)`)
        .run(roomId, itemId, parsedRepo, parsedPr, claimant, memberId, now, now);
    });
    const item = viewFromRow(this.#row(roomId, itemId));
    return this.#refreshRow(item, { duplicate: false });
  }

  remove(roomId, memberId, { itemId } = {}) {
    this.#member(roomId, memberId);
    if (!validId(itemId)) fail(422, "invalid_land_item", "itemId is required");
    const row = this.#row(roomId, itemId);
    if (!row) fail(404, "land_item_not_found", "Land queue item was not found");
    this.store.transaction(() => {
      this.db.prepare("DELETE FROM land_queue WHERE room_id=? AND item_id=?").run(roomId, itemId);
    });
    return { roomId, itemId, removed: true };
  }

  reportTip(roomId, memberId, { itemId, sourceRevision, buildId } = {}) {
    this.#member(roomId, memberId);
    if (!validId(itemId)) fail(422, "invalid_land_item", "itemId is required");
    const source = parseTipField(sourceRevision, "sourceRevision");
    const build = parseTipField(buildId, "buildId");
    if (source === undefined && build === undefined) {
      fail(422, "invalid_land_tip", "sourceRevision or buildId is required");
    }
    const row = this.#row(roomId, itemId);
    if (!row) fail(404, "land_item_not_found", "Land queue item was not found");
    const previous = observedFromRow(row);
    const nextTip = {
      sourceRevision: source === undefined ? previous.tipSourceRevision : source,
      buildId: build === undefined ? previous.tipBuildId : build
    };
    const changed = tipTransition(previous, {
      sourceRevision: source === undefined ? previous.tipSourceRevision : source,
      buildId: build === undefined ? previous.tipBuildId : build
    });
    const now = this.store.now();
    let item;
    this.store.transaction(() => {
      this.db.prepare(`UPDATE land_queue SET tip_source_revision=?, tip_build_id=?, updated_at=?
        WHERE room_id=? AND item_id=?`)
        .run(nextTip.sourceRevision, nextTip.buildId, now, roomId, itemId);
      item = viewFromRow(this.#row(roomId, itemId));
      if (changed.length > 0) this.#emit(roomId, item, changed);
    });
    return { item, changed };
  }

  async refreshDue({ now = this.store.now() } = {}) {
    const limited = this.db.prepare("SELECT MAX(rate_limited_until) AS until FROM land_queue").get();
    if (limited?.until != null && limited.until > now) {
      return { checked: 0, updated: 0, unconfigured: 0, rateLimited: 1 };
    }
    const limit = this.token ? REFRESH_LIMIT : REFRESH_LIMIT_NO_TOKEN;
    const due = this.db.prepare(`SELECT * FROM land_queue
      WHERE merged_sha IS NULL AND closed = 0
        AND (next_poll_at IS NULL OR next_poll_at <= ?)
      ORDER BY next_poll_at ASC
      LIMIT ?`).all(now, limit);
    const summary = { checked: 0, updated: 0, unconfigured: 0, rateLimited: 0 };
    for (const row of due) {
      summary.checked += 1;
      try {
        const result = await this.#refreshRow(viewFromRow(row), { duplicate: false, cron: true });
        if (result.rateLimited) {
          summary.rateLimited += 1;
          break;
        }
        if (result.changed?.length) summary.updated += 1;
      } catch (error) {
        if (error?.code === "github_unconfigured") summary.unconfigured += 1;
        // The tick must keep going. The code is logged; the token is not.
        console.warn(`land queue refresh skipped: ${error?.code ?? "github_unavailable"}`);
      }
    }
    return summary;
  }

  #stampRateLimit(item, until) {
    const stamp = Number(until);
    if (!Number.isFinite(stamp)) return;
    this.store.transaction(() => {
      this.db.prepare("UPDATE land_queue SET rate_limited_until=? WHERE room_id=? AND item_id=?")
        .run(stamp, item.roomId, item.itemId);
    });
  }

  #schedule(itemId, roomId, { backoff, cache, now }) {
    this.db.prepare(`UPDATE land_queue SET backoff_ms=?, next_poll_at=?, poll_etag=?, updated_at=?
      WHERE room_id=? AND item_id=?`)
      .run(backoff, now + backoff, cache ? JSON.stringify(cache) : null, now, roomId, itemId);
  }

  async #refreshRow(item, { duplicate, cron = false }) {
    const row = this.#row(item.roomId, item.itemId);
    const now = this.store.now();
    let poll;
    try {
      const cache = readPollCache(row?.poll_etag);
      poll = await fetchPullSnapshot({
        repo: item.repo,
        prNumber: item.prNumber,
        token: this.token,
        fetchImpl: this.fetchImpl,
        now,
        previous: row ? {
          title: row.title ?? null,
          headSha: row.head_sha ?? null,
          mergeable: row.mergeable,
          behind: row.behind === 1,
          checks: row.checks_state,
          mergedSha: row.merged_sha ?? null,
          closed: row.closed === 1,
          cache
        } : null
      });
    } catch (error) {
      if (error?.code === "github_rate_limited") {
        this.#stampRateLimit(item, error.rateLimitedUntil);
        if (cron) return { item: viewFromRow(this.#row(item.roomId, item.itemId)), duplicate, changed: [], rateLimited: true };
        this.store.transaction(() => {
          this.db.prepare("UPDATE land_queue SET last_error=?, updated_at=? WHERE room_id=? AND item_id=?")
            .run("github_unavailable", now, item.roomId, item.itemId);
        });
        fail(503, "github_unavailable", "GitHub refused the pull request read");
      }
      if (error?.code === "pr_not_found" && !duplicate) {
        this.store.transaction(() => {
          this.db.prepare("DELETE FROM land_queue WHERE room_id=? AND item_id=?").run(item.roomId, item.itemId);
        });
      } else if (error?.code === "github_unconfigured" || error?.code === "github_unavailable") {
        const backoff = nextPollBackoff(row?.backoff_ms);
        this.store.transaction(() => {
          this.db.prepare(`UPDATE land_queue SET last_error=?, backoff_ms=?, next_poll_at=?, updated_at=?
            WHERE room_id=? AND item_id=?`)
            .run(error.code, backoff, now + backoff, now, item.roomId, item.itemId);
        });
        if (error.code === "github_unconfigured") {
          error.item = viewFromRow(this.#row(item.roomId, item.itemId));
        }
      }
      throw error;
    }
    if (poll.unchanged) {
      const backoff = nextPollBackoff(row?.backoff_ms);
      let saved;
      this.store.transaction(() => {
        this.#schedule(item.itemId, item.roomId, { backoff, cache: poll.cache, now });
        this.db.prepare("UPDATE land_queue SET last_error=NULL WHERE room_id=? AND item_id=?").run(item.roomId, item.itemId);
        saved = viewFromRow(this.#row(item.roomId, item.itemId));
      });
      return { item: saved, duplicate, changed: [] };
    }
    const snapshot = poll.snapshot;
    const identical = row?.observed === 1 && (row.title ?? null) === (snapshot.title ?? null)
      && (row.head_sha ?? null) === (snapshot.headSha ?? null)
      && row.mergeable === snapshot.mergeable
      && (row.behind === 1) === snapshot.behind
      && row.checks_state === snapshot.checks
      && (row.merged_sha ?? null) === (snapshot.mergedSha ?? null)
      && (row.closed === 1) === snapshot.closed;
    const backoff = identical ? nextPollBackoff(row?.backoff_ms) : POLL_BACKOFF_STEPS_MS[0];
    const changed = landTransition(row?.observed ? observedFromRow(row) : null, snapshot);
    const closed = snapshot.closed || snapshot.mergedSha ? 1 : 0;
    let saved;
    this.store.transaction(() => {
      this.db.prepare(`UPDATE land_queue SET title=?, head_sha=?, mergeable=?, behind=?, checks_state=?,
        merged_sha=?, closed=?, last_error=NULL, observed=1, backoff_ms=?, next_poll_at=?, poll_etag=?, updated_at=?
        WHERE room_id=? AND item_id=?`)
        .run(snapshot.title, snapshot.headSha, snapshot.mergeable, snapshot.behind ? 1 : 0, snapshot.checks,
          snapshot.mergedSha, closed, backoff, now + backoff, JSON.stringify(poll.cache), now, item.roomId, item.itemId);
      saved = viewFromRow(this.#row(item.roomId, item.itemId));
      if (changed.length > 0) this.#emit(item.roomId, saved, changed);
    });
    return { item: saved, duplicate, changed };
  }

  #emit(roomId, item, changed) {
    const payload = landWakePayload(item, changed);
    const room = this.store.room(roomId);
    const claimant = room.state.members?.[item.claimantMemberId];
    const actorId = claimant && claimant.active !== false ? item.claimantMemberId : room.state.room.ownerId;
    const incoming = event({
      id: randomUUID(),
      idempotencyKey: randomUUID(),
      type: EVENT_TYPES.LAND_UPDATED,
      actorId,
      roomId,
      at: new Date(this.store.now()).toISOString(),
      data: {
        itemId: item.itemId,
        repo: item.repo,
        claimantMemberId: item.claimantMemberId,
        ...payload
      }
    });
    const state = applyEvent(room.state, incoming);
    const sequence = room.sequence + 1;
    this.db.prepare("INSERT INTO events VALUES(?,?,?,?)").run(roomId, sequence, incoming.id, JSON.stringify(incoming));
    const compact = { ...state, eventLog: [], seenEvents: {}, seenIdempotencyKeys: {} };
    this.db.prepare("UPDATE rooms SET sequence=?, projection=? WHERE id=?").run(sequence, JSON.stringify(compact), roomId);
    try {
      if (this.store.agentPlugin) this.store.agentPlugin.fanoutRoomEvent({ roomId, event: incoming });
    } catch (error) {
      console.error("land queue fan-out failed:", error?.message ?? error);
    }
    try { this.wakeClaimant(roomId, item.claimantMemberId, incoming, payload); }
    catch (error) { console.error("land queue wake failed:", error?.message ?? error); }
    return incoming;
  }

  // Push the thin payload through the existing wake path: a pointer doorbell
  // for an offline claimant, plus an agent.wake delivery whose signal carries
  // pr, head, state, and what changed. Online claimants already see the room
  // event. No identity link means there is no host to wake.
  wakeClaimant(roomId, claimantMemberId, incoming, payload) {
    let identityId = null;
    try {
      identityId = this.db.prepare(
        "SELECT identity_id AS identityId FROM identity_links WHERE room_id=? AND member_id=?"
      ).get(roomId, claimantMemberId)?.identityId ?? null;
    } catch { return null; }
    if (!identityId) return null;
    const status = this.store.agentHeartbeats?.statusOf(identityId);
    if (!status || status.status !== "offline") return null;
    this.store.agentHeartbeats.pushNotify({
      identityId, eventType: "land.updated", roomId, id: incoming.id, ts: this.store.now()
    });
    const signal = {
      signalId: incoming.id,
      kind: "land",
      roomId,
      messageId: incoming.id,
      pr: payload.pr,
      head: payload.head,
      state: payload.state,
      changed: payload.changed
    };
    this.store.agentPlugin?.deliverWakePing({ identityId, signal });
    return { identityId, signal };
  }
}
