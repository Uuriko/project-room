// Permission moment (lane6, plug-in crew): the "here's what you can do
// here" moment for agents joining a room.
//
// The standing policy gives room agents broad permissions, but nothing ever
// tells them: room_check_access returns raw tokens, the activation pack
// lists raw tokens, and the Room Guide welcome never mentions permissions.
// This module renders an agent's ACTUAL permission set in plain language,
// each capability paired with a concrete executable next action (MCP tool +
// REST call), following the room's pure-builder precedent
// (morning-digest.mjs, next-actions.mjs): no I/O, frozen outputs,
// malformed inputs throw PermissionMomentError.
//
// Permission semantics verified against the code, not docs:
// - accept_work: claim work / board claims (work-claim-routes.mjs,
//   store.mjs:4719 — steers may also claim on others' behalf)
// - complete_work: record completion (src/events.js completeWork)
// - verify: record verification of others' results (review routes)
// - steer: propose/supersede work, clear halts (src/events.js proposeWork,
//   supersedeWork, "Clearing a halt requires steer or decide")
// - manage_claims: board admin — sweep, reassign, review anyone
//   (work-claim-routes.mjs)
// - write_external: start/complete write-mode work items — the room's
//   external-write boundary (src/events.js startWork/completeWork)
// - invite_member: mint invite codes without manage_members
//   (src/events.js canInviteMembers)
// - decide: owner decisions incl. access requests (room_decide_access_request)
// - manage_members: member add/remove/access changes
// Autonomy tiers (server/autonomy-tiers.mjs): t1_readonly agents keep reads,
// heartbeats and session reports/stops; every other write is refused.
import { PERMISSIONS } from "../src/events.js";

export const PERMISSION_MOMENT_SCHEMA = "room-permission-moment/1";

export class PermissionMomentError extends Error {
  constructor(code, message) { super(message); this.name = "PermissionMomentError"; this.code = code; }
}
const fail = (code, message) => { throw new PermissionMomentError(code, message); };

const AUTONOMY_TIERS = Object.freeze(["t1_readonly", "t2_standard"]);

// Capabilities that change room state (paused at t1_readonly). Reads,
// heartbeats and session status/stop reports are not capabilities — they
// are available to every member and to t1_readonly agents.
const WRITE_PERMISSIONS = Object.freeze(new Set([
  "accept_work", "complete_work", "steer", "verify",
  "manage_claims", "write_external", "invite_member", "decide", "manage_members",
]));

// The standing auto-approve rule can never mint these (access-requests.mjs
// AUTO_APPROVE_FORBIDDEN_PERMISSIONS): asking means asking the owner.
const OWNER_ONLY_PERMISSIONS = Object.freeze(new Set([
  "manage_members", "decide", "manage_claims", "write_external", "invite_member",
]));

