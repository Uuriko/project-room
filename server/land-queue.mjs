// Land queue: one list of pull requests per room, refreshed from GitHub so
// agents stop polling the forge while a PR lands.
//
// Any room member can add, list, or remove an item. The claimant defaults to
// the caller. There is no new permission rule.
//
// GitHub access reuses a token already present in the environment
// (GITHUB_TOKEN or GH_TOKEN). Public repositories answer without one. When a
// token is required and missing, callers get 503 github_unconfigured. The
// token is never logged and never copied onto an item or a room event.
//
// There is no inbound GitHub webhook receiver in this service. Refresh runs
// on the existing scheduled tick (cloudflare/room.mjs scheduled), which is
// the Durable Object cron path. A missing token does not fail that tick.

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
// Unauthenticated GitHub allows 60 requests an hour. With a token the budget
// is much larger, so the tick can look more often. Either way the tick is
// capped so one room cannot drain the budget.
const REFRESH_MIN_MS = 5 * 60 * 1000;
const REFRESH_MIN_WITH_TOKEN_MS = 60 * 1000;
const REFRESH_LIMIT = 4;
const REFRESH_LIMIT_NO_TOKEN = 1;

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
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, item_id),
    UNIQUE (room_id, repo, pr_number)
  );
  CREATE INDEX IF NOT EXISTS land_queue_due ON land_queue(updated_at);
`;

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };

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

export function rollupChecks({ statusState = null, checkRuns = [] } = {}) {
  const runs = Array.isArray(checkRuns) ? checkRuns : [];
  const failedRun = runs.some(run => ["failure", "cancelled", "timed_out", "action_required", "startup_failure"].includes(run?.conclusion));
  const failedStatus = statusState === "failure" || statusState === "error";
  if (failedRun || failedStatus) return "red";
  const pendingRun = runs.some(run => run && run.status && run.status !== "completed");
  const pendingStatus = statusState === "pending";
  if (pendingRun || pendingStatus) return "pending";
  return "green";
}

export function normalizePull(pr, { statusState = null, checkRuns = [] } = {}) {
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
  return {
    title,
    headSha,
    mergeable,
    behind,
    checks: rollupChecks({ statusState, checkRuns }),
    mergedSha
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

async function responseMessage(response) {
  try {
    const body = await response.json();
    return typeof body?.message === "string" ? body.message : "";
  } catch {
    return "";
  }
}

async function githubJson(fetchImpl, url, token, { missingOk = false } = {}) {
  let response;
  try {
    response = await fetchImpl(url, { headers: githubHeaders(token) });
  } catch {
    fail(502, "github_unavailable", "GitHub could not be reached");
  }
  if (response.status === 404 && missingOk) return null;
  if (!token && (response.status === 401 || response.status === 403 || response.status === 404)) {
    // A rate-limit 403 is not a missing token. The GitHub message is not
    // copied onto the error and is not logged.
    if (response.status === 403 && /rate limit/i.test(await responseMessage(response))) {
      fail(503, "github_unavailable", "GitHub refused the pull request read");
    }
    fail(503, "github_unconfigured", "GitHub access is not configured. A token is required to read this pull request and none is set.");
  }
  if (token && response.status === 401) {
    fail(503, "github_unconfigured", "GitHub rejected the configured token.");
  }
  if (response.status === 404) fail(404, "pr_not_found", "Pull request was not found");
  if (response.status === 403 || response.status === 429) {
    fail(503, "github_unavailable", "GitHub refused the pull request read");
  }
  if (!response.ok) fail(502, "github_unavailable", "GitHub could not be read");
  try { return await response.json(); }
  catch { fail(502, "github_unavailable", "GitHub returned an unreadable pull request"); }
}

export async function fetchPullSnapshot({ repo, prNumber, token = null, fetchImpl = fetch } = {}) {
  const [owner, name] = parseRepo(repo).split("/");
  const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const pr = await githubJson(fetchImpl, `${base}/pulls/${parsePrNumber(prNumber)}`, token);
  const sha = typeof pr?.head?.sha === "string" && SHA_PATTERN.test(pr.head.sha) ? pr.head.sha : null;
  let statusState = null;
  let checkRuns = [];
  if (sha) {
    const status = await githubJson(fetchImpl, `${base}/commits/${sha}/status`, token, { missingOk: true });
    const checks = await githubJson(fetchImpl, `${base}/commits/${sha}/check-runs`, token, { missingOk: true });
    statusState = typeof status?.state === "string" ? status.state : null;
    checkRuns = Array.isArray(checks?.check_runs) ? checks.check_runs : [];
  }
  return normalizePull(pr, { statusState, checkRuns });
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
    const minAge = this.token ? REFRESH_MIN_WITH_TOKEN_MS : REFRESH_MIN_MS;
    const limit = this.token ? REFRESH_LIMIT : REFRESH_LIMIT_NO_TOKEN;
    const due = this.db.prepare(`SELECT * FROM land_queue
      WHERE merged_sha IS NULL AND updated_at <= ?
      ORDER BY updated_at ASC LIMIT ?`).all(now - minAge, limit);
    const summary = { checked: 0, updated: 0, unconfigured: 0 };
    for (const row of due) {
      summary.checked += 1;
      try {
        const result = await this.#refreshRow(viewFromRow(row), { duplicate: false });
        if (result.changed?.length) summary.updated += 1;
      } catch (error) {
        if (error?.code === "github_unconfigured") summary.unconfigured += 1;
        // The tick must keep going. The code is logged; the token is not.
        console.warn(`land queue refresh skipped: ${error?.code ?? "github_unavailable"}`);
      }
    }
    return summary;
  }

  async #refreshRow(item, { duplicate }) {
    let snapshot;
    try {
      snapshot = await fetchPullSnapshot({
        repo: item.repo, prNumber: item.prNumber, token: this.token, fetchImpl: this.fetchImpl
      });
    } catch (error) {
      if (error?.code === "pr_not_found" && !duplicate) {
        this.store.transaction(() => {
          this.db.prepare("DELETE FROM land_queue WHERE room_id=? AND item_id=?").run(item.roomId, item.itemId);
        });
      } else if (error?.code === "github_unconfigured" || error?.code === "github_unavailable") {
        this.store.transaction(() => {
          this.db.prepare("UPDATE land_queue SET last_error=?, updated_at=? WHERE room_id=? AND item_id=?")
            .run(error.code, this.store.now(), item.roomId, item.itemId);
        });
        if (error.code === "github_unconfigured") {
          error.item = viewFromRow(this.#row(item.roomId, item.itemId));
        }
      }
      throw error;
    }
    const row = this.#row(item.roomId, item.itemId);
    const changed = landTransition(row.observed ? observedFromRow(row) : null, snapshot);
    const now = this.store.now();
    let saved;
    this.store.transaction(() => {
      this.db.prepare(`UPDATE land_queue SET title=?, head_sha=?, mergeable=?, behind=?, checks_state=?,
        merged_sha=?, last_error=NULL, observed=1, updated_at=? WHERE room_id=? AND item_id=?`)
        .run(snapshot.title, snapshot.headSha, snapshot.mergeable, snapshot.behind ? 1 : 0, snapshot.checks,
          snapshot.mergedSha, now, item.roomId, item.itemId);
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
