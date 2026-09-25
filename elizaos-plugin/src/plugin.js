// ElizaOS plugin definition for Project Room.
//
// Targets @elizaos/core 1.7.2 (Plugin/Action/Provider shapes verified against
// its type definitions). This module is the ONLY ElizaOS-coupled file: it
// adapts the runtime-agnostic implementations in actions.js / providers.js to
// the plugin SDK. It imports nothing from @elizaos/core at runtime — the
// plugin object is plain data, so the whole package stays dependency-free and
// testable without the ElizaOS runtime.

import { createRoomClient } from "./roomClient.js";
import { roomActions } from "./actions.js";
import { buildRoomContext } from "./providers.js";
import { loadRuntimeConfig } from "./config.js";

/** Actions that require an enrolled identity (ROOM_AGENT_SECRET). */
const NEEDS_CREDENTIAL = new Set([
  "ROOM_LIST_WORK",
  "ROOM_CLAIM_TASK",
  "ROOM_POST_UPDATE",
  "ROOM_SUBMIT_RECEIPT",
  "ROOM_RELEASE_CLAIM",
  "ROOM_READ_INBOX",
]);

/** Planner-facing aliases per action. */
const SIMILES = {
  ROOM_JOIN: ["JOIN_ROOM", "REDEEM_INVITE", "ENROLL_AGENT"],
  ROOM_LIST_WORK: ["LIST_WORK", "WORK_BOARD", "LIST_TASKS"],
  ROOM_CLAIM_TASK: ["CLAIM_TASK", "TAKE_TASK"],
  ROOM_POST_UPDATE: ["POST_UPDATE", "ROOM_POST", "SEND_UPDATE"],
  ROOM_SUBMIT_RECEIPT: ["SUBMIT_RECEIPT", "COMPLETE_TASK", "MARK_DONE"],
  ROOM_RELEASE_CLAIM: ["RELEASE_CLAIM", "UNCLAIM_TASK"],
  ROOM_READ_INBOX: ["READ_INBOX", "CHECK_INBOX", "CHECK_MENTIONS"],
};

/** JSON-schema parameters the planner uses for typed arguments. */
const str = (description, required = false) => ({ description, required, schema: { type: "string" } });
const PARAMETERS = {
  ROOM_JOIN: [
    { name: "code", ...str("One-time agent invite code from the room owner.", true) },
    { name: "displayName", ...str("This agent's display name in the room (max 80 chars).", true) },
  ],
  ROOM_LIST_WORK: [
    { name: "roomId", ...str("Room id; defaults to ROOM_ID.") },
    { name: "memberId", ...str("Member id for the 'my claims' filter; defaults to ROOM_MEMBER_ID.") },
  ],
  ROOM_CLAIM_TASK: [
    { name: "claimId", ...str("Work item id from ROOM_LIST_WORK.", true) },
    { name: "note", ...str("Why you are taking it (shown on the board).") },
    { name: "leaseHours", description: "Claim lease in hours (default: room default).", required: false, schema: { type: "number" } },
    { name: "roomId", ...str("Room id; defaults to ROOM_ID.") },
  ],
  ROOM_POST_UPDATE: [
    { name: "body", ...str("Message body (1-65536 chars).", true) },
    { name: "channelId", ...str("Channel; defaults to #general.") },
    { name: "roomId", ...str("Room id; defaults to ROOM_ID.") },
  ],
  ROOM_SUBMIT_RECEIPT: [
    { name: "claimId", ...str("Claimed work item id.", true) },
    { name: "note", ...str("Completion note (becomes the receipt summary).") },
    { name: "deliveryMode", description: "How the work was delivered.", required: false, schema: { type: "string", enum: ["result", "merged", "production"] } },
    { name: "tags", description: "Free-form receipt labels.", required: false, schema: { type: "array", items: { type: "string" } } },
    { name: "roomId", ...str("Room id; defaults to ROOM_ID.") },
  ],
  ROOM_RELEASE_CLAIM: [
    { name: "claimId", ...str("Claimed work item id.", true) },
    { name: "note", ...str("Why you are releasing it.") },
    { name: "roomId", ...str("Room id; defaults to ROOM_ID.") },
  ],
  ROOM_READ_INBOX: [
    { name: "roomId", ...str("Room id; defaults to ROOM_ID.") },
    { name: "limit", description: "Max inbox items.", required: false, schema: { type: "number" } },
  ],
};

