// RT routes for roles with hierarchy (missing-features #6).
//
// Read (GET) is open to any room member — the member list already shows
// everyone's permission bits. Writes need manage_members (or the room
// owner, who holds every capability): role management is membership
// administration. Custom roles can never carry owner-only capabilities
// (decide, manage_members, invite_member stay with the room owner), so a
// role manager cannot escalate past the Moderator preset.
//
// Assignment writes THROUGH to the member capability bits via the existing
// member.access_changed command: the bits stay the enforcement substrate,
// and the command pipeline's own gates (manage_members, agent-admin
// delegation rules) apply unchanged.

function roomContext(ctx, write) {
  const roomId = ctx.params.roomId;
  const selected = ctx.roomCredentials(ctx.req, ctx.url);
  const fence = selected.mode === "account" ? ctx.accountBinding(ctx.req) : ctx.expectedBinding(ctx.req);
  const auth = ctx.roomAuth(selected, roomId, fence);
  if (selected.bearer && auth.credentialScope !== "room") ctx.reject(403, "access_denied", "Bearer account sessions are not accepted");
  if (!selected.bearer && auth.kind !== "session") ctx.reject(401, "unauthenticated", "Browser session required");
  ctx.rate(`read:${auth.credentialHash}`, 600);
  if (write) {
    ctx.protectWrite(ctx.req, auth, selected.bearer);
    ctx.rate(`write:${auth.credentialHash}`, 60);
  }
  return { roomId, selected, fence, auth };
}

function requireRoleManager(ctx, store, roomId, auth) {
  const state = store.room(roomId).state;
  const member = state.members[auth.member.id];
  if (!member || member.active === false) ctx.reject(403, "access_denied", "Not an active room member");
  if (auth.member.id !== state.room.ownerId && !member.permissions.includes("manage_members")) {
    ctx.reject(403, "access_denied", "Role management needs the manage_members capability");
  }
  return { state, member };
}

async function readBody(ctx) {
  const data = await ctx.body(ctx.req);
  if (!data || typeof data !== "object" || Array.isArray(data)) ctx.reject(422, "invalid_body", "A JSON object body is required");
  return data;
}

export async function listRoomRoles(ctx) {
  const store = ctx.store;
  const { roomId } = roomContext(ctx, false);
  store.roomRoles.ensureRoomRoles(roomId);
  return ctx.json(ctx.res, 200, {
    roomId,
    roles: store.roomRoles.listRoles(roomId),
    assignments: store.roomRoles.rolesForSnapshot(roomId).memberRoles,
    overwrites: store.roomRoles.listOverwrites(roomId),
  });
}

export async function createRoomRole(ctx) {
  const store = ctx.store;
  const { roomId, auth } = roomContext(ctx, true);
  requireRoleManager(ctx, store, roomId, auth);
  const data = await readBody(ctx);
  const role = store.roomRoles.createRole(roomId,
    { name: data.name, rank: data.rank, capabilities: data.capabilities }, auth.member.id);
  return ctx.json(ctx.res, 201, { roomId, role });
}

export async function updateRoomRole(ctx) {
  const store = ctx.store;
  const { roomId, auth } = roomContext(ctx, true);
  requireRoleManager(ctx, store, roomId, auth);
  const data = await readBody(ctx);
  const role = store.roomRoles.updateRole(roomId, ctx.params.roleId,
    { name: data.name, rank: data.rank, capabilities: data.capabilities }, auth.member.id);
  return ctx.json(ctx.res, 200, { roomId, role });
}

export async function deleteRoomRole(ctx) {
  const store = ctx.store;
  const { roomId, auth } = roomContext(ctx, true);
  requireRoleManager(ctx, store, roomId, auth);
  const deleted = store.roomRoles.deleteRole(roomId, ctx.params.roleId);
  return ctx.json(ctx.res, 200, { roomId, ...deleted });
}

// Assignment writes through to the member capability bits via
// store.setMemberRole (member.access_changed command): the bits stay the
// enforcement substrate, and the command pipeline re-checks manage_members
// and the agent-admin delegation rules.
function authedRoleCall(ctx) {
  const store = ctx.store;
  const { roomId, selected, fence, auth } = roomContext(ctx, true);
  requireRoleManager(ctx, store, roomId, auth);
  const call = args => {
    try {
      return store.setMemberRole(selected.token, roomId, args, { expectedSessionBinding: fence });
    } catch (error) {
      ctx.reject(error.status ?? 500, error.code ?? "internal_error", error.message);
    }
  };
  return { roomId, call };
}

export async function assignMemberRole(ctx) {
  const { roomId, call } = authedRoleCall(ctx);
  const data = await readBody(ctx);
  if (typeof data.memberId !== "string" || !data.memberId) ctx.reject(422, "invalid_member", "memberId is required");
  const result = call({ roleId: ctx.params.roleId, memberId: data.memberId, assign: true });
  return ctx.json(ctx.res, 200, { roomId, ...result });
}

