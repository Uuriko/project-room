// Lock-screen text for a human push. Counts only. Any other field on the
// payload, including a message body a caller might have attached, is ignored.

export function notificationFromPush(payload) {
  const counts = payload && typeof payload === "object" ? payload.counts : null;
  const mention = Number.isInteger(counts?.mention) && counts.mention > 0 ? counts.mention : 0;
  const dm = Number.isInteger(counts?.dm) && counts.dm > 0 ? counts.dm : 0;
  const waiting = mention + dm;
  let title = "Mentions and DMs";
  if (dm > 0 && mention === 0) title = waiting === 1 ? "Direct message" : "Direct messages";
  else if (mention > 0 && dm === 0) title = waiting === 1 ? "Mention" : "Mentions";
  const body = waiting === 0 ? "Something is waiting in the room"
    : waiting === 1 ? "1 waiting in the room"
    : `${waiting} waiting in the room`;
  const roomId = typeof payload?.roomId === "string" && payload.roomId ? payload.roomId : null;
  return { title, body, tag: roomId ? `room:${roomId}` : "room", data: { roomId } };
}