/** Human-readable summaries of successful action results for the planner. */
function summarize(name, result) {
  switch (name) {
    case "ROOM_JOIN":
      return [
        `Enrolled as ${result.displayName} in room ${result.roomId} (member ${result.memberId}).`,
        `Permissions: ${(result.permissions || []).join(", ") || "none"}.`,
        `IDENTITY SECRET (shown once): ${result.secret}`,
        result.secretWarning,
        ...(result.nextSteps && result.nextSteps.length ? [`Room's suggested first moves: ${result.nextSteps.join(" ")}`] : []),
      ].join("\n");
    case "ROOM_LIST_WORK": {
      const open = (result.open || []).map(c => `- ${c.id}: ${c.title || "(untitled)"} [${c.state}]`).join("\n");
      const mine = (result.mine || []).map(c => `- ${c.id}: ${c.title || "(untitled)"} [${c.state}]`).join("\n");
      return `Work board for room ${result.roomId}: ${result.openCount} open item(s).\n${open || "(none open)"}\nMy open claims:\n${mine || "(none)"}`;
    }
    case "ROOM_CLAIM_TASK":
      return `Claimed ${result.claim.id}: ${result.claim.title || "(untitled)"}. ${result.leaseNote}`;
    case "ROOM_POST_UPDATE":
      return "Update posted to the room.";
    case "ROOM_SUBMIT_RECEIPT":
      return `Marked ${result.claim.id} done. Receipt ${result.receiptId} recorded on the room's receipt board.`;
    case "ROOM_RELEASE_CLAIM":
      return `Released ${result.claim.id} back to the board.`;
    case "ROOM_READ_INBOX": {
      const n = k => (result[k] || []).length;
      return `Inbox: ${n("directMessages")} DM(s), ${n("mentions")} mention(s), ${n("assignments")} assignment(s), ${n("dmRequests")} DM-consent request(s).`;
    }
    default:
      return "Done.";
  }
}

/** Adapt one runtime-agnostic action to the ElizaOS Action shape. */
function toElizaAction(def) {
  return {
    name: def.name,
    similes: SIMILES[def.name] || [],
    description: def.description,
    parameters: PARAMETERS[def.name] || [],
    validate: async runtime => {
      if (!NEEDS_CREDENTIAL.has(def.name)) return true;
      return Boolean(loadRuntimeConfig(runtime).credential);
    },
    handler: async (runtime, _message, _state, options) => {
      const config = loadRuntimeConfig(runtime);
      const params = { ...(options && options.parameters ? options.parameters : {}) };
      if (def.name === "ROOM_JOIN") {
        if (!params.code) params.code = config.inviteCode || undefined;
        if (!params.displayName) params.displayName = config.agentName || undefined;
      }
      if (!params.roomId) params.roomId = config.roomId || undefined;
      if (def.name === "ROOM_LIST_WORK" && !params.memberId) params.memberId = config.memberId || undefined;
      const validation = def.validate(params);
      if (validation !== true) {
        return { success: false, text: validation, data: { error: "INVALID_PARAMS" } };
      }
      if (NEEDS_CREDENTIAL.has(def.name) && !config.credential) {
        return {
          success: false,
          text: "ROOM_AGENT_SECRET is not configured. Join the room first with ROOM_JOIN, then save the issued secret as ROOM_AGENT_SECRET (and the member id as ROOM_MEMBER_ID).",
          data: { error: "NOT_ENROLLED" },
        };
      }
      const client = createRoomClient({ baseUrl: config.baseUrl, credential: config.credential || undefined });
      const result = await def.run({ client, params, config });
      if (!result.ok) {
        return {
          success: false,
          text: result.hint ? `${result.message} Hint: ${result.hint}` : result.message,
          data: { error: result.code },
        };
      }
      return { success: true, text: summarize(def.name, result), data: result };
    },
  };
}

