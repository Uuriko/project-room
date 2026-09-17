// W4-46 H4: quiet hours and digest choice. The operator controls WHEN
// attention is delivered; the queue (W4-45) still owns WHAT is pending.
// Delivery control never mutates queue state: a held wake stays pending and
// is simply not deliverable yet, so delivery can never be mistaken for
// handled. Preferences are private per member (draft class) and append no
// room events, exactly like private reminders.

import { createHash } from "node:crypto";
import { validId } from "../src/events.js";
import { ServiceError } from "./store.mjs";

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };
export const attentionSchema = `
  CREATE TABLE IF NOT EXISTS private_attention_prefs (
    room_id TEXT NOT NULL REFERENCES rooms(id), member_id TEXT NOT NULL,
    quiet_start INTEGER, quiet_end INTEGER,
    delivery TEXT NOT NULL CHECK(delivery IN ('immediate','digest')),
    digest_hour INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(room_id,member_id)
  );
  CREATE TABLE IF NOT EXISTS private_attention_commands (
    room_id TEXT NOT NULL REFERENCES rooms(id), member_id TEXT NOT NULL, request_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL, response TEXT NOT NULL,
    PRIMARY KEY(room_id,member_id,request_id)
  );
  CREATE TRIGGER IF NOT EXISTS attention_commands_no_update BEFORE UPDATE ON private_attention_commands BEGIN SELECT RAISE(ABORT,'attention receipts are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS attention_commands_no_delete BEFORE DELETE ON private_attention_commands BEGIN SELECT RAISE(ABORT,'attention receipts are retained'); END;
`;
const MINUTES_PER_DAY = 1440;
const prefsView = row => row ? { quietStart: row.quiet_start, quietEnd: row.quiet_end, delivery: row.delivery, digestHour: row.digest_hour, updatedAt: row.updated_at } : null;

// Pure delivery arithmetic, in UTC minutes. A quiet window may wrap midnight
// (start > end). heldUntil returns null when delivery is allowed at `at`,
// otherwise the earliest later moment when delivery is allowed. Digest choice
// collects attention into one daily delivery moment (the digest hour); when
// that moment falls inside quiet hours, delivery moves to the window's end.
export function heldUntil(prefs, at) {
  if (!prefs) return null;
  const MIN = 60000, DAY = MINUTES_PER_DAY * MIN;
  const inQuiet = ms => {
    if (prefs.quietStart === null || prefs.quietStart === undefined) return false;
    const mod = Math.floor(ms / MIN) % MINUTES_PER_DAY, s = prefs.quietStart, e = prefs.quietEnd;
    return s < e ? mod >= s && mod < e : mod >= s || mod < e;
  };
  const exitQuiet = ms => {
    if (!inQuiet(ms)) return ms;
    const s = prefs.quietStart, e = prefs.quietEnd;
    const dayStart = Math.floor(ms / DAY) * DAY, mod = Math.floor(ms / MIN) % MINUTES_PER_DAY;
    if (s < e) return dayStart + e * MIN;                            // same-day window: end is later today
    return (mod >= s ? dayStart + DAY : dayStart) + e * MIN;         // wrapping window: end is tomorrow past start, today past midnight
  };
  let target = at;
  if (prefs.delivery === "digest") {
    const dayStart = Math.floor(at / DAY) * DAY, boundary = dayStart + prefs.digestHour * 60 * MIN;
    target = at <= boundary ? boundary : boundary + DAY;
  }
  const delivered = exitQuiet(target);
  return delivered <= at ? null : delivered;
}

