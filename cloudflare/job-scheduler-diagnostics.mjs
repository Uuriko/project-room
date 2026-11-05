// Read-only public scheduler evidence: no row identities, documents or raw errors.
export function createSchedulerDiagnostics({ now = Date.now, warn = value => console.warn(value) } = {}) {
  const state = { scope: 'current-isolate', lastSuccessAt: null, lastSuccessfulAlarmAt: null,
    lastFailureAt: null, lastFailureCode: null, lastFailureStage: null, stage: null, failureCurrent: false };
  return {
    snapshot: () => ({ ...state }),
    observeStage(value) { if (['yield', 'calculate', 'get_alarm', 'set_alarm', 'delete_alarm'].includes(value)) state.stage = value; },
    async reconcile(operation) {
      try {
        const result = await operation();
        state.lastSuccessAt = now();
        state.lastSuccessfulAlarmAt = Number.isFinite(result?.alarmAt) ? result.alarmAt : null;
        state.failureCurrent = false; state.stage = null;
        return result;
      } catch (error) {
        state.lastFailureStage = state.stage;
        state.lastFailureAt = now(); state.lastFailureCode = 'alarm_reconciliation_failed'; state.failureCurrent = true;
        try { warn(JSON.stringify({ event: 'room.scheduler_reconciliation_failed', code: state.lastFailureCode, at: state.lastFailureAt, stage: state.lastFailureStage })); } catch { /* Diagnostics must preserve the original failure. */ }
        throw error;
      }
    },
  };
}

export async function readSchedulerDiagnostics({ storage, store, diagnostics, requestWriteWatermark, alarmArmedSinceBoot }) {
  const result = diagnostics?.snapshot() ?? { scope: 'current-isolate', lastSuccessAt: null, lastSuccessfulAlarmAt: null,
    lastFailureAt: null, lastFailureCode: null, lastFailureStage: null, stage: null, failureCurrent: false };
  result.requestWriteWatermark = Number.isSafeInteger(requestWriteWatermark) ? requestWriteWatermark : null;
  result.currentWriteStatements = Number.isSafeInteger(store?.db?.writeStatements) ? store.db.writeStatements : null;
  result.alarmArmedSinceBoot = alarmArmedSinceBoot === true;
  try {
    const alarm = await storage.getAlarm();
    result.alarmAt = Number.isFinite(alarm) ? alarm : null;
    result.alarmReadError = null;
  } catch { result.alarmAt = null; result.alarmReadError = 'alarm_read_failed'; }
  result.nativeEvents = { enabled: store?.nativeMcpEventsEnabled === true, counts: null, readError: null };
  try {
    if (store?.db) {
      const row = store.db.prepare(`SELECT
        count(CASE WHEN state='pending' THEN 1 END) AS pending,
        count(CASE WHEN state='leased' THEN 1 END) AS leased,
        count(CASE WHEN state='delivered' THEN 1 END) AS delivered,
        count(CASE WHEN state='dead' THEN 1 END) AS dead,
        min(CASE WHEN state='pending' THEN next_at WHEN state='leased' THEN lease_until END) AS oldestDueAt,
        max(CASE WHEN state IN ('pending','leased') THEN attempts END) AS maxPendingAttempts
        FROM mcp_event_outbox`).get();
      result.nativeEvents.counts = { ...row };
    }
  } catch { result.nativeEvents.readError = 'native_queue_read_failed'; }
  return result;
}
