import { rollupContributions } from "./rollup.js";

/**
 * Thin Contributors read-model for Quiet Focus / return-brief.
 * Pure projection. Does not acknowledge, mutate work, or mint Events.
 */
export function contributorsForReturnBrief(input = {}, options = {}) {
  const { since = null, workItemId = null } = options;
  const rolled = rollupContributions(input, options);
  let lines = rolled.active_rows;
  let gaps = rolled.gaps;

  if (workItemId) {
    lines = lines.filter((row) => row.work_item_id === workItemId);
    gaps = gaps.filter((gap) => gap.work_item_id === workItemId);
  }
  if (since) {
    lines = lines.filter((row) => row.created_at > since);
    gaps = gaps.filter((gap) => gap.created_at > since);
  }

  const activeWeight = lines.reduce((sum, row) => sum + row.weight, 0);
  const totals = new Map();
  for (const row of lines) {
    const current = totals.get(row.member_id) || { member_id: row.member_id, member_weight: 0 };
    current.member_weight += row.weight;
    totals.set(row.member_id, current);
  }

  return {
    lines: lines.map((row) => ({
      member_id: row.member_id,
      kind: row.kind,
      weight: row.weight,
      evidence_ref: row.evidence_ref,
      source_event_id: row.source_event_id,
      work_item_id: row.work_item_id,
      created_at: row.created_at,
      reported_by: row.reported_by
    })),
    gaps,
    member_shares: [...totals.values()]
      .map((entry) => ({
        ...entry,
        member_share: activeWeight === 0 ? 0 : entry.member_weight / activeWeight
      }))
      .sort((a, b) => a.member_id.localeCompare(b.member_id)),
    active_weight: activeWeight
  };
}
