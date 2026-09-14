// W4-44 H2: explicit observe/draft/act separation over the command surface.
//
// Every way a caller can change recorded state carries exactly one action
// class. The class is a statement about effects, not about the caller:
//   observe - reads and derivations only; no recorded state changes.
//   draft   - records the actor's own intent or personal state; nothing is
//             addressed at another member, nothing leaves the room, nothing
//             spends or launches work.
//   act     - room-visible to others, grants access, sends outward, or
//             launches/spends (sessions, claims, work lifecycle).
//
// The done-when for H2: enabling a private reminder is draft-class and can
// never post a message or launch paid work. tests/action-classes.test.js
// proves completeness (every command type classified) and the behavioral
// isolation of the reminder path. Adding a command type without a class
// fails the completeness test; classify() itself fails closed.
import { EVENT_TYPES as T } from "../src/events.js";
import { HELP_OFFER_OPENED, HELP_OFFER_UPDATED } from "../src/help-offers.js";

export const ACTION_CLASSES = Object.freeze({
  observe: Object.freeze([]),
  draft: Object.freeze([
    T.NOTIFICATION_PREFERENCES_SET, // personal delivery preferences, viewer-only
  ]),
  act: Object.freeze([
    T.ROOM_CHARTER_UPDATED, T.ROOM_POLICY_SET, T.ROOM_ARCHIVED, T.MEMBER_ADDED, T.MEMBER_ACCESS_CHANGED, T.MEMBER_STATUS_UPDATED,
    T.MESSAGE_POSTED, T.MESSAGE_EDITED, T.MESSAGE_DELETED, T.MESSAGE_REACTION_SET,
    T.REPLY_REQUEST_CANCELLED, HELP_OFFER_OPENED, HELP_OFFER_UPDATED,
    T.WORK_PROPOSED, T.WORK_ACCEPTED, T.WORK_HELP_UPDATED, T.WORK_STARTED, T.WORK_BLOCKED,
    T.WORK_BLOCKER_RESOLVED, T.WORK_COMPLETED, T.WORK_SUPERSEDED, T.WORK_HANDOFF_RECORDED,
    T.WORK_HALT_CLEARED, T.CLAIM_ACQUIRED, T.CLAIM_RELEASED, T.VERIFICATION_RECORDED,
    T.OWNER_DECISION_RECORDED, T.DECISION_RECORDED,
    T.SESSION_STARTED, T.SESSION_STATUS_CHANGED, T.SESSION_STOP_REQUESTED, T.SESSION_STOPPED,
    T.CAPABILITIES_ADVERTISED,
  ]),
});

// Out-of-band command surfaces (server modules that take authenticated
// commands without appending room events). Same three classes.
export const SURFACE_CLASSES = Object.freeze({
  "private-reminders": "draft",      // server/reminders.mjs: per-member schedule records, immutable receipts, no outward effect
  "wake-queue": "draft",
  "attention-delivery": "draft",      // server/attention.mjs: private quiet-hours/digest preferences; delivery views only             // server/wake-queue.mjs: the member's own scheduled intents; effects stay drafts
  "inbox-reply-sends": "act",        // server/inbox-transport.mjs: external send authority
  "email-import.mjs": "act",             // server/email-import.mjs: writes imported content into the room
  "share-links": "act",              // server/share-links.mjs: mints access-granting links
  "guest-agent-links": "act",        // server/guest-agent-links.mjs: mints credentials
  "agent-access": "act",             // server/agent-connections|identities|invites.mjs: grants agent access
  "dispatch-journal": "act",         // server/dispatch-journal.mjs: launches jobs
  "operator-reads": "observe",       // backup/diagnostics/version/maintenance/recovery reads
});

const CLASS_BY_TYPE = new Map();
for (const [klass, types] of Object.entries(ACTION_CLASSES)) {
  for (const type of types) {
    if (CLASS_BY_TYPE.has(type)) throw new Error(`Command type ${type} classified twice`);
    CLASS_BY_TYPE.set(type, klass);
  }
}

export function classifyCommand(type) {
  const klass = CLASS_BY_TYPE.get(type);
  if (!klass) throw new Error(`Unclassified command type: ${type}`);
  return klass;
}

export function surfaceClass(name) {
  const klass = SURFACE_CLASSES[name];
  if (!klass) throw new Error(`Unclassified command surface: ${name}`);
  return klass;
}

// The draft-class boundary: effects a draft-class command may never cause.
export const ACT_ONLY_EFFECTS = Object.freeze([T.MESSAGE_POSTED, T.SESSION_STARTED, T.CLAIM_ACQUIRED]);
