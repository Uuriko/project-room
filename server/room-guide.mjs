// ACT-1a: Room Guide, a deterministic demo agent. No LLM calls.
// After the first real agent is assigned, Guide does nothing here.
// ACT-4 owns later nudges. If JOBS lands server/jobs.mjs, register room-guide
// there for those time-based steps. This slice does not.
//
// ACT-1b waits on S1, RT, and GR2 deployed. ACT-3b humanClaimUrl waits on S1 and C.
import { EVENT_TYPES, isRoomArchived } from "../src/events.js";
import { claimWork, updateWork } from "./work-claims.mjs";
import { emitWorkClaimEventRouted, enqueueClaimWake } from "./work-claim-events.mjs";
import { ROOM_GUIDE_ID, appendRoomEvent, stableEventId } from "./receipt-cards.mjs";

export { ROOM_GUIDE_ID };

export const WELCOME_BODY = "I'm Room Guide, a demo agent. I took **See how work closes here** to show you how work closes. Pick what your own agent should do first:";
export const STARTER_CLAIM_ID = "starter-receipt";

const pending = new WeakMap();

function noteGuideRoom(store, roomId) {
  let rooms = pending.get(store);
  if (!rooms) {
    rooms = new Set();
    pending.set(store, rooms);
  }
  rooms.add(roomId);
}

// Installed on first seed and from the Durable Object constructor. The wrapper
// runs after RoomStore.command returns and before that transaction commits, so
// node tests see the step without editing server/store.mjs. A guide failure
// does not fail the caller's command.
export function installGuideCommandHook(store) {
  const proto = store && Object.getPrototypeOf(store);
  if (!proto || typeof proto.command !== "function" || proto.__roomGuideHook) return;
  const original = proto.command;
  proto.command = function(token, roomId, command, binding) {
    const result = original.call(this, token, roomId, command, binding);
    if (typeof roomId === "string") {
      noteGuideRoom(this, roomId);
      try {
        runGuideStep(this, roomId, typeof this.now === "function" ? this.now() : Date.now());
        pending.get(this)?.delete(roomId);
      } catch (error) {
        console.error("room guide step failed:", error?.message ?? error);
      }
    }
    return result;
  };
  Object.defineProperty(proto, "__roomGuideHook", { value: true });
}

// cloudflare/room.mjs calls this from the post-request flush. Rooms the command
// hook already advanced are not queued. A step that threw stays queued.
export function flushRoomGuide(store) {
  const rooms = pending.get(store);
  if (!rooms || rooms.size === 0) return;
  for (const roomId of [...rooms]) {
    rooms.delete(roomId);
    try {
      runGuideStep(store, roomId, typeof store.now === "function" ? store.now() : Date.now());
    } catch (error) {
      console.error("room guide flush failed:", error?.message ?? error);
    }
  }
}

const welcomeId = roomId => `gw-${roomId}`;

function choiceClaims(registry, roomId) {
  return registry.list(roomId).filter(item => (item.tags ?? []).includes("starter-choice"));
}

function pickedChoice(state, choices) {
  for (const message of state.messages ?? []) {
    if (!message || message.authorId === ROOM_GUIDE_ID || message.kind === "receipt_card") continue;
    if (typeof message.body !== "string") continue;
    const text = message.body.trim();
    const match = choices.find(item => item.id === text || item.title === text);
    if (match) return match;
  }
  return null;
}

function choiceIdFromItem(item) {
  const stamp = [...(item.history ?? [])].reverse().find(entry => entry.action === "state:done");
  if (typeof stamp?.note !== "string" || !stamp.note.startsWith("choice:")) return null;
  const id = stamp.note.slice("choice:".length).split(" ")[0];
  return id || null;
}

function firstJoinedAgent(state) {
  return Object.values(state.members ?? []).find(member =>
    member && member.active !== false && member.kind === "agent" && member.system !== true && member.id !== ROOM_GUIDE_ID) ?? null;
}

function commitClaim(store, roomId, item, action, actorId, atMs) {
  store.workClaims.set(roomId, item);
  emitWorkClaimEventRouted(store, roomId, { actorId, item, action, atMs });
  return item;
}

function step(store, roomId, now) {
  const room = store.room(roomId);
  const state = room.state;
  if (!state?.room?.starterSeeded || isRoomArchived(state)) return null;
  const guide = state.members?.[ROOM_GUIDE_ID];
  if (!guide || guide.active === false) return null;
  const registry = store.workClaims;
  if (!registry) return null;
  const welcome = welcomeId(roomId);
  if (!state.messages?.some(message => message.id === welcome)) {
    const choices = choiceClaims(registry, roomId);
    appendRoomEvent(store, roomId, {
      id: welcome,
      type: EVENT_TYPES.MESSAGE_POSTED,
      actorId: ROOM_GUIDE_ID,
      atMs: now,
      data: {
        messageId: welcome,
        body: WELCOME_BODY,
        ...(choices.length ? { actions: choices.map(item => ({ claimId: item.id, label: item.title })) } : {})
      }
    });
    const starter = registry.get(roomId, STARTER_CLAIM_ID);
    if (starter?.state === "unclaimed") {
      commitClaim(store, roomId, claimWork(starter, ROOM_GUIDE_ID, { leaseHours: null, now }), "claimed", ROOM_GUIDE_ID, now);
    }
    return "seeded";
  }
  const starter = registry.get(roomId, STARTER_CLAIM_ID);
  const choices = choiceClaims(registry, roomId);
  const choice = pickedChoice(store.room(roomId).state, choices);
  if (choice && starter && starter.owner === ROOM_GUIDE_ID && starter.state !== "done") {
    let item = starter;
    if (item.state === "claimed") {
      item = commitClaim(store, roomId, updateWork(item, ROOM_GUIDE_ID, { state: "in_progress", now }), "state_changed", ROOM_GUIDE_ID, now);
    }
    if (item.state === "in_progress") {
      commitClaim(store, roomId, updateWork(item, ROOM_GUIDE_ID, {
        state: "done",
        deliveryMode: "result",
        note: `choice:${choice.id} ${choice.title}`,
        now
      }), "state_changed", ROOM_GUIDE_ID, now);
    }
    return "choice_made";
  }
  if (starter?.state === "done") {
    const agent = firstJoinedAgent(store.room(roomId).state);
    const choiceId = choiceIdFromItem(starter);
    const chosen = choiceId ? registry.get(roomId, choiceId) : null;
    if (!agent || !chosen) return null;
    const messageId = stableEventId("ga", `${roomId}\0${agent.id}`);
    if (store.room(roomId).state.messages?.some(message => message.id === messageId)) return null;
    if (chosen.state === "unclaimed") {
      commitClaim(store, roomId, claimWork(chosen, agent.id, { leaseHours: null, now, note: "Assigned by Room Guide" }), "claimed", ROOM_GUIDE_ID, now);
    }
    const name = agent.displayName || agent.id;
    appendRoomEvent(store, roomId, {
      id: messageId,
      type: EVENT_TYPES.MESSAGE_POSTED,
      actorId: ROOM_GUIDE_ID,
      atMs: now,
      data: { messageId, body: `@${name} ${chosen.title} is yours.` }
    });
    enqueueClaimWake(store, roomId, agent.id, messageId);
    return "agent_joined";
  }
  return null;
}

// One stage per call: welcome and claim, or close the starter, or assign.
export function runGuideStep(store, roomId, now = Date.now()) {
  if (!store?.db || typeof store.room !== "function" || typeof store.transaction !== "function") return null;
  return store.transaction(() => step(store, roomId, now));
}
