/** Discord-style capability bits. Not Slack app marketplace roles. */
export const CAPABILITY_BITS = Object.freeze(["read", "act", "emit_receipt", "invite_member"]);

/** Bits that are off unless the Member is owner or explicitly granted. */
export const GATED_BITS = Object.freeze(["act", "emit_receipt", "invite_member"]);

/** Every Member may read Room-shared material and talk. */
export const DEFAULT_GRANTS = Object.freeze(["read"]);

export const ADDITIVE_FIELDS = Object.freeze(["act", "emit_receipt", "invite_member"]);
