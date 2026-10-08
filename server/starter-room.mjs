// ACT-1a: seed a starter room and Room Guide. No new HTTP route.
// ACT-1b (/start, landing, receipt UI, provider list) waits on S1, RT, and
// GR2 deployed. ACT-3b humanClaimUrl waits on S1 and C. GitHub OAuth app
// setup is ACT-1c and is not done here.
//
// Guide is not an identity: this module stores no secret, mints no key, and
// links no identity. Board writes need the contribute pair (accept_work and
// complete_work). There is no separate post or claim_work permission.
import { EVENT_TYPES } from "../src/events.js";
import { ServiceError } from "./service-error.mjs";
import { getRoomTemplate } from "./templates.mjs";
import { createWork } from "./work-claims.mjs";
import { emitWorkClaimEventRouted } from "./work-claim-events.mjs";
import { checkAgentDisplayName } from "./display-name-guard.mjs";
import { appendRoomEvent } from "./receipt-cards.mjs";
import { ROOM_GUIDE_ID, STARTER_CLAIM_ID, installGuideCommandHook, runGuideStep } from "./room-guide.mjs";

export { ROOM_GUIDE_ID, STARTER_CLAIM_ID };

// bug stays on agent-pair, the template the prompt names. review is the GR2
// template whose tasks include reviewing a pull request. plan is the GR2
// research/planning template. Anything else falls back to agent-pair.
export const INTENT_TEMPLATES = Object.freeze({
  bug: "agent-pair",
  review: "open-source-triage",
  plan: "research-swarm"
});

const INTENT_TITLES = Object.freeze({
  bug: "Fix a bug",
  review: "Review a pull request",
  plan: "Plan a feature"
});

const GUIDE_PERMISSIONS = Object.freeze(["accept_work", "complete_work"]);

export function starterTitleForIntent(intent) {
  const trimmed = typeof intent === "string" ? intent.trim() : "";
  return INTENT_TITLES[trimmed.toLowerCase()] ?? trimmed.slice(0, 80);
}

function intentKindOf(intent, start) {
  const key = typeof intent === "string" ? intent.trim().toLowerCase() : "";
  if (key === "bug" || key === "review" || key === "plan") return key;
  if (key) return "custom";
  if (start) return "start";
  return "custom";
}

function templateFor({ templateSlug, intent }) {
  if (typeof templateSlug === "string" && getRoomTemplate(templateSlug)) return getRoomTemplate(templateSlug);
  const key = typeof intent === "string" ? intent.trim().toLowerCase() : "";
  return getRoomTemplate(INTENT_TEMPLATES[key] ?? "agent-pair");
}

function putClaim(store, roomId, actorId, spec, now) {
  if (store.workClaims.has(roomId, spec.id)) return store.workClaims.get(roomId, spec.id);
  const item = createWork({ id: spec.id, title: spec.title, tags: spec.tags }, { now, agentId: actorId });
  store.workClaims.set(roomId, item);
  emitWorkClaimEventRouted(store, roomId, { actorId, item, action: "created", atMs: now });
  return item;
}

export function seedStarter(store, roomId, { templateSlug = null, intent = null, ownerMemberId, start = false } = {}) {
  installGuideCommandHook(store);
  return store.transaction(() => {
    const room = store.room(roomId);
    const state = room.state;
    if (!state?.room) throw new ServiceError(404, "room_not_found", "Room not found");
    if (state.room.ownerId !== ownerMemberId) throw new ServiceError(403, "owner_required", "Only the room owner can seed a starter");
    const template = templateFor({ templateSlug, intent });
    if (!state.room.starterSeeded) {
      if (!state.members?.[ROOM_GUIDE_ID]) {
        const activeNames = Object.values(state.members).filter(member => member.active !== false)
          .map(member => ({ memberId: member.id, displayName: member.displayName }));
        const checked = checkAgentDisplayName("Room Guide", { activeNames });
        if (!checked.safe) throw new ServiceError(422, "invalid_display_name", "Room Guide is not an available name in this room");
        const now = store.now();
        appendRoomEvent(store, roomId, {
          id: `gm-${roomId}`,
          type: EVENT_TYPES.MEMBER_ADDED,
          actorId: ownerMemberId,
          atMs: now,
          data: {
            memberId: ROOM_GUIDE_ID,
            displayName: "Room Guide",
            kind: "agent",
            agentType: "room-guide",
            system: true,
            permissions: [...GUIDE_PERMISSIONS]
          }
        });
      }
      const now = store.now();
      putClaim(store, roomId, ownerMemberId, {
        id: STARTER_CLAIM_ID,
        title: "See how work closes here",
        tags: ["starter"]
      }, now);
      for (const task of template.tasks) {
        putClaim(store, roomId, ownerMemberId, {
          id: `${template.slug}-${task.id}`,
          title: task.title,
          tags: ["starter-choice"]
        }, now);
      }
      appendRoomEvent(store, roomId, {
        id: `ss-${roomId}`,
        type: EVENT_TYPES.ROOM_STARTER_SEEDED,
        actorId: ownerMemberId,
        atMs: now,
        data: { templateSlug: template.slug, intentKind: intentKindOf(intent, start) }
      });
    }
    runGuideStep(store, roomId, store.now());
    const seeded = store.room(roomId).state;
    const claims = store.workClaims.list(roomId);
    return {
      roomId,
      templateSlug: seeded.room.starterSeeded?.templateSlug ?? template.slug,
      intentKind: seeded.room.starterSeeded?.intentKind ?? intentKindOf(intent, start),
      guideMemberId: ROOM_GUIDE_ID,
      starterClaimId: STARTER_CLAIM_ID,
      choiceClaimIds: claims.filter(item => (item.tags ?? []).includes("starter-choice")).map(item => item.id)
    };
  });
}

// Called from createAccountRoom when the request carries intent or start=1.
// roomId and ownerMemberId are required: an account can own more than one room.
// ACT-1b's signed-in /start redirect is the other caller, once that route exists.
export function seedStarterForNewAccount(store, accountId, { intent = null, templateSlug = null, roomId = null, ownerMemberId = null, start = false } = {}) {
  void accountId;
  if (!roomId || !ownerMemberId) return null;
  if (!intent && !start && !templateSlug) return null;
  return seedStarter(store, roomId, { templateSlug, intent, ownerMemberId, start: Boolean(start) });
}
