// One drain per isolate, with a fresh calculation after any overlapping request.
// This caches no job eligibility. A generation changed across storage awaits
// invalidates the decision, including a decision to delete an existing alarm.
export function createJobAlarmReconciler({ storage, calculate, now = Date.now, yieldTurn = () => new Promise(resolve => setTimeout(resolve, 0)), observeStage = () => {} }) {
  let generation = 0, flight = null, retryAt = null;
  const stage = value => { try { observeStage(value); } catch { /* Observation cannot alter scheduling. */ } };
  return function request({ retryDelayMs = 0 } = {}) {
    generation++;
    if (retryDelayMs > 0) {
      const deadline = now() + retryDelayMs;
      retryAt = retryAt == null ? deadline : Math.min(retryAt, deadline);
    }
    if (flight) return flight;
    flight = (async () => {
      try {
        let result;
        do {
          stage('yield');
          await yieldTurn();
          const owned = generation;
          stage('calculate');
          let when = await calculate();
          if (retryAt != null) when = when == null ? retryAt : Math.min(when, retryAt);
          stage('get_alarm');
          const current = await storage.getAlarm();
          // A stale non-null decision may conservatively arm an extra wake,
          // but never postpone an existing earlier alarm. Do not starve known
          // work while read traffic keeps advancing the generation. Only a
          // current empty decision may delete an alarm.
          if (owned !== generation && when == null) continue;
          // A past timestamp is not a future wake: replace it rather than
          // leaving due work waiting for the slower safety-net cron.
          if (when == null) {
            if (current != null) { stage('delete_alarm'); await storage.deleteAlarm(); }
            result = { armed: false, alarmAt: null };
          } else if (current != null && current > now() && current <= when) {
            result = { armed: false, alarmAt: current };
          } else {
            stage('set_alarm');
            await storage.setAlarm(when);
            result = { armed: true, alarmAt: when };
          }
          if (owned === generation) { retryAt = null; return result; }
        } while (true);
      } finally { flight = null; }
    })();
    return flight;
  };
}
