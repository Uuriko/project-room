/** Feed kinds only. Ordinary message volume never becomes a row. */
export const FEED_KINDS = Object.freeze(["ack_needed", "failed_receipt", "mention", "exception"]);

export const DEFAULT_TIER = "mentions_and_exceptions";

export const TIERS = Object.freeze(["mentions_and_exceptions", "all_actionable", "nothing"]);

/** Failed Receipts notify as exception-class at the default tier. */
export const DEFAULT_NOTIFY_KINDS = Object.freeze(["mention", "exception", "failed_receipt"]);

export const FAILED_RECEIPT_STATUSES = Object.freeze(["failed", "cancelled", "expired"]);

export const EVENT_TYPES = Object.freeze({
  MESSAGE_POSTED: "message.posted",
  MESSAGE_REACTION_SET: "message.reaction_set",
  WORK_BLOCKED: "work.blocked",
  WORK_COMPLETED: "work.completed",
  VERIFICATION_RECORDED: "verification.recorded",
  RECEIPT_RECORDED: "receipt.recorded"
});
