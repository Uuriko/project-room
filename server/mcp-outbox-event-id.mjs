import { createHash } from "node:crypto";

// Deterministic mcp_event_outbox.event_id for one native wake: the same
// (room, recipient, source room event) always maps to the same row key, so a
// reader can find the exact row through mcp_event_outbox_event instead of
// scanning documents.
export function nativeOutboxEventId(roomId, memberId, sourceEventId) {
  return "mcp_" + createHash("sha256").update(JSON.stringify([roomId, memberId, sourceEventId])).digest("hex");
}
