// CD-01 (COMP-DEEP #1, REV §3 reqs 1–5): the verdict inbox's attention set.
//
// A server-maintained set of (claim, person, reason, since) tuples with
// Gerrit fold semantics: updates are append-only records, and per person
// per claim only the latest record is live — there is no separate mutable
// membership table to drift. Membership changes on events only, per the
// REV §3 req-1 transition table, implemented twice over one fold:
//   - applyAttentionEvent(records, event) — the event API the lifecycle
//     emits against (delivery submitted, verdict recorded, re-delivery,
//     verdict voided by a new delivery, accept).
//   - attentionRecordsForClaim(claim, ctx) — synthesises the same records
//     from a claim's existing facts (frozen delivery, reviews, the
//     delivered→verified verification fact from #3627) in chronological
//     order, so the read below is a fold over the claim record, never a
//     second store. It builds on #3627's review-basis machinery
//     (resolveNamedReviewers / the delivery digest+generation binding via
//     review bases); it does not fork it.
//
// Orphan rule (req 2): a claim in `delivered` whose live set is empty for
// longer than the room-configured interval (default 24h,
// roomWorkClaimConfig.verdictOrphanAfterMs) auto-adds the ROOM owner with
// reason orphaned-review. The room owner is the escalation target because
// the claim's holder is the worker, who cannot review their own work;
// nobody-in-set is repaired here, never displayed as a state.
//
// Bots (req 3): the underlying set is one set. The human surface filters
// it to human members only — agent identities never enter the human set.
// Agent reviewers are served the SAME underlying set through the agent
// door (GET /api/verdict-inbox with an identity secret, beside
// /api/needs-me + room_needs_me): a queue view, not a second set.
//
// Pure module, no store import (cycle-safe, like owner-attention.mjs).
import { resolveNamedReviewers } from "./work-claims.mjs";
import { ownMember } from "../src/events.js";

export const ATTENTION_REASONS = Object.freeze([
  "verdict-requested",
  "re-review-required",
  "verdict-voided-new-delivery",
  "orphaned-review",
  "revision-requested",
  "rejected",
]);
// Reasons that ask the tuple's person for a verdict.
export const VERDICT_REASONS = Object.freeze(new Set([
  "verdict-requested", "re-review-required", "verdict-voided-new-delivery", "orphaned-review",
]));
// Reasons that hand the claim back to its worker.
export const RETURN_REASONS = Object.freeze(new Set(["revision-requested", "rejected"]));

export const DEFAULT_ORPHAN_AFTER_MS = 24 * 3600 * 1000;
export const DEFAULT_RECENT_WINDOW_MS = 7 * 24 * 3600 * 1000;

const msOf = value => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : null; }
  return null;
};
const isoOf = ms => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

const memberOf = (members, id) => {
  if (!members || typeof id !== "string") return null;
  if (members instanceof Map) return members.get(id) ?? null;
  return ownMember(members, id) ?? null;
};
const isActiveMember = (members, id) => {
  const member = memberOf(members, id);
  return !member || member.active !== false;
};
// Bots never enter the human set: a person proven to be a non-human member
// is excluded from the human surface. Unknown persons are kept — absence
// from the members map is not proof of bot-hood.
const isHumanPerson = (members, id) => {
  const member = memberOf(members, id);
  return !member || member.kind === "human";
};

const record = (claimId, roomId, personId, action, reason, atMs) => Object.freeze({
  claimId, ...(roomId ? { roomId } : {}), personId, action,
  ...(reason ? { reason } : {}), since: isoOf(atMs),
});

// ---------------------------------------------------------------- fold ---

// Fold append-only attention records into the live set. Per (claim,
// person) only the latest record is live; a "clear" record drops every
// person for the claim as of that record (later records may re-add).
// Records carrying a numeric `seq` fold in seq order; otherwise in array
// order (callers append chronologically).
export function foldAttentionRecords(records) {
  const ordered = [...(records ?? [])];
  if (ordered.every(entry => Number.isSafeInteger(entry?.seq))) {
    ordered.sort((a, b) => a.seq - b.seq);
  }
  const live = new Map();
  for (const entry of ordered) {
    if (!entry || typeof entry.claimId !== "string" || typeof entry.personId !== "string") continue;
    if (entry.action === "clear") {
      for (const key of [...live.keys()]) if (key.startsWith(`${entry.claimId}\u0000`)) live.delete(key);
      continue;
    }
    const key = `${entry.claimId}\u0000${entry.personId}`;
    if (entry.action === "remove") { live.delete(key); continue; }
    if (entry.action !== "add" || !ATTENTION_REASONS.includes(entry.reason)) continue;
    const sinceMs = msOf(entry.since);
    if (sinceMs === null) continue;
    live.set(key, Object.freeze({
      claimId: entry.claimId,
      ...(entry.roomId ? { roomId: entry.roomId } : {}),
      personId: entry.personId, reason: entry.reason, since: isoOf(sinceMs),
    }));
  }
  return [...live.values()].sort((a, b) =>
    String(a.claimId).localeCompare(String(b.claimId)) || String(a.since).localeCompare(String(b.since)));
}

