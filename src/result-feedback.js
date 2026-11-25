import { MAX_MESSAGE_BODY_CHARS } from "./events.js";
import { canReplyToResult } from "./result-availability.js";

// Validate before navigating: the shell owns drafts/focus; this controller owns
// eligibility and destination selection. Re-read current state on every action.
export function createResultFeedback({ getState, getConversation, isBlocked,
  getDraft, onBlocked, openThread, setReply }) {
  return (messageId, selection = null, completionEventId = null) => {
    const state = getState();
    const conversation = getConversation();
    const message = conversation?.byId.get(messageId);
    if (!canReplyToResult(state, message) || isBlocked()) return false;
    const destination = conversation?.rootById.get(message.id);
    if (!destination || !conversation.threads.has(destination)) return false;
    const draft = getDraft(destination);
    let quote;
    if (selection) {
      const { body, start, end } = selection;
      // Bind the quote to the exact source inspected, before any navigation.
      if (typeof body !== "string" || body !== message.body || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
        || start < 0 || end <= start || end > body.length) return false;
      const passage = body.slice(start, end).split("\n").map(line => `> ${line}`).join("\n");
      quote = [passage, selection.sourceHref].filter(Boolean).join("\n") + "\n\n";
    }
    const hasContent = Boolean(draft?.body?.trim() || draft?.files?.length);
    const differentReply = hasContent && ((draft.replyToId && draft.replyToId !== message.id)
      || (draft.resultReplyEventId && draft.resultReplyEventId !== completionEventId));
    if (draft?.pending || draft?.toMemberId || differentReply) { onBlocked(); return false; }
    const body = draft?.body ?? "";
    if (quote && !body.startsWith(quote) && quote.length + body.length > MAX_MESSAGE_BODY_CHARS) {
      onBlocked("result.quoteTooLong"); return false;
    }
    openThread(message, destination);
    setReply(message.id, quote, completionEventId);
    return true;
  };
}
