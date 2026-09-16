// Inbox snooze (A013). Pure snooze records: snoozeMessage parks a message
// until a future timestamp, isSnoozed checks the clock, dueSnoozes lists the
// records ready to return to the inbox, and unsnooze closes one early. Pure,
// dependency-free, deterministic for a given `now`; frozen records. No
// timers, no store writes — the caller holds the records and re-injects due
// ones; persistence is a later slice.
class SnoozeError extends Error { constructor(code, message) { super(message); this.name = "SnoozeError"; this.code = code; } }
const fail = (code, message) => { throw new SnoozeError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_snooze", message); };

const timestamp = (value, name) => {
  check(typeof value === "string" && Number.isFinite(Date.parse(value)), `${name} must be a parseable timestamp`);
  return value;
};
const recordOf = value => {
  check(value !== null && typeof value === "object" && !Array.isArray(value), "snooze must be an object");
  check(typeof value.messageId === "string" && value.messageId.length > 0 && value.messageId.length <= 512, "messageId must be 1..512 characters");
  timestamp(value.snoozedUntil, "snoozedUntil");
  check(value.status === "snoozed" || value.status === "returned", "status must be snoozed or returned");
  return value;
};
// Parse a snooze delay like "30m", "2h", "1d", "1w" into milliseconds.
export function parseSnoozeDelay(delay) {
  check(typeof delay === "string", "delay must be text");
  const match = /^(\d+)(m|h|d|w)$/.exec(delay.trim());
  check(match !== null, 'delay must look like "30m", "2h", "1d", or "1w"');
  const amount = Number(match[1]);
  check(amount >= 1 && amount <= 1000, "delay amount must be 1..1000");
  return amount * { m: 60000, h: 3600000, d: 86400000, w: 604800000 }[match[2]];
}
// Park a message. snoozedUntil must be in the future relative to `now`.
export function snoozeMessage({ messageId, snoozedUntil, folder, snoozedBy }, { now } = {}) {
  const at = now ? timestamp(now, "now") : new Date().toISOString();
  check(typeof messageId === "string" && messageId.length > 0 && messageId.length <= 512, "messageId must be 1..512 characters");
  const until = timestamp(snoozedUntil, "snoozedUntil");
  check(Date.parse(until) > Date.parse(at), "snoozedUntil must be in the future");
  return Object.freeze({ messageId, snoozedUntil: until, folder: folder ?? "inbox",
    snoozedBy: snoozedBy ?? null, snoozedAt: at, status: "snoozed" });
}
// Convenience: snooze for a delay ("2h") instead of an absolute timestamp.
export function snoozeFor({ messageId, delay, folder, snoozedBy }, { now } = {}) {
  const at = now ? timestamp(now, "now") : new Date().toISOString();
  return snoozeMessage({ messageId, snoozedUntil: new Date(Date.parse(at) + parseSnoozeDelay(delay)).toISOString(), folder, snoozedBy }, { now: at });
}
export const isSnoozed = (record, { now } = {}) => {
  const snooze = recordOf(record);
  const at = now ? timestamp(now, "now") : new Date().toISOString();
  return snooze.status === "snoozed" && Date.parse(at) < Date.parse(snooze.snoozedUntil);
};
// Records whose time has come — the caller re-injects these into the inbox.
export function dueSnoozes(records, { now } = {}) {
  check(Array.isArray(records), "records must be a list");
  const at = now ? timestamp(now, "now") : new Date().toISOString();
  return records.map(recordOf).filter(snooze => snooze.status === "snoozed" && Date.parse(snooze.snoozedUntil) <= Date.parse(at));
}
// Bring a message back early (e.g. the owner opens it manually).
export function unsnooze(record, { now } = {}) {
  const snooze = recordOf(record);
  check(snooze.status === "snoozed", "only snoozed records can be unsnoozed");
  const at = now ? timestamp(now, "now") : new Date().toISOString();
  return Object.freeze({ ...snooze, status: "returned", returnedAt: at });
}
export { SnoozeError };
