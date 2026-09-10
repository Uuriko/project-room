import {
  DEFAULT_NOTIFY_KINDS,
  DEFAULT_TIER,
  EVENT_TYPES,
  FAILED_RECEIPT_STATUSES,
  FEED_KINDS,
  TIERS
} from "./kinds.js";

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueById(items) {
  const seen = new Set();
  const unique = [];
  for (const item of items) {
    if (!item || typeof item !== "object" || !item.id) continue;
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    unique.push(item);
  }
  return unique;
}

/** Same address rule as room mentions search: @DisplayName then space or end. */
export function mentionsDisplayName(body, displayName) {
  if (!displayName) return false;
  const label = `@${displayName}`;
  const text = String(body ?? "");
  let from = 0;
  while (from <= text.length) {
    const i = text.indexOf(label, from);
    if (i === -1) return false;
    const after = text[i + label.length];
    if (after == null || /\s/.test(after)) return true;
    from = i + 1;
  }
  return false;
}

function addressesViewer(event, viewer) {
  const data = event.data ?? {};
  if (viewer.memberId && data.toMemberId === viewer.memberId) return true;
  if (viewer.memberId && asList(data.mentions).includes(viewer.memberId)) return true;
  return mentionsDisplayName(data.body, viewer.displayName);
}

function receiptStatus(record) {
  return record?.status ?? record?.data?.status ?? record?.data?.receiptStatus ?? null;
}

function isFailedReceiptStatus(status) {
  return FAILED_RECEIPT_STATUSES.includes(status);
}

function notifyFor(kind, tier) {
  if (tier === "nothing") return false;
  if (tier === "all_actionable") return FEED_KINDS.includes(kind);
  return DEFAULT_NOTIFY_KINDS.includes(kind);
}

function opensFrom(event, receipt) {
  const data = event?.data ?? receipt ?? {};
  const opens = { eventId: event?.id ?? receipt?.eventId ?? null };
  const workItemId = data.workItemId ?? receipt?.workItemId ?? null;
  const receiptId = data.receiptId ?? receipt?.id ?? null;
  if (workItemId) opens.workItemId = workItemId;
  if (receiptId) opens.receiptId = receiptId;
  return opens;
}

function row({ event, receipt, kind, viewer, tier, summary }) {
  const source = event ?? {};
  const data = source.data ?? receipt ?? {};
  return {
    kind,
    at: source.at ?? receipt?.at ?? null,
    room_id: source.roomId ?? receipt?.roomId ?? null,
    work_item_id: data.workItemId ?? receipt?.workItemId ?? null,
    source_event_id: source.id ?? receipt?.eventId ?? null,
    source_receipt_id: data.receiptId ?? receipt?.id ?? null,
    opens: opensFrom(event, receipt),
    notify: notifyFor(kind, tier),
    actor_id: source.actorId ?? receipt?.actorId ?? null,
    viewer_id: viewer.memberId,
    summary
  };
}

function classifyEvent(event, viewer) {
  const data = event.data ?? {};
  const type = event.type;

  if (type === EVENT_TYPES.MESSAGE_REACTION_SET) return null;

  if (type === EVENT_TYPES.RECEIPT_RECORDED && isFailedReceiptStatus(receiptStatus(event))) {
    return { kind: "failed_receipt", summary: "Receipt failed" };
  }
  if (type === EVENT_TYPES.WORK_COMPLETED && isFailedReceiptStatus(data.receiptStatus)) {
    return { kind: "failed_receipt", summary: "Receipt failed" };
  }

  if (type === EVENT_TYPES.VERIFICATION_RECORDED && data.result === "fail") {
    return { kind: "exception", summary: "Verification failed" };
  }
  if (type === EVENT_TYPES.WORK_BLOCKED || data.exception === true) {
    return { kind: "exception", summary: "Exception" };
  }

  if (data.ackNeeded === true) {
    if (data.toMemberId && data.toMemberId !== viewer.memberId) return null;
    return { kind: "ack_needed", summary: "Acknowledgment needed" };
  }
  if (type === EVENT_TYPES.MESSAGE_POSTED && data.requestKind === "reply" && data.toMemberId === viewer.memberId) {
    return { kind: "ack_needed", summary: "Reply requested" };
  }

  if (type === EVENT_TYPES.MESSAGE_POSTED && addressesViewer(event, viewer)) {
    return { kind: "mention", summary: "Mentioned you" };
  }

  return null;
}

/**
 * Project Activity rows from existing Events / Receipts.
 * Does not write Events, rank message volume, or start inference.
 */
export function projectActivity(input = {}, options = {}) {
  const viewer = input.viewer ?? options.viewer ?? {};
  const tier = TIERS.includes(options.tier ?? input.tier) ? (options.tier ?? input.tier) : DEFAULT_TIER;
  const events = uniqueById(asList(input.events));
  const receipts = uniqueById(asList(input.receipts));
  const rows = [];
  const seenEvents = new Set();

  for (const event of events) {
    const classified = classifyEvent(event, viewer);
    if (!classified) continue;
    seenEvents.add(event.id);
    rows.push(row({ event, kind: classified.kind, viewer, tier, summary: classified.summary }));
  }

  for (const receipt of receipts) {
    if (!isFailedReceiptStatus(receiptStatus(receipt))) continue;
    if (receipt.eventId && seenEvents.has(receipt.eventId)) continue;
    rows.push(row({
      event: receipt.eventId ? { id: receipt.eventId, roomId: receipt.roomId, at: receipt.at, actorId: receipt.actorId, data: { workItemId: receipt.workItemId, receiptId: receipt.id } } : null,
      receipt,
      kind: "failed_receipt",
      viewer,
      tier,
      summary: "Receipt failed"
    }));
  }

  rows.sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")));
  return { rows, tier };
}

export function activityForViewer(events, viewer, options = {}) {
  return projectActivity({ events, viewer, receipts: options.receipts }, options);
}
