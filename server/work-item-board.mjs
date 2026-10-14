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

export const WORK_ITEM_BOARD_BACKFILL_VERSION = 1;
export const WORK_ITEM_BOARD_BACKFILL_TABLE = "work_item_board_backfill";
// Lazily created by this module on first use (the run-once/request_replays
// pattern); registered in server/writer-fence.mjs lazyAdditiveTables.
export const WORK_ITEM_BOARD_BACKFILL_SCHEMA = `CREATE TABLE IF NOT EXISTS ${WORK_ITEM_BOARD_BACKFILL_TABLE} (room_id TEXT PRIMARY KEY, version INTEGER NOT NULL, at TEXT NOT NULL)`;

const MAX_CLAIM_HISTORY = 200; // mirrors withHistory in server/work-claims.mjs
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
// from server/work-claim-mirror.mjs (which re-exports it during the
// migration; the mirror cut removes that module, not this mapping):
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
  const files = [];
  const fileBlocks = {};
  const seen = new Set();
  const add = (path, block) => {
    if (typeof path !== "string" || path.length === 0 || seen.has(path)) return;
    seen.add(path);
    files.push(path);
    if (typeof block === "string" && block.length > 0) fileBlocks[path] = block.slice(0, 128);
  };
  for (const path of claim?.paths ?? []) add(path, null);
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!block || typeof block !== "object") continue;
    add(block.path, typeof block.block === "string" ? block.block : (typeof block.region === "string" ? block.region : (typeof block.name === "string" ? block.name : null)));
  }
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
      case "work.completed":
        push(at, actor, "state:done", cleanText(receiptForEvent(event.id)?.summary ?? item.receipt?.summary, 2000));
        claimHeld = false;
        boardState = "done";
        break;
      case "work.superseded":
        push(at, actor, "closed", cleanText(event.data?.reason, 2000));
        claimHeld = false;
        boardState = "closed";
        break;
      case "verification.recorded": {
        // Event data is flat: { result, summary, completionEventId, ... }.
        const failed = event.data?.result === "fail";
        push(at, actor, "reviewed", cleanText(event.data?.summary, 512));
        if (failed) { push(at, actor, "state:blocked", cleanText(event.data?.summary, 2000)); boardState = "blocked"; }
        break;
      }
      case "owner.decision_recorded": {
        // Event data is flat: { decision, reason, completionEventId, ... }.
        push(at, actor, "reviewed", cleanText(event.data?.reason, 512));
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
    case "completed": return "done";
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

  const { history, historyOmitted } = historyForWorkItem(item, facts);
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
    pullRequests: claimForScope ? pullRequestsFrom(facts?.pullRequests) : [],
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
    if (seen.has(key(review))) continue;
    seen.add(key(review));
    merged.push({ memberId: review.memberId, verdict: review.verdict, summary: review.summary, url: review.url ?? null, at: review.at });
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
    if (seen.has(key(attestation))) continue;
    seen.add(key(attestation));
    merged.push({ memberId: attestation.memberId, at: attestation.at, note: attestation.note ?? null });
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
  };
}

const ACTIVE_STATES = new Set(["claimed", "in_progress", "blocked"]);

// Plan one room's backfill without writing: the rows the board should
// hold for the room's work items, plus the items whose live board row
// disagrees with the work item's own lifecycle (board-native divergence
// — e.g. a mirrored card was claimed directly through the board door).
// Diverged rows are never overwritten by the backfill; an operator (or
// the item's next command, post-cutover) resolves them.
export function planWorkItemBoardBackfill({ items, events = [], existing = new Map(), nowMs = Date.now() } = {}) {
  const factsByItem = workItemEventFacts(events);
  const rows = new Map();
  const diverged = [];
  const workItemIds = new Set();
  for (const item of items ?? []) {
    if (!item || typeof item.id !== "string") continue;
    workItemIds.add(item.id);
    const claimId = boardClaimId(item.id);
    const current = existing.get(claimId) ?? null;
    const mapped = boardClaimForWorkItem(item, factsByItem.get(item.id) ?? null, { nowMs, existing: current });
    if (!mapped) continue;
    if (current && isDiverged(current, mapped, item)) {
      diverged.push({ workItemId: item.id, claimId, boardState: current.state, itemState: item.state });
      continue;
    }
    rows.set(claimId, mapped);
  }
  // Successor lineage lives on the SOURCE card's chain + supersededBy
  // (set by the mapping above) and on phantom successor cards — exactly
  // the mirror's shape. A real successor work item's own card never
  // gains a dependsOn from lineage: the board's availability gate
  // requires dependencies to be done, and a superseded source is closed,
  // never done, so a lineage dependsOn would hide live work forever.
  for (const item of items ?? []) {
    if (!item || item.state !== "superseded" || typeof item.supersededBy !== "string") continue;
    const sourceId = boardClaimId(item.id);
    const targetId = boardClaimId(item.supersededBy);
    if (targetId === sourceId) continue;
    const supersedeEvent = (factsByItem.get(item.id)?.supersedeEvents ?? [])[0];
    if (!rows.has(targetId) && !existing.has(targetId) && !workItemIds.has(item.supersededBy)) {
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
export function backfillRoomWorkItems(store, roomId, { nowMs = Date.now(), dryRun = false } = {}) {
  const report = { roomId, items: 0, created: 0, updated: 0, unchanged: 0, diverged: [], errors: [] };
  const roomRow = store.db.prepare("SELECT projection FROM rooms WHERE id=?").get(roomId);
  if (!roomRow) { report.errors.push("room_not_found"); return report; }
  let state;
  try { state = JSON.parse(roomRow.projection); } catch { report.errors.push("projection_unparseable"); return report; }
  const items = Object.values(state?.workItems ?? {});
  report.items = items.length;
  if (items.length === 0) return report;
  const events = store.db.prepare("SELECT body FROM events WHERE room_id=? ORDER BY sequence").all(roomId)
    .map(row => { try { return JSON.parse(row.body); } catch { return null; } })
    .filter(Boolean);
  const existing = new Map(store.workClaims.list(roomId).map(row => [row.id, row]));
  const { rows, diverged } = planWorkItemBoardBackfill({ items, events, existing, nowMs });
  report.diverged = diverged;
  const planErrors = [];
  for (const [claimId, mapped] of rows) {
    const current = existing.get(claimId) ?? null;
    if (current && diverged.some(entry => entry.claimId === claimId)) continue;
    if (current && sameClaimRow(current, mapped)) { report.unchanged += 1; continue; }
    try {
      // Validate the mapped row the same way every board write is
      // validated: a set/get round-trip through the durable registry
      // applies the persisted-row codec; the engine-level check happens
      // in tests via updateWork on mapped rows.
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
