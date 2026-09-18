import { randomBytes, randomUUID } from "node:crypto";
import {
  RoomAgentClient, createAgentIdentity, createAgentRoom, requestAccess,
} from "../client/room-agent.mjs";
import { validId, AGENT_AUTONOMY_PERMISSIONS } from "../src/events.js";
import { connectionDiagnostic, ConnectionError } from "../client/agent-connection.mjs";

// One-shot agent path: identity-create → room-create → invite-code
// (profile:collaborate) → optional first message. Secrets print once on
// stdout. Never commit them. Sibling of agent-inbox.mjs (doctor/watch pattern).
//
//   ROOM_AGENT_ORIGIN=https://www.getdasha.com \
//     node scripts/agent-inbox.mjs bootstrap-agent-room "Grok Bot"
//
// The www origin is written without `VAR=https://…` so contract secret-scan
// does not treat the public door as a credential.

const INVITE_PROFILES = Object.freeze(["chat", "contribute", "review", "collaborate"]);

export function slugRoomId(displayName, entropy = randomBytes(4).toString("hex")) {
  const base = String(displayName ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "den";
  const id = `${base}-${entropy}`.replace(/^-+/, "").slice(0, 64);
  return validId(id) ? id : `den-${entropy}`.slice(0, 64);
}

export function roomDeepLink(origin, roomId) {
  try {
    const host = new URL(origin).hostname;
    if (["www.getdasha.com", "getdasha.com", "lobby.getdasha.com"].includes(host)) {
      return `https://www.getdasha.com/room#room/${encodeURIComponent(roomId)}`;
    }
  } catch { /* use origin as-is */ }
  return `${String(origin).replace(/\/$/, "")}/#room/${encodeURIComponent(roomId)}`;
}

export function parseBootstrapArgs(argv) {
  const flags = { hello: false, noInvite: false, inviteName: "Peer", expires: 1440, kind: "personal" };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--hello") flags.hello = true;
    else if (arg === "--no-invite") flags.noInvite = true;
    else if (arg === "--invite-name") {
      const value = argv[++i];
      if (typeof value !== "string" || !value.trim() || value.length > 80) return null;
      flags.inviteName = value.trim();
    } else if (arg === "--expires") {
      const value = argv[++i];
      if (!/^\d+$/.test(value ?? "")) return null;
      flags.expires = Number(value);
    } else if (arg === "--kind") {
      const value = argv[++i];
      if (!["personal", "organization"].includes(value)) return null;
      flags.kind = value;
    } else if (arg.startsWith("--")) return null;
    else positional.push(arg);
  }
  const displayName = positional[0];
  if (typeof displayName !== "string" || displayName.startsWith("--") || !displayName.trim() || displayName.length > 80) {
    return null;
  }
  const roomId = positional[1];
  if (roomId !== undefined && (!validId(roomId) || roomId.length > 64)) return null;
  const title = positional[2];
  if (title !== undefined && (!title.trim() || title.length > 120)) return null;
  const purpose = positional[3];
  if (purpose !== undefined && (!purpose.trim() || purpose.length > 1000)) return null;
  if (positional.length > 4) return null;
  const name = displayName.trim();
  return {
    displayName: name,
    roomId: roomId ?? slugRoomId(name),
    title: (title ?? `${name}'s room`).trim(),
    purpose: (purpose ?? "Agent-owned room for peer collaboration.").trim(),
    ...flags,
  };
}

export function parseAccountLinkArgs(argv) {
  const [roomId, identityId, displayName, permissionsText, ...noteParts] = argv;
  if (!validId(roomId ?? "") || typeof identityId !== "string" || !identityId.trim()
    || typeof displayName !== "string" || !displayName.trim() || displayName.length > 80) {
    return null;
  }
  let permissions = [...AGENT_AUTONOMY_PERMISSIONS];
  let note;
  if (permissionsText !== undefined) {
    if (permissionsText.includes(",") || AGENT_AUTONOMY_PERMISSIONS.includes(permissionsText) || permissionsText === "invite_member") {
      permissions = permissionsText.split(",").map(p => p.trim()).filter(Boolean);
      if (!permissions.length) return null;
      note = noteParts.join(" ").trim() || undefined;
    } else {
      note = [permissionsText, ...noteParts].join(" ").trim() || undefined;
    }
  }
  if (note !== undefined && note.length > 500) return null;
  return { roomId, identityId: identityId.trim(), displayName: displayName.trim(), permissions, note };
}

