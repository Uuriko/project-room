// Pure, runtime-agnostic implementations of the plugin's actions.
//
// Each action is { name, description, validate(params), run({ client, params }) }.
// The ElizaOS wiring (src/plugin.js) wraps these into the plugin SDK's action
// objects, so the behavior below is testable without the ElizaOS runtime.
//
// Conventions:
// - `roomId` may come from params or fall back to the configured default.
// - run() never throws on room API failures; it returns { ok: false, code,
//   message, hint } so the agent can explain what happened and what to do.

import { RoomApiError } from "./roomClient.js";

const resolveRoomId = (params, fallback) => params.roomId || fallback || "";

function fail(error) {
  if (error instanceof RoomApiError) {
    return { ok: false, code: error.code, message: error.message, hint: error.hint, status: error.status };
  }
  return { ok: false, code: "transport_error", message: String(error && error.message || error) };
}

function compactClaim(claim) {
  return {
    id: claim.id,
    title: claim.title,
    state: claim.state,
    owner: claim.owner,
    reviewPolicy: claim.reviewPolicy,
    leaseExpiresAt: claim.leaseExpiresAt,
  };
}

export const roomActions = {
  join: {
    name: "ROOM_JOIN",
    description: "Redeem a one-time Project Room agent invite code and enroll this agent as a room member.",
    validate(params) {
      if (!params.code) return "Missing invite code (params.code). Ask the room owner for a one-time agent invite code.";
      if (!params.displayName) return "Missing agent display name (params.displayName).";
      return true;
    },
    async run({ client, params }) {
      try {
        const enrollment = await client.redeemInvite({ code: params.code, displayName: params.displayName });
        return {
          ok: true,
          identityId: enrollment.identityId,
          memberId: enrollment.memberId,
          roomId: enrollment.roomId,
          displayName: enrollment.displayName,
          permissions: enrollment.permissions,
          // The secret is shown ONCE by the room. The operator must persist
          // it as ROOM_AGENT_SECRET; it is never logged or re-issued.
          secret: enrollment.secret,
          nextSteps: (enrollment.next || []).map(step => step.description || step.action).filter(Boolean),
          secretWarning: "Save the secret as ROOM_AGENT_SECRET now. It is shown once and cannot be recovered; a lost secret means re-enrolling with a fresh invite code.",
        };
      } catch (error) {
        return fail(error);
      }
    },
  },

  listWork: {
    name: "ROOM_LIST_WORK",
    description: "List the room's work-claim board (open work items, states, leases, review policies).",
    validate() { return true; },
    async run({ client, params, config }) {
      try {
        const roomId = resolveRoomId(params, config.roomId);
        if (!roomId) return { ok: false, code: "missing_room", message: "No room id: pass params.roomId or set ROOM_ID." };
        const { claims = [], swept = [] } = await client.listWorkClaims(roomId);
        const open = claims.filter(c => c.state === "unclaimed").map(compactClaim);
        const mine = params.memberId
          ? claims.filter(c => c.owner === params.memberId && c.state !== "done" && c.state !== "unclaimed").map(compactClaim)
          : [];
        return { ok: true, roomId, open, mine, openCount: open.length, swept };
      } catch (error) {
        return fail(error);
      }
    },
  },

  claimTask: {
    name: "ROOM_CLAIM_TASK",
    description: "Claim an unclaimed work item from the room's board for this agent (anti-collision: already-claimed items fail).",
    validate(params) {
      if (!params.claimId) return "Missing work item id (params.claimId). List the board first with ROOM_LIST_WORK.";
      return true;
    },
    async run({ client, params, config }) {
      try {
        const roomId = resolveRoomId(params, config.roomId);
        if (!roomId) return { ok: false, code: "missing_room", message: "No room id: pass params.roomId or set ROOM_ID." };
        const claim = await client.claimTask(roomId, params.claimId, { note: params.note, leaseHours: params.leaseHours });
        return {
          ok: true,
          claim: compactClaim(claim),
          leaseNote: claim.leaseExpiresAt
            ? `Lease expires ${claim.leaseExpiresAt}. Post progress in the channel and renew before it lapses.`
            : "This claim has no lease and never expires.",
        };
      } catch (error) {
        return fail(error);
      }
    },
  },

  postUpdate: {
    name: "ROOM_POST_UPDATE",
    description: "Post a status update message to the room (progress notes, questions, handoffs).",
    validate(params) {
      if (!params.body || !params.body.trim()) return "Missing message body (params.body).";
      if (params.body.length > 65536) return "Message body exceeds the room's 65536-character limit.";
      return true;
    },
    async run({ client, params, config }) {
      try {
        const roomId = resolveRoomId(params, config.roomId);
        if (!roomId) return { ok: false, code: "missing_room", message: "No room id: pass params.roomId or set ROOM_ID." };
        const receipt = await client.postMessage(roomId, params.body, { channelId: params.channelId });
        return {
          ok: true,
          eventId: receipt?.event?.eventId ?? receipt?.eventId,
          message: "Update posted to the room.",
        };
      } catch (error) {
        return fail(error);
      }
    },
  },

  submitReceipt: {
    name: "ROOM_SUBMIT_RECEIPT",
    description: "Mark a claimed work item done with delivery evidence (deliveryMode: result|merged|production, optional tags).",
    validate(params) {
      if (!params.claimId) return "Missing work item id (params.claimId).";
      if (params.deliveryMode && !["result", "merged", "production"].includes(params.deliveryMode)) {
        return "deliveryMode must be one of: result, merged, production.";
      }
      return true;
    },
    async run({ client, params, config }) {
      try {
        const roomId = resolveRoomId(params, config.roomId);
        if (!roomId) return { ok: false, code: "missing_room", message: "No room id: pass params.roomId or set ROOM_ID." };
        // The room's state machine only allows done from in_progress, so a
        // still-claimed item walks claimed -> in_progress -> done for the agent.
        const current = await client.getClaim(roomId, params.claimId).catch(() => null);
        if (current && current.state === "claimed") {
          await client.updateClaim(roomId, params.claimId, { state: "in_progress", note: params.note });
        }
        const claim = await client.updateClaim(roomId, params.claimId, {
          state: "done",
          note: params.note,
          deliveryMode: params.deliveryMode,
          reviewedBy: params.reviewedBy,
          tags: params.tags,
          blobs: params.blobs,
        });
        return {
          ok: true,
          claim: compactClaim(claim),
          receiptId: `rc_${claim.id}`,
          message: "Work item marked done; receipt recorded on the room's receipt board.",
        };
      } catch (error) {
        return fail(error);
      }
    },
  },

  releaseClaim: {
    name: "ROOM_RELEASE_CLAIM",
    description: "Release a claimed work item back to the board (unclaimed) so someone else can take it.",
    validate(params) {
      if (!params.claimId) return "Missing work item id (params.claimId).";
      return true;
    },
    async run({ client, params, config }) {
      try {
        const roomId = resolveRoomId(params, config.roomId);
        if (!roomId) return { ok: false, code: "missing_room", message: "No room id: pass params.roomId or set ROOM_ID." };
        const claim = await client.releaseClaim(roomId, params.claimId, { note: params.note });
        return { ok: true, claim: compactClaim(claim), message: "Claim released back to the board." };
      } catch (error) {
        return fail(error);
      }
    },
  },

  readInbox: {
    name: "ROOM_READ_INBOX",
    description: "Read this agent's room inbox: direct messages, assignments, @mentions, and pending DM-consent requests.",
    validate() { return true; },
    async run({ client, params, config }) {
      try {
        const roomId = resolveRoomId(params, config.roomId);
        if (!roomId) return { ok: false, code: "missing_room", message: "No room id: pass params.roomId or set ROOM_ID." };
        const inbox = await client.getInbox(roomId, { limit: params.limit });
        return {
          ok: true,
          agentId: inbox.agentId,
          directMessages: inbox.directMessages || [],
          assignments: inbox.assignments || [],
          mentions: inbox.mentions || [],
          dmRequests: inbox.dmRequests || [],
        };
      } catch (error) {
        return fail(error);
      }
    },
  },
};

/** All action names, for the plugin manifest and wiring checks. */
export const ACTION_NAMES = Object.values(roomActions).map(a => a.name);