export async function unassignMemberRole(ctx) {
  const { roomId, call } = authedRoleCall(ctx);
  const result = call({ roleId: ctx.params.roleId, memberId: ctx.params.memberId, assign: false });
  return ctx.json(ctx.res, 200, { roomId, roleId: ctx.params.roleId, ...result });
}

export async function setRoleChannelOverwrites(ctx) {
  const store = ctx.store;
  const { roomId, auth } = roomContext(ctx, true);
  requireRoleManager(ctx, store, roomId, auth);
  const data = await readBody(ctx);
  if (!Array.isArray(data.overwrites)) ctx.reject(422, "invalid_overwrites", "overwrites must be an array of { capability, effect }");
  let overwrites;
  try {
    overwrites = store.roomRoles.setChannelOverwrites(
      roomId, ctx.params.channelId, ctx.params.roleId, data.overwrites, auth.member.id);
  } catch (error) {
    ctx.reject(error.status ?? 500, error.code ?? "internal_error", error.message);
  }
  return ctx.json(ctx.res, 200, { roomId, channelId: ctx.params.channelId, roleId: ctx.params.roleId, overwrites });
}

const roomParams = Object.freeze({ type: "object", required: ["roomId"], properties: { roomId: { type: "string" } } });
const roleParams = Object.freeze({ type: "object", required: ["roomId", "roleId"],
  properties: { roomId: { type: "string" }, roleId: { type: "string" } } });
const assignmentParams = Object.freeze({ type: "object", required: ["roomId", "roleId", "memberId"],
  properties: { roomId: { type: "string" }, roleId: { type: "string" }, memberId: { type: "string" } } });
const overwriteParams = Object.freeze({ type: "object", required: ["roomId", "channelId", "roleId"],
  properties: { roomId: { type: "string" }, channelId: { type: "string" }, roleId: { type: "string" } } });
const roleBody = Object.freeze({ type: "object", required: ["name", "rank", "capabilities"], additionalProperties: false,
  properties: { name: { type: "string" }, rank: { type: "integer" }, capabilities: { type: "array", items: { type: "string" } } } });
const rolePatchBody = Object.freeze({ type: "object", additionalProperties: false,
  properties: { name: { type: "string" }, rank: { type: "integer" }, capabilities: { type: "array", items: { type: "string" } } } });
const assignBody = Object.freeze({ type: "object", required: ["memberId"], additionalProperties: false,
  properties: { memberId: { type: "string" } } });
const overwritesBody = Object.freeze({ type: "object", required: ["overwrites"], additionalProperties: false,
  properties: { overwrites: { type: "array", items: { type: "object" } } } });

export const ROOM_ROLE_ROUTES = Object.freeze([
  Object.freeze({ id: "list-room-roles", method: "GET", path: "/api/rooms/{roomId}/roles",
    auth: "room", capability: null, scope: "room", handler: listRoomRoles,
    schema: { params: roomParams, response: { type: "object" } }, events: [] }),
  Object.freeze({ id: "create-room-role", method: "POST", path: "/api/rooms/{roomId}/roles",
    auth: "room", capability: null, scope: "room", handler: createRoomRole,
    schema: { params: roomParams, body: roleBody, response: { type: "object" } }, events: [] }),
  Object.freeze({ id: "update-room-role", method: "PATCH", path: "/api/rooms/{roomId}/roles/{roleId}",
    auth: "room", capability: null, scope: "room", handler: updateRoomRole,
    schema: { params: roleParams, body: rolePatchBody, response: { type: "object" } }, events: [] }),
  Object.freeze({ id: "delete-room-role", method: "DELETE", path: "/api/rooms/{roomId}/roles/{roleId}",
    auth: "room", capability: null, scope: "room", handler: deleteRoomRole,
    schema: { params: roleParams, response: { type: "object" } }, events: [] }),
  Object.freeze({ id: "assign-member-role", method: "POST", path: "/api/rooms/{roomId}/roles/{roleId}/assignments",
    auth: "room", capability: null, scope: "room", handler: assignMemberRole,
    schema: { params: roleParams, body: assignBody, response: { type: "object" } }, events: ["member.access_changed"] }),
  Object.freeze({ id: "unassign-member-role", method: "DELETE", path: "/api/rooms/{roomId}/roles/{roleId}/assignments/{memberId}",
    auth: "room", capability: null, scope: "room", handler: unassignMemberRole,
    schema: { params: assignmentParams, response: { type: "object" } }, events: ["member.access_changed"] }),
  Object.freeze({ id: "set-role-channel-overwrites", method: "PUT", path: "/api/rooms/{roomId}/channels/{channelId}/roles/{roleId}/overwrites",
    auth: "room", capability: null, scope: "room", handler: setRoleChannelOverwrites,
    schema: { params: overwriteParams, body: overwritesBody, response: { type: "object" } }, events: [] }),
]);
