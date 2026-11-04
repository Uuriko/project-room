// Only stable, explicitly recognized categories leave the process. Never retain
// exception messages, stacks, headers, arbitrary codes, SQL, or request data.
const CODES = new Set(['pilot_limit', 'rate_limited', 'room_archived', 'permission_denied', 'unauthorized', 'invalid_command', 'conflict', 'SQLITE_BUSY', 'SQLITE_FULL', 'SQLITE_TOOBIG', 'SQLITE_CONSTRAINT', 'ERR_SQLITE_ERROR']);
const STATUSES = new Set([400, 401, 403, 404, 409, 410, 413, 422, 429, 500, 502, 503, 504]);
const MAX_CATEGORIES = 32;
export function createRefusalCounter() {
  const counts = new Map();
  return {
    record(error, count = 1) {
      let code = 'unknown', status = null;
      try {
        const candidateCode = error?.code, candidateStatus = error?.status;
        if (CODES.has(candidateCode)) code = candidateCode;
        if (STATUSES.has(candidateStatus)) status = candidateStatus;
      } catch { /* Malformed error metadata cannot break benchmark reporting. */ }
      let key = `${code}:${status}`;
      if (!counts.has(key) && counts.size >= MAX_CATEGORIES) { code = 'other'; status = null; key = 'other:null'; }
      const row = counts.get(key) ?? { code, status, count: 0 };
      row.count += count; counts.set(key, row);
    },
    snapshot() { return [...counts.values()].map(row => ({ ...row })).sort((a, b) => a.code.localeCompare(b.code) || (a.status ?? 0) - (b.status ?? 0)); }
  };
}
export function summarizeRefusals(samples) {
  const counter = createRefusalCounter();
  for (const sample of samples) {
    let classified = 0;
    for (const row of sample.writeRefusals ?? []) {
      if (!Number.isSafeInteger(row.count) || row.count <= 0) continue;
      const count = Math.min(row.count, Math.max(0, (sample.writeFailures ?? 0) - classified));
      if (!count) continue;
      counter.record(row, count); classified += count;
    }
    const unknown = (sample.writeFailures ?? 0) - classified;
    if (unknown > 0) counter.record(null, unknown);
  }
  return counter.snapshot();
}
