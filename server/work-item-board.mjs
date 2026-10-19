import { terminalWork } from "../src/workflow.js";
import { hydrateWorkItems } from "./work-repository.mjs";
// Decision #10 (workItems -> board claims) — the migration core.
//
// Every projection work item (server-side state.workItems, written by the
// src/events.js reducer from the browser work-item form and the MCP work
// tools) gets a first-class row on the work-claims board (SQLite
// work_claims, keyed by boardClaimId(workItemId)). The mapping in this
// module is the single definition of "what the board should say about a
// work item": the one-shot backfill below uses it, and the write-path
// cutover (store.command) uses the same function so live writes and the
// backfill converge on identical rows by construction.
//
// Shape sources, all pinned by tests/workitems-migration-census.test.js
// (PR #3282): work item / claim / receipt / verification / decision key
// sets come from the reducer; board row fields + validators come from
// server/work-claims.mjs (workOf). Session counters (round_count,
// tool_calls, suspended_by) deliberately do NOT move: sessions are
// event-derived and re-derive keyed by claim id, and the board row has
// no fields for them (decision: E6 mapping, exec-e6-work.md).
//
// Idempotency: a mapped row is a pure function of (work item, its event
// facts, existing board row's board-native fields, now). updatedAt comes
// from the work item, never from the wall clock, so re-running the
// backfill over an unchanged room produces byte-identical rows and the
// second run writes nothing.
import { createHash } from "node:crypto";
import { emitWorkClaimEvent } from "./work-claim-events.mjs";
import { openClaimCount, roomWorkClaimConfig, workOf } from "./work-claims.mjs";

export const WORK_ITEM_BOARD_BACKFILL_VERSION = 1;
export const WORK_ITEM_BOARD_BACKFILL_TABLE = "work_item_board_backfill";
// Lazily created by this module on first use (the run-once/request_replays
// pattern); registered in server/writer-fence.mjs lazyAdditiveTables.
export const WORK_ITEM_BOARD_BACKFILL_SCHEMA = `CREATE TABLE IF NOT EXISTS ${WORK_ITEM_BOARD_BACKFILL_TABLE} (room_id TEXT PRIMARY KEY, version INTEGER NOT NULL, at TEXT NOT NULL)`;
export const WORK_ITEM_BOARD_DIVERGENCE_TABLE = "work_item_board_divergence";
// Per-room divergence snapshot (Appendix D §D.2.3 monitor): persisted
// whenever a backfill run or a sync plan computes diverged rows.
// Zero is the only healthy value; any non-zero reading re-opens #3607.
export const WORK_ITEM_BOARD_DIVERGENCE_SCHEMA = `CREATE TABLE IF NOT EXISTS ${WORK_ITEM_BOARD_DIVERGENCE_TABLE} (room_id TEXT PRIMARY KEY, diverged INTEGER NOT NULL, rework INTEGER NOT NULL, board_native INTEGER NOT NULL, at TEXT NOT NULL)`;
export const DIVERGENCE_REPAIR_NOTE = "divergence repair: board reopened to match the work item; was done";

const MAX_CLAIM_HISTORY = 200; // mirrors withHistory in server/work-claims.mjs
const isDivergenceRepairStamp = stamp => typeof stamp?.note === "string" && stamp.note.startsWith("divergence repair:");
// Apply the MAX_CLAIM_HISTORY cap to a board row's history. Event-derived
// stamps drop oldest-first and are counted in `dropped`; divergence-repair
// stamps are exempt — they are board-native (no journal event re-derives
// them), so dropping one would destroy the only record of a repair and
// fold the loss silently into the generic historyOmitted counter.
function capBoardHistory(history) {
  if (history.length <= MAX_CLAIM_HISTORY) return { history, dropped: 0 };
  const kept = [...history];
  let dropped = 0;
  while (kept.length > MAX_CLAIM_HISTORY) {
    const index = kept.findIndex(stamp => !isDivergenceRepairStamp(stamp));
    if (index === -1) break; // only repair stamps remain: they stay, over cap
    kept.splice(index, 1);
    dropped += 1;
  }
  return { history: kept, dropped };
}
const MAX_CHAIN = 20;
const MAX_REVIEWS = 50;
const MAX_EVIDENCE_REFS = 16;
const MAX_BLOBS = 10;
const MAX_PULLS = 20;
const SUCCESSOR_TITLE_MAX_CHARS = 512; // same bound as the mirror's successor cards
const TAG_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const BLOB_PATTERN = /^sha256:[0-9a-f]{64}$/;
const BOARD_SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

// The claim id a work item maps to on the board. Moved here verbatim
// from the former server/work-claim-mirror.mjs in step 1 of the
// migration (the mirror module itself was cut in step 2):
// ids that are already board-safe pass through unchanged, so existing
// cards — and receipts, rc_<claim id> — keep their ids. Any other id is
// encoded reversibly instead of squashed: "_" is the escape character
// ("__" is "_", "_p" is ".", "_c" is ":", "_x<hex>_" is any other
// character by code point) and the result takes an "_e" prefix. Valid
// work item ids start with a letter or digit (src/events.js validId),
// so a pass-through id can never start with "_" and the encoded space
// is disjoint from it: "task.1", "task:1" and "task_1" land on three
// different cards. An encoding that would overflow the 128-char board
// limit falls back to "_h" plus a SHA-256 prefix of the original id —
// deterministic, and two distinct ids collide only if their digests
// do. (The previous mapping replaced every non-board character with
// "_" and truncated to 120 chars, merging distinct ids onto one card;
// #2854.)
export function boardClaimId(workItemId) {
  if (typeof workItemId === "string" && BOARD_SAFE_ID.test(workItemId)) return workItemId;
  const raw = String(workItemId ?? "");
  if (!raw) return "workitem";
  let encoded = "";
  for (const char of raw) {
    if (/^[A-Za-z0-9-]$/.test(char)) encoded += char;
    else if (char === "_") encoded += "__";
    else if (char === ".") encoded += "_p";
    else if (char === ":") encoded += "_c";
    else encoded += `_x${char.codePointAt(0).toString(16)}_`;
  }
  const candidate = `_e${encoded}`;
  if (BOARD_SAFE_ID.test(candidate)) return candidate;
  return `_h${createHash("sha256").update(raw).digest("hex").slice(0, 40)}`;
}

const iso = ms => new Date(ms).toISOString();
const isoOrNull = value => (typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null);
const msOf = value => (typeof value === "string" ? Date.parse(value) : Number.NaN);
const cleanText = (value, max) => (typeof value === "string" && value.length > 0 ? value.slice(0, max) : null);

// Files a claimed work item pins, in the board's stored shape (files: path
// strings; fileBlocks: path -> named block). Same normalization the mirror
// applied from claim data: block-labeled paths keep their label.
function filesFromClaim(claim, blocks) {
  const labels = new Map();
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!block || typeof block !== "object" || typeof block.path !== "string") continue;
    const name = typeof block.block === "string" ? block.block
      : (typeof block.region === "string" ? block.region : (typeof block.name === "string" ? block.name : null));
    if (name) labels.set(block.path, name.slice(0, 128));
  }
  const files = [];
  const fileBlocks = {};
  const seen = new Set();
  const add = path => {
    if (typeof path !== "string" || path.length === 0 || seen.has(path)) return;
    seen.add(path);
    files.push(path);
    if (labels.has(path)) fileBlocks[path] = labels.get(path);
  };
  for (const path of claim?.paths ?? []) add(path);
  for (const path of labels.keys()) add(path);
  return { files, fileBlocks };
}

