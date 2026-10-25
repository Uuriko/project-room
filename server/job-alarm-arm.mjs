// A stored alarm timestamp that is already in the past is not a schedule.
// The platform will not fire it again. Treating it as current skips
// setAlarm, and every fast job on that shared tick stays dark until the
// 30-minute cron. Only a future alarm at or before the new time is enough.
export function alarmAlreadyScheduled(current, when, now) {
  return typeof current === "number" && typeof when === "number" && current > now && current <= when;
}
