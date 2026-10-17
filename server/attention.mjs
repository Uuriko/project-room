// W4-46 H4: quiet hours and digest choice. The operator controls WHEN
// attention is delivered; the queue (W4-45) still owns WHAT is pending.
// Delivery control never mutates queue state: a held wake stays pending and
// is simply not deliverable yet, so delivery can never be mistaken for
// handled. Preferences are private per member (draft class) and append no
// room events, exactly like private reminders.
//
// T-6 dead-verdict (2026-10-16): the mutate() write door was REMOVED — at
// main 6f828f08 it had zero production callers (no HTTP route, MCP tool or
// command dispatch reached it; only tests and scripts/recovery-coverage
// called it), so no production path could ever set preferences. Reading
// stays: prefs() is consumed in production by server/work-wakes.mjs, and
// preference rows written before the door closed keep working. The
// private_attention_commands journal below is retained-for-audit: its
// only writer was mutate(), existing rows are immutable receipts, and no
// code reads or writes it now. Re-adding a write door is a product
// decision; do not resurrect mutate() without one.


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

// Two-trigger discipline (lane B8): the quiet-window check shared by the
// legacy heldUntil arithmetic and the interrupt delivery decision, so both
// read the same window. Pure; prefs carry UTC minute offsets, may be null.
const inQuietWindow = (prefs, at) => {
  if (!prefs || prefs.quietStart === null || prefs.quietStart === undefined) return false;
  const mod = Math.floor(at / 60000) % MINUTES_PER_DAY, s = prefs.quietStart, e = prefs.quietEnd;
  return s < e ? mod >= s && mod < e : mod >= s || mod < e;
};

// Interrupt-class delivery (lane B8): interrupts are never held — inside
// quiet hours they deliver silently (badge/count, no sound), outside they
// deliver normally. The break-through bar (loud vs silent) is the
// classifier's call; this is pure delivery arithmetic, and like heldUntil
// it never mutates queue state. Additive; heldUntil below is untouched.
export function interruptDelivery(prefs, at = Date.now()) {
  return Object.freeze({ decision: "deliver", silent: inQuietWindow(prefs, at), heldUntil: null });
}

// Pure delivery arithmetic, in UTC minutes. A quiet window may wrap midnight
// (start > end). heldUntil returns null when delivery is allowed at `at`,
// otherwise the earliest later moment when delivery is allowed. Digest choice
// collects attention into one daily delivery moment (the digest hour); when
// that moment falls inside quiet hours, delivery moves to the window's end.
export function heldUntil(prefs, at) {
  if (!prefs) return null;
  const MIN = 60000, DAY = MINUTES_PER_DAY * MIN;
  const inQuiet = ms => inQuietWindow(prefs, ms);
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
  // Due wakes filtered through the member's delivery preference. Held wakes
  // keep their queue state (still pending, never done) - delivery is only
  // ever a view over intent, so held delivery never pretends handled.
  deliverable(token, roomId, binding = null) {
    return this.store.readTransaction(() => {
      const auth = this.store.authenticate(token, roomId, binding);
      const now = this.store.now();
      const prefs = this.prefs(roomId, auth.member.id);
      const due = this.db.prepare("SELECT * FROM wake_queue WHERE room_id=? AND member_id=? AND state='pending' AND due_at<=? ORDER BY due_at,queue_key").all(roomId, auth.member.id, now);
      // Each wake has its own delivery moment, computed from when it became
      // due - not from now. heldUntil(prefs, due_at) answers "when does a
      // wake due at due_at first become deliverable": for digest prefs that
      // is the first digest boundary at/after due_at (moved out of quiet
      // hours), so a wake due before today's digest hour is deliverable once
      // that hour passes, instead of being re-held until tomorrow's just
      // because the query happens later. A null hold means the wake was
      // deliverable from its due moment.
      const deliverNow = [], held = [];
      for (const row of due) {
        const wakeHeldUntil = heldUntil(prefs, row.due_at);
        const deliverAt = wakeHeldUntil ?? row.due_at;
        if (deliverAt <= now) deliverNow.push(row.queue_key);
        else held.push({ queueKey: row.queue_key, dueAt: row.due_at, heldUntil: deliverAt, state: row.state });
      }
      return {
        roomId, viewerId: auth.member.id, evaluatedAt: now, preferences: prefs,
        heldUntil: held.length ? Math.min(...held.map(row => row.heldUntil)) : null,
        deliverNow, held
      };
    });
  }
}