// The REV §3 req-1 transition table, as appends to the record log.
// Returns a NEW records array; the input is never mutated.
export function applyAttentionEvent(records, event) {
  if (!event || typeof event.claimId !== "string") throw new TypeError("attention event needs a claimId");
  const atMs = msOf(event.at ?? event.since);
  if (atMs === null) throw new TypeError("attention event needs an at/since timestamp");
  const { claimId, roomId } = event;
  const reviewers = [...new Set([
    ...(Array.isArray(event.reviewers) ? event.reviewers : []),
    ...(event.reviewerId ? [event.reviewerId] : []),
  ].filter(id => typeof id === "string" && id))];
  const workerId = typeof event.workerId === "string" && event.workerId ? event.workerId : null;
  const appended = [];
  const addReviewers = reason => { for (const id of reviewers) appended.push(record(claimId, roomId, id, "add", reason, atMs)); };
  const removeReviewer = () => { if (event.reviewerId) appended.push(record(claimId, roomId, event.reviewerId, "remove", null, atMs)); };
  const removeWorker = () => { if (workerId) appended.push(record(claimId, roomId, workerId, "remove", null, atMs)); };
  switch (event.type) {
    case "delivery-submitted":
      removeWorker();
      addReviewers("verdict-requested");
      break;
    case "redelivery-submitted":
      removeWorker();
      addReviewers("re-review-required");
      break;
    case "verdict-recorded":
      removeReviewer();
      break;
    case "verdict-accepted":
    case "accept":
      appended.push(record(claimId, roomId, "*", "clear", null, atMs));
      break;
    case "verdict-revision-requested":
      removeReviewer();
      if (workerId) appended.push(record(claimId, roomId, workerId, "add", "revision-requested", atMs));
      break;
    case "verdict-rejected":
      removeReviewer();
      if (workerId) appended.push(record(claimId, roomId, workerId, "add", "rejected", atMs));
      break;
    case "verdict-voided-new-delivery":
      removeWorker();
      addReviewers("verdict-voided-new-delivery");
      break;
    default:
      throw new TypeError(`unknown attention event type "${event.type}"`);
  }
  return Object.freeze([...(records ?? []), ...appended]);
}

// ------------------------------------------------------- claim derivation ---

const isRejectVerdict = verdict => verdict === "reject" || verdict === "rejected";