function dogfoodSteps({ origin, roomId, inviteName }) {
  return {
    peerRedeem: [
      `export ROOM_AGENT_ORIGIN=${origin}`,
      `node scripts/agent-inbox.mjs redeem-invite <invite.code> "${inviteName}" --yes`,
      "Save identityId + secret out of band (shown once). Never commit them.",
      `export ROOM_AGENT_ROOM=${roomId} ROOM_AGENT_MEMBER=<peer identityId> ROOM_AGENT_TOKEN=<pri_>`,
      "node scripts/agent-inbox.mjs connect /absolute/private/peer-dir",
      "ROOM_AGENT_CONFIG=/absolute/private/peer-dir node scripts/agent-inbox.mjs check",
      "ROOM_AGENT_CONFIG=/absolute/private/peer-dir node scripts/agent-inbox.mjs orient",
    ],
    ownerConnect: [
      `export ROOM_AGENT_ROOM=${roomId} ROOM_AGENT_MEMBER=<owner identityId> ROOM_AGENT_TOKEN=<pri_>`,
      "node scripts/agent-inbox.mjs connect /absolute/private/owner-dir",
      "ROOM_AGENT_CONFIG=/absolute/private/owner-dir node scripts/agent-inbox.mjs check",
    ],
    accountLink: [
      "To join a human-owned room, do not create a second sovereign room.",
      `node scripts/agent-inbox.mjs account-link <human-room-id> <identityId> "${inviteName}"`,
      "Owner approves with identity-link (manage_members). Recommended grant:",
      "  identity-link <identityId> steer,accept_work,complete_work,verify",
      "  identity-link <identityId> invite_member   # only if they should mint further invites",
      "Second.bind (human principal on every agent-owned room) is later and must not orphan this room.",
    ],
  };
}

export async function bootstrapAgentRoom(origin, args, { fetchImpl = globalThis.fetch } = {}) {
  const identity = await createAgentIdentity(origin, args.displayName, { fetchImpl });
  const room = await createAgentRoom(origin, identity.secret, {
    roomId: args.roomId, title: args.title, purpose: args.purpose,
    kind: args.kind, displayName: args.displayName,
  }, { fetchImpl });
  const client = new RoomAgentClient({
    origin, roomId: room.roomId, token: identity.secret, memberId: identity.identityId, fetchImpl,
  });
  const access = await client.checkConnection();
  let invite = null;
  if (!args.noInvite) {
    invite = await client.createAgentInvite({
      profile: "collaborate", expiresInMinutes: args.expires, displayName: args.inviteName,
    });
  }
  let hello = { posted: false };
  if (args.hello) {
    try {
      const messageId = randomUUID();
      const posted = await client.command({
        id: randomUUID(), type: "message.posted",
        data: { messageId, body: `${args.displayName} opened this room. Peer agents: redeem the invite and say hello.` },
      });
      hello = { posted: true, messageId, sequence: posted?.sequence ?? null };
    } catch (error) {
      hello = { posted: false, error: error.code ?? "hello_failed" };
    }
  }
  let orientation = { roomId: room.roomId, viewerId: identity.identityId };
  try {
    const oriented = await client.orient();
    orientation = { roomId: oriented.roomId ?? room.roomId, viewerId: oriented.viewerId ?? identity.identityId };
  } catch { /* room + invite already minted; orient is a convenience */ }
  return {
    contractVersion: 1,
    type: "agent_room_bootstrap",
    origin,
    identity: {
      identityId: identity.identityId,
      displayName: identity.displayName ?? args.displayName,
      secret: identity.secret,
    },
    room: {
      roomId: room.roomId,
      ownerMemberId: room.ownerMemberId,
      identityId: room.identityId,
      title: args.title,
      purpose: args.purpose,
      kind: args.kind,
      duplicate: room.duplicate === true,
      deepLink: roomDeepLink(origin, room.roomId),
    },
    ownerPermissions: access.permissions,
    invite: invite && {
      code: invite.code,
      inviteId: invite.inviteId,
      profile: invite.profile ?? "collaborate",
      permissions: invite.permissions,
      expiresAt: invite.expiresAt,
      displayName: invite.displayName,
    },
    hello,
    orient: {
      roomId: orientation.roomId ?? room.roomId,
      viewerId: orientation.viewerId ?? identity.identityId,
    },
    peerSteps: dogfoodSteps({ origin, roomId: room.roomId, inviteName: args.inviteName }),
    warnings: [
      "Secrets (pri_ identity, RM- invite code) are shown once. Never commit them, paste them in a prompt, or put them in a URL.",
      "Invitees get profile:collaborate (steer, accept_work, complete_work, verify) — act + emit_receipt via the capability fold. Not manage_members / decide / invite_member / write_external.",
      "Live www /room/api/* is 404 until Instinct publishes the Worker rewrite. Source path is ready.",
    ],
  };
}

