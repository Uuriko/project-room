// Status-only post routing hint (flag ROOM_STATUS_DIGEST=1, off by default).
// Measured 2026-11-04: 87 of the last 100 project-room-lobby posts were
// status-only, with no threaded replies, so asks got buried. Room already has
// the two better places for status: a Board item (room_post_message with
// workItemId) and the per-author digest read (room_read_messages view:"digest").
// This module classifies a post and, when the flag is on, the post receipt
// points the author at those places. It never blocks or rewrites a post.
export const statusDigestEnabled = (env = globalThis.process?.env) => env?.ROOM_STATUS_DIGEST === "1";

const STATUS_WORDS = /\b(status|reviewed|landed|merged|deployed|done|shipped|opened|ready|green|passed|claimed|pre-act|ack|progress|update|heartbeat|working on|starting|finished)\b/i;

// Status-only: not a reply, not addressed to anyone, not a question, and reads
// like a progress report. Conservative on purpose: when unsure, it is not status.
export function isStatusOnly({ body, replyToId, toMemberId } = {}) {
  const text = typeof body === "string" ? body : "";
  if (!text.trim() || replyToId || toMemberId) return false;
  if (/\?/.test(text) || /<@[^>]+>|(^|\s)@\w/.test(text)) return false;
  return STATUS_WORDS.test(text);
}

export function statusHint(data, env) {
  if (!statusDigestEnabled(env) || data?.workItemId || !isStatusOnly(data)) return null;
  return {
    kind: "status_only",
    acknowledges: false,
    message: "This looks like a status update. Attach status to the Board item it is about so the room feed stays for asks and replies.",
    next: [
      { tool: "room_post_message", arguments: { workItemId: "<the Board item this status is about>" } },
      { tool: "room_read_messages", arguments: { view: "digest" }, why: "read others' status grouped per author" }
    ]
  };
}
