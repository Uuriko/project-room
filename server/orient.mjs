// Orient endpoint builder (jill lane, RC-2026-09-28 — ryska's 404).
//
// The URL outside agents guess by analogy with /activation-pack:
// GET /api/rooms/{roomId}/orient. Read-only, member-scoped orientation
// payload: contract version, the authenticated member and their scope,
// room summary, evaluated-through sequence, and a bounded list of open
// work records with their next steps — the same "where the room stands"
// the client-side orient() computes from a snapshot, served to cold-HTTP
// agents with no client SDK.
//
// Everything returned is derivable from the activation pack plus the
// caller's own member record, so this adds no new visibility and has no
// DM-privacy implications. Unknown rooms surface the store's 404
// (room_not_found).
import { roomOrientation } from "../src/work-selectors.js";
import { nextWorkStep } from "../src/workflow.js";
import { roomKind, WORK_STATES } from "../src/events.js";

// Work states that count as open; completed and superseded work is history,
// not something an arriving agent should pick up.
const OPEN_WORK_STATES = new Set([
  WORK_STATES.PROPOSED, WORK_STATES.ACCEPTED, WORK_STATES.WORKING, WORK_STATES.BLOCKED
]);

// Orientation is a glance, not a dump.
const MAX_WORK = 50;

const memberOf = member => ({
  id: member.id,
  handle: member.displayName,
  kind: member.kind,
  permissions: [...member.permissions],
  active: member.active !== false
});

const workOf = (item, now) => {
  const next = nextWorkStep(item, now);
  return {
    id: item.id,
    title: item.title,
    state: item.state,
    claimant: item.claim?.holderId ?? null,
    next: {
      action: next.action,
      label: next.label,
      memberId: next.memberId ?? null,
      needsAttention: next.needsAttention
    }
  };
};

// Opaque resume token for the event log: versioned, self-describing to the
// server, meaningless to clients. Encodes the room event sequence the
// payload was generated from.
const cursorOf = sequence =>
  Buffer.from(JSON.stringify({ v: 1, seq: sequence }), "utf8").toString("base64url");

export function buildOrient(store, roomSlug, viewerId) {
  // Unknown rooms fail here with the store's 404 (room_not_found).
  const { sequence, state } = store.room(roomSlug);
  if (!state.room) throw new Error("Room projection is missing its room record");
  const member = state.members?.[viewerId];
  if (!member) throw new Error("Viewer is not a member of this room");
  const now = store.now();
  const openWork = Object.values(state.workItems ?? {})
    .filter(item => item && OPEN_WORK_STATES.has(item.state))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  return {
    contract: { name: "project-room/orient", version: 1 },
    room: {
      slug: state.room.id,
      title: state.room.title,
      state: typeof state.room.archivedAt === "string" ? "archived" : "active",
      kind: roomKind(state.room)
    },
    member: memberOf(member),
    evaluatedThrough: sequence,
    eventCursor: cursorOf(sequence),
    orientation: roomOrientation(state),
    work: openWork.slice(0, MAX_WORK).map(item => workOf(item, now)),
    workTotal: openWork.length,
    links: { activationPack: `/api/rooms/${state.room.id}/activation-pack` },
    generatedAt: new Date(now).toISOString()
  };
}