// Plain-language legibility table. Every entry: what the token means in
// everyday words, and the concrete next action with the exact executable
// call. mcpTool is null where no hosted MCP tool covers the action — the
// REST route is always present, so the action is always one step away.
const LEGIBILITY = {
  accept_work: {
    title: "Claim work from the board",
    means: "Take ownership of a work item so you can start it. Nobody else can claim it while you hold it.",
    tryNow: {
      mcpTool: "room_accept_work",
      rest: { method: "POST", path: "/api/rooms/{room}/work-claims/{id}/claim" },
      note: "Browse first: GET /api/rooms/{room}/work-claims (MCP room_list_work), then claim the item id.",
    },
  },
  complete_work: {
    title: "Finish work and record the result",
    means: "Mark a work item you hold as done and attach what you delivered.",
    tryNow: {
      mcpTool: "room_record_completion",
      rest: { method: "POST", path: "/api/rooms/{room}/work-claims/{id}/update" },
      note: "Update the claim you hold with state done and your delivery note.",
    },
  },
  verify: {
    title: "Verify someone else's result",
    means: "Independently check a completed work item and record your verdict — this is how results become trusted.",
    tryNow: {
      mcpTool: "room_record_verification",
      rest: { method: "POST", path: "/api/rooms/{room}/work-claims/{id}/review" },
      note: "Pick a completed item you did not do yourself and record your review.",
    },
  },
  steer: {
    title: "Propose and steer work",
    means: "Put new work on the queue, supersede stale items, and clear halts. You can also claim work on another member's behalf.",
    tryNow: {
      mcpTool: "room_propose_work",
      rest: { method: "POST", path: "/api/rooms/{room}/commands" },
      note: 'Send { "type": "work.proposed", "data": { workItemId, title, definitionOfDone, accountableMemberId } }.',
    },
  },
  manage_claims: {
    title: "Run the claims board",
    means: "Sweep expired claims, reassign stuck ones, and review any claim regardless of who holds it.",
    tryNow: {
      mcpTool: null,
      rest: { method: "POST", path: "/api/rooms/{room}/work-claims/sweep" },
      note: "No hosted MCP tool covers board admin — the REST route is the one step.",
    },
  },
  write_external: {
    title: "Publish results outside the room",
    means: "Start and complete work items in write mode — the ones whose results leave the room (files, PRs, external posts).",
    tryNow: {
      mcpTool: "room_start_work",
      rest: { method: "POST", path: "/api/rooms/{room}/commands" },
      note: 'Start a write-mode item: { "type": "work.started", ... }. Completion needs this permission too.',
    },
  },
  invite_member: {
    title: "Invite other agents",
    means: "Mint invite codes that admit new agents without needing the owner's manage_members power.",
    tryNow: {
      mcpTool: "room_create_agent_invite",
      rest: { method: "POST", path: "/api/rooms/{room}/agent-invites" },
      note: 'Send { "profile": "chat|contribute|review|collaborate", ... } with an expiry.',
    },
  },
  decide: {
    title: "Record room decisions",
    means: "Settle access requests and record owner-level decisions that unblock the room.",
    tryNow: {
      mcpTool: "room_decide_access_request",
      rest: { method: "POST", path: "/api/rooms/{room}/access-requests/{requestId}/decide" },
      note: 'Send { "decision": "approve"|"deny", "permissions": [...], "note": null }.',
    },
  },
  manage_members: {
    title: "Manage members",
    means: "Add, remove, or change what members are allowed to do in this room.",
    tryNow: {
      mcpTool: null,
      rest: { method: "POST", path: "/api/rooms/{room}/commands" },
      note: 'Send { "type": "member.access_changed", ... }. No hosted MCP tool covers this — the REST route is the one step.',
    },
  },
};

// Access-profile labels, matching the fixed server-side sets so the label
// never drifts from what the grant actually contains.
const PROFILES = [
  ["owner", null], // handled separately
  ["full-member", [...PERMISSIONS]],
  ["moderator", ["steer", "manage_members", "manage_claims", "accept_work", "complete_work", "verify"]],
  ["collaborate", ["steer", "accept_work", "complete_work", "verify"]],
  ["member", ["accept_work", "complete_work", "verify"]],
  ["contribute", ["accept_work", "complete_work"]],
  ["review", ["verify"]],
  ["chat", []],
];
const profileOf = (permissions, isOwner) => {
  if (isOwner) return "owner";
  const sorted = [...permissions].sort();
  for (const [name, set] of PROFILES) {
    if (name === "owner") continue;
    if (sorted.length === set.length && sorted.every((p, i) => p === [...set].sort()[i])) return name;
  }
  return "custom";
};

// Order an agent should try things: claiming work first, then verifying,
// then steering. Anything granted beats read-only orientation.
const START_PRIORITY = Object.freeze([
  "accept_work", "verify", "steer", "complete_work",
  "write_external", "manage_claims", "invite_member", "decide", "manage_members",
]);

const freezeDeep = value => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) freezeDeep(value[key]);
    Object.freeze(value);
  }
  return value;
};

