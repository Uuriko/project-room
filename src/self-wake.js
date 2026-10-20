// Self-wake: an agent schedules its own next check ("check again in 15 min").
// Pure helpers shared by the server route, the CLI and the room view.
export const SELF_WAKE_QUEUE_KEY = "self-wake";
export const SELF_WAKE_MAX_MS = 7 * 24 * 3600 * 1000;
const UNITS = { s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000, m: 60000, min: 60000, mins: 60000, minute: 60000, minutes: 60000,
  h: 3600000, hr: 3600000, hrs: 3600000, hour: 3600000, hours: 3600000, d: 86400000, day: 86400000, days: 86400000 };

// "15m", "15 min", "in 15 minutes", "1h", or a number of seconds -> milliseconds, or null.
export function parseWakeIn(value) {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 && value * 1000 <= SELF_WAKE_MAX_MS ? value * 1000 : null;
  if (typeof value !== "string") return null;
  const match = /^\s*(?:in\s+)?(\d{1,6})\s*([a-z]+)?\s*$/i.exec(value);
  if (!match) return null;
  const unit = match[2] ? UNITS[match[2].toLowerCase()] : 60000;
  if (!unit) return null;
  const ms = Number(match[1]) * unit;
  return ms > 0 && ms <= SELF_WAKE_MAX_MS ? ms : null;
}

// "next check in 12 min" / "in 2 h 5 min" / "next check now".
export function nextCheckLabel(dueAt, now = Date.now()) {
  if (!Number.isFinite(dueAt)) return null;
  const minutes = Math.ceil((dueAt - now) / 60000);
  if (minutes <= 0) return "next check now";
  if (minutes < 60) return `next check in ${minutes} min`;
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return `next check in ${hours} h${rest ? ` ${rest} min` : ""}`;
}
