import { identityIdForWakeMember } from "./wake-identity-resolution.mjs";

// Sender-facing mention receipts.
//
// A mention row is written as delivered when the @ resolves (store.trackMentions).
// The mentioned member's acknowledgement, or a reply that answers it, is the
// read/ack. This lists those rows for the member who sent the mention, so they
// can see whether it landed without reading someone else's inbox.
//
// delivered is true for every row: the row is the delivery record. read and
// acked are true once the state has moved to acknowledged or responded.
// timed_out was delivered and was not read.
//
// wakeState (WAKE0-2, wake-on-mention Step 0 §2.6): the wake intent this
// mention caused, when one exists — "summoned" while it stands,
// "discharged" once the runtime connected or the mention resolved,
// "expired" when the mention timed out before the intent discharged.
// The state is COMPUTED on this read (the mention surface never mutates
// wake rows — discharge belongs to the wake surface, §2.4); a mention
// that caused no intent (online / hostless / paused / target-less)
// reports null.

const READ_STATES = new Set(["acknowledged", "responded"]);

function wakeStateFor(store, wakeStmt, roomId, row) {
  if (!wakeStmt) return null;
  const agentId = identityIdForWakeMember(store.db, roomId, row.memberId);
  if (!agentId) return null;
  const wake = wakeStmt.get(agentId, roomId, `wake:${row.messageId}`);
  if (!wake) return null;
  if (row.state === "timed_out" && (wake.deliveredAt === null || wake.deliveredAt > row.timeoutAt)) {
    return "expired";
  }
  return wake.deliveredAt === null ? "summoned" : "discharged";
}

export function listMentionReceipts(store, token, roomId, expectedSessionBinding = null) {
  const auth = store.authenticate(token, roomId, expectedSessionBinding);
  return store.transaction(() => {
    store.flipExpiredMentions(roomId);
    const rows = store.db.prepare(
      `SELECT m.message_event_id AS messageEventId, m.mentioned_member_id AS memberId, m.state,
              m.created_at AS createdAt, m.timeout_at AS timeoutAt, m.decided_at AS decidedAt,
              COALESCE(json_extract(e.body, '$.data.messageId'), e.id) AS messageId
       FROM mention_states m
       JOIN events e ON e.room_id = m.room_id AND e.id = m.message_event_id
       WHERE m.room_id = ? AND json_extract(e.body, '$.actorId') = ?
         AND json_extract(e.body, '$.type') = 'message.posted'
       ORDER BY m.created_at DESC LIMIT 200`
    ).all(roomId, auth.member.id);
    // Defensive: a database from before the wake fabric has no signals
    // table; receipts then simply carry no wake state.
    let wakeStmt = null;
    try {
      wakeStmt = store.db.prepare(
        "SELECT delivered_at AS deliveredAt FROM agent_wake_signals WHERE agent_id=? AND room_id=? AND kind='wake' AND message_id=?");
    } catch { wakeStmt = null; }
    const members = store.room(roomId).state.members ?? {};
    return {
      roomId,
      senderId: auth.member.id,
      receipts: rows.map(row => ({
        messageEventId: row.messageEventId,
        memberId: row.memberId,
        displayName: members[row.memberId]?.displayName ?? row.memberId,
        delivered: true,
        state: row.state,
        wakeState: wakeStateFor(store, wakeStmt, roomId, row),
        read: READ_STATES.has(row.state),
        acked: READ_STATES.has(row.state),
        createdAt: new Date(row.createdAt).toISOString(),
        timeoutAt: new Date(row.timeoutAt).toISOString(),
        decidedAt: row.decidedAt === null ? null : new Date(row.decidedAt).toISOString()
      }))
    };
  });
}
