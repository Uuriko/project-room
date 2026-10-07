// Room roles with hierarchy (missing-features #6).
//
// The member capability bits (member.permissions, enforced by memberCan in
// src/events.js) stay the enforcement substrate: this module never replaces
// them. Roles are named, ranked capability bundles that write THROUGH to
// those bits on assignment — the bits remain authoritative, so every existing
// gate keeps working unchanged.
//
// - Default roles seed from the invite presets (INVITATION_ROLES): Moderator,
//   Member, Guest. Their capabilities track the preset bit-for-bit and are
//   immutable; custom roles cannot carry owner-only capabilities
//   (decide, manage_members, invite_member stay with the room owner).
// - Rank orders the hierarchy (higher rank = higher). listRoles returns
//   rank-descending for display; a member's effective capabilities are the
//   union of their roles' capabilities in rank order.
// - Channel-scoped overwrites resolve per (channel, role): deny wins over
//   allow, and the room owner bypasses every overwrite.
// - Members with no role rows keep their stored permission snapshot exactly
//   (backward compatible); backfill maps preset members onto default roles
//   without touching permission bits.
//
// Tables are purely additive (IF NOT EXISTS, no schema version bump) and
// registered in server/writer-fence.mjs unfencedAdditiveTables. Older writers
// have no code path to them.
import { randomBytes } from "node:crypto";
import { PERMISSIONS, INVITATION_ROLES } from "../src/events.js";
import { ServiceError } from "./service-error.mjs";

// Owner-only powers. Custom roles can never carry these; the seeded default
// Moderator keeps manage_members because the invite preset grants it today
// (grandfathered, capabilities immutable).
export const OWNER_ONLY_CAPABILITIES = Object.freeze(["decide", "manage_members", "invite_member"]);

export const DEFAULT_ROLE_NAMES = Object.freeze({
  moderator: "Moderator",
  member: "Member",
  guest: "Guest",
});

// Rank orders the hierarchy: Moderator > Member > Guest. Custom roles slot
// between by rank; display and unions both read rank-descending.
export const DEFAULT_ROLE_RANKS = Object.freeze({
  moderator: 300,
  member: 200,
  guest: 100,
});

export const ROOM_ROLES_SCHEMA = `
CREATE TABLE IF NOT EXISTS room_roles (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  name TEXT NOT NULL,
  rank INTEGER NOT NULL,
  capabilities_json TEXT NOT NULL CHECK(json_valid(capabilities_json)),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1)),
  created_by TEXT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_room_roles_room_name ON room_roles(room_id, name);
CREATE INDEX IF NOT EXISTS idx_room_roles_room_rank ON room_roles(room_id, rank DESC);
CREATE TABLE IF NOT EXISTS room_role_assignments (
  room_id TEXT NOT NULL,
  role_id TEXT NOT NULL REFERENCES room_roles(id),
  member_id TEXT NOT NULL,
  assigned_by TEXT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, role_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_room_role_assignments_member ON room_role_assignments(room_id, member_id);
CREATE TABLE IF NOT EXISTS room_channel_role_overwrites (
  room_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  role_id TEXT NOT NULL REFERENCES room_roles(id),
  capability TEXT NOT NULL,
  effect TEXT NOT NULL CHECK(effect IN ('allow','deny')),
  set_by TEXT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, channel_id, role_id, capability)
);
`;

// Called from the writer boot path next to ensureGrantsSchema in
// server/store.mjs. Purely additive, IF NOT EXISTS is idempotent.
export function ensureRoomRolesSchema(db) {
  db.exec(ROOM_ROLES_SCHEMA);
}

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };

const MEMBER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const validMemberId = id => typeof id === "string" && MEMBER_ID_PATTERN.test(id);
const validRoleName = name => typeof name === "string" && name.trim().length >= 1 && name.trim().length <= 64;
const validRank = rank => Number.isSafeInteger(rank) && rank >= 0;

const newRoleId = () => `role_${randomBytes(12).toString("hex")}`;