// Pull links in the board's stored shape. The engine's pullRequestOf
// drops anything that is not a GitHub pull URL and derives repo/number
// from the URL; fresh links carry null sync state. Mirroring that here
// keeps a backfilled row identical to the row the board would have built.
function pullRequestsFrom(value) {
  const out = [];
  const seen = new Set();
  for (const entry of Array.isArray(value) ? value : []) {
    const url = typeof entry === "string" ? entry : entry?.url;
    if (typeof url !== "string" || seen.has(url)) continue;
    const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(url);
    if (!match) continue;
    seen.add(url);
    out.push({
      url, repo: `${match[1]}/${match[2]}`, number: Number.parseInt(match[3], 10),
      outcome: null, syncedAt: null, nextPollAt: null, etag: null,
      rateLimitedUntil: null, pollBackoffMs: null, ciCursor: null, ciStatus: null,
    });
    if (out.length >= MAX_PULLS) break;
  }
  return out;
}

// Event facts for one work item, gathered from the room's event log in
// sequence order. The projection item is authoritative for content; the
// log supplies what the item does not timestamp (transition times,
// verification/decision times, claim pull links and file blocks).
export function workItemEventFacts(events) {
  const byItem = new Map();
  for (const event of events ?? []) {
    const workItemId = event?.data?.workItemId;
    if (typeof workItemId !== "string" || workItemId.length === 0) continue;
    let facts = byItem.get(workItemId);
    if (!facts) {
      facts = { events: [], byEventId: new Map(), pullRequests: [], blocks: [], supersedeEvents: [] };
      byItem.set(workItemId, facts);
    }
    facts.events.push(event);
    if (typeof event.id === "string") facts.byEventId.set(event.id, event);
    if (event.type === "claim.acquired") {
      // The live claim scope is the latest acquisition's scope.
      if (Array.isArray(event.data?.pullRequests)) facts.pullRequests = event.data.pullRequests;
      if (Array.isArray(event.data?.blocks)) facts.blocks = event.data.blocks;
    }
    if (event.type === "work.superseded") facts.supersedeEvents.push(event);
    // A supersede also names its target; the target's card needs the
    // lineage even when the target is not itself a work item here.
    if (event.type === "work.superseded" && typeof event.data?.supersededByWorkItemId === "string") {
      let target = byItem.get(event.data.supersededByWorkItemId);
      if (!target) {
        target = { events: [], byEventId: new Map(), pullRequests: [], blocks: [], supersedeEvents: [] };
        byItem.set(event.data.supersededByWorkItemId, target);
      }
      target.supersededByEvent = event;
    }
  }
  return byItem;
}

const eventAt = (facts, eventId, fallback) => {
  const event = eventId ? facts?.byEventId?.get(eventId) : null;
  return isoOrNull(event?.at) ?? isoOrNull(fallback);
};

// Board history stamps for a work item, in event order, using the board
// engine's own stamp vocabulary (created / claimed / renewed /
// state:<state> / reviewed / closed). The receipts surface reads the
// state:done stamp's note as the receipt summary, so completion stamps
// carry the receipt that completion produced. Capped exactly like the
// engine's withHistory: newest 200 kept, the rest counted as omitted.
function historyForWorkItem(item, facts) {
  const stamps = [];
  const push = (at, agentId, action, note) => {
    const stampAt = isoOrNull(at);
    if (!stampAt) return;
    stamps.push({ at: stampAt, agentId: typeof agentId === "string" && agentId.length > 0 ? agentId : "system", action, note: note ?? null });
  };
  let boardState = "unclaimed";
  let claimHeld = false;
  const receipts = [...(item.receiptHistory ?? []), ...(item.receipt ? [item.receipt] : [])];
  const receiptForEvent = eventId => receipts.find(receipt => receipt?.eventId === eventId) ?? null;
  for (const event of facts?.events ?? []) {
    const at = event.at, actor = event.actorId;
    switch (event.type) {
      case "work.proposed":
        push(at, actor, "created", null);
        boardState = "unclaimed";
        break;
      case "claim.acquired":
        push(at, actor, "claimed", null);
        claimHeld = true;
        boardState = "claimed";
        break;
      case "claim.renewed":
        push(at, actor, "renewed", null);
        break;
      case "claim.released":
        if (boardState === "in_progress" || boardState === "blocked") push(at, actor, "state:claimed", null);
        push(at, actor, "state:unclaimed", null);
        claimHeld = false;
        boardState = "unclaimed";
        break;
      case "work.started":
        if (boardState !== "in_progress") push(at, actor, "state:in_progress", null);
        boardState = "in_progress";
        break;
      case "work.blocked":
        push(at, actor, "state:blocked", cleanText(event.data?.reason, 2000));
        boardState = "blocked";
        break;
      case "work.blocker_resolved": {
        const next = claimHeld ? "claimed" : "unclaimed";
        if (boardState === "blocked") push(at, actor, `state:${next}`, null);
        boardState = next;
        break;
      }
      case "work.completed": {
        const receipt = receiptForEvent(event.id);
        boardState = !item.ownerDecisionRequired && !item.independentVerificationRequired && receipt?.evidenceVersion ? "done" : "delivered";
        push(at, actor, `state:${boardState}`, cleanText(receipt?.summary ?? item.receipt?.summary, 2000));
        claimHeld = false;
        break;
      }
      case "work.superseded":
        push(at, actor, "closed", cleanText(event.data?.reason, 2000));
        claimHeld = false;
        boardState = "closed";
        break;
      case "verification.recorded": {
        // Event data is flat: { result, summary, completionEventId, ... }.
        const failed = event.data?.result === "fail";
        push(at, actor, "reviewed", cleanText(event.data?.summary, 512));
        if (!failed && !item.ownerDecisionRequired && terminalWork(item) && event.data?.completionEventId === item.receipt?.eventId) {
          push(at, actor, "state:done", cleanText(item.receipt?.summary, 2000));
          boardState = "done";
        }
        if (failed) { push(at, actor, "state:blocked", cleanText(event.data?.summary, 2000)); boardState = "blocked"; }
        break;
      }
      case "owner.decision_recorded": {
        // Event data is flat: { decision, reason, completionEventId, ... }.
        push(at, actor, "reviewed", cleanText(event.data?.reason, 512));
        if (event.data?.decision === "approved" && terminalWork(item) && event.data?.completionEventId === item.receipt?.eventId) {
          push(at, actor, "state:done", cleanText(item.receipt?.summary, 2000));
          boardState = "done";
        }
        if (typeof event.data?.decision === "string" && event.data.decision !== "approved") {
          push(at, actor, "state:blocked", cleanText(event.data?.reason, 2000));
          boardState = "blocked";
        }
        break;
      }
      default:
        break;
    }
  }
  if (stamps.length === 0) push(item.createdAt, item.proposedById, "created", null);
  const omitted = Math.max(0, stamps.length - MAX_CLAIM_HISTORY);
  return { history: stamps.slice(omitted), historyOmitted: omitted };
}

