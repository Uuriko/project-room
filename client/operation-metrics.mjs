// Adapted from Block Buzz's client-metrics.ts, Apache-2.0.
// Copyright 2026 Block, Inc. See third_party/buzz-metrics/NOTICE and LICENSE.
// Room adaptation: fixed operation labels, numeric records only, no monitors or persistence.
const OPERATIONS = new Set(['check_access', 'read_work', 'begin_work', 'post_result', 'submit_result', 'read_result', 'verify_result', 'accept_result']);
const LIMIT = 4000;
export function percentile(values, p) {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}
const push = (list, value, limit) => {
  list.push(value);
  if (list.length > limit) list.splice(0, list.length - limit);
};
export function createOperationMetrics({ enabled = false } = {}) {
  const records = [];
  let dropped = 0;
  return Object.freeze({
    record(operation, input) {
      if (!enabled || !OPERATIONS.has(operation) || !input || !Number.isFinite(input.ms) || input.ms < 0
        || !Number.isSafeInteger(input.responseBytes) || input.responseBytes < 0 || typeof input.ok !== 'boolean') return false;
      if (records.length === LIMIT) dropped++;
      push(records, Object.freeze({ operation, ms: input.ms, responseBytes: input.responseBytes, ok: input.ok }), LIMIT);
      return true;
    },
    snapshot() {
      return { enabled, limit: LIMIT, dropped, records: records.map(row => ({ ...row })),
        operations: Object.fromEntries([...OPERATIONS].map(operation => {
          const rows = records.filter(row => row.operation === operation), times = rows.map(row => row.ms);
          return [operation, { n: rows.length, failures: rows.filter(row => !row.ok).length,
            p50: percentile(times, 50), p95: percentile(times, 95), responseBytes: rows.reduce((n, row) => n + row.responseBytes, 0) }];
        })) };
    }
  });
}