function normalizeCapabilities(capabilities, { allowOwnerOnly }) {
  if (!Array.isArray(capabilities)) fail(422, "invalid_role_capabilities", "capabilities must be an array of room permissions");
  const seen = [];
  for (const capability of capabilities) {
    if (typeof capability !== "string" || !PERMISSIONS.includes(capability)) {
      fail(422, "unknown_capability", `unknown capability ${JSON.stringify(capability)} (valid: ${PERMISSIONS.join(", ")})`);
    }
    if (!allowOwnerOnly && OWNER_ONLY_CAPABILITIES.includes(capability)) {
      fail(422, "owner_only_capability", `custom roles cannot include owner-only capabilities (${capability}); decide, manage_members and invite_member stay with the room owner`);
    }
    if (!seen.includes(capability)) seen.push(capability);
  }
  return seen;
}

function publicRole(row) {
  return {
    id: row.id,
    name: row.name,
    rank: row.rank,
    capabilities: JSON.parse(row.capabilities_json),
    isDefault: row.is_default === 1,
  };
}

function snapshotMatchesPreset(permissions) {
  if (!Array.isArray(permissions)) return null;
  for (const [preset, caps] of Object.entries(INVITATION_ROLES)) {
    if (permissions.length === caps.length && caps.every(cap => permissions.includes(cap))) return preset;
  }
  return null;
}