// Pure builder. member: { id, displayName?, kind?, permissions[] }.
// roomId scopes the REST paths. autonomyTier defaults to t2_standard.
export function buildPermissionMoment({ member, roomId, autonomyTier = "t2_standard", isOwner = false } = {}) {
  if (!member || typeof member !== "object" || Array.isArray(member)) fail("invalid_input", "member must be an object");
  if (typeof member.id !== "string" || member.id.length === 0) fail("invalid_input", "member.id must be a non-empty string");
  if (typeof roomId !== "string" || roomId.length === 0) fail("invalid_input", "roomId must be a non-empty string");
  if (!AUTONOMY_TIERS.includes(autonomyTier)) fail("invalid_input", `autonomyTier must be one of ${AUTONOMY_TIERS.join(", ")}`);
  if (!Array.isArray(member.permissions)) fail("invalid_input", "member.permissions must be an array");
  for (const token of member.permissions) {
    if (typeof token !== "string" || !PERMISSIONS.includes(token)) {
      fail("unknown_permission", `Unknown permission token ${JSON.stringify(token)} — refusing to render it`);
    }
  }
  const permissions = [...new Set(member.permissions)];
  const pausedWrites = autonomyTier === "t1_readonly";
  const path = template => template.replace("{room}", roomId);

  const youCan = permissions.map(token => {
    const entry = LEGIBILITY[token];
    return {
      permission: token,
      title: entry.title,
      means: entry.means,
      ...(pausedWrites && WRITE_PERMISSIONS.has(token) ? { paused: true } : {}),
      tryNow: {
        mcpTool: entry.tryNow.mcpTool,
        rest: { method: entry.tryNow.rest.method, path: path(entry.tryNow.rest.path) },
        note: entry.tryNow.note,
      },
    };
  });

  const granted = new Set(permissions);
  const notGranted = PERMISSIONS.filter(token => !granted.has(token)).map(token => {
    const entry = LEGIBILITY[token];
    return {
      permission: token,
      title: entry.title,
      means: entry.means,
      howToGet: OWNER_ONLY_PERMISSIONS.has(token)
        ? "Only the room owner can grant this — ask them directly. Standing auto-approve rules can never mint it."
        : `File an access request: POST /api/access-requests with { "roomId": "${roomId}", "identityId": "<your identity>", "displayName": "<your name>", "requestedPermissions": ["${token}"] } — or ask the room owner.`,
    };
  });

  const profile = profileOf(permissions, isOwner);
  const verbs = {
    accept_work: "claim work", complete_work: "finish it", verify: "verify results",
    steer: "steer the queue", manage_claims: "run the claims board",
    write_external: "publish outside the room", invite_member: "invite other agents",
    decide: "record decisions", manage_members: "manage members",
  };
  const headline = isOwner
    ? "You own this room — every permission is granted. Nothing here can tell you no."
    : permissions.length === 0
      ? "You can read and chat in this room. To do more, ask the owner or file an access request."
      : pausedWrites
        ? `Your writes are paused at the read-only tier, but you still hold: ${permissions.map(p => verbs[p]).join(", ").replace(/, ([^,]*)$/, ", and $1")}.`
        : `You can ${permissions.map(p => verbs[p]).join(", ").replace(/, ([^,]*)$/, ", and $1")} in this room.`;

  const startToken = pausedWrites ? null : START_PRIORITY.find(token => granted.has(token));
  const startHere = startToken
    ? { permission: startToken, title: LEGIBILITY[startToken].title,
        tryNow: youCan.find(cap => cap.permission === startToken).tryNow }
    : { permission: null, title: "Read the room",
        tryNow: { mcpTool: "get_room_context", rest: { method: "GET", path: `/api/rooms/${roomId}/context` },
          note: pausedWrites
            ? "Your writes are paused — orient first, then ask the owner to restore full access."
            : "No write permissions granted — orient first, then ask for more." } };

  return freezeDeep({
    schema: PERMISSION_MOMENT_SCHEMA,
    roomId,
    memberId: member.id,
    displayName: member.displayName ?? member.id,
    kind: member.kind ?? "agent",
    profile,
    autonomyTier,
    headline,
    pausedWrites,
    ...(pausedWrites ? { pausedNote:
      "Your writes are paused at the read-only autonomy tier: you can still read the room, and heartbeats plus session reports keep landing. Ask the room owner to restore full access." } : {}),
    youCan,
    notGranted,
    startHere,
  });
}

// Compact chat rendering for the Room Guide welcome message.
export function renderPermissionMomentText(packet) {
  const lines = [packet.headline];
  if (packet.pausedWrites) lines.push(packet.pausedNote);
  if (packet.youCan.length) {
    lines.push("You can:");
    for (const cap of packet.youCan) {
      const via = cap.tryNow.mcpTool ? `MCP ${cap.tryNow.mcpTool}` : cap.tryNow.rest.method + " " + cap.tryNow.rest.path;
      lines.push(`- ${cap.title}${cap.paused ? " (paused — read-only tier)" : ""} — ${via}`);
    }
  }
  if (packet.startHere?.permission) {
    lines.push(`Start here: ${packet.startHere.title} — ${packet.startHere.tryNow.rest.method} ${packet.startHere.tryNow.rest.path}`);
  }
  lines.push(`Full list anytime: GET /api/rooms/${packet.roomId}/my-permissions`);
  return lines.join("\n");
}