// Synthesise the attention records a claim's own facts imply, in
// chronological order, from #3627's machinery: the frozen delivery
// (digest + generation + deliveredAt/deliveredBy), the per-member review
// records with their delivery-bound bases, and the verification fact the
// verify / changes_requested transitions stamp.
export function attentionRecordsForClaim(claim, { roomId = null, members = {} } = {}) {
  if (!claim || claim.supersededBy) return Object.freeze([]);
  const workerId = claim.owner ?? claim.delivery?.deliveredBy ?? null;
  const records = [];
  const deliveredMs = msOf(claim.delivery?.deliveredAt)
    ?? (claim.state === "delivered" ? msOf(claim.updatedAt) : null);
  const reviews = [...(claim.reviews ?? [])]
    .filter(review => review && typeof review.memberId === "string")
    .sort((a, b) => (msOf(a.at) ?? 0) - (msOf(b.at) ?? 0));

  if (deliveredMs !== null) {
    const generation = Number.isSafeInteger(claim.deliveryGeneration) ? claim.deliveryGeneration : 0;
    const digest = claim.delivery?.digest ?? null;
    for (const reviewerId of resolveNamedReviewers(claim, members)) {
      // A verdict this reviewer recorded against an earlier delivery
      // (basis generation/digest no longer current) was voided by this
      // delivery — they re-enter with that reason (REV §3 req 1, last
      // clause). Any earlier verdict at all, or a generation beyond the
      // first, makes a fresh delivery a re-review; otherwise it is the
      // first ask.
      const prior = reviews.filter(review => review.memberId === reviewerId);
      const voided = prior.some(review => review.verdict === "approve" && review.basis
        && ((Number.isSafeInteger(review.basis.deliveryGeneration) && review.basis.deliveryGeneration !== generation)
          || (review.basis.deliveryDigest != null && digest != null && review.basis.deliveryDigest !== digest)));
      const reason = voided ? "verdict-voided-new-delivery"
        : (generation > 1 || prior.length > 0) ? "re-review-required" : "verdict-requested";
      records.push(record(claim.id, roomId, reviewerId, "add", reason, deliveredMs));
    }
    // Verdicts recorded against this delivery move the set on.
    for (const review of reviews) {
      const atMs = msOf(review.at);
      if (atMs === null || atMs < deliveredMs) continue;
      if (review.verdict === "approve") {
        records.push(record(claim.id, roomId, review.memberId, "remove", null, atMs));
      } else if (review.verdict === "changes_requested" && workerId) {
        // A send-back ends the verdict ask for every named reviewer, not
        // only the one who recorded it: the claim is the worker's again.
        for (const id of resolveNamedReviewers(claim, members)) {
          records.push(record(claim.id, roomId, id, "remove", null, atMs));
        }
        records.push(record(claim.id, roomId, review.memberId, "remove", null, atMs));
        records.push(record(claim.id, roomId, workerId, "add", "revision-requested", atMs));
      } else if (isRejectVerdict(review.verdict) && workerId) {
        for (const id of resolveNamedReviewers(claim, members)) {
          records.push(record(claim.id, roomId, id, "remove", null, atMs));
        }
        records.push(record(claim.id, roomId, review.memberId, "remove", null, atMs));
        records.push(record(claim.id, roomId, workerId, "add", "rejected", atMs));
      }
    }
  }

  // The send-back fact (#3627 changes_requested transition): the delivery
  // stays as the record, the verification fact names who sent it back and
  // when. It is authoritative even when no review record rides along.
  if (claim.state === "in_progress" && claim.verification?.state === "changes_requested" && workerId) {
    const atMs = msOf(claim.verification.at);
    if (atMs !== null) {
      for (const id of resolveNamedReviewers(claim, members)) {
        records.push(record(claim.id, roomId, id, "remove", null, atMs));
      }
      if (typeof claim.verification.by === "string") {
        records.push(record(claim.id, roomId, claim.verification.by, "remove", null, atMs));
      }
      records.push(record(claim.id, roomId, workerId, "add", "revision-requested", atMs));
    }
  }
  // A reject-shaped standing verdict on a non-delivered, non-decided claim.
  if (claim.state !== "delivered" && claim.state !== "done" && workerId) {
    const latest = reviews.at(-1);
    if (latest && isRejectVerdict(latest.verdict)) {
      const atMs = msOf(latest.at);
      if (atMs !== null && !records.some(entry => entry.personId === workerId && entry.reason === "rejected")) {
        records.push(record(claim.id, roomId, workerId, "add", "rejected", atMs));
      }
    }
  }

  // Accept clears the set: a done claim holds no live tuples. The clear
  // is stamped at the verification fact (or the claim's last update).
  if (claim.state === "done") {
    const atMs = msOf(claim.verification?.at) ?? msOf(claim.updatedAt) ?? deliveredMs;
    if (atMs !== null) records.push(record(claim.id, roomId, "*", "clear", null, atMs));
  }
  // Fold order is chronological; a clear only drops records at or before
  // it because the fold walks in array order — so sort by time, stable.
  records.sort((a, b) => (msOf(a.since) ?? 0) - (msOf(b.since) ?? 0));
  return Object.freeze(records);
}

// The live attention tuples for one claim: fold, then the orphan rule.
export function attentionTuplesForClaim(claim, {
  roomId = null, members = {}, roomOwnerId = null, nowMs = Date.now(),
  orphanAfterMs = DEFAULT_ORPHAN_AFTER_MS,
} = {}) {
  const live = foldAttentionRecords(attentionRecordsForClaim(claim, { roomId, members }));
  if (!claim || claim.state !== "delivered" || live.length > 0) return live;
  // Orphan rule (req 2): a claim awaiting verdict whose set stays empty
  // beyond the interval auto-adds the room owner as orphaned-review.
  const deliveredMs = msOf(claim.delivery?.deliveredAt) ?? msOf(claim.updatedAt);
  const interval = Number.isFinite(orphanAfterMs) && orphanAfterMs >= 0 ? orphanAfterMs : DEFAULT_ORPHAN_AFTER_MS;
  if (deliveredMs === null || !roomOwnerId || roomOwnerId === claim.owner) return live;
  if (nowMs - deliveredMs < interval) return live;
  if (!isActiveMember(members, roomOwnerId)) return live;
  return Object.freeze([Object.freeze({
    claimId: claim.id, ...(roomId ? { roomId } : {}), personId: roomOwnerId,
    reason: "orphaned-review", since: isoOf(deliveredMs + interval),
  })]);
}

