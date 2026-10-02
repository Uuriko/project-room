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

const READ_STATES = new Set(["acknowledged", "responded"]);

export function listMentionReceipts(store, token, roomId, expectedSessionBinding = null) {
  const auth = store.authenticate(token, roomId, expectedSessionBinding);
  return store.transaction(() => {
    store.flipExpiredMentions(roomId);
    const rows = store.db.prepare(
      `SELECT m.message_event_id AS messageEventId, m.mentioned_member_id AS memberId, m.state,
              m.created_at AS createdAt, m.timeout_at AS timeoutAt, m.decided_at AS decidedAt
       FROM mention_states m
       JOIN events e ON e.room_id = m.room_id AND e.id = m.message_event_id
       WHERE m.room_id = ? AND json_extract(e.body, '$.actorId') = ?
         AND json_extract(e.body, '$.type') = 'message.posted'
       ORDER BY m.created_at DESC LIMIT 200`
    ).all(roomId, auth.member.id);
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
        read: READ_STATES.has(row.state),
        acked: READ_STATES.has(row.state),
        createdAt: new Date(row.createdAt).toISOString(),
        timeoutAt: new Date(row.timeoutAt).toISOString(),
        decidedAt: row.decidedAt === null ? null : new Date(row.decidedAt).toISOString()
      }))
    };
  });
}
