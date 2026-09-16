// Natural-language reminder parsing (K020). A pure local parser: extract
// a reminder time and message from phrases like "remind me Friday 9am" or
// "remind me in 30 minutes to call". Supports: "in N minutes/hours",
// weekday names, "today"/"tomorrow" with optional times, and bare times.
// The caller supplies "now" (a Date) for relative resolution. The module
// is pure and dependency-free. Frozen outputs; malformed inputs throw
// ReminderError. Scheduling wiring is a later slice.
class ReminderError extends Error { constructor(code, message) { super(message); this.name = "ReminderError"; this.code = code; } }
const fail = (code, message) => { throw new ReminderError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_reminder", message); };
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const TIME_RE = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i;
const IN_RE = /\bin\s+(\d+)\s*(minute|minutes|hour|hours)\b/i;
// Parse "remind me ..." text. Returns { at (ISO), message } or null if no time found.
export function parseReminder({ text, now }) {
  check(typeof text === "string" && text.trim().length > 0, "text must be a non-empty string");
  check(now instanceof Date && !Number.isNaN(now.getTime()), "now must be a valid Date");
  const lower = text.toLowerCase();
  if (!lower.includes("remind")) return null;
  // Strip the "remind me" prefix to isolate the time + message.
  const body = text.replace(/.*?\bremind\s+(me\s+)?/i, "").trim();
  if (body.length === 0) return null;
  let at = null;
  // "in N minutes/hours"
  const inMatch = body.match(IN_RE);
  if (inMatch) {
    const amount = parseInt(inMatch[1], 10);
    const unit = inMatch[2].startsWith("hour") ? 3600000 : 60000;
    at = new Date(now.getTime() + amount * unit);
  } else {
    // weekday / today / tomorrow
    let dayOffset = null;
    for (let i = 0; i < WEEKDAYS.length; i++) {
      if (lower.includes(WEEKDAYS[i])) {
        const target = i;
        const current = now.getUTCDay();
        dayOffset = (target - current + 7) % 7;
        if (dayOffset === 0) dayOffset = 7; // next week if today
        break;
      }
    }
    if (dayOffset === null) {
      if (lower.includes("tomorrow")) dayOffset = 1;
      else if (lower.includes("today")) dayOffset = 0;
    }
    // time of day
    let hours = 9, minutes = 0; // default 9am
    const timeMatch = body.match(TIME_RE);
    if (timeMatch) {
      hours = parseInt(timeMatch[1], 10);
      minutes = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
      const meridiem = (timeMatch[3] || "").toLowerCase();
      if (meridiem === "pm" && hours < 12) hours += 12;
      if (meridiem === "am" && hours === 12) hours = 0;
      check(hours >= 0 && hours < 24 && minutes >= 0 && minutes < 60, "invalid time");
    }
    if (dayOffset !== null) {
      at = new Date(now);
      at.setUTCDate(at.getUTCDate() + dayOffset);
      at.setUTCHours(hours, minutes, 0, 0);
      if (at <= now) at.setUTCDate(at.getUTCDate() + 7); // roll forward if past
    } else if (timeMatch) {
      // bare time: today if future, else tomorrow
      at = new Date(now);
      at.setUTCHours(hours, minutes, 0, 0);
      if (at <= now) at.setUTCDate(at.getUTCDate() + 1);
    }
  }
  if (!at) return null;
  // Message is the body with the time expression removed.
  const message = body.replace(IN_RE, "").replace(TIME_RE, "")
    .replace(/\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi, "")
    .replace(/\s+/g, " ").replace(/^[,\s]+|[,\s]+$/g, "").trim() || body.trim();
  return Object.freeze({ at: at.toISOString(), message });
}
export { ReminderError };