// ----------------------------------------------------------------- read ---

// Contract F (CD-06) follow totals, normalised: per-member
// { followedClaims, unreadClaims, unreadEvents, mentions } plus per-claim
// follow state when the provider supplies it. Unknown shapes read as null
// (CD-06 not landed yet) rather than as zeroes — the read must not invent
// follow data.
export function normalizeFollow(follow) {
  if (!follow || typeof follow !== "object") return null;
  const totalsSource = follow.totals && typeof follow.totals === "object" ? follow.totals : follow;
  const count = value => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
  const totals = Object.freeze({
    followedClaims: count(totalsSource.followedClaims),
    unreadClaims: count(totalsSource.unreadClaims),
    unreadEvents: count(totalsSource.unreadEvents),
    mentions: count(totalsSource.mentions),
  });
  const claims = Array.isArray(follow.claims) ? follow.claims.filter(entry => entry && typeof entry.claimId === "string").map(entry => Object.freeze({
    claimId: entry.claimId,
    ...(typeof entry.roomId === "string" ? { roomId: entry.roomId } : {}),
    ...(["follow", "mute", "inherit"].includes(entry.policy) ? { policy: entry.policy } : {}),
    unreadCount: count(entry.unreadCount),
    mentionCount: count(entry.mentionCount),
  })) : [];
  return Object.freeze({ totals, claims: Object.freeze(claims) });
}

const SECTION_NAMES = Object.freeze(["needsYourVerdict", "returnedToYou", "waitingOnWorker", "recentlyDecided"]);

