import { isRoomArchived, messageChannelId } from "./events.js";

export function canReplyToResult(state, message) {
  return Boolean(state && message && !message.deletedAt && !message.toMemberId
    && !isRoomArchived(state) && !state.channels?.[messageChannelId(message)]?.archivedAt);
}
