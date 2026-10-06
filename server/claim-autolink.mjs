// Claim <-> pull-request auto-linking (plan-pr-autolink).
//
// Off-room PRs find their board item on their own:
//  1. parseClaimId / findClaimForPull read a claim id out of a branch name,
//     an explicit `claim:` marker, the PR title, or the PR body. Priority is
//     marker > branch > title > body, and an ambiguous token never guesses.
//  2. autoLinkPullRequest attaches the PR URL to a live claim as the system
//     actor and posts one work_claim.updated receipt (the owner-driven path
//     in server/work-claims.mjs stays untouched).
//  3. handlePrWebhookPayload is the core a pull_request webhook calls after
//     signature verification: it records the delivery (so the poll fallback
//     knows the webhook is alive), auto-links unlinked PRs, and settles
//     already-linked claims through the existing applyPullRequestWebhook.
//  4. discoverUnlinkedPulls is the poll fallback for repos/rooms where the
//     webhook is not configured: open PRs are matched to claims that carry
//     no PR link yet. It shares the claim-pr GitHub budget and skips repos
//     with a fresh webhook delivery.
//  5. linkDeployToSettledClaims links a recorded deploy revision back to the
//     settled board items whose required revision is that deploy.
//
// No new tables: webhook deliveries and discovery cursors live in
// work_claim_config under _claim-pr-webhook: and _claim-pr-discover: keys.
// The webhook secret is never read here as a value for storage and never
// leaves the process; only its env var NAME is documented (ops__STATE.md).
import { parsePullRequestUrl, pullLinks, rateLimitUntil } from "./claim-coordination.mjs";
import { applyPullRequestWebhook, readClaimPullBudget, writeClaimPullBudget } from "./claim-pr-sync.mjs";
import { emitWorkClaimEvent } from "./work-claim-events.mjs";
import { MAX_CLAIM_HISTORY } from "./work-claims.mjs";

// Claim ids in the wild: plan-pr-autolink, fo-sec06-invite-race,
// qa7-10-m53-tmpdir, ready-WK41-E3, claude-code-drops.
const CLAIM_TOKEN = /[A-Za-z][A-Za-z0-9_-]{2,79}/g;
const CLAIM_MARKER = /(?:^|[\s>\[(])claim\s*[:=]\s*([A-Za-z][A-Za-z0-9_-]{2,79})/gim;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA40 = /^[0-9a-f]{40}$/;
const LIVE_CLAIM_STATES = new Set(["claimed", "in_progress", "blocked"]);
// Mirrors the module-private MAX_PULLS in server/work-claims.mjs (16).
const MAX_AUTO_PULLS = 16;
const WEBHOOK_FRESH_MS = 24 * 60 * 60_000;
const DISCOVERY_BACKOFF_MS = 30 * 60_000;
const DISCOVERY_PER_PAGE = 30;
const WEBHOOK_ROOM = "_claim-pr-webhook:";
const DISCOVERY_ROOM = "_claim-pr-discover:";

// The webhook receiver flag and secret env var name. The flag defaults OFF;
// the secret VALUE is never stored in the repo (only this name is recorded
// in ops__STATE.md).
export const PR_WEBHOOK_FLAG = "ROOM_PR_WEBHOOK";
export const PR_WEBHOOK_SECRET_ENV = "GITHUB_PR_WEBHOOK_SECRET";

function liveEnv() {
  const proc = globalThis.process;
  return proc && proc.env && typeof proc.env === "object" ? proc.env : {};
}

export function prWebhookEnabled(env = liveEnv()) {
  const value = env?.[PR_WEBHOOK_FLAG];
  return typeof value === "string" && /^(1|true|yes)$/i.test(value.trim());
}

// --- claim-id parsing -------------------------------------------------

function tokensOf(text) {
  if (typeof text !== "string" || !text) return [];
  const out = [];
  CLAIM_TOKEN.lastIndex = 0;
  let match;
  while ((match = CLAIM_TOKEN.exec(text)) !== null) out.push(match[0]);
  return out;
}

function markersOf(body) {
  if (typeof body !== "string" || !body) return [];
  const out = [];
  CLAIM_MARKER.lastIndex = 0;
  let match;
  while ((match = CLAIM_MARKER.exec(body)) !== null) out.push(match[1]);
  return out;
}

// Claim id candidates from a PR's branch, title and body, in priority
// order: explicit `claim:` marker > branch segment > title token > body
// token. A branch like u/jill/plan-pr-autolink yields its exact segment;
// a token that merely contains a claim id (plan-pr-autolinker) does not.
export function parseClaimId({ branch = "", title = "", body = "" } = {}) {
  const seen = new Set();
  const out = [];
  const push = (id, source) => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ id, source });
  };
  for (const id of markersOf(body)) push(id, "marker");
  if (typeof branch === "string" && branch) {
    for (const segment of branch.split("/")) {
      const token = segment.trim();
      if (token && /^[A-Za-z][A-Za-z0-9_-]{2,79}$/.test(token)) push(token, "branch");
    }
  }
  for (const id of tokensOf(title)) push(id, "title");
  for (const id of tokensOf(body)) push(id, "body");
  return out;
}

