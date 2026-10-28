# Bring back an AI draft

1. Open a work item’s Details → **Use my AI**. Review the prompt before copying; the original source message is optional.
2. Ask your AI to return its answer with the exact `ROOM-RETURN` line. Copying the prompt does not run an agent or grant outside permission.
3. Choose **Paste AI draft**, review the answer, then **Post draft**. Desktop Enter posts; Shift+Enter adds a line. Touch Return adds a line.
4. The confirmed draft opens as a conversation message. **View latest draft** on its work card returns to the newest linked pasted draft; older contributions remain in conversation. These links do not mark the room caught up.

The signed-in member is the submitter, not automatically the verified producer of an outside answer. A pasted draft does not accept an assignment, start work, create completion evidence, pass review or approve anything. The accountable member’s separate **Post evidence** flow still requires a reported HTTPS reference, exact version and explicit producer attribution. There is no new native artifact store or automatic adoption.

## If something changes

- **Work changed:** after confirmed rejection, review the draft and explicitly choose whether to post an older draft. Unrelated conversation does not invalidate the work revision.
- **Save not confirmed:** retry the same draft. The browser preserves its exact command and message identity, including after rate limiting or another pre-ledger refusal. A new attempt is allowed only after a recognized definitive rejection of the original. Reload/sign-out clears this in-memory retry, not a contribution that may already exist; check conversation before submitting again.
- **Saved, but refresh failed:** the confirmed post remains saved. Refresh to view it; the browser does not invent a visible message or replace it with another command.
- **Close:** text and uncertain retries stay in this tab for that work item. Reload, sign-out and observed access loss clear them. There is no cross-device or durable portable-draft recovery.

Only an exact, owned receipt clears the form. The browser checks room, submitter, event type, stable message ID and all submitted fields, plus receipt sequence/event identity/duplicate shape. Multiple drafts may use the same packet; packet ID alone is not submission identity. Old-session callbacks cannot announce success, clear a newer draft or move its focus.

ROOM-RETURN v1, existing message events, service authorization and schema are unchanged. `messageId` was already supported by the service. No permissions, notifications, read markers, paid agents, external requests or publication are added.
