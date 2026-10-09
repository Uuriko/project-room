// server/event-compaction.mjs — WAVE-500 W5 prototype: event compaction.
//
// PURE FUNCTIONS ONLY. No DB writes, no store coupling: takes arrays, returns
// results. This module is a prototype for design validation only — it is NOT
// wired into store.mjs or any write path (conservative by task spec).
//
// Design law respected: "the database is the truth, events are just
// notifications." Compaction never discards truth-bearing events; it only
// folds notification churn (progress chatter, renewals, wakes) into summaries.
// Classification defaults to 'retain' for unknown/malformed types.

import { randomUUID } from "node:crypto";

// Event types that carry durable room truth: membership, invites, provenance,
// claim lifecycle endpoints (create/settle), and room/policy records.
// Everything not explicitly classified below is retained by default.
const RETAIN_TYPES = new Set([
  // membership
  "member.added",
  "member.joined_via_invitation",
  "member.access_changed",
  "member.status_updated",
  "member.public_name_set",
  "member.mute_set",
  "notifications.preferences_set",
  // invitations
  "invitation.created",
  "invitation.accepted",
  "invitation.revoked",
  // claim lifecycle endpoints: create and settle
  "claim.acquired",
  "claim.released",
  "work.completed",
  "work.superseded",
  // provenance / decisions
  "verification.recorded",
  "owner.decision_recorded",
  "decision.recorded",
  "receipt.evidence_withdrawn",
  "referral.completed",
  "ownership.transferred",
  "bond.proposed",
  "bond.activated",
  "bond.revoked",
  // room structural / policy records
  "room.created",
  "room.policy_set",
  "room.spend_allowance_set",
  "room.spend_pricing_set",
  "room.trust_set",
  "room.public_receipts_set",
  "room.public_page_set",
  "room.join_link_set",
  "room.archived",
  "room.history_visibility_set",
  "room.exported",
  "room.starter_seeded",
  // work structural endpoints
  "work.proposed",
  "work.accepted",
  "work.started",
  "work.handoff_recorded",
]);

// High-churn notification types that can be folded into a per-claim (or
// per-work-item) summary without losing durable truth.
const SUMMARIZABLE_TYPES = new Set([
  "work_claim.updated",
  "claim.renewed",
  "work.blocked",
  "work.blocker_resolved",
  "work.halt_cleared",
]);

// Ephemeral notification types: wakes, triage hints, suggestions. Safe to
// drop once a summary records that they existed and how many.
const isDroppableHint = (type) =>
  type.startsWith("wake") || type.startsWith("hint") || type.includes("triage");

/**
 * classifyEvent(event) -> 'summarizable' | 'retain' | 'drop-after-summary'
 * Conservative: unknown, future, or malformed event types are always retained.
 */
export function classifyEvent(event) {
  const type = event && typeof event.type === "string" ? event.type : "";
  if (!type) return "retain";
  if (isDroppableHint(type)) return "drop-after-summary";
  if (SUMMARIZABLE_TYPES.has(type)) return "summarizable";
  return "retain";
}

const groupKeyFor = (event) => {
  const data = event && event.data && typeof event.data === "object" ? event.data : {};
  const id = data.claimId ?? data.claim_id ?? data.workItemId ?? data.work_item_id ?? data.messageId ?? "ungrouped";
  return event.type === "work_claim.updated" || event.type === "claim.renewed"
    ? `claim:${id}`
    : `note:${id}`;
};

const summarizeGroup = ({ type, key, events: groupEvents, roomId, kind }) => {
  const firstSeq = groupEvents[0].sequence;
  const lastSeq = groupEvents[groupEvents.length - 1].sequence;
  const types = {};
  for (const e of groupEvents) types[e.type] = (types[e.type] ?? 0) + 1;
  return {
    id: `summary:${randomUUID()}`,
    room_id: roomId,
    type: "compaction.summary",
    summary: true,
    data: {
      kind,
      summaryOf: key,
      summarizedCount: groupEvents.length,
      summarizedIds: groupEvents.map((e) => e.id),
      summarizedTypes: types,
      firstSeq,
      lastSeq,
    },
  };
};

