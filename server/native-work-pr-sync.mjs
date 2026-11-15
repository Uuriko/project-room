// Native work <-> pull request: poll-only lease renewal (no GitHub App, no
// webhook).
//
// A native write claim names the exact repository and branch it holds. When the
// claim holder opens a pull request from that branch of that repository and
// tags it `claim:<workItemId>` in the title or body, a new push to the pull
// request is evidence the holder is still working. This job reads the open pull
// requests of each repository that has an active native claim, and for every
// matching pull request whose head commit it has not yet seen it appends one
// `claim.renewed` event (attributed to the holder, source pr-poll) carrying the
// pull request URL and head commit, so the claim records its link.
//
// What makes a match: the tag names this work item AND the pull request's head
// branch equals the claim's ref AND its head repository equals the claim's
// repository. The tag alone never renews anything (anyone can open a pull
// request on a public repository); a fork cannot match because its head
// repository differs. Nothing else is authority: the renewal still passes the
// reducer's own rules (an active claim, an accepted/working/blocked item, a
// future expiry), and the holder gains nothing a manual renewal would not give.
//
// Bounds: at most MAX_RENEWALS_PER_CLAIM automatic renewals per claim (a stuck
// branch cannot hold work forever), one repository per run without a GitHub
// token and four with one, the shared claim-pr GitHub rate-limit hold, and one
// page of the 30 most recently updated open pull requests per repository.
// State lives in work_claim_config under `_native-pr-renew:` keys (no new
// table): the last head commit seen and the renewal count per claim.
import { randomUUID } from "node:crypto";
import { applyEvent, event, isRoomArchived, EVENT_TYPES as T } from "../src/events.js";
import { currentCommandContext, prepareCurrentWrite, withCurrentServingWriter } from "./current-room-repository.mjs";
import { fetchOpenPulls, githubToken, readConfig, writeConfig } from "./claim-autolink.mjs";
import { readClaimPullBudget, writeClaimPullBudget } from "./claim-pr-sync.mjs";
import { PILOT_LIMITS } from "./store.mjs";

export const NATIVE_RENEW_LEASE_MS = 60 * 60_000;
export const MAX_RENEWALS_PER_CLAIM = 48;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA40 = /^[0-9a-f]{40}$/;
const STATE_KEY = "_native-pr-renew:";
const POLL_KEY = "_native-pr-poll:";
const POLL_BACKOFF_MS = 2 * 60_000;
const MAX_CLAIMS = 200;
const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The explicit `claim:<workItemId>` tag, exact id, in a title or body.
export function hasClaimTag(text, workItemId) {
  if (typeof text !== "string" || !text || typeof workItemId !== "string" || !workItemId) return false;
  return new RegExp(`(?:^|[\\s>\\[(])claim\\s*[:=]\\s*${escapeRegExp(workItemId)}(?![A-Za-z0-9_-])`, "im").test(text);
}

// Active native claims with a repository and ref, newest lease first. Reads the
// summary rows the claim-expiry index already covers.
export function activeNativeClaims(store, nowMs) {
  let rows;
  try {
    rows = store.db.prepare(`SELECT room_id AS roomId, record_key AS workItemId, payload FROM current_room_records INDEXED BY current_native_claim_expiry
      WHERE domain='workSummary' AND json_extract(payload,'$.work.claim.status')='active'
        AND json_extract(payload,'$.work.claim.expiresAtMs')>? ORDER BY room_id, record_key LIMIT ?`).all(nowMs, MAX_CLAIMS);
  } catch (error) {
    if (/no such (table|index)/i.test(error?.message ?? "")) return [];
    throw error;
  }
  const out = [];
  for (const row of rows) {
    let work;
    try { work = JSON.parse(row.payload)?.work; } catch { continue; }
    const claim = work?.claim;
    if (!claim || claim.status !== "active" || typeof claim.holderId !== "string") continue;
    if (!["accepted", "working", "blocked"].includes(work.state)) continue;
    if (typeof claim.repository !== "string" || !REPO_PATTERN.test(claim.repository) || typeof claim.ref !== "string" || !claim.ref) continue;
    out.push({ roomId: row.roomId, workItemId: row.workItemId, holderId: claim.holderId, repository: claim.repository, ref: claim.ref, expiresAt: claim.expiresAt });
  }
  return out;
}

// Does this open pull request belong to this claim? See the header: tag, branch
// and head repository must all agree.
export function pullMatchesClaim(pull, claim) {
  if (!pull || typeof pull !== "object") return null;
  const head = pull.head;
  if (typeof head?.ref !== "string" || head.ref !== claim.ref) return null;
  if (typeof head?.repo?.full_name !== "string" || head.repo.full_name.toLowerCase() !== claim.repository.toLowerCase()) return null;
  if (typeof head?.sha !== "string" || !SHA40.test(head.sha)) return null;
  if (typeof pull.html_url !== "string" || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]{0,8}$/.test(pull.html_url)) return null;
  if (pull.html_url.toLowerCase().indexOf(`github.com/${claim.repository.toLowerCase()}/pull/`) < 0) return null;
  if (!hasClaimTag(pull.title, claim.workItemId) && !hasClaimTag(pull.body, claim.workItemId)) return null;
  return { url: pull.html_url, headSha: head.sha };
}

