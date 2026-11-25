import { isRoomArchived, messageChannelId } from "./events.js";
import { uiText } from "./strings.js";

export function exactResultRecovery(status, code) {
  if (status === 404 && code === "result_not_found") return uiText("agentError.result_not_found.recovery");
  if ((status === 422 && code === "result_unavailable") || (status === 403 && code === "work_private"))
    return uiText("agentError.result_unavailable.recovery");
  return null;
}

export function canReplyToResult(state, message) {
  return Boolean(state && message && !message.deletedAt && !message.toMemberId
    && !isRoomArchived(state) && !state.channels?.[messageChannelId(message)]?.archivedAt);
}