/**
 * compactRun(events, { maxSeq }) -> { kept, summaries, dropped, cursorMap }
 *
 * Compacts one run over events with sequence <= maxSeq (the run's high-water
 * mark; anything beyond it is left for a later run and is absent from the
 * output). New dense sequences are assigned 1..kept.length, retained events
 * first in original order, then summary rows.
 *
 * - kept: retained events (verbatim) + summary rows. <= input length.
 * - summaries: the summary rows (same objects as in kept).
 * - dropped: wake/hint events folded into summaries, returned for audit.
 * - cursorMap: old sequence -> new sequence (number), or 'summary:<id>'.
 *   Summary rows also self-register as cursorMap['summary:<id>'] = their new
 *   sequence so translateCursor can resolve summary targets with only the map.
 */
export function compactRun(events, { maxSeq }) {
  const scoped = events
    .filter((e) => e && typeof e.sequence === "number" && e.sequence <= maxSeq)
    .slice()
    .sort((a, b) => a.sequence - b.sequence);

  const kept = [];
  const summaries = [];
  const dropped = [];
  const cursorMap = {};
  const churnGroups = new Map(); // groupKey -> events[]
  const hintGroups = new Map();  // type -> events[]

  for (const event of scoped) {
    const cls = classifyEvent(event);
    if (cls === "retain") {
      kept.push(event);
    } else if (cls === "summarizable") {
      const key = groupKeyFor(event);
      if (!churnGroups.has(key)) churnGroups.set(key, []);
      churnGroups.get(key).push(event);
    } else {
      if (!hintGroups.has(event.type)) hintGroups.set(event.type, []);
      hintGroups.get(event.type).push(event);
      dropped.push(event);
    }
  }

  // Dense re-sequencing: retained events keep relative order.
  let nextSeq = 0;
  for (const event of kept) {
    nextSeq += 1;
    cursorMap[event.sequence] = nextSeq;
    event.sequence = nextSeq;
  }

  const emitSummary = (summary) => {
    nextSeq += 1;
    summary.sequence = nextSeq;
    kept.push(summary);
    summaries.push(summary);
    cursorMap[summary.id] = nextSeq; // self-entry for cursor resolution
  };

  for (const [key, groupEvents] of churnGroups) {
    const summary = summarizeGroup({
      type: "churn", key, events: groupEvents, roomId: groupEvents[0].room_id, kind: "work-claim-churn",
    });
    emitSummary(summary);
    for (const e of groupEvents) cursorMap[e.sequence] = summary.id;
  }

  for (const [type, groupEvents] of hintGroups) {
    const summary = summarizeGroup({
      type: "hints", key: type, events: groupEvents, roomId: groupEvents[0].room_id, kind: "dropped-hints",
    });
    emitSummary(summary);
    for (const e of groupEvents) cursorMap[e.sequence] = summary.id;
  }

  return { kept, summaries, dropped, cursorMap };
}

/**
 * translateCursor(cursorMap, afterSeq) -> new afterSeq (number)
 *
 * Moves a client's old poll cursor onto the compacted log. A cursor pointing
 * at a retained event resolves to its new sequence; a cursor pointing at a
 * summarized/dropped event resolves to its summary row's new sequence. Cursors
 * past the run clamp to the last kept sequence; cursors at/below 0 stay at 0.
 */
export function translateCursor(cursorMap, afterSeq) {
  let best = 0;
  for (const [key, value] of Object.entries(cursorMap)) {
    const oldSeq = Number(key);
    if (!Number.isInteger(oldSeq) || oldSeq > afterSeq) continue;
    let resolved = value;
    if (typeof resolved === "string" && resolved.startsWith("summary:")) {
      resolved = cursorMap[resolved];
    }
    if (typeof resolved === "number") best = Math.max(best, resolved);
  }
  return best;
}
