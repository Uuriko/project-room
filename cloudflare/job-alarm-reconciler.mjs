// One drain per isolate, with a fresh calculation after any overlapping request.
// This caches no job eligibility. A generation changed across storage awaits
// invalidates the decision, including a decision to delete an existing alarm.
export function createJobAlarmReconciler({ storage, calculate, now = Date.now, yieldTurn = () => new Promise(resolve => setTimeout(resolve, 0)) }) {
  let generation = 0, flight = null, retryAt = null;
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
          await yieldTurn();
          const owned = generation;
          let when = await calculate();
          if (retryAt != null) when = when == null ? retryAt : Math.min(when, retryAt);
          const current = await storage.getAlarm();
          // A stale non-null decision may conservatively arm an extra wake,
          // but never postpone an existing earlier alarm. Do not starve known
          // work while read traffic keeps advancing the generation. Only a
          // current empty decision may delete an alarm.
          if (owned !== generation && when == null) continue;
          if (when == null) {
            if (current != null) await storage.deleteAlarm();
            result = { armed: false, alarmAt: null };
          } else if (current != null && current <= when) {
            result = { armed: false, alarmAt: current };
          } else {
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
