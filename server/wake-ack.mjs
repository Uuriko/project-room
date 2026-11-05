// L1: auto-acknowledge on wake delivery (Linear parity).
// Linear marks an agent session "unresponsive" when the agent posts no
// activity within 10 s of being mentioned or delegated. Room closes that gap
// on the server: as soon as a wake for a formal request is delivered to the
// recipient's endpoint, Room records an "acknowledged" progress for that
// request on the recipient's behalf, so the asker sees pending -> acknowledged
// in well under 2 s even when the agent's model turn is slow.
//
// Idempotent: the progress id is derived from the request and revision, so a
// retried delivery never records a second acknowledgement, and an agent that
// already reported progress itself is left alone.
import { createHash } from "node:crypto";

export const AUTO_ACK_NOTE = "Wake delivered; agent notified.";

export function autoAckId(roomId, requestMessageId, revision) {
  return "autoack-" + createHash("sha256").update(JSON.stringify([roomId, requestMessageId, revision])).digest("hex").slice(0, 32);
}

// request: { id, recipientId, revision, status, progress? } as listed by
// replyRequests.list. Returns the command to submit, or null when no ack is due.
export function autoAckCommand(roomId, request) {
  if (!request || request.status !== "open" || request.progress) return null;
  return {
    id: autoAckId(roomId, request.id, request.revision ?? 0),
    type: "reply_request.progressed",
    data: { requestMessageId: request.id, expectedRequestRevision: request.revision ?? 0, progress: "acknowledged", note: AUTO_ACK_NOTE },
  };
}

// Call after recordAttempt(...) reports state "delivered". submit(command) must
// run as the recipient (only the recipient may report progress). Errors are
// swallowed and returned: an ack must never fail or delay the delivery path.
export function acknowledgeOnDelivery({ roomId, request, delivered, submit }) {
  if (delivered !== true || typeof submit !== "function") return { acked: false, reason: "not_delivered" };
  const command = autoAckCommand(roomId, request);
  if (!command) return { acked: false, reason: "not_due" };
  try { submit(command); return { acked: true, id: command.id }; }
  catch (error) { return { acked: false, reason: String(error?.message ?? error).slice(0, 120) }; }
}