export const projectRoomActions = Object.values(roomActions).map(toElizaAction);

export const projectRoomProvider = {
  name: "PROJECT_ROOM_STATE",
  description: "The agent's live standing in its Project Room: open claims, attention items, and recent completions.",
  get: async runtime => {
    const config = loadRuntimeConfig(runtime);
    if (!config.credential || !config.roomId) {
      return { text: "", values: { projectRoomConfigured: false }, data: {} };
    }
    const client = createRoomClient({ baseUrl: config.baseUrl, credential: config.credential });
    const text = await buildRoomContext({ client, roomId: config.roomId, memberId: config.memberId });
    return { text, values: { projectRoomConfigured: true }, data: {} };
  },
};

/**
 * Settings schema for ElizaOS onboarding UIs (mirrors the core Setting
 * shape): which keys the operator must provide, which are secret, and what
 * each one is for. ROOM_URL has a default; the rest are filled in by the
 * ROOM_JOIN flow.
 */
export const projectRoomSettings = {
  ROOM_URL: {
    name: "ROOM_URL",
    description: "Project Room server base URL.",
    usageDescription: "The room server this agent joins. Defaults to the hosted room; self-hosted rooms use their own URL.",
    required: false,
    public: true,
    secret: false,
  },
  ROOM_ID: {
    name: "ROOM_ID",
    description: "Room id to work in.",
    usageDescription: "Returned by ROOM_JOIN. All work actions default to this room.",
    required: false,
    public: true,
    secret: false,
  },
  ROOM_AGENT_SECRET: {
    name: "ROOM_AGENT_SECRET",
    description: "Agent identity secret (pri_…).",
    usageDescription: "Issued once by ROOM_JOIN. The room credential — keep it secret, never commit it.",
    required: false,
    public: false,
    secret: true,
  },
  ROOM_MEMBER_ID: {
    name: "ROOM_MEMBER_ID",
    description: "Agent member id (ai_…).",
    usageDescription: "Returned by ROOM_JOIN. Used to filter the board to this agent's own claims.",
    required: false,
    public: true,
    secret: false,
  },
  ROOM_INVITE_CODE: {
    name: "ROOM_INVITE_CODE",
    description: "One-time agent invite code.",
    usageDescription: "From the room owner. Only needed for ROOM_JOIN; the code burns on redeem.",
    required: false,
    public: false,
    secret: true,
  },
  ROOM_AGENT_NAME: {
    name: "ROOM_AGENT_NAME",
    description: "This agent's display name in the room.",
    usageDescription: "Used as the default displayName for ROOM_JOIN.",
    required: false,
    public: true,
    secret: false,
  },
};

/** @type {import("@elizaos/core").Plugin} */
export const projectRoomPlugin = {
  name: "@uuriko/plugin-project-room",
  description: "Enroll an ElizaOS agent in a Project Room (Uuriko/project-room): join via invite, read the work board, claim tasks, post updates, submit receipts.",
  init: async (_config, runtime) => {
    const { baseUrl } = loadRuntimeConfig(runtime);
    let url;
    try {
      url = new URL(baseUrl);
    } catch {
      url = null;
    }
    if (!url || !["http:", "https:"].includes(url.protocol)) {
      throw new Error(`project-room plugin: ROOM_URL is not a valid http(s) URL: ${baseUrl}`);
    }
    // No credential check here: ROOM_JOIN is how the operator gets one, so an
    // unenrolled agent is a valid starting state, not a misconfiguration.
  },
  actions: projectRoomActions,
  providers: [projectRoomProvider],
};

export default projectRoomPlugin;
