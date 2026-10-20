import { canReplyToResult } from "./result-availability.js";

// Validate before navigating: the shell owns drafts/focus; this controller owns
// eligibility and destination selection. Re-read current state on every action.
export function createResultFeedback({ getState, getConversation, isBlocked,
  getDraft, onBlocked, openThread, setReply }) {
  return messageId => {
    const state = getState();
    const message = state?.messages.find(entry => entry.id === messageId);
    if (!canReplyToResult(state, message) || isBlocked()) return false;
    const conversation = getConversation();
    const destination = conversation?.rootById.get(message.id);
    if (!destination || !conversation.threads.has(destination)) return false;
    const draft = getDraft(destination);
    if (draft?.pending || draft?.toMemberId) { onBlocked(); return false; }
    openThread(message, destination);
    setReply(message.id);
    return true;
  };
}
