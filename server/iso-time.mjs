// ISO 8601 instants for since/until. A zone-less value is not UTC: Date.parse
// reads it in the host's local zone, which is a silent UTC read only when the
// host itself is UTC. Callers refuse that shape and keep Z or a numeric offset.
export const TIMESTAMP_EXAMPLE = "2026-10-24T20:30:00Z";

const ZONE_LESS_TIME = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?)?$/;
const ZONED_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-](\d{2}):(\d{2}))$/;

export function zoneLessTime(value) {
  return typeof value === "string" && ZONE_LESS_TIME.test(value);
}

export function timeZoneMessage(name) {
  return `${name} must be an ISO 8601 timestamp with Z or an offset, for example ${TIMESTAMP_EXAMPLE}`;
}

// Epoch millis for an RFC 3339 timestamp with Z or a numeric offset, or null
// when the value is not that shape or names a calendar instant that does not
// exist. A zone-less string is null here; callers map that shape to
// invalid_time_zone before calling this.
export function zonedTimestampMillis(value) {
  if (typeof value !== "string") return null;
  const match = ZONED_TIMESTAMP.exec(value);
  if (!match) return null;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const hour = Number(match[4]), minute = Number(match[5]), second = Number(match[6]);
  const zone = match[8];
  const offHour = zone === "Z" ? 0 : Number(match[9]);
  const offMinute = zone === "Z" ? 0 : Number(match[10]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 60 || offHour > 23 || offMinute > 59) return null;
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}
