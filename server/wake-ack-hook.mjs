// Bridge: auto-ack open formal requests the moment needs-me delivers them.
// Poll-based agents have no webhook "delivered" event; returning the item
// from room_needs_me is delivery. Push delivery can call acknowledgeOnDelivery
// the same way after recordAttempt reports delivered.
import { acknowledgeOnDelivery } from "./wake-ack.mjs";

export function autoAckDeliveredAsks(store, { items, memberByRoom }) {
  if (!Array.isArray(items) || !items.length) return { acked: 0 };
  let acked = 0;
  for (const item of items) {
    if (item?.kind !== "direct_ask" || item.id == null) continue;
    const memberId = memberByRoom?.get?.(item.roomId);
    if (!memberId) continue;
    try {
      const key = store.issueAccessKey(item.roomId, memberId);
      const listed = store.replyRequests.list(key, item.roomId, { direction: "incoming", status: "open" });
      const request = listed?.requests?.find(r => r.id === item.id);
      if (!request) continue;
      const result = acknowledgeOnDelivery({
        roomId: item.roomId,
        request,
        delivered: true,
        submit: command => store.command(key, item.roomId, command),
      });
      if (result.acked) acked += 1;
    } catch {
      // Auto-ack must never fail or delay needs-me.
    }
  }
  return { acked };
}