// Reviews: the item's verifications and owner decisions, merged in event
// order. Board verdicts are approve / changes_requested / comment; a
// verification pass and an owner approval are approvals, everything else
// sent the item back, which is a changes_requested.
function reviewsForWorkItem(item, facts) {
  const sequenceOf = eventId => {
    const events = facts?.events ?? [];
    const index = events.findIndex(event => event.id === eventId);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  const reviews = [];
  const verifications = [...(item.verificationHistory ?? []), ...(item.verification ? [item.verification] : [])];
  for (const verification of verifications) {
    if (!verification?.verifierId) continue;
    reviews.push({
      memberId: verification.verifierId,
      verdict: verification.result === "pass" ? "approve" : "changes_requested",
      summary: cleanText(verification.summary, 2000) ?? "verification",
      url: null,
      at: eventAt(facts, verification.eventId, item.updatedAt),
      order: sequenceOf(verification.eventId),
    });
  }
  const decisions = [...(item.decisionHistory ?? []), ...(item.decision ? [item.decision] : [])];
  for (const decision of decisions) {
    if (!decision?.actorId) continue;
    reviews.push({
      memberId: decision.actorId,
      verdict: decision.decision === "approved" ? "approve" : "changes_requested",
      summary: cleanText(decision.reason, 2000) ?? "owner decision",
      url: null,
      at: eventAt(facts, decision.eventId, item.updatedAt),
      order: sequenceOf(decision.eventId),
    });
  }
  reviews.sort((a, b) => a.order - b.order);
  return reviews.slice(-MAX_REVIEWS).map(({ order, ...review }) => review);
}

// Attestations: one per completion (receipt history + current receipt).
// The producer attests the delivery; the completion event supplies the
// time (receipts carry no timestamp of their own).
function attestationsForWorkItem(item, facts) {
  const receipts = [...(item.receiptHistory ?? []), ...(item.receipt ? [item.receipt] : [])];
  const attestations = [];
  for (const receipt of receipts) {
    const memberId = receipt?.producerId ?? receipt?.reportedById;
    if (typeof memberId !== "string" || memberId.length === 0) continue;
    attestations.push({
      memberId,
      at: eventAt(facts, receipt.eventId, item.updatedAt),
      note: cleanText(receipt.summary, 512),
    });
  }
  return attestations;
}

function evidenceForWorkItem(item) {
  const receipts = [...(item.receiptHistory ?? []), ...(item.receipt ? [item.receipt] : [])];
  const refs = [];
  const blobs = [];
  for (const receipt of receipts) {
    const url = receipt?.evidenceUrl;
    if (typeof url === "string" && url.startsWith("https://") && url.length <= 512 && !refs.includes(url)) refs.push(url);
    const version = receipt?.evidenceVersion;
    if (typeof version === "string" && BLOB_PATTERN.test(version) && !blobs.includes(version)) blobs.push(version);
  }
  return { evidenceRefs: refs.slice(0, MAX_EVIDENCE_REFS), blobs: blobs.slice(-MAX_BLOBS) };
}

// The board state a work item's lifecycle maps to (E6's ratified mapping):
// accepted -> unclaimed, or claimed while a live claim lease runs;
// working -> in_progress; blocked -> blocked; completed -> done;
// superseded -> closed. PROPOSED items map to NO card: the board has no
// draft state, an unclaimed card is claimable by definition of the
// board's availability predicate (server/available-work.mjs offers
// every usable unclaimed claim), and the work-item door's contract is
// that proposed work is not claimable until accepted. E6's table said
// "proposed -> unclaimed"; that predates the shipped AvailableWork
// predicate, and following it literally would make unaccepted work
// claimable through the board door. A proposed item's card appears the
// moment it is accepted (the write-path cutover syncs on that command).
// A claim is live only while its status is active and its lease has not
// expired at `nowMs` — an expired lease is exactly what the board's own
// sweep would release.
export function boardStateForWorkItem(item, nowMs) {
  switch (item?.state) {
    case "superseded": return "closed";
    case "completed": return terminalWork(item) ? "done" : "delivered";
    case "blocked": return "blocked";
    case "working": return "in_progress";
    case "accepted": return liveClaim(item, nowMs) ? "claimed" : "unclaimed";
    default: return "unclaimed"; // proposed
  }
}

export function liveClaim(item, nowMs) {
  const claim = item?.claim;
  if (!claim || claim.status !== "active") return null;
  const expires = msOf(claim.expiresAt);
  if (!Number.isFinite(expires) || expires <= nowMs) return null;
  return claim;
}

// The mapped board row for one work item. `existing` is the row already
// on the board for this item (decoded from work_claims), if any: fields
// the board owns natively and the work item cannot express (ci, deploy
// receipts, reading acks, request outcomes, squad placement, delivery
// mode, parent link) are preserved from it, and reviews/attestations the
// board collected itself are unioned in — the mapping owns the work
// item's lifecycle, not the board's own enrichments.
export function boardClaimForWorkItem(item, facts = null, { nowMs = Date.now(), existing = null } = {}) {
  if (!item || typeof item.id !== "string" || item.id.length === 0) return null;
  if (item.state === "proposed") return null; // no card until accepted (see boardStateForWorkItem)
  const id = boardClaimId(item.id);
  const state = boardStateForWorkItem(item, nowMs);
  const live = liveClaim(item, nowMs);
  // The claim scope (files, repo, branch, pull links) rides while the
  // item is claimed or was claimed when it finished/blocked; a released
  // claim on an unclaimed card is cleared, exactly as the board's own
  // release clears files.
  const claimForScope = live ?? (state === "done" || state === "blocked" || state === "in_progress" ? item.claim ?? null : null);
  const scope = claimForScope ? filesFromClaim(claimForScope, facts?.blocks) : { files: [], fileBlocks: {} };

  let owner = null;
  let claimedAt = null;
  let leaseStartAt = null;
  let leaseExpiresAt = null;
  if (live) {
    owner = live.holderId ?? null;
    claimedAt = isoOrNull(live.acquiredAt);
    leaseStartAt = isoOrNull(live.renewedAt ?? live.acquiredAt);
    leaseExpiresAt = isoOrNull(live.expiresAt);
  } else if (state === "in_progress" || state === "blocked") {
    // Working/blocked without a live lease: the accountable member is
    // doing (or stuck on) the work. Read-mode items never hold claims;
    // their owner + start time come from the item and its start event.
    owner = item.claim?.holderId ?? item.accountableMemberId ?? null;
    if (item.claim) {
      claimedAt = isoOrNull(item.claim.acquiredAt);
      leaseStartAt = isoOrNull(item.claim.renewedAt ?? item.claim.acquiredAt);
      leaseExpiresAt = isoOrNull(item.claim.expiresAt);
    } else {
      const started = (facts?.events ?? []).findLast(event => event.type === "work.started");
      claimedAt = isoOrNull(started?.at) ?? isoOrNull(item.updatedAt);
    }
    if (state === "in_progress" && !item.claim) { leaseStartAt = null; leaseExpiresAt = null; }
  } else if (state === "done") {
    owner = item.claim?.holderId ?? item.accountableMemberId ?? null;
    if (item.claim) {
      claimedAt = isoOrNull(item.claim.acquiredAt);
      leaseStartAt = isoOrNull(item.claim.renewedAt ?? item.claim.acquiredAt);
      leaseExpiresAt = isoOrNull(item.claim.expiresAt);
    }
  }

  let { history, historyOmitted } = historyForWorkItem(item, facts);
  // Divergence-repair stamps are board-native history the event mapping
  // cannot re-derive: preserve them from the existing row (in time
  // order) so a repaired row is a fixed point of re-mapping — without
  // this, the next sync/backfill would silently drop the reopen record.
  for (const stamp of existing?.history ?? []) {
    if (!isDivergenceRepairStamp(stamp)) continue;
    if (history.some(entry => entry.at === stamp.at && entry.agentId === stamp.agentId && entry.action === stamp.action && entry.note === stamp.note)) continue;
    const at = isoOrNull(stamp.at) ?? iso(nowMs);
    const index = history.findIndex(entry => entry.at > at);
    history.splice(index === -1 ? history.length : index, 0, { at, agentId: typeof stamp.agentId === "string" && stamp.agentId ? stamp.agentId : "system", action: stamp.action, note: stamp.note });
  }
  const cappedHistory = capBoardHistory(history);
  history = cappedHistory.history; historyOmitted += cappedHistory.dropped;
  const reviews = reviewsForWorkItem(item, facts);
  const attestations = attestationsForWorkItem(item, facts);
  const evidence = evidenceForWorkItem(item);

  // Chain links: supersede + each recorded handoff, in event order.
  const chain = [];
  for (const event of facts?.events ?? []) {
    const atIso = isoOrNull(event.at);
    if (!atIso) continue;
    if (event.type === "work.superseded" && typeof event.data?.supersededByWorkItemId === "string") {
      chain.push({ kind: "supersede", targetId: boardClaimId(event.data.supersededByWorkItemId), at: atIso, actorId: event.actorId ?? "system", note: cleanText(event.data?.reason, 2000) });
    } else if (event.type === "work.handoff_recorded") {
      chain.push({ kind: "handoff", targetId: boardClaimId(`${item.id}-next`), at: atIso, actorId: event.actorId ?? "system", note: cleanText(event.data?.nextAction, 2000) });
    }
  }

  const tags = new Set((Array.isArray(item.labels) ? item.labels : []).filter(tag => TAG_PATTERN.test(tag)));
  if (Array.isArray(existing?.tags)) for (const tag of existing.tags) if (TAG_PATTERN.test(tag)) tags.add(tag);

  const reviewsMerged = mergeReviews(reviews, existing?.reviews);
  const attestationsMerged = mergeAttestations(attestations, existing?.attestations);
  const evidenceRefs = [...new Set([...(existing?.evidenceRefs ?? []), ...evidence.evidenceRefs])].slice(0, MAX_EVIDENCE_REFS);
  const blobs = [...new Set([...(existing?.blobs ?? []), ...evidence.blobs])].slice(-MAX_BLOBS);

  const row = {
    id,
    title: cleanText(item.title, 512) ?? id,
    state,
    owner,
    history,
    claimedAt,
    leaseStartAt,
    leaseExpiresAt,
    deliveryMode: existing?.deliveryMode ?? null,
    reviewPolicy: item.independentVerificationRequired === true ? "independent_principal"
      : (typeof item.verifierMemberId === "string" && item.verifierMemberId.length > 0 ? "distinct_member" : null),
    reviewedBy: reviewsMerged.length > 0 ? reviewsMerged[reviewsMerged.length - 1].memberId : null,
    attestations: attestationsMerged,
    tags: [...tags].slice(0, 32),
    files: scope.files,
    fileBlocks: scope.fileBlocks,
    blobs,
    // Dependencies are board-native structure (or lineage from a phantom
    // card this item grew into): the work item cannot express them, so
    // an existing row's list is preserved verbatim.
    dependsOn: Array.isArray(existing?.dependsOn) ? existing.dependsOn.filter(dep => typeof dep === "string").slice(0, 16) : [],
    parentClaimId: existing?.parentClaimId ?? null,
    evidenceRefs,
    premiseFlag: null,
    pullRequest: existing?.pullRequest ?? null,
    // Existing links and their polling outcomes belong to the board. Rebuilding
    // them from acquisition events erased board-added links and completed polls.
    pullRequests: [...new Map([
      ...pullRequestsFrom(claimForScope ? facts?.pullRequests : []),
      ...(existing?.pullRequests ?? []),
    ].map(pull => [pull.url, pull])).values()].slice(0, MAX_PULLS),
    updatedAt: isoOrNull(item.updatedAt) ?? isoOrNull(item.createdAt) ?? iso(nowMs),
    repo: claimForScope ? (claimForScope.repository ?? null) : null,
    branch: claimForScope ? (claimForScope.ref ?? null) : null,
    chain: chain.slice(-MAX_CHAIN),
    supersededBy: item.state === "superseded" && typeof item.supersededBy === "string" ? boardClaimId(item.supersededBy) : null,
    workItemId: item.id,
    squadId: existing?.squadId ?? null,
    kind: "work",
    revision: existing?.revision ?? null,
    ci: existing?.ci ?? null,
    reviews: reviewsMerged,
    readingAcks: existing?.readingAcks ?? {},
    // #3547 kernel fields: the canonical claim row carries them (workOf's
    // output shape; the registry codec defaults missing ones to []/null),
    // so a mapped row that omits them never equals its stored form and the
    // board diff never converges. The work item cannot express a delivery
    // bundle or the kernel's verification record, and its criteria live
    // on the claim, so an existing row's values are preserved verbatim.
    // #3684 added deliveryGeneration to the same shape (the claim round's
    // own delivery counter; the codec defaults it to 0): same rule — the
    // work item cannot express it, an existing row's counter is preserved
    // verbatim (normalised exactly as workOf normalises it), and resetting
    // it here would unbind approvals recorded against the live round.
    acceptanceCriteria: Array.isArray(existing?.acceptanceCriteria) ? [...existing.acceptanceCriteria] : [],
    delivery: existing?.delivery ?? null,
    verification: existing?.verification ?? null,
    claimRound: Number.isSafeInteger(existing?.claimRound) && existing.claimRound > 0 ? existing.claimRound : 0,
    deliveryGeneration: Number.isSafeInteger(existing?.deliveryGeneration) && existing.deliveryGeneration > 0 ? existing.deliveryGeneration : 0,
  };
  if (historyOmitted > 0) row.historyOmitted = historyOmitted;
  if (existing?.deploy !== undefined && existing?.deploy !== null) row.deploy = existing.deploy;
  if (existing?.requestOutcomes && typeof existing.requestOutcomes === "object" && Object.keys(existing.requestOutcomes).length > 0) row.requestOutcomes = existing.requestOutcomes;
  if (state === "blocked" && item.blocker) {
    const blockerEvent = facts?.byEventId?.get(item.blocker.eventId);
    row.premiseFlag = {
      premiseId: id,
      reason: cleanText(item.blocker.reason, 2000) ?? "blocked",
      by: blockerEvent?.actorId ?? item.accountableMemberId ?? "system",
      at: isoOrNull(blockerEvent?.at) ?? isoOrNull(item.updatedAt) ?? iso(nowMs),
    };
  }
  return row;
}

// Union a board-native review/attestation list into the mapped one,
// keyed by full content, chronological by `at`. Monotone under
// re-mapping, which is what makes re-runs idempotent.
function mergeReviews(mapped, existing) {
  if (!Array.isArray(existing) || existing.length === 0) return mapped;
  const key = review => `${review.memberId}|${review.verdict}|${review.at}|${review.summary}`;
  const seen = new Set(mapped.map(key));
  const merged = [...mapped];
  for (const review of existing) {
    if (!review || typeof review.memberId !== "string" || typeof review.at !== "string") continue;
    // Preserve the exact recorded basis, never rebind a review to today's
    // delivery. Prefer the board's complete record over an identical mapped
    // summary which cannot express its authority.
    if (seen.has(key(review))) {
      const index = merged.findIndex(entry => key(entry) === key(review));
      if (review.basis) merged[index] = { ...review };
      continue;
    }
    seen.add(key(review));
    merged.push({ ...review, url: review.url ?? null });
  }
  merged.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return merged.slice(-MAX_REVIEWS);
}
function mergeAttestations(mapped, existing) {
  if (!Array.isArray(existing) || existing.length === 0) return mapped;
  const key = attestation => `${attestation.memberId}|${attestation.at}|${attestation.note ?? ""}`;
  const seen = new Set(mapped.map(key));
  const merged = [...mapped];
  for (const attestation of existing) {
    if (!attestation || typeof attestation.memberId !== "string" || typeof attestation.at !== "string") continue;
    if (seen.has(key(attestation))) {
      const index = merged.findIndex(entry => key(entry) === key(attestation));
      if (attestation.basis) merged[index] = { ...attestation };
      continue;
    }
    seen.add(key(attestation));
    merged.push({ ...attestation, note: attestation.note ?? null });
  }
  merged.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return merged;
}

// A phantom successor card, matching the ones the mirror creates: when a
// supersede/handoff names a successor that is not itself a work item in
// the room, the successor still gets a board card so the lineage is
// visible and claimable. If a real board row already exists for it, the
// caller reconciles instead (never clobber a live card).
function phantomSuccessorCard({ targetId, title, at, by, dependsOn }) {
  return {
    id: boardClaimId(targetId),
    title: cleanText(title, SUCCESSOR_TITLE_MAX_CHARS) ?? boardClaimId(targetId),
    state: "unclaimed",
    owner: null,
    history: [{ at: isoOrNull(at) ?? iso(Date.now()), agentId: by ?? "system", action: "created", note: null }],
    claimedAt: null,
    leaseStartAt: null,
    leaseExpiresAt: null,
    deliveryMode: null,
    reviewPolicy: null,
    reviewedBy: null,
    attestations: [],
    tags: [],
    files: [],
    fileBlocks: {},
    blobs: [],
    dependsOn: [...dependsOn],
    parentClaimId: null,
    evidenceRefs: [],
    premiseFlag: null,
    pullRequest: null,
    pullRequests: [],
    updatedAt: isoOrNull(at) ?? iso(Date.now()),
    repo: null,
    branch: null,
    chain: [],
    supersededBy: null,
    workItemId: boardClaimId(targetId),
    squadId: null,
    kind: "work",
    revision: null,
    ci: null,
    reviews: [],
    readingAcks: {},
    acceptanceCriteria: [],
    delivery: null,
    verification: null,
    deliveryGeneration: 0,
  };
}

const ACTIVE_STATES = new Set(["claimed", "in_progress", "blocked"]);
const TERMINAL_BOARD_STATES = new Set(["done", "closed"]);

// Divergence classes (Appendix D §D.2, #3607). `rework` is the one class
// with a provable, transition-lite repair: the board says done, the item
// provably completed before (a work.completed event in its facts, or a
// receipt on the item), and the item now maps to a non-terminal state —
// the §4.6 completed -> blocked rework. Everything else (foreign-owner
// active claims, closed mismatches, unprovable cases) is `board_native`:
// forcing those rows stays prohibited and the skip is preserved exactly.
function provablyCompleted(item, facts) {
  return (facts?.events ?? []).some(event => event.type === "work.completed")
    || Boolean(item?.receipt) || (Array.isArray(item?.receiptHistory) && item.receiptHistory.length > 0);
}
export function classifyWorkItemBoardDivergence(current, mapped, item, facts) {
  // A board delivery is an independent execution record. Work receipts cannot
  // prove that its verification or send-back should be rewritten.
  if (current?.delivery) return "board_native";
  if (current?.state === "done" && !TERMINAL_BOARD_STATES.has(mapped?.state) && provablyCompleted(item, facts)) return "rework";
  return "board_native";
}

// Transition-lite repair for a rework row: the mapped row (which already
// carries the mapping's history stamps for the item's current state —
// e.g. the state:blocked stamp from the reopening work.blocked event,
// after the state:done stamp) plus one explicit repair stamp naming the
// reopen a divergence repair. The done stamp stays: history is
// append-only, and the stamps after it are what receipts must read.
function reworkRepairRow(mapped, item, facts, nowMs) {
  const reopen = [...(facts?.events ?? [])].reverse().find(event => event.type === "work.blocked");
  const stamp = {
    at: isoOrNull(reopen?.at) ?? isoOrNull(item?.updatedAt) ?? iso(nowMs),
    agentId: typeof reopen?.actorId === "string" && reopen.actorId ? reopen.actorId : "system",
    action: `state:${mapped.state}`, note: DIVERGENCE_REPAIR_NOTE,
  };
  if (mapped.history.some(entry => entry.at === stamp.at && entry.agentId === stamp.agentId && entry.action === stamp.action && entry.note === stamp.note)) return mapped;
  const capped = capBoardHistory([...mapped.history, stamp]);
  const row = { ...mapped, history: capped.history };
  const omitted = (mapped.historyOmitted ?? 0) + capped.dropped;
  if (omitted > 0) row.historyOmitted = omitted; else delete row.historyOmitted;
  return row;
}

// Plan one room's backfill without writing: the rows the board should
// hold for the room's work items, plus the items whose live board row
// disagrees with the work item's own lifecycle (board-native divergence
// — e.g. a mirrored card was claimed directly through the board door).
// Board-native diverged rows are never overwritten by the backfill; an
// operator (or the item's next command, post-cutover) resolves them.
// Rework-class diverged rows are the sole exception: they enter the
// write plan as a transition-lite repair (see reworkRepairRow).
export function planWorkItemBoardBackfill({ items, events = [], existing = new Map(), nowMs = Date.now() } = {}) {
  const factsByItem = workItemEventFacts(events);
  const rows = new Map();
  const diverged = [];
  for (const item of items ?? []) {
    if (!item || typeof item.id !== "string") continue;
    const claimId = boardClaimId(item.id);
    const current = existing.get(claimId) ?? null;
    const mapped = boardClaimForWorkItem(item, factsByItem.get(item.id) ?? null, { nowMs, existing: current });
    if (!mapped) continue;
    if (current && isDiverged(current, mapped, item)) {
      const facts = factsByItem.get(item.id) ?? null;
      const entry = { workItemId: item.id, claimId, boardState: current.state, itemState: item.state, class: classifyWorkItemBoardDivergence(current, mapped, item, facts) };
      diverged.push(entry);
      // Rework rows are repaired, not skipped; board_native rows stay
      // excluded from the write plan (forcing them is prohibited).
      if (entry.class === "rework") rows.set(claimId, reworkRepairRow(mapped, item, facts, nowMs));
      continue;
    }
    rows.set(claimId, mapped);
  }
  // Successor lineage: the source card carries chain + supersededBy;
  // the successor's card carries dependsOn [source] — the mirror's
  // shape, created at supersede time whenever the successor has no card
  // yet (a phantom, even when the successor is a merely-proposed work
  // item; its own mapping later replaces the phantom's title and keeps
  // the dependsOn, which the mapping preserves from existing rows). A
  // successor that already has a board row of its own (board-native, or
  // mapped from its item) is never given lineage it did not have —
  // except the mapped-row case below, where the plan owns the row.
  for (const item of items ?? []) {
    if (!item || item.state !== "superseded" || typeof item.supersededBy !== "string") continue;
    const sourceId = boardClaimId(item.id);
    const targetId = boardClaimId(item.supersededBy);
    if (targetId === sourceId) continue;
    const supersedeEvent = (factsByItem.get(item.id)?.supersedeEvents ?? [])[0];
    if (rows.has(targetId)) {
      const target = rows.get(targetId);
      if (!target.dependsOn.includes(sourceId)) {
        target.dependsOn = [...target.dependsOn, sourceId].slice(0, 16);
      }
    } else if (!existing.has(targetId)) {
      rows.set(targetId, phantomSuccessorCard({
        targetId: item.supersededBy,
        title: item.supersededBy,
        at: supersedeEvent?.at ?? item.updatedAt,
        by: supersedeEvent?.actorId,
        dependsOn: [sourceId],
      }));
    }
  }
  // Handoff successors: "<item>-next" phantom cards for items with a
  // recorded handoff, when no row for them exists yet. The title is the
  // FIRST handoff's nextAction — the mirror creates the card at the
  // first handoff and never retitles it.
  for (const item of items ?? []) {
    if (!item || (!item.handoff && !(item.handoffHistory?.length > 0))) continue;
    const nextId = boardClaimId(`${item.id}-next`);
    if (rows.has(nextId) || existing.has(nextId)) continue;
    const firstHandoff = (factsByItem.get(item.id)?.events ?? []).find(event => event.type === "work.handoff_recorded");
    rows.set(nextId, phantomSuccessorCard({
      targetId: `${item.id}-next`,
      title: firstHandoff?.data?.nextAction ?? item.handoff?.nextAction ?? `${item.id}-next`,
      at: firstHandoff?.at ?? item.updatedAt,
      by: firstHandoff?.actorId,
      dependsOn: [boardClaimId(item.id)],
    }));
  }
  return { rows, diverged };
}

function isDiverged(current, mapped, item) {
  // The work projection has no representation of a board delivery or its
  // exact review round. Even when both say in_progress after send-back,
  // rebuilding the row would erase execution history and stale its fences.
  if (current.delivery && !sameClaimRow(current, mapped)) return true;
  // A stale mirror card for THIS item is not divergence: it sits in an
  // active state under the item's own claim holder or accountable
  // member (the mirror never learned work.started / work.completed, so
  // its cards lag the lifecycle) and the mapping simply brings it
  // current. Divergence is a board row whose state the work item cannot
  // explain at all: an active claim held by someone the item has never
  // named (a board-native claim taken through the board door), or a
  // terminal board state (done/closed) the item has not reached.
  const principals = new Set([item?.claim?.holderId, item?.accountableMemberId].filter(Boolean));
  if (ACTIVE_STATES.has(current.state) && current.owner && !principals.has(current.owner)) return true;
  if (current.state === "done" && mapped.state !== "done") return true;
  if (current.state === "closed" && mapped.state !== "closed") return true;
  return false;
}

// Canonical comparison for the unchanged check: both sides are board rows
// (existing rows arrive decoded from the registry; mapped rows are built
// above), so a sorted-key JSON form is stable across runs.
export function canonicalClaimRow(row) {
  if (row === null || typeof row !== "object") return row;
  if (Array.isArray(row)) return row.map(canonicalClaimRow);
  const out = {};
  for (const key of Object.keys(row).sort()) {
    const value = row[key];
    if (value === undefined) continue;
    out[key] = canonicalClaimRow(value);
  }
  return out;
}
export const sameClaimRow = (a, b) => JSON.stringify(canonicalClaimRow(a)) === JSON.stringify(canonicalClaimRow(b));

// Backfill one room: read its work items + event log, plan the board
// rows, and write only the rows that differ. Returns a report; with
// dryRun, writes nothing. Emits NO room events — the work_claims table
// is the board's source of truth and the migration must not spam the
// room timeline or fire receipt cards for historical completions.
// Only these event types supply timestamps, claim scope or lineage to the
// mapping. Reuse the existing type index instead of decoding every message
// and unrelated board event on each work command.
export const WORK_ITEM_BOARD_EVENT_SQL = `SELECT body FROM events INDEXED BY events_room_type
  WHERE room_id=? AND json_extract(body, '$.type') IN (
    'work.proposed', 'work.accepted', 'work.started', 'work.blocked',
    'work.blocker_resolved', 'work.completed', 'work.superseded',
    'work.handoff_recorded', 'claim.acquired', 'claim.renewed',
    'claim.released', 'verification.recorded', 'owner.decision_recorded'
  ) ORDER BY sequence`;
export function roomEvents(store, roomId) {
  store.ensureEventTypeIndex();
  return store.db.prepare(WORK_ITEM_BOARD_EVENT_SQL).all(roomId)
    .map(row => { try { return JSON.parse(row.body); } catch { return null; } })
    .filter(Boolean);
}

// Persist one room's divergence snapshot from a computed diverged list.
// The snapshot is the last computation's counts, split by class; a later
// clean computation overwrites it with zeros. Zero is the only healthy
// value.
function recordWorkItemBoardDivergence(store, roomId, diverged, nowMs) {
  if (!store?.db) return;
  store.db.exec(WORK_ITEM_BOARD_DIVERGENCE_SCHEMA);
  const rework = (diverged ?? []).filter(entry => entry.class === "rework").length;
  store.db.prepare(`INSERT INTO ${WORK_ITEM_BOARD_DIVERGENCE_TABLE} (room_id, diverged, rework, board_native, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(room_id) DO UPDATE SET diverged=excluded.diverged, rework=excluded.rework, board_native=excluded.board_native, at=excluded.at`)
    .run(roomId, (diverged ?? []).length, rework, (diverged ?? []).length - rework, iso(nowMs));
}

// Read the divergence snapshot: one room's last snapshot (or null when
// none has been computed), or, without a roomId, the store aggregate
// { divergedRooms, divergedRows, rework, boardNative, rooms } the health
// surface reads. A store with no snapshot table yet reads as zero.
export function workItemBoardDivergence(store, roomId = null) {
  const empty = { divergedRooms: 0, divergedRows: 0, rework: 0, boardNative: 0, rooms: [] };
  if (!store?.db) return roomId ? null : empty;
  let exists = false;
  try { exists = Boolean(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(WORK_ITEM_BOARD_DIVERGENCE_TABLE)); } catch { exists = false; }
  if (!exists) return roomId ? null : empty;
  const shape = row => ({ roomId: row.room_id, diverged: row.diverged, rework: row.rework, boardNative: row.board_native, at: row.at });
  if (roomId) {
    const row = store.db.prepare(`SELECT * FROM ${WORK_ITEM_BOARD_DIVERGENCE_TABLE} WHERE room_id=?`).get(roomId);
    return row ? shape(row) : null;
  }
  const rooms = store.db.prepare(`SELECT * FROM ${WORK_ITEM_BOARD_DIVERGENCE_TABLE} ORDER BY room_id`).all().map(shape);
  return {
    divergedRooms: rooms.filter(room => room.diverged > 0).length,
    divergedRows: rooms.reduce((sum, room) => sum + room.diverged, 0),
    rework: rooms.reduce((sum, room) => sum + room.rework, 0),
    boardNative: rooms.reduce((sum, room) => sum + room.boardNative, 0),
    rooms,
  };
}

export function backfillRoomWorkItems(store, roomId, { nowMs = Date.now(), dryRun = false } = {}) {
  const report = { roomId, items: 0, created: 0, updated: 0, unchanged: 0, diverged: [], errors: [] };
  const roomRow = store.db.prepare("SELECT projection FROM rooms WHERE id=?").get(roomId);
  if (!roomRow) { report.errors.push("room_not_found"); return report; }
  let state;
  try { state = hydrateWorkItems(store.db, roomId, JSON.parse(roomRow.projection)); } catch { report.errors.push("projection_unparseable"); return report; }
  const items = Object.values(state?.workItems ?? {});
  report.items = items.length;
  if (items.length === 0) { if (!dryRun) recordWorkItemBoardDivergence(store, roomId, [], nowMs); return report; }
  const events = roomEvents(store, roomId);
  const existing = new Map(store.workClaims.list(roomId).map(row => [row.id, row]));
  const { rows, diverged } = planWorkItemBoardBackfill({ items, events, existing, nowMs });
  report.diverged = diverged;
  // Snapshot the computed divergence (D.2.3 monitor). A dry run (the
  // shadow diff) writes nothing, snapshot included.
  if (!dryRun) recordWorkItemBoardDivergence(store, roomId, diverged, nowMs);
  const planErrors = [];
  for (const [claimId, mapped] of rows) {
    const current = existing.get(claimId) ?? null;
    if (current && diverged.some(entry => entry.claimId === claimId && entry.class !== "rework")) continue;
    try {
      // #3465: validate the mapped row through the state machine BEFORE
      // storing it. The registry's persisted-row codec decodes stored rows
      // without validation, so a row stored verbatim from the projection's
      // free-form fields (a full URL in `repository` -> `repo`, say) is
      // readable but throws on its first state-machine touch — one such
      // row wedged the claim-prs sweep for every room (#3464). Rows that
      // fail validation are reported here, never stored; an already-stored
      // row whose mapped form fails is named too, so the operator cleanup
      // can find it.
      workOf(mapped);
    } catch (error) {
      planErrors.push(`${claimId}: ${error?.message ?? String(error)}`);
      continue;
    }
    if (current && sameClaimRow(current, mapped)) { report.unchanged += 1; continue; }
    try {
      if (!dryRun) store.workClaims.set(roomId, mapped);
      if (current) report.updated += 1; else report.created += 1;
    } catch (error) {
      planErrors.push(`${claimId}: ${error?.message ?? String(error)}`);
    }
  }
  report.errors.push(...planErrors);
  return report;
}

// Read-only diff for one room: what a backfill would change. This is
// the shadow-read surface for the migration (the AvailableWork
// equivalence harness consumes the same plan).
export function diffRoomWorkItems(store, roomId, { nowMs = Date.now() } = {}) {
  const report = backfillRoomWorkItems(store, roomId, { nowMs, dryRun: true });
  return {
    roomId: report.roomId,
    items: report.items,
    missing: report.created,
    stale: report.updated,
    unchanged: report.unchanged,
    diverged: report.diverged,
    errors: report.errors,
    converged: report.created === 0 && report.updated === 0 && report.diverged.length === 0 && report.errors.length === 0,
  };
}

// Backfill every room in the store that has not yet run the current
// mapping version. The marker table makes repeat opens cheap and lets a
// future mapping version re-run the corpus deliberately. A room whose
// backfill reports errors does not advance its marker, so the next open
// retries it; the store open itself never fails on a legacy item's
// shape — the failure is reported (and logged by the caller) instead.
export function backfillAllRoomsWorkItemBoard(store, { nowMs = Date.now(), force = false } = {}) {
  const aggregate = { version: WORK_ITEM_BOARD_BACKFILL_VERSION, rooms: 0, items: 0, created: 0, updated: 0, unchanged: 0, diverged: [], errors: [] };
  store.db.exec(WORK_ITEM_BOARD_BACKFILL_SCHEMA);
  // The divergence snapshot table is this pass's sibling bookkeeping:
  // create it here, alongside the marker table, not only when a room's
  // snapshot is recorded — a store that has run the pass then always has
  // both lazy tables, which is what the purge registry's optional entry
  // and the health reader assume.
  store.db.exec(WORK_ITEM_BOARD_DIVERGENCE_SCHEMA);
  const markers = new Map(store.db.prepare(`SELECT room_id, version FROM ${WORK_ITEM_BOARD_BACKFILL_TABLE}`).all().map(row => [row.room_id, row.version]));
  const roomIds = store.db.prepare("SELECT id FROM rooms").all().map(row => row.id);
  for (const roomId of roomIds) {
    if (!force && markers.get(roomId) === WORK_ITEM_BOARD_BACKFILL_VERSION) continue;
    const report = store.transaction(() => backfillRoomWorkItems(store, roomId, { nowMs }));
    aggregate.rooms += 1;
    aggregate.items += report.items;
    aggregate.created += report.created;
    aggregate.updated += report.updated;
    aggregate.unchanged += report.unchanged;
    aggregate.diverged.push(...report.diverged.map(entry => ({ roomId, ...entry })));
    aggregate.errors.push(...report.errors.map(error => `${roomId}: ${error}`));
    if (report.errors.length === 0) {
      store.db.prepare(`INSERT INTO ${WORK_ITEM_BOARD_BACKFILL_TABLE} (room_id, version, at) VALUES (?, ?, ?) ON CONFLICT(room_id) DO UPDATE SET version=excluded.version, at=excluded.at`)
        .run(roomId, WORK_ITEM_BOARD_BACKFILL_VERSION, iso(nowMs));
    }
  }
  return aggregate;
}

// ---------------------------------------------------------------------------
// Write-path cutover (decision #10 step 2): the command layer writes
// board claims directly, from post-command projection state, through the
// same mapping the backfill uses — replacing the work-claim-mirror's
// event translation, and the mirror module is deleted in this same step
// (the repo's reachability gate does not allow a shipped module with no
// runtime importer to linger for a later cleanup PR; decision #34's
// intent — the mirror dies only once its replacement is live in the
// same change, never before — is preserved). Because sync and backfill
// share the mapping, the board converges to the same rows by
// construction; the room diff (diffRoomWorkItems) stays empty across
// live command flow.
//
// The mirror's transactional guards carry over exactly: the room
// open-claim cap and the per-member open-claim cap throw 409s that roll
// the whole command back, and a handoff/supersede naming a successor
// card that is a live claim held as someone else's work is refused
// (work_claim_conflict). A board row the item cannot explain (a live
// board-native claim by a member the item never named) is left alone —
// the mirror likewise returned such a card unchanged.

export const WORK_ITEM_BOARD_SYNC_TYPES = new Set([
  "work.accepted", "work.started", "work.blocked", "work.blocker_resolved",
  "work.completed", "work.superseded", "work.handoff_recorded",
  "claim.acquired", "claim.renewed", "claim.released",
  "verification.recorded", "owner.decision_recorded",
]);

const SYNC_ACTIVE = new Set(["claimed", "in_progress", "blocked"]);

// #3747: the command types the command layer itself treats as cleanup at
// pilot capacity (store.command's endingClaim / endingWork). Their whole
// board footprint is a resolution, including a supersession's phantom
// successor card, so the sync declares it to emitWorkClaimEvent and the
// pilot caps do not refuse it mid-transaction.
const RESOLUTION_SYNC_TYPES = new Set(["claim.released", "work.completed", "work.blocker_resolved", "work.superseded"]);

function boardConfig(store, roomId) {
  const registry = store.workClaims;
  if (typeof registry.configFor === "function") return registry.configFor(roomId);
  return roomWorkClaimConfig({ workClaims: typeof registry.rawConfig === "function" ? registry.rawConfig(roomId) : {} });
}

function refuse(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  throw error;
}

export function syncWorkItemClaim(store, roomId, actorId, incoming, state) {
  const registry = store?.workClaims;
  if (!registry || typeof registry.get !== "function" || typeof registry.set !== "function") return null;
  if (!WORK_ITEM_BOARD_SYNC_TYPES.has(incoming?.type)) return null;
  const data = incoming?.data ?? {};
  const workItemId = data.workItemId;
  if (typeof workItemId !== "string" || !workItemId) return null;
  const item = state?.workItems?.[workItemId];
  if (!item) return null;
  const nowMs = Date.parse(incoming.at);
  if (!Number.isFinite(nowMs)) return null;
  const claimId = boardClaimId(workItemId);
  const existing = new Map(registry.list(roomId).map(row => [row.id, row]));
  const current = existing.get(claimId) ?? null;

  // Occupied-successor refusal (the mirror's work_claim_conflict): a
  // handoff/supersede successor card that is a live claim NOT already
  // chained to this source belongs to someone else's work.
  if (incoming.type === "work.handoff_recorded" || (incoming.type === "work.superseded" && typeof data.supersededByWorkItemId === "string")) {
    const targetId = incoming.type === "work.handoff_recorded" ? boardClaimId(`${workItemId}-next`) : boardClaimId(data.supersededByWorkItemId);
    const successorRow = existing.get(targetId);
    if (successorRow && SYNC_ACTIVE.has(successorRow.state) && !(successorRow.dependsOn ?? []).includes(claimId)) {
      refuse(409, "work_claim_conflict", `Board card ${targetId} is already claimed. It is not a successor of ${claimId}.`);
    }
  }

  // Holder refusal (DCP-1 / D-1): the registry row is the holder
  // authority — a claim-taking event by a member who is not the primary
  // row's active holder would mint a second hold in the projection
  // while the board keeps the first, and the divergence skip below
  // would let it pass silently (the diverged board_native row is
  // exactly the board-first claim). Refuse inside the transaction so
  // the command rolls back with nothing written. The skip stays for
  // every non-claim-taking type: a release by the projection holder
  // still leaves a foreign board hold untouched, and the diverged row
  // itself is never rewritten here.
  const claimTaking = incoming.type === "claim.acquired" || incoming.type === "claim.renewed";
  if (claimTaking && current && SYNC_ACTIVE.has(current.state) && current.owner && current.owner !== actorId) {
    refuse(409, "work_claim_conflict", `Work "${claimId}" is held by ${current.owner} — ask them to reassign or release it`);
  }

  const events = roomEvents(store, roomId);
  const { rows, diverged } = planWorkItemBoardBackfill({
    items: Object.values(state.workItems ?? {}), events, existing, nowMs,
  });
  // Surface the computed divergence (D.2.3 monitor) even when the sync
  // below skips: the silent skip becomes a counted skip.
  recordWorkItemBoardDivergence(store, roomId, diverged, nowMs);
  // A board_native diverged primary row is the board's own live state,
  // not the item's to rewrite: leave the whole sync alone (mirror
  // parity). A rework primary is the exception: its repaired row is in
  // the plan and flows through the normal write/event path below.
  if (diverged.some(entry => entry.claimId === claimId && entry.class !== "rework")) return current;
  const mapped = rows.get(claimId) ?? null;

  // Caps, checked before any write so a refusal rolls the command back
  // with nothing written (the surrounding transaction does the rest).
  const config = boardConfig(store, roomId);
  if (mapped && !current && openClaimCount([...existing.values()], nowMs) >= config.maxOpenClaims) {
    refuse(409, "work_board_full", `This room already has ${config.maxOpenClaims} open claims. Close stale claims (close or cancel) before opening another.`);
  }
  const takesCard = incoming.type === "claim.acquired" || (incoming.type === "claim.renewed" && !current);
  if (mapped && takesCard && (!current || current.state === "unclaimed")) {
    const held = [...existing.values()].filter(entry => entry.owner === actorId && SYNC_ACTIVE.has(entry.state)).length;
    if (held >= config.maxMemberOpenClaims) {
      refuse(409, "too_many_open_claims", `You already hold ${config.maxMemberOpenClaims} open claims. Release or finish one before claiming another.`);
    }
  }

  // Write only rows that differ (unchanged rows stay untouched, so a
  // no-op command emits nothing). Events fire for the command's own
  // item, plus "created" for any phantom successor the plan produced.
  const resolving = RESOLUTION_SYNC_TYPES.has(incoming.type);
  let primary = current;
  for (const [rowId, row] of rows) {
    const before = existing.get(rowId) ?? null;
    if (before && sameClaimRow(before, row)) { if (rowId === claimId) primary = row; continue; }
    registry.set(roomId, row);
    if (rowId === claimId) primary = row;
    if (!before) emitWorkClaimEvent(store, roomId, { actorId, item: row, action: "created", resolving, atMs: nowMs });
  }
  if (mapped && current && sameClaimRow(current, mapped)) return primary;
  if (mapped) {
    const action = !current
      ? (incoming.type === "claim.acquired" || incoming.type === "claim.renewed" ? "claimed" : null)
      : incoming.type === "claim.acquired" ? "claimed"
        : incoming.type === "claim.renewed" ? "renewed"
          : incoming.type === "claim.released" ? "released"
            : "state_changed";
    if (action) emitWorkClaimEvent(store, roomId, { actorId, item: mapped, action, previousState: current?.state ?? null, resolving, atMs: nowMs });
  }
  return primary;
}