// Match PR metadata against live claims. Returns { claim, source }, or
// { ambiguous: ["room:id", ...] } when one token names several live claims,
// or null. Only owned, active claims whose declared repo (when set) matches
// the PR's repo are eligible; an ambiguous token never guesses.
export function findClaimForPull({ branch = "", title = "", body = "", repo = "" } = {}, claims = []) {
  const candidates = parseClaimId({ branch, title, body });
  if (!candidates.length) return null;
  const prRepo = typeof repo === "string" ? repo.toLowerCase() : "";
  const live = (claims ?? []).filter(claim =>
    claim && LIVE_CLAIM_STATES.has(claim.state) && claim.owner &&
    (!claim.repo || !prRepo || String(claim.repo).toLowerCase() === prRepo));
  const byId = new Map();
  for (const claim of live) {
    const key = String(claim.id).toLowerCase();
    if (!byId.has(key)) byId.set(key, []);
    byId.get(key).push(claim);
  }
  for (const { id, source } of candidates) {
    const matches = byId.get(id.toLowerCase()) ?? [];
    if (matches.length === 1) return { claim: matches[0], source };
    if (matches.length > 1) {
      return { ambiguous: matches.map(claim => `${claim.roomId}:${claim.id}`) };
    }
  }
  return null;
}

// --- system auto-link --------------------------------------------------

const isoOf = ms => new Date(ms).toISOString();

function stampHistory(item, atMs, action, note) {
  const entry = Object.freeze({ at: isoOf(atMs), agentId: "system", action, note: note ?? null });
  const full = [...(item.history ?? []), entry];
  const dropped = Math.max(0, full.length - MAX_CLAIM_HISTORY);
  return {
    history: Object.freeze(dropped ? full.slice(dropped) : full),
    ...(dropped ? { historyOmitted: (item.historyOmitted ?? 0) + dropped } : {}),
  };
}

function autoLinkShape(parsed) {
  // Same fields server/work-claims.mjs pullRequestOf produces; the poller
  // fills outcome/etag/CI in later. Kept in sync by hand: work-claims.mjs
  // is owned by another lane (first-claim-wins), so this module does not
  // edit it.
  return Object.freeze({
    url: parsed.url, repo: parsed.repo, number: parsed.number,
    outcome: null, syncedAt: null, nextPollAt: null, etag: null,
    rateLimitedUntil: null, pollBackoffMs: null, ciCursor: null,
  });
}

