import { DEFAULT_WEIGHTS, EVENT_TYPES, UNKNOWN_PRODUCER, WEIGHT_KINDS } from "./kinds.js";
import { sourcePayloadFingerprint } from "./fingerprint.js";
import { deriveWorkItemRoles, isUnknownProducer, trustedActorId, versionedArtifact } from "./roles.js";

function asEventList(input) {
  if (Array.isArray(input)) return input;
  if (input && Array.isArray(input.events)) return input.events;
  return [];
}

function rowKey(kind, workItemId, memberId, evidenceRef) {
  return `${kind}:${workItemId ?? ""}:${memberId}:${evidenceRef}`;
}

function projectRow({ event, kind, memberId, evidenceRef, weight }) {
  return {
    room_id: event.roomId,
    work_item_id: event.data?.workItemId ?? undefined,
    member_id: memberId,
    kind,
    weight,
    evidence_ref: evidenceRef,
    reported_by: trustedActorId(event),
    created_at: event.at,
    superseded_by: null,
    source_event_id: event.id
  };
}

function uniqueEvents(events) {
  const seenIds = new Set();
  const seenPayloads = new Set();
  const unique = [];
  for (const event of events) {
    if (!event || typeof event !== "object" || !event.id || !event.type) continue;
    if (seenIds.has(event.id)) continue;
    const payload = sourcePayloadFingerprint(event);
    if (seenPayloads.has(payload)) continue;
    seenIds.add(event.id);
    seenPayloads.add(payload);
    unique.push(event);
  }
  return unique;
}

function memberShares(activeRows) {
  const totals = new Map();
  let activeWeight = 0;
  for (const row of activeRows) {
    activeWeight += row.weight;
    const current = totals.get(row.member_id) || { member_id: row.member_id, member_weight: 0, kinds: [] };
    current.member_weight += row.weight;
    if (!current.kinds.includes(row.kind)) current.kinds.push(row.kind);
    totals.set(row.member_id, current);
  }
  return [...totals.values()]
    .map((entry) => ({
      ...entry,
      member_share: activeWeight === 0 ? 0 : entry.member_weight / activeWeight
    }))
    .sort((a, b) => a.member_id.localeCompare(b.member_id));
}

/**
 * Replay existing Events into contribution rows.
 * Does not write Events, change work states, or credit message/ack activity.
 */
export function rollupContributions(input = {}, options = {}) {
  const events = asEventList(input);
  const weights = { ...DEFAULT_WEIGHTS, ...(options.weights || input.weights || {}) };
  const roles = deriveWorkItemRoles(events, input.workItems || null);
  const unique = uniqueEvents(events);
  const rows = [];
  const gaps = [];
  const seenRowKeys = new Set();

  const addRow = (row) => {
    if (!WEIGHT_KINDS.includes(row.kind)) return;
    if (!(row.weight > 0)) return;
    const key = rowKey(row.kind, row.work_item_id, row.member_id, row.evidence_ref);
    if (seenRowKeys.has(key)) return;
    seenRowKeys.add(key);
    rows.push(row);
  };

  const supersedeWorkItem = (workItemId, supersededBy) => {
    if (!workItemId || !supersededBy) return;
    for (const row of rows) {
      if (row.work_item_id === workItemId && !row.superseded_by) {
        row.superseded_by = supersededBy;
      }
    }
    if (roles[workItemId]) roles[workItemId].supersededBy = supersededBy;
  };

  const supersedePriorVersion = (workItemId, newEvidence, supersededBy) => {
    if (!workItemId || !newEvidence || !supersededBy) return;
    for (const row of rows) {
      if (row.work_item_id !== workItemId || row.superseded_by) continue;
      if (row.evidence_ref === newEvidence || row.source_event_id === supersededBy) continue;
      row.superseded_by = supersededBy;
    }
  };

  for (const event of unique) {
    const workItemId = event.data?.workItemId;
    const item = workItemId ? roles[workItemId] : null;

    if (event.type === EVENT_TYPES.WORK_SUPERSEDED) {
      supersedeWorkItem(workItemId, event.data?.supersededByWorkItemId || event.id);
      continue;
    }

    if (event.type === EVENT_TYPES.WORK_COMPLETED) {
      const reporter = trustedActorId(event);
      if (!reporter) continue;
      const artifactVersion = versionedArtifact(event.data);
      if (isUnknownProducer(event.data)) {
        gaps.push({
          room_id: event.roomId,
          work_item_id: workItemId,
          completion_event_id: event.id,
          reported_by: reporter,
          reason: UNKNOWN_PRODUCER,
          created_at: event.at
        });
        continue;
      }
      if (!artifactVersion) continue;
      supersedePriorVersion(workItemId, artifactVersion, event.id);
      addRow(
        projectRow({
          event,
          kind: "complete",
          memberId: event.data.producerId,
          evidenceRef: event.id,
          weight: weights.complete
        })
      );
      addRow(
        projectRow({
          event,
          kind: "artifact",
          memberId: event.data.producerId,
          evidenceRef: artifactVersion,
          weight: weights.artifact
        })
      );
      continue;
    }

    if (event.type === EVENT_TYPES.VERIFICATION_RECORDED) {
      const actor = trustedActorId(event);
      const designated = item?.verifierMemberId;
      if (!actor || !designated || actor !== designated) continue;
      addRow(
        projectRow({
          event,
          kind: "verify",
          memberId: designated,
          evidenceRef: event.id,
          weight: weights.verify
        })
      );
      continue;
    }

    if (event.type === EVENT_TYPES.OWNER_DECISION_RECORDED) {
      const actor = trustedActorId(event);
      const designated = item?.humanDecisionMakerId;
      if (!actor || !designated || actor !== designated) continue;
      addRow(
        projectRow({
          event,
          kind: "decide",
          memberId: designated,
          evidenceRef: event.id,
          weight: weights.decide
        })
      );
    }
  }

  const activeRows = rows.filter((row) => !row.superseded_by);
  return {
    rows,
    active_rows: activeRows,
    gaps,
    member_shares: memberShares(activeRows),
    active_weight: activeRows.reduce((sum, row) => sum + row.weight, 0)
  };
}
