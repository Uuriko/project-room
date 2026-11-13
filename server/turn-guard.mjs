// Turn end and the reply guard.
//
// A wake ack by an agent (REST or MCP, not the stale-prune cron) is the Room's
// notion of "this agent finished a turn on that signal". Two things happen:
//   1. a typed `turn.completed` signal is appended to room_signal_log per room:
//      { n signals acked, k kinds, rp: 1 replied | 0 silent | -1 unknown, d door };
//   2. for mention/DM signals, the reply guard checks whether the agent posted
//      anything in that room since the oldest acked signal was created. If not,
//      the ack result carries one advisory reminder.
//
// Idea from Buzz's reply guard (crates/buzz-agent/README.md "Reply Guard",
// block/buzz, Apache-2.0): a turn that does work and never publishes is a silent
// failure the requester cannot see. Borrowed: the problem statement, "advisory,
// never a trap", reminder text that explicitly licenses silence. Not borrowed:
// the rerolling of a model turn (Room agents are external processes; the Room
// can only advise on the ack and measure). One reminder per signal at most (a
// signal can be acked once). No Buzz code is copied.
//
// Cost: when mention/DM signals are acked, one identity link read and one read
// of the room's last REPLY_WINDOW_EVENTS journal rows per room. If that window
// does not reach back to the signal, the verdict is "unknown" (rp -1): never a
// false "silent". Never throws.
import { appendSignal } from "./signal-log.mjs";

export const REPLY_WINDOW_EVENTS = 200;
export const REPLY_GUARD_NOTE = "Advisory only: you acknowledged a mention or DM here and have not posted in this room since. "
  + "If a reply is owed, post it now. If silence is the right answer, ignore this; it is not repeated.";
const GUARDED = new Set(["mention", "dm"]);
const POSTED = new Set(["message.posted", "dm.posted"]);

// rows: [{ signalId, kind, roomId, createdAt }] for the signals this ack settled.
// Returns { silent: [{ signalId, kind, roomId }] } (empty when nothing to remind).
export function guardTurn(db, { agentId, rows, at, door }) {
  const silent = [];
  try {
    if (door !== "rest" && door !== "mcp") return { silent };
    const byRoom = new Map();
    for (const row of rows) {
      if (!row?.roomId) continue;
      const g = byRoom.get(row.roomId) ?? { rows: [], kinds: new Set() };
      g.rows.push(row); g.kinds.add(row.kind);
      byRoom.set(row.roomId, g);
    }
    for (const [roomId, g] of byRoom) {
      const guarded = g.rows.filter(r => GUARDED.has(r.kind));
      let rp = -1;
      if (guarded.length > 0) {
        const since = Math.min(...guarded.map(r => r.createdAt));
        const member = db.prepare("SELECT member_id AS memberId FROM identity_links WHERE room_id=? AND identity_id=?").get(roomId, agentId)?.memberId;
        if (member) {
          const window = db.prepare(`SELECT json_extract(body,'$.at') AS at, json_extract(body,'$.actorId') AS actorId, json_extract(body,'$.type') AS type
            FROM events WHERE room_id=? AND sequence>(SELECT MAX(sequence) FROM events WHERE room_id=?)-? ORDER BY sequence`).all(roomId, roomId, REPLY_WINDOW_EVENTS);
          const reach = window.length ? Date.parse(window[0].at) : NaN;
          const reached = window.length < REPLY_WINDOW_EVENTS || reach <= since; // the whole history, or back past the signal
          if (reached) {
            rp = window.some(e => e.actorId === member && POSTED.has(e.type) && Date.parse(e.at) >= since) ? 1 : 0;
          }
          if (rp === 0) for (const r of guarded) silent.push({ signalId: r.signalId, kind: r.kind, roomId });
        }
      }
      appendSignal(db, { roomId, at, type: "turn.completed", targetId: agentId, ref: g.rows[0].signalId,
        detail: { n: g.rows.length, k: [...g.kinds].sort().join(",").slice(0, 60), rp, d: door } });
    }
  } catch { /* the guard is advisory and never fails an ack */ }
  return { silent };
}