// Attach a PR URL to a live claim as the system actor (no owner session:
// webhooks and the poller have none). Refuses settled, unclaimed, and
// already-linked claims; refuses a second auto-link while an open link
// exists (the owner can still link more by hand). Emits one
// work_claim.updated receipt with reason pr_autolinked.
export function autoLinkPullRequest(store, roomId, claimId, { url, source = "unknown" } = {}, { nowMs = Date.now() } = {}) {
  const item = store?.workClaims?.get(roomId, claimId);
  if (!item || !LIVE_CLAIM_STATES.has(item.state) || !item.owner || item.supersededBy) {
    return { linked: false, reason: "not_active" };
  }
  const parsed = parsePullRequestUrl(url);
  if (!parsed) return { linked: false, reason: "bad_url" };
  const links = pullLinks(item);
  if (links.some(pull => pull.url === parsed.url)) return { linked: false, reason: "already_linked" };
  if (links.some(pull => !pull.outcome)) return { linked: false, reason: "open_link_exists" };
  if (links.length >= MAX_AUTO_PULLS) return { linked: false, reason: "too_many_links" };
  const link = autoLinkShape(parsed);
  const nextLinks = Object.freeze([...links, link]);
  const open = nextLinks.find(pull => !pull.outcome) ?? nextLinks[nextLinks.length - 1];
  const stamped = stampHistory(item, nowMs, "pr_autolinked",
    `Auto-linked pull request ${parsed.url} (matched via ${source})`);
  const next = Object.freeze({
    ...item,
    pullRequests: nextLinks,
    pullRequest: open,
    ...stamped,
    updatedAt: isoOf(nowMs),
  });
  store.workClaims.set(roomId, next);
  // No reason: the event projection (src/events.js) only accepts ci_changed /
  // reviewed as reasons; the history entry below carries the detail.
  emitWorkClaimEvent(store, roomId, {
    actorId: item.owner ?? "system", item: next, action: "state_changed",
    atMs: nowMs,
  });
  return { linked: true, roomId, claimId, url: parsed.url, source };
}

// --- webhook delivery journal (poll-fallback input) ----------------------

function readConfig(store, key) {
  if (!store?.db || typeof store.db.prepare !== "function") return null;
  try {
    const row = store.db.prepare("SELECT config_json FROM work_claim_config WHERE room_id=?").get(key);
    return row ? JSON.parse(row.config_json) : null;
  } catch { return null; }
}

function writeConfig(store, key, value, nowMs) {
  if (!store?.db || typeof store.db.prepare !== "function") return;
  store.db.prepare(`INSERT INTO work_claim_config(room_id, config_json, updated_at) VALUES(?,?,?)
    ON CONFLICT(room_id) DO UPDATE SET config_json=excluded.config_json, updated_at=excluded.updated_at`)
    .run(key, JSON.stringify(value), nowMs);
}

export function recordWebhookDelivery(store, repo, nowMs = Date.now()) {
  if (!REPO_PATTERN.test(repo ?? "")) return false;
  writeConfig(store, WEBHOOK_ROOM + repo, { deliveredAt: nowMs }, nowMs);
  return true;
}

export function webhookDeliveryStale(store, repo, nowMs = Date.now()) {
  const saved = readConfig(store, WEBHOOK_ROOM + repo);
  const at = Number(saved?.deliveredAt);
  return !(Number.isFinite(at) && nowMs - at < WEBHOOK_FRESH_MS);
}

function discoveryDue(store, repo, nowMs) {
  const saved = readConfig(store, DISCOVERY_ROOM + repo);
  const nextAt = Number(saved?.nextAt);
  return !Number.isFinite(nextAt) || nextAt <= nowMs;
}

function liveClaims(store) {
  const out = [];
  let roomIds = [];
  try {
    roomIds = store.db.prepare("SELECT DISTINCT room_id AS roomId FROM work_claims").all().map(row => row.roomId);
  } catch (error) {
    if (/no such table/i.test(error?.message ?? "")) return out;
    throw error;
  }
  for (const roomId of roomIds) {
    for (const item of store.workClaims.list(roomId)) {
      out.push({ id: item.id, roomId, state: item.state, owner: item.owner, repo: item.repo ?? null, item });
    }
  }
  return out;
}

// --- webhook core --------------------------------------------------------
// Runs after the route verified the HMAC signature. Never throws on
// hostile payload shapes; returns { ok:false, reason } instead.