export class Attention {
  constructor(store) { this.store = store; this.db = store.db; }
  // Purely additive at v27 (W4-46): a read-only open of an older v27 file may
  // find none of these objects and must not migrate, so allowAbsent accepts a
  // wholly missing schema; a partially present one still fails.
  verifySchema({ allowAbsent = false } = {}) {
    const normalize = sql => sql?.trim().replace(/;$/, "").replace(/IF NOT EXISTS /g, "").replace(/\s+/g, " ");
    const expected = attentionSchema.trim().split(/;\s*(?=CREATE|$)/).filter(Boolean)
      .map(sql => ({ sql, actual: this.db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(/^CREATE (?:TABLE|INDEX|TRIGGER) (?:IF NOT EXISTS )?([a-z_]+)/.exec(sql.trim())[1])?.sql }));
    if (allowAbsent && expected.every(({ actual }) => actual === undefined)) return false;
    for (const { sql, actual } of expected) {
      if (normalize(actual) !== normalize(sql)) throw new Error("Attention preference schema requires operator reconciliation");
    }
    return true;
  }
  prefs(roomId, memberId) {
    return prefsView(this.db.prepare("SELECT * FROM private_attention_prefs WHERE room_id=? AND member_id=?").get(roomId, memberId));
  }
  list(token, roomId, binding = null) {
    return this.store.readTransaction(() => {
      const auth = this.store.authenticate(token, roomId, binding);
      return { roomId, viewerId: auth.member.id, evaluatedAt: this.store.now(), preferences: this.prefs(roomId, auth.member.id) };
    });
  }
  mutate(token, roomId, request, binding = null) {
    return this.store.transaction(() => {
      const auth = this.store.authenticate(token, roomId, binding);
      const fields = ["requestId", "quietStart", "quietEnd", "delivery", "digestHour"];
      const minute = v => v === null || (Number.isSafeInteger(v) && v >= 0 && v < MINUTES_PER_DAY);
      if (!request || Array.isArray(request) || Object.keys(request).length !== fields.length || !fields.every(field => Object.hasOwn(request, field))
        || !validId(request.requestId) || !minute(request.quietStart) || !minute(request.quietEnd)
        || !["immediate", "digest"].includes(request.delivery)
        || !(request.digestHour === null || (Number.isSafeInteger(request.digestHour) && request.digestHour >= 0 && request.digestHour <= 23)))
        fail(422, "invalid_attention", "Supply quiet window minutes (or null), a delivery choice, a digest hour (or null) and a request ID.");
      if ((request.quietStart === null) !== (request.quietEnd === null)) fail(422, "invalid_attention", "Quiet hours need both a start and an end, or neither.");
      if (request.quietStart !== null && request.quietStart === request.quietEnd) fail(422, "invalid_attention", "Quiet hours start and end must differ.");
      if (request.delivery === "digest" && request.digestHour === null) fail(422, "invalid_attention", "Digest delivery needs a digest hour.");
      if (request.delivery === "immediate" && request.digestHour !== null) fail(422, "invalid_attention", "Immediate delivery takes no digest hour.");
      const fingerprint = createHash("sha256").update(JSON.stringify(Object.fromEntries(fields.sort().map(field => [field, request[field]])))).digest("hex");
      const prior = this.db.prepare("SELECT fingerprint,response FROM private_attention_commands WHERE room_id=? AND member_id=? AND request_id=?").get(roomId, auth.member.id, request.requestId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) fail(409, "idempotency_conflict", "Request ID already used for different attention settings");
        return { ...this.list(token, roomId, binding), receipt: JSON.parse(prior.response), duplicate: true };
      }
      const now = this.store.now();
      const receipt = { requestId: request.requestId, quietStart: request.quietStart, quietEnd: request.quietEnd, delivery: request.delivery, digestHour: request.digestHour };
      this.db.prepare(`INSERT INTO private_attention_prefs (room_id,member_id,quiet_start,quiet_end,delivery,digest_hour,updated_at) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(room_id,member_id) DO UPDATE SET quiet_start=excluded.quiet_start,quiet_end=excluded.quiet_end,delivery=excluded.delivery,digest_hour=excluded.digest_hour,updated_at=excluded.updated_at`)
        .run(roomId, auth.member.id, request.quietStart, request.quietEnd, request.delivery, request.digestHour, now);
      this.db.prepare("INSERT INTO private_attention_commands VALUES(?,?,?,?,?)").run(roomId, auth.member.id, request.requestId, fingerprint, JSON.stringify(receipt));
      return { ...this.list(token, roomId, binding), receipt, duplicate: false };
    });
  }
  // Due wakes filtered through the member's delivery preference. Held wakes
  // keep their queue state (still pending, never done) - delivery is only
  // ever a view over intent, so held delivery never pretends handled.
  deliverable(token, roomId, binding = null) {
    return this.store.readTransaction(() => {
      const auth = this.store.authenticate(token, roomId, binding);
      const now = this.store.now();
      const prefs = this.prefs(roomId, auth.member.id);
      const due = this.db.prepare("SELECT * FROM wake_queue WHERE room_id=? AND member_id=? AND state='pending' AND due_at<=? ORDER BY due_at,queue_key").all(roomId, auth.member.id, now);
      const held = heldUntil(prefs, now);
      return {
        roomId, viewerId: auth.member.id, evaluatedAt: now, preferences: prefs, heldUntil: held,
        deliverNow: held === null ? due.map(row => row.queue_key) : [],
        held: held === null ? [] : due.map(row => ({ queueKey: row.queue_key, dueAt: row.due_at, heldUntil: held, state: row.state }))
      };
    });
  }
}