export function createRoomRoles(db, { now = () => Date.now(), ownerIdForRoom = null } = {}) {
  if (!db || typeof db.prepare !== "function") throw new Error("createRoomRoles needs a database");
  // Schema comes from the store boot path (ensureRoomRolesSchema in
  // server/store.mjs), which runs after the schema-version check — running
  // DDL here would trip the fresh-database guard.

  const ownerIdOf = roomId => {
    if (typeof ownerIdForRoom !== "function") return null;
    return ownerIdForRoom(roomId) ?? null;
  };

  // Seed the invite-preset defaults. Idempotent: INSERT OR IGNORE on
  // (room_id, name); a second seed changes nothing.
  function ensureRoomRoles(roomId) {
    const at = now();
    const insert = db.prepare(`INSERT OR IGNORE INTO room_roles
      (id, room_id, name, rank, capabilities_json, is_default, created_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,NULL,?,?)`);
    for (const preset of Object.keys(DEFAULT_ROLE_NAMES)) {
      insert.run(newRoleId(), roomId, DEFAULT_ROLE_NAMES[preset], DEFAULT_ROLE_RANKS[preset],
        JSON.stringify([...INVITATION_ROLES[preset]]), 1, at, at);
    }
    return listRoles(roomId);
  }

  function listRoles(roomId) {
    return db.prepare("SELECT * FROM room_roles WHERE room_id=? ORDER BY rank DESC, name ASC")
      .all(roomId).map(publicRole);
  }

  function getRole(roomId, roleId) {
    const row = db.prepare("SELECT * FROM room_roles WHERE room_id=? AND id=?").get(roomId, roleId);
    if (!row) fail(404, "role_not_found", "Unknown role");
    return publicRole(row);
  }

  function createRole(roomId, { name, rank, capabilities }, actorId = null) {
    ensureRoomRoles(roomId);
    if (!validRoleName(name)) fail(422, "invalid_role_name", "Role name must be 1..64 characters");
    if (!validRank(rank)) fail(422, "invalid_role_rank", "Role rank must be a non-negative integer");
    const caps = normalizeCapabilities(capabilities, { allowOwnerOnly: false });
    if (caps.length === 0) fail(422, "invalid_role_capabilities", "A custom role needs at least one capability");
    const trimmed = name.trim();
    const dupe = db.prepare("SELECT 1 FROM room_roles WHERE room_id=? AND lower(name)=lower(?)").get(roomId, trimmed);
    if (dupe) fail(409, "role_name_taken", `A role named ${JSON.stringify(trimmed)} already exists in this room`);
    const at = now();
    const id = newRoleId();
    db.prepare(`INSERT INTO room_roles (id, room_id, name, rank, capabilities_json, is_default, created_by, created_at, updated_at)
      VALUES (?,?,?,?,?,0,?,?,?)`).run(id, roomId, trimmed, rank, JSON.stringify(caps), actorId, at, at);
    return getRole(roomId, id);
  }

  function updateRole(roomId, roleId, patch, actorId = null) {
    const row = db.prepare("SELECT * FROM room_roles WHERE room_id=? AND id=?").get(roomId, roleId);
    if (!row) fail(404, "role_not_found", "Unknown role");
    const isDefault = row.is_default === 1;
    const patchObj = patch && typeof patch === "object" ? patch : {};
    const updates = [];
    const params = [];
    if (patchObj.name !== undefined) {
      if (isDefault) fail(422, "default_role_immutable", "default roles are immutable: names track the invite presets");
      if (!validRoleName(patchObj.name)) fail(422, "invalid_role_name", "Role name must be 1..64 characters");
      const trimmed = patchObj.name.trim();
      const dupe = db.prepare("SELECT 1 FROM room_roles WHERE room_id=? AND lower(name)=lower(?) AND id<>?")
        .get(roomId, trimmed, roleId);
      if (dupe) fail(409, "role_name_taken", `A role named ${JSON.stringify(trimmed)} already exists in this room`);
      updates.push("name=?"); params.push(trimmed);
    }
    if (patchObj.rank !== undefined) {
      if (!validRank(patchObj.rank)) fail(422, "invalid_role_rank", "Role rank must be a non-negative integer");
      updates.push("rank=?"); params.push(patchObj.rank);
    }
    if (patchObj.capabilities !== undefined) {
      if (isDefault) fail(422, "default_role_immutable", "default roles are immutable: capabilities track the invite preset bit-for-bit");
      const caps = normalizeCapabilities(patchObj.capabilities, { allowOwnerOnly: false });
      if (caps.length === 0) fail(422, "invalid_role_capabilities", "A custom role needs at least one capability");
      updates.push("capabilities_json=?"); params.push(JSON.stringify(caps));
    }
    if (updates.length === 0) fail(422, "empty_role_patch", "Nothing to update: send name, rank, or capabilities");
    updates.push("updated_at=?"); params.push(now(), roomId, roleId);
    db.prepare(`UPDATE room_roles SET ${updates.join(", ")} WHERE room_id=? AND id=?`).run(...params);
    return getRole(roomId, roleId);
  }

  function deleteRole(roomId, roleId) {
    const row = db.prepare("SELECT * FROM room_roles WHERE room_id=? AND id=?").get(roomId, roleId);
    if (!row) fail(404, "role_not_found", "Unknown role");
    if (row.is_default === 1) fail(422, "default_role_immutable", "default roles cannot be deleted; they track the invite presets");
    db.prepare("DELETE FROM room_channel_role_overwrites WHERE room_id=? AND role_id=?").run(roomId, roleId);
    db.prepare("DELETE FROM room_role_assignments WHERE room_id=? AND role_id=?").run(roomId, roleId);
    db.prepare("DELETE FROM room_roles WHERE room_id=? AND id=?").run(roomId, roleId);
    return { deleted: true, id: roleId };
  }

  function memberRoles(roomId, memberId) {
    ensureRoomRoles(roomId);
    return db.prepare(`SELECT r.* FROM room_roles r
      JOIN room_role_assignments a ON a.role_id=r.id AND a.room_id=r.room_id
      WHERE a.room_id=? AND a.member_id=? ORDER BY r.rank DESC, r.name ASC`)
      .all(roomId, memberId).map(publicRole);
  }

  // Union of a member's roles, rank-descending, first occurrence wins.
  function unionFor(roomId, memberId) {
    const caps = [];
    for (const role of memberRoles(roomId, memberId)) {
      for (const capability of role.capabilities) {
        if (!caps.includes(capability)) caps.push(capability);
      }
    }
    return caps;
  }

  function assignRole(roomId, roleId, memberId, actorId = null) {
    const role = getRole(roomId, roleId);
    if (!validMemberId(memberId)) fail(422, "invalid_member", "memberId is not a valid member id");
    if (memberId === ownerIdOf(roomId)) {
      fail(403, "role_owner_immutable", "The room owner holds every capability; roles are not assigned to the owner");
    }
    db.prepare(`INSERT OR IGNORE INTO room_role_assignments (room_id, role_id, member_id, assigned_by, created_at)
      VALUES (?,?,?,?,?)`).run(roomId, roleId, memberId, actorId, now());
    return { role, permissions: unionFor(roomId, memberId) };
  }

  function unassignRole(roomId, roleId, memberId, actorId = null) {
    const row = db.prepare("SELECT * FROM room_roles WHERE room_id=? AND id=?").get(roomId, roleId);
    if (!row) fail(404, "role_not_found", "Unknown role");
    if (!validMemberId(memberId)) fail(422, "invalid_member", "memberId is not a valid member id");
    // Union before removal: unassigning the last role keeps the member's
    // current snapshot (no wipe) — the write-through layer recomputes from
    // the remaining roles and falls back to this.
    const before = unionFor(roomId, memberId);
    db.prepare("DELETE FROM room_role_assignments WHERE room_id=? AND role_id=? AND member_id=?")
      .run(roomId, roleId, memberId);
    const remaining = unionFor(roomId, memberId);
    return { permissions: remaining.length > 0 ? remaining : before };
  }

  // Map preset members onto their default roles. Never touches the stored
  // permission bits: members whose bits don't exactly match a preset keep
  // their snapshot and get no role (backward compatible).
  function backfillRoleAssignments(roomId, members, actorId = null) {
    ensureRoomRoles(roomId);
    const ownerId = ownerIdOf(roomId);
    const already = new Set(db.prepare("SELECT member_id FROM room_role_assignments WHERE room_id=?")
      .all(roomId).map(row => row.member_id));
    const roleIdByPreset = {};
    for (const preset of Object.keys(DEFAULT_ROLE_NAMES)) {
      roleIdByPreset[preset] = defaultRoleIdForPreset(roomId, preset);
    }
    let assigned = 0;
    const insert = db.prepare(`INSERT OR IGNORE INTO room_role_assignments
      (room_id, role_id, member_id, assigned_by, created_at) VALUES (?,?,?,?,?)`);
    for (const member of members ?? []) {
      if (!member || typeof member.id !== "string") continue;
      if (member.active === false) continue;
      if (member.id === ownerId) continue;
      if (already.has(member.id)) continue;
      // A preset stamp is only a hint: the stored permission snapshot must
      // still match that preset bit-for-bit, otherwise custom bits would
      // silently gain a role. Members with no stamp match by snapshot.
      const hinted = typeof member.role === "string" && Object.hasOwn(INVITATION_ROLES, member.role) ? member.role : null;
      const matched = snapshotMatchesPreset(member.permissions);
      const preset = hinted ? (matched === hinted ? hinted : null) : matched;
      if (!preset || !roleIdByPreset[preset]) continue;
      insert.run(roomId, roleIdByPreset[preset], member.id, actorId, now());
      already.add(member.id);
      assigned += 1;
    }
    return assigned;
  }

  function defaultRoleIdForPreset(roomId, preset) {
    if (!Object.hasOwn(DEFAULT_ROLE_NAMES, preset)) return null;
    ensureRoomRoles(roomId);
    return db.prepare("SELECT id FROM room_roles WHERE room_id=? AND name=? AND is_default=1")
      .get(roomId, DEFAULT_ROLE_NAMES[preset])?.id ?? null;
  }

  // Replace the overwrite set for (channel, role). Duplicate capabilities in
  // one call collapse deny-wins, so resolution never sees both.
  function setChannelOverwrites(roomId, channelId, roleId, overwrites, actorId = null) {
    getRole(roomId, roleId);
    if (typeof channelId !== "string" || !channelId.trim() || channelId.length > 128) {
      fail(422, "invalid_channel", "channelId must be a non-empty string");
    }
    if (!Array.isArray(overwrites)) fail(422, "invalid_overwrites", "overwrites must be an array of { capability, effect }");
    const collapsed = new Map();
    for (const overwrite of overwrites) {
      const capability = overwrite?.capability;
      const effect = overwrite?.effect;
      if (typeof capability !== "string" || !PERMISSIONS.includes(capability)) {
        fail(422, "unknown_capability", `unknown capability ${JSON.stringify(capability)} (valid: ${PERMISSIONS.join(", ")})`);
      }
      if (effect !== "allow" && effect !== "deny") fail(422, "invalid_overwrite_effect", "effect must be allow or deny");
      if (effect === "deny" || !collapsed.has(capability)) collapsed.set(capability, effect);
    }
    const at = now();
    db.prepare("DELETE FROM room_channel_role_overwrites WHERE room_id=? AND channel_id=? AND role_id=?")
      .run(roomId, channelId, roleId);
    const insert = db.prepare(`INSERT INTO room_channel_role_overwrites
      (room_id, channel_id, role_id, capability, effect, set_by, created_at) VALUES (?,?,?,?,?,?,?)`);
    for (const [capability, effect] of collapsed) {
      insert.run(roomId, channelId, roleId, capability, effect, actorId, at);
    }
    return [...collapsed].map(([capability, effect]) => ({ capability, effect }))
      .sort((a, b) => a.capability < b.capability ? -1 : 1);
  }

  function listOverwrites(roomId) {
    return db.prepare(`SELECT channel_id AS channelId, role_id AS roleId, capability, effect
      FROM room_channel_role_overwrites WHERE room_id=? ORDER BY channel_id, role_id, capability`)
      .all(roomId);
  }

  // Effective room-wide capabilities: the role union, or the stored
  // snapshot for members with no roles. The owner always resolves to the
  // full capability set.
  function effectiveCapabilities(roomId, memberLike, ownerId) {
    if (memberLike?.id === ownerId) return [...PERMISSIONS];
    const union = unionFor(roomId, memberLike?.id);
    if (union.length > 0) return union;
    return [...(memberLike?.permissions ?? [])];
  }

  // Channel-scoped resolution: deny wins over allow; the owner bypasses
  // every overwrite. Members with no roles see no overwrites (their
  // snapshot governs).
  function channelCapabilities(roomId, memberLike, channelId, ownerId) {
    const base = effectiveCapabilities(roomId, memberLike, ownerId);
    if (memberLike?.id === ownerId) return base;
    const roles = memberRoles(roomId, memberLike?.id);
    if (roles.length === 0) return base;
    const placeholders = roles.map(() => "?").join(",");
    const rows = db.prepare(`SELECT capability, effect FROM room_channel_role_overwrites
      WHERE room_id=? AND channel_id=? AND role_id IN (${placeholders})`)
      .all(roomId, channelId, ...roles.map(role => role.id));
    const allow = new Set();
    const deny = new Set();
    for (const row of rows) (row.effect === "deny" ? deny : allow).add(row.capability);
    const out = base.filter(capability => !deny.has(capability));
    for (const capability of allow) {
      if (!deny.has(capability) && !out.includes(capability)) out.push(capability);
    }
    return out;
  }

  // Display projection for the room snapshot: roles in hierarchy order and
  // each member's role ids, rank-descending.
  function rolesForSnapshot(roomId) {
    const roles = listRoles(roomId);
    const rankOf = new Map(roles.map(role => [role.id, role.rank]));
    const memberRoles = {};
    for (const row of db.prepare("SELECT member_id, role_id FROM room_role_assignments WHERE room_id=?").all(roomId)) {
      (memberRoles[row.member_id] ??= []).push(row.role_id);
    }
    for (const ids of Object.values(memberRoles)) {
      ids.sort((a, b) => (rankOf.get(b) ?? 0) - (rankOf.get(a) ?? 0));
    }
    return { version: 1, roles, memberRoles };
  }

  return {
    ensureRoomRoles,
    listRoles,
    getRole,
    createRole,
    updateRole,
    deleteRole,
    assignRole,
    unassignRole,
    memberRoles,
    backfillRoleAssignments,
    defaultRoleIdForPreset,
    setChannelOverwrites,
    listOverwrites,
    effectiveCapabilities,
    channelCapabilities,
    rolesForSnapshot,
  };
}