// One reducer-validated claim.renewed, written the way the claim receipts are:
// same transaction, same current-record proofs, holder as actor. Returns the
// event, or null when the room is archived or at capacity (renewal is a
// convenience: it never forces a write the room would refuse).
function appendRenewal(store, claim, { url, headSha }, nowMs) {
  const at = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + NATIVE_RENEW_LEASE_MS).toISOString();
  const data = { workItemId: claim.workItemId, expiresAt, prUrl: url, prHeadSha: headSha, source: "pr-poll" };
  const current = currentCommandContext(store, claim.roomId, { id: "native-pr-renew-context", type: T.CLAIM_RENEWED, data: { workItemId: claim.workItemId, expiresAt } }, { actorId: claim.holderId });
  const room = current?.room ?? store.room(claim.roomId);
  if (isRoomArchived(room.state) || room.sequence >= PILOT_LIMITS.eventsPerRoom) return null;
  const incoming = event({ id: randomUUID(), idempotencyKey: `native-pr-renew:${claim.roomId}:${claim.workItemId}:${headSha}`, type: T.CLAIM_RENEWED,
    roomId: claim.roomId, actorId: claim.holderId, at, data });
  const applied = applyEvent(room.state, incoming);
  const compact = { ...applied, eventLog: [], seenEvents: {}, seenIdempotencyKeys: {} };
  const sequence = room.sequence + 1;
  const write = current?.current ? prepareCurrentWrite(store, { roomId: claim.roomId, previous: room, state: compact, event: incoming, sequence, current: current.current }) : null;
  const projection = write?.projection ?? store.storedProjection(claim.roomId, compact);
  if (Buffer.byteLength(projection) > PILOT_LIMITS.projectionBytes) return null;
  withCurrentServingWriter(store.db, claim.roomId, () => {
    store.db.prepare("INSERT INTO events VALUES(?,?,?,?)").run(claim.roomId, sequence, incoming.id, JSON.stringify(incoming));
    store.db.prepare("UPDATE rooms SET sequence=?, projection=? WHERE id=?").run(sequence, projection, claim.roomId);
    write?.persistEntities();
  });
  try { store.agentPlugin?.fanoutRoomEvent({ roomId: claim.roomId, event: incoming }); }
  catch (error) { console.error("native lease renewal fan-out failed:", error?.message ?? error); }
  return incoming;
}

// The job body. Returns counts for the job log; never throws on one bad claim.
export async function renewNativeLeasesFromPulls(store, { env = null, fetchImpl = fetch, token = undefined, nowMs = Date.now(), deadline = Infinity } = {}) {
  const out = { repos: 0, pulls: 0, renewed: [] };
  if (!store?.db) return out;
  if (readClaimPullBudget(store) > nowMs) return { ...out, rateLimited: true };
  const claims = activeNativeClaims(store, nowMs);
  if (!claims.length) return out;
  const access = token === undefined ? githubToken(env ?? globalThis.process?.env ?? {}) : token;
  const byRepo = new Map();
  for (const claim of claims) {
    const key = claim.repository.toLowerCase();
    if (!byRepo.has(key)) byRepo.set(key, { repository: claim.repository, claims: [] });
    byRepo.get(key).claims.push(claim);
  }
  for (const { repository, claims: repoClaims } of [...byRepo.values()].slice(0, access ? 4 : 1)) {
    if (Date.now() > deadline) break;
    const poll = readConfig(store, POLL_KEY + repository.toLowerCase());
    if (Number.isFinite(Number(poll?.nextAt)) && Number(poll.nextAt) > nowMs) continue;
    const read = await fetchOpenPulls(repository, { fetchImpl, token: access, nowMs, deadline });
    if (read.kind === "budget") break;
    if (read.kind === "rateLimited") {
      writeClaimPullBudget(store, read.rateLimitedUntil, nowMs);
      return { ...out, rateLimited: true };
    }
    out.repos += 1;
    writeConfig(store, POLL_KEY + repository.toLowerCase(), { nextAt: nowMs + POLL_BACKOFF_MS }, nowMs);
    if (read.kind !== "ok") continue;
    out.pulls += read.pulls.length;
    for (const claim of repoClaims) {
      for (const pull of read.pulls) {
        const match = pullMatchesClaim(pull, claim);
        if (!match) continue;
        try {
          const renewed = store.transaction(() => {
            const key = `${STATE_KEY}${claim.roomId}:${claim.workItemId}`;
            const seen = readConfig(store, key) ?? {};
            if (seen.headSha === match.headSha) return null;
            if ((seen.renewals ?? 0) >= MAX_RENEWALS_PER_CLAIM) return null;
            const incoming = appendRenewal(store, claim, match, nowMs);
            if (!incoming) return null;
            writeConfig(store, key, { url: match.url, headSha: match.headSha, renewals: (seen.renewals ?? 0) + 1, renewedAt: nowMs }, nowMs);
            return incoming;
          });
          if (renewed) out.renewed.push({ roomId: claim.roomId, workItemId: claim.workItemId, url: match.url, headSha: match.headSha });
        } catch (error) {
          console.error("native lease renewal skipped:", error?.message ?? error);
        }
        break; // one pull request per claim per run
      }
    }
  }
  return out;
}

// Is any native claim waiting on this poll? One indexed row, no payload reads.
export function nativeRenewDueAt(store, nowMs) {
  try {
    const row = store.db.prepare(`SELECT 1 AS n FROM current_room_records INDEXED BY current_native_claim_expiry
      WHERE domain='workSummary' AND json_extract(payload,'$.work.claim.status')='active'
        AND json_extract(payload,'$.work.claim.expiresAtMs')>? LIMIT 1`).get(nowMs);
    return row ? nowMs : null;
  } catch { return null; }
}