export function handlePrWebhookPayload(store, payload, { nowMs = Date.now() } = {}) {
  const pr = payload && typeof payload === "object" && !Array.isArray(payload) ? payload.pull_request : null;
  const parsed = parsePullRequestUrl(pr && typeof pr.html_url === "string" ? pr.html_url : "");
  if (!parsed) return { ok: false, reason: "unparseable" };
  const payloadRepo = payload?.repository?.full_name;
  const repo = typeof payloadRepo === "string" && REPO_PATTERN.test(payloadRepo) ? payloadRepo : parsed.repo;
  if (!REPO_PATTERN.test(repo)) return { ok: false, reason: "bad_repo" };
  recordWebhookDelivery(store, repo, nowMs);
  const found = findClaimForPull({
    branch: typeof pr?.head?.ref === "string" ? pr.head.ref : "",
    title: typeof pr?.title === "string" ? pr.title : "",
    body: typeof pr?.body === "string" ? pr.body : "",
    repo,
  }, liveClaims(store));
  let linked = null;
  let ambiguous = null;
  let settled = [];
  store.workClaims.transaction(() => {
    if (found && found.claim) {
      const result = autoLinkPullRequest(store, found.claim.roomId, found.claim.id,
        { url: parsed.url, source: found.source }, { nowMs });
      if (result.linked) linked = { roomId: result.roomId, claimId: result.claimId, url: result.url, source: result.source };
    } else if (found && found.ambiguous) {
      ambiguous = found.ambiguous;
    }
    // Settlement for already-linked claims (existing behavior, shared).
    const applied = applyPullRequestWebhook(store, payload, { nowMs });
    settled = applied.applied ?? [];
  });
  return {
    ok: true, repo, url: parsed.url,
    action: typeof payload?.action === "string" ? payload.action : null,
    linked, ambiguous, settled,
  };
}

// --- poll fallback ---------------------------------------------------------