// Contract V: the sectioned verdict-inbox read. `rooms` is a list of
// { roomId, claims, members, roomOwnerId, orphanAfterMs, follow? } the
// caller has already authorised for the viewer; `surface` is "human"
// (default — bots filtered out of every row) or "agent" (the agent door's
// queue view of the same underlying set). Rows sort by waiting time,
// oldest first (req 4). `follow` is Contract F data (per-room follow on
// the room entries, or one viewer-wide value in options.follow).
export function buildVerdictInbox({ viewerId = null, rooms = [], nowMs = Date.now(), surface = "human",
  recentWindowMs = DEFAULT_RECENT_WINDOW_MS, follow = null } = {}) {
  // The viewer is a per-room member: a person can hold a different member
  // id in different rooms, so a room entry may carry its own viewerId,
  // which wins over the call-wide one.
  const anyViewer = viewerId ?? (rooms ?? []).find(room => typeof room?.viewerId === "string")?.viewerId ?? null;
  if (!anyViewer) throw new TypeError("buildVerdictInbox needs a viewerId (call-wide or per-room)");
  const sections = { needsYourVerdict: [], returnedToYou: [], waitingOnWorker: [], recentlyDecided: [] };
  let attentionTotal = 0;
  const followByRoom = new Map();

  const rowFor = (tuple, claim, roomId) => Object.freeze({
    claimId: tuple.claimId, roomId, title: String(claim?.title ?? tuple.claimId),
    personId: tuple.personId, reason: tuple.reason, since: tuple.since,
    waitingSeconds: Math.max(0, Math.floor((nowMs - (msOf(tuple.since) ?? nowMs)) / 1000)),
    ...(claim?.state ? { claimState: claim.state } : {}),
  });

  for (const room of rooms ?? []) {
    if (!room || typeof room.roomId !== "string") continue;
    const { roomId, members = {}, roomOwnerId = null } = room;
    const viewer = room.viewerId ?? viewerId ?? anyViewer;
    const orphanAfterMs = room.orphanAfterMs ?? room.config?.verdictOrphanAfterMs ?? DEFAULT_ORPHAN_AFTER_MS;
    if (room.follow) followByRoom.set(roomId, room.follow);
    const claimsById = new Map((room.claims ?? []).filter(claim => claim && typeof claim.id === "string").map(claim => [claim.id, claim]));
    const viewerReviewerSide = claim => roomOwnerId === viewer
      || resolveNamedReviewers(claim, members).includes(viewer)
      || (claim.reviews ?? []).some(review => review?.memberId === viewer)
      || claim.verification?.by === viewer;

    for (const claim of claimsById.values()) {
      const tuples = attentionTuplesForClaim(claim, { roomId, members, roomOwnerId, nowMs, orphanAfterMs });
      attentionTotal += tuples.length;
      for (const tuple of tuples) {
        // Req 3: on the human surface, a tuple held by a proven non-human
        // member never renders. The underlying set is unchanged.
        if (surface !== "agent" && !isHumanPerson(members, tuple.personId)) continue;
        const row = rowFor(tuple, claim, roomId);
        if (tuple.personId === viewer && VERDICT_REASONS.has(tuple.reason)) sections.needsYourVerdict.push(row);
        else if (tuple.personId === viewer && RETURN_REASONS.has(tuple.reason)) sections.returnedToYou.push(row);
        else if (tuple.personId !== viewer && RETURN_REASONS.has(tuple.reason) && viewerReviewerSide(claim)) sections.waitingOnWorker.push(row);
      }
      // Recently decided: done within the window, and the viewer was the
      // worker, a reviewer, the verifying member, or the room owner.
      if (claim.state === "done") {
        const decidedMs = msOf(claim.verification?.at) ?? msOf(claim.updatedAt);
        const involved = claim.owner === viewer || claim.delivery?.deliveredBy === viewer
          || claim.reviewedBy === viewer || claim.verification?.by === viewer
          || (claim.reviews ?? []).some(review => review?.memberId === viewer)
          || roomOwnerId === viewer;
        if (decidedMs !== null && nowMs - decidedMs <= recentWindowMs && decidedMs <= nowMs && involved) {
          sections.recentlyDecided.push(Object.freeze({
            claimId: claim.id, roomId, title: String(claim.title ?? claim.id),
            personId: claim.verification?.by ?? claim.reviewedBy ?? viewer,
            reason: "accepted", verdict: "accepted",
            since: isoOf(decidedMs),
            waitingSeconds: Math.max(0, Math.floor((nowMs - decidedMs) / 1000)),
            claimState: claim.state,
          }));
        }
      }
    }
  }

  // Default sort (req 4): waiting time, oldest first; claimId breaks ties.
  const byWaiting = (a, b) => b.waitingSeconds - a.waitingSeconds || String(a.claimId).localeCompare(String(b.claimId));
  for (const name of SECTION_NAMES) sections[name] = Object.freeze(sections[name].sort(byWaiting));

  // Follow data (Contract F): one viewer-wide value wins; otherwise merge
  // per-room providers by summing totals and concatenating claim states.
  let followData = follow;
  if (!followData && followByRoom.size) {
    const merged = { followedClaims: 0, unreadClaims: 0, unreadEvents: 0, mentions: 0 };
    const claims = [];
    for (const entry of followByRoom.values()) {
      const normalised = normalizeFollow(entry);
      if (!normalised) continue;
      for (const key of Object.keys(merged)) merged[key] += normalised.totals[key];
      claims.push(...normalised.claims);
    }
    followData = { totals: merged, claims };
  }

  const followNormalized = normalizeFollow(followData);
  const totals = Object.freeze({
    needsYourVerdict: sections.needsYourVerdict.length,
    returnedToYou: sections.returnedToYou.length,
    waitingOnWorker: sections.waitingOnWorker.length,
    recentlyDecided: sections.recentlyDecided.length,
    total: SECTION_NAMES.reduce((sum, name) => sum + sections[name].length, 0),
    attentionTuples: attentionTotal,
    // Contract F echoes for consumers that read follow counts out of the
    // totals bag: followedChanges = unread events on followed claims.
    followedChanges: followNormalized?.totals.unreadEvents ?? 0,
    mentions: followNormalized?.totals.mentions ?? 0,
  });
  return Object.freeze({
    contractVersion: 1,
    generatedAt: isoOf(nowMs),
    viewerId: anyViewer,
    surface: surface === "agent" ? "agent" : "human",
    sections: Object.freeze(sections),
    totals,
    follow: followNormalized,
    // Alias of follow.claims with a row type, for consumers built against
    // a `following[]` shape: followed-claim changes surface alongside the
    // verdict sections (CD-06 totals complete the inbox, per K4).
    following: Object.freeze((followNormalized?.claims ?? []).map(entry => Object.freeze({ ...entry, type: "followed-claim" }))),
  });
}