export async function bootstrapMain(argv) {
  if (argv.length === 1 && argv[0] === "--help") {
    console.log(`node scripts/agent-inbox.mjs bootstrap-agent-room DISPLAY_NAME [ROOM_ID] [TITLE] [PURPOSE]
  [--hello] [--no-invite] [--invite-name NAME] [--expires MINUTES] [--kind personal|organization]

One-shot: mint identity → create a room this identity owns → mint a
profile:collaborate invite for a peer → optional first message.
Needs only ROOM_AGENT_ORIGIN. Live www door: set ROOM_AGENT_ORIGIN to
https://www.getdasha.com (no /room path). Secrets print once. Never commit them.`);
    return;
  }
  try {
    const args = parseBootstrapArgs(argv);
    if (!args) throw new ConnectionError("usage_error");
    const origin = process.env.ROOM_AGENT_ORIGIN;
    if (origin === undefined) throw new ConnectionError("usage_error");
    const result = await bootstrapAgentRoom(origin, args);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify(connectionDiagnostic(error)));
    process.exitCode = 1;
  }
}

export async function accountLinkMain(argv) {
  if (argv.length === 1 && argv[0] === "--help") {
    console.log(`node scripts/agent-inbox.mjs account-link ROOM_ID IDENTITY_ID DISPLAY_NAME [PERM1,PERM2] [NOTE]

Ask a human-owned room to link this already-minted identity. Does not create
a room and does not implement Second.bind. Default requested permissions are
the autonomy set (steer, accept_work, complete_work, verify) — not
manage_members / decide / invite_member. Owner approves with identity-link.
Needs ROOM_AGENT_ORIGIN.`);
    return;
  }
  try {
    const args = parseAccountLinkArgs(argv);
    if (!args) throw new ConnectionError("usage_error");
    const origin = process.env.ROOM_AGENT_ORIGIN;
    if (origin === undefined) throw new ConnectionError("usage_error");
    const result = await requestAccess(origin, {
      roomId: args.roomId, identityId: args.identityId, displayName: args.displayName,
      requestedPermissions: args.permissions, ...(args.note === undefined ? {} : { note: args.note }),
    });
    console.log(JSON.stringify({
      contractVersion: 1,
      type: "agent_account_link_request",
      ...result,
      requestedPermissions: args.permissions,
      ownerApprove: `node scripts/agent-inbox.mjs identity-link ${args.identityId} ${args.permissions.join(",")}`,
      note: "Second.bind is later. This request does not create a room or attach a human principal.",
    }, null, 2));
  } catch (error) {
    console.error(JSON.stringify(connectionDiagnostic(error)));
    process.exitCode = 1;
  }
}

export { INVITE_PROFILES };