function githubToken(env) {
  if (!env || typeof env !== "object") return null;
  for (const key of ["GITHUB_TOKEN", "GH_TOKEN"]) {
    const value = env[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

async function fetchOpenPulls(repo, { fetchImpl, token, nowMs, deadline }) {
  const [owner, name] = repo.split("/");
  const endpoint = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}` +
    `/pulls?state=open&per_page=${DISCOVERY_PER_PAGE}&sort=updated&direction=desc`;
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "project-room-claim-autolink",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (Date.now() > deadline) return { kind: "budget" };
  let response;
  try {
    response = await fetchImpl(endpoint, { headers, signal: AbortSignal.timeout(5000) });
  } catch {
    return Date.now() > deadline ? { kind: "budget" } : { kind: "error" };
  }
  if (response.status === 403 || response.status === 429) {
    let remaining = null;
    let reset = null;
    let retryAfter = null;
    try {
      remaining = response.headers?.get?.("x-ratelimit-remaining") ?? null;
      reset = response.headers?.get?.("x-ratelimit-reset") ?? null;
      retryAfter = response.headers?.get?.("retry-after") ?? null;
    } catch { /* header shape unknown */ }
    const until = rateLimitUntil({ status: response.status, remaining, reset, retryAfter, message: "" }, nowMs);
    return until ? { kind: "rateLimited", rateLimitedUntil: until } : { kind: "error" };
  }
  if (!response.ok) return { kind: "error" };
  let body;
  try { body = await response.json(); } catch { return { kind: "error" }; }
  if (!Array.isArray(body) || body.length > DISCOVERY_PER_PAGE) return { kind: "error" };
  return { kind: "ok", pulls: body };
}

// Open PRs for repos whose webhook is stale or absent are matched to claims
// that carry no PR link yet. Shares the claim-pr GitHub budget: a held
// budget stops the poll, and 403/429 writes the hold. One repo per run
// without a token, four with one.
export async function discoverUnlinkedPulls(store, { env = null, fetchImpl = fetch, token = undefined, nowMs = Date.now(), deadline = Infinity } = {}) {
  const out = { repos: 0, pulls: 0, linked: [] };
  if (!store?.db || !store.workClaims) return out;
  if (readClaimPullBudget(store) > nowMs) return { ...out, rateLimited: true };
  const access = token === undefined ? githubToken(env ?? liveEnv()) : token;
  const candidates = new Map();
  for (const entry of liveClaims(store)) {
    if (!LIVE_CLAIM_STATES.has(entry.state) || !entry.owner) continue;
    if (!entry.repo || !REPO_PATTERN.test(entry.repo)) continue;
    if (pullLinks(entry.item).length > 0) continue;
    if (!candidates.has(entry.repo)) candidates.set(entry.repo, []);
    candidates.get(entry.repo).push(entry);
  }
  const repos = [...candidates.keys()].slice(0, access ? 4 : 1);
  for (const repo of repos) {
    if (Date.now() > deadline) break;
    if (!webhookDeliveryStale(store, repo, nowMs)) continue;
    if (!discoveryDue(store, repo, nowMs)) continue;
    const read = await fetchOpenPulls(repo, { fetchImpl, token: access, nowMs, deadline });
    if (read.kind === "budget") break;
    if (read.kind === "rateLimited") {
      writeClaimPullBudget(store, read.rateLimitedUntil, nowMs);
      return { ...out, rateLimited: true };
    }
    out.repos += 1;
    writeConfig(store, DISCOVERY_ROOM + repo, { nextAt: nowMs + DISCOVERY_BACKOFF_MS }, nowMs);
    if (read.kind !== "ok") continue;
    out.pulls += read.pulls.length;
    const claims = candidates.get(repo);
    store.workClaims.transaction(() => {
      for (const pr of read.pulls) {
        if (!pr || typeof pr !== "object") continue;
        const parsed = parsePullRequestUrl(typeof pr.html_url === "string" ? pr.html_url : "");
        if (!parsed || parsed.repo.toLowerCase() !== repo.toLowerCase()) continue;
        const found = findClaimForPull({
          branch: typeof pr.head?.ref === "string" ? pr.head.ref : "",
          title: typeof pr.title === "string" ? pr.title : "",
          body: typeof pr.body === "string" ? pr.body : "",
          repo,
        }, claims);
        if (!found || !found.claim) continue;
        const result = autoLinkPullRequest(store, found.claim.roomId, found.claim.id,
          { url: parsed.url, source: found.source }, { nowMs });
        if (result.linked) out.linked.push({ roomId: result.roomId, claimId: result.claimId, url: result.url, source: result.source });
      }
    });
  }
  return out;
}

// --- deploy linking ----------------------------------------------------------
// When a deploy records its version, link it back to the settled board items
// in that deploy: done items whose required revision IS the live revision
// (their merge commit is the build the deploy stamped). Items from earlier
// deploys keep their own link; nothing is overwritten.

export function linkDeployToSettledClaims(store, { revision, nowMs = Date.now() } = {}) {
  const out = { linked: 0 };
  if (typeof revision !== "string" || !SHA40.test(revision)) return { ...out, skipped: "unstamped" };
  if (!store?.db || !store.workClaims) return out;
  let roomIds = [];
  try {
    roomIds = store.db.prepare("SELECT DISTINCT room_id AS roomId FROM work_claims").all().map(row => row.roomId);
  } catch (error) {
    if (/no such table/i.test(error?.message ?? "")) return out;
    throw error;
  }
  store.workClaims.transaction(() => {
    for (const roomId of roomIds) {
      for (const item of store.workClaims.list(roomId)) {
        if (item.state !== "done") continue;
        if (item.revision !== revision) continue;
        if (item.deploy && item.deploy.revision) continue;
        const stamped = stampHistory(item, nowMs, "deploy_linked",
          `Linked deploy revision ${revision}`);
        const next = Object.freeze({
          ...item,
          deploy: Object.freeze({ revision, at: isoOf(nowMs) }),
          ...stamped,
          updatedAt: isoOf(nowMs),
        });
        store.workClaims.set(roomId, next);
        emitWorkClaimEvent(store, roomId, {
          actorId: item.owner ?? "system", item: next, action: "state_changed",
          atMs: nowMs,
        });
        out.linked += 1;
      }
    }
  });
  return out;
}
