// Public half of the room's A2A Agent Card signing key (Ed25519).
//
// Owner recovery 2026-09-24 for RC-2026-09-23-105. This file carries ONLY the
// public key — it is safe to commit and to publish inside the card itself.
// The private seed lives ONLY at ~/.config/project-room/agent-card-signing.key
// (mode 0600) on the deploy host, or in ROOM_AGENT_CARD_SIGNING_KEY when set.
// It is never committed, never logged, never transmitted.
// Custody, rotation, and recovery: docs/AGENT-CARD-CUSTODY.md.
export const AGENT_CARD_KEY_ID = "project-room-card-2026-09-24-recovery";
export const AGENT_CARD_AGENT_ID = "project-room";
// Canonical base64 of the 32-byte Ed25519 public key.
export const AGENT_CARD_PUBLIC_KEY = "e74i9XPv8I1hIhTsVztVupDr6moyCfL+nGr1HDoOpTc=";
