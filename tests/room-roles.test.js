// Roles with hierarchy (missing-features #6).
//
// Test-audit gate:
// 1. Behavior: role objects (name/rank/capabilities), assignment write-through
//    to the member permission bits, invite-preset -> default-role mapping,
//    channel-scoped overwrite resolution, and the owner-only capability guard.
// 2. Credible regressions: preset drift (INVITATION_ROLES changes and the
//    mapping silently breaks), deny/allow precedence flip, privilege
//    escalation through a custom role, backfill mutating permission bits,
//    channel overwrites applying to the room owner.
// 3. Existing coverage: none — this is a new subsystem; the permission bits
//    stay the enforcement substrate and are covered elsewhere.
// 4. No test-only production seams: server/room-roles.mjs is imported by
//    server/store.mjs (redemption hook + service) and
//    server/routes/room-roles.mjs (HTTP API).
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T, INVITATION_ROLES, PERMISSIONS } from "../src/events.js";
import {
  createRoomRoles,
  OWNER_ONLY_CAPABILITIES,
  DEFAULT_ROLE_NAMES,
} from "../server/room-roles.mjs";

function fixture(t, ownerId = "owner") {
  // TMPDIR is the worktree .tmp (never the shared /tmp tmpfs).
  const directory = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "room-roles-"));
  const filename = join(directory, "room.sqlite");
  const store = new RoomStore(filename, { now: () => Date.now() });
  store.initialize(initialRoom("commons", ownerId));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, roles: store.roomRoles, ownerId };
}

function roleByName(roles, name) {
  return roles.listRoles("commons").find(r => r.name === name);
}

test("default roles seed from the invite presets and match their capability sets exactly", t => {
  const { roles } = fixture(t);
  const seeded = roles.ensureRoomRoles("commons");
  assert.equal(seeded.length, 3);
  for (const preset of ["moderator", "member", "guest"]) {
    const role = seeded.find(r => r.name === DEFAULT_ROLE_NAMES[preset]);
    assert.ok(role, `default role for preset ${preset}`);
    assert.deepEqual(role.capabilities, [...INVITATION_ROLES[preset]],
      `default ${preset} role tracks the invite preset bit-for-bit`);
  }
  // Ranks order the hierarchy: moderator above member above guest.
  const byRank = [...seeded].sort((a, b) => b.rank - a.rank).map(r => r.name);
  assert.deepEqual(byRank, [DEFAULT_ROLE_NAMES.moderator, DEFAULT_ROLE_NAMES.member, DEFAULT_ROLE_NAMES.guest]);
  // Idempotent: a second seed changes nothing.
  assert.equal(roles.ensureRoomRoles("commons").length, 3);
});

test("backfill assigns preset roles to existing members without touching permission bits", t => {
  const { roles } = fixture(t);
  roles.ensureRoomRoles("commons");
  const members = [
    { id: "m1", role: "moderator", permissions: [...INVITATION_ROLES.moderator], active: true },
    { id: "m2", role: "member", permissions: [...INVITATION_ROLES.member], active: true },
    { id: "m3", role: "guest", permissions: [], active: true },
    // Custom bits: no role, and the snapshot must survive untouched.
    { id: "m4", role: "member", permissions: ["steer", "verify"], active: true },
    // No preset stamp but an exact preset snapshot still maps.
    { id: "m5", permissions: [...INVITATION_ROLES.member], active: true },
    // Inactive members are skipped.
    { id: "m6", role: "member", permissions: [...INVITATION_ROLES.member], active: false },
  ];
  const before = members.map(m => [...m.permissions]);
  const assigned = roles.backfillRoleAssignments("commons", members, "owner");
  assert.equal(roles.memberRoles("commons", "m1")[0].name, DEFAULT_ROLE_NAMES.moderator);
  assert.equal(roles.memberRoles("commons", "m2")[0].name, DEFAULT_ROLE_NAMES.member);
  assert.equal(roles.memberRoles("commons", "m3")[0].name, DEFAULT_ROLE_NAMES.guest);
  assert.equal(roles.memberRoles("commons", "m4").length, 0, "custom bits get no role");
  assert.equal(roles.memberRoles("commons", "m5")[0].name, DEFAULT_ROLE_NAMES.member);
  assert.equal(roles.memberRoles("commons", "m6").length, 0, "inactive member skipped");
  assert.deepEqual(members.map(m => m.permissions), before, "backfill never mutates permission bits");
  assert.ok(assigned >= 4);
  // The room owner never receives a role row.
  assert.equal(roles.memberRoles("commons", "owner").length, 0);
});

test("assignRole unions capabilities across roles for the write-through permission set", t => {
  const { roles } = fixture(t);
  roles.ensureRoomRoles("commons");
  const helper = roles.createRole("commons", { name: "Helper", rank: 150, capabilities: ["verify", "write_external"] }, "owner");
  const member = roleByName(roles, DEFAULT_ROLE_NAMES.member);
  let writeThrough = roles.assignRole("commons", member.id, "m2", "owner");
  assert.deepEqual(writeThrough.permissions, [...INVITATION_ROLES.member]);
  writeThrough = roles.assignRole("commons", helper.id, "m2", "owner");
  assert.deepEqual(writeThrough.permissions, [...new Set([...INVITATION_ROLES.member, "verify", "write_external"])]);
  const held = roles.memberRoles("commons", "m2").map(r => r.name);
  assert.ok(held.includes(DEFAULT_ROLE_NAMES.member) && held.includes("Helper"));
  // Unassign recomputes from the remaining roles.
  writeThrough = roles.unassignRole("commons", helper.id, "m2", "owner");
  assert.deepEqual(writeThrough.permissions, [...INVITATION_ROLES.member]);
  // Unassigning the last role keeps the member's current snapshot (no wipe).
  writeThrough = roles.unassignRole("commons", member.id, "m2", "owner");
  assert.deepEqual(writeThrough.permissions, [...INVITATION_ROLES.member]);
  assert.equal(roles.memberRoles("commons", "m2").length, 0);
});

test("custom roles cannot carry owner-only capabilities", t => {
  const { roles } = fixture(t);
  roles.ensureRoomRoles("commons");
  for (const cap of OWNER_ONLY_CAPABILITIES) {
    assert.throws(
      () => roles.createRole("commons", { name: `Sneaky-${cap}`, rank: 50, capabilities: ["steer", cap] }, "owner"),
      /owner-only/,
      `custom role with ${cap} is refused`);
  }
  assert.ok(OWNER_ONLY_CAPABILITIES.includes("decide"));
  assert.ok(OWNER_ONLY_CAPABILITIES.includes("manage_members"));
  assert.ok(OWNER_ONLY_CAPABILITIES.includes("invite_member"));
  // Unknown capabilities are refused too.
  assert.throws(() => roles.createRole("commons", { name: "Bogus", rank: 50, capabilities: ["fly"] }, "owner"), /capabilit/);
  // ...but the full non-owner set is fine.
  const ok = roles.createRole("commons",
    { name: "Steward", rank: 250, capabilities: PERMISSIONS.filter(p => !OWNER_ONLY_CAPABILITIES.includes(p)) }, "owner");
  assert.equal(ok.name, "Steward");
});

test("default role capabilities are immutable; custom roles are editable", t => {
  const { roles } = fixture(t);
  roles.ensureRoomRoles("commons");
  const moderator = roleByName(roles, DEFAULT_ROLE_NAMES.moderator);
  assert.throws(() => roles.updateRole("commons", moderator.id, { capabilities: ["steer"] }, "owner"), /default/);
  const custom = roles.createRole("commons", { name: "Scribe", rank: 120, capabilities: ["verify"] }, "owner");
  const updated = roles.updateRole("commons", custom.id, { name: "Scribe+", rank: 130, capabilities: ["verify", "steer"] }, "owner");
  assert.equal(updated.name, "Scribe+");
  assert.deepEqual(updated.capabilities, ["verify", "steer"]);
  // Editing a custom role to add an owner-only capability is refused.
  assert.throws(() => roles.updateRole("commons", custom.id, { capabilities: ["decide"] }, "owner"), /owner-only/);
  // Default roles cannot be deleted; custom roles can.
  assert.throws(() => roles.deleteRole("commons", moderator.id, "owner"), /default/);
  roles.deleteRole("commons", custom.id, "owner");
  assert.equal(roles.listRoles("commons").length, 3);
});

test("channel overwrites: deny wins over allow, and the owner bypasses all overwrites", t => {
  const { roles } = fixture(t);
  roles.ensureRoomRoles("commons");
  const member = roleByName(roles, DEFAULT_ROLE_NAMES.member);
  roles.assignRole("commons", member.id, "m2", "owner");
  const base = roles.channelCapabilities("commons", { id: "m2", permissions: [...INVITATION_ROLES.member] }, "general", "owner");
  assert.deepEqual(base, [...INVITATION_ROLES.member], "no overwrites: channel caps equal base caps");
  // Deny steer for the Member role in #general.
  roles.setChannelOverwrites("commons", "general", member.id,
    [{ capability: "steer", effect: "deny" }], "owner");
  let channel = roles.channelCapabilities("commons", { id: "m2", permissions: [...INVITATION_ROLES.member] }, "general", "owner");
  assert.ok(!channel.includes("steer"), "deny removes the capability in that channel");
  assert.ok(channel.includes("accept_work"), "other capabilities survive");
  // Another channel is unaffected.
  const other = roles.channelCapabilities("commons", { id: "m2", permissions: [...INVITATION_ROLES.member] }, "random", "owner");
  assert.deepEqual(other, [...INVITATION_ROLES.member]);
  // Allow can grant a capability the role lacks...
  roles.setChannelOverwrites("commons", "general", member.id,
    [{ capability: "steer", effect: "deny" }, { capability: "write_external", effect: "allow" }], "owner");
  channel = roles.channelCapabilities("commons", { id: "m2", permissions: [...INVITATION_ROLES.member] }, "general", "owner");
  assert.ok(channel.includes("write_external"), "allow grants in that channel");
  // ...but deny wins when both target the same capability.
  roles.setChannelOverwrites("commons", "general", member.id,
    [{ capability: "steer", effect: "deny" }, { capability: "steer", effect: "allow" }], "owner");
  channel = roles.channelCapabilities("commons", { id: "m2", permissions: [...INVITATION_ROLES.member] }, "general", "owner");
  assert.ok(!channel.includes("steer"), "deny wins over allow for the same capability");
  // The room owner bypasses every overwrite.
  const ownerCaps = roles.channelCapabilities("commons", { id: "owner", permissions: [] }, "general", "owner");
  assert.deepEqual(ownerCaps, [...PERMISSIONS], "owner keeps every capability in every channel");
});

test("effectiveCapabilities falls back to the stored snapshot for members with no roles", t => {
  const { roles } = fixture(t);
  roles.ensureRoomRoles("commons");
  const custom = { id: "m9", permissions: ["steer", "verify"] };
  assert.deepEqual(roles.effectiveCapabilities("commons", custom, "owner"), ["steer", "verify"],
    "role-less members keep their exact snapshot: backward compatible");
  const member = roleByName(roles, DEFAULT_ROLE_NAMES.moderator);
  roles.assignRole("commons", member.id, "m9", "owner");
  assert.deepEqual(roles.effectiveCapabilities("commons", custom, "owner"), [...INVITATION_ROLES.moderator],
    "once a role is assigned, the role union governs");
  assert.deepEqual(roles.effectiveCapabilities("commons", { id: "owner", permissions: [] }, "owner"), [...PERMISSIONS],
    "owner always resolves to the full capability set");
});

test("invite preset names map to their default roles", t => {
  const { roles } = fixture(t);
  roles.ensureRoomRoles("commons");
  assert.equal(roles.defaultRoleIdForPreset("commons", "moderator"), roleByName(roles, DEFAULT_ROLE_NAMES.moderator).id);
  assert.equal(roles.defaultRoleIdForPreset("commons", "member"), roleByName(roles, DEFAULT_ROLE_NAMES.member).id);
  assert.equal(roles.defaultRoleIdForPreset("commons", "guest"), roleByName(roles, DEFAULT_ROLE_NAMES.guest).id);
  assert.equal(roles.defaultRoleIdForPreset("commons", "nope"), null);
});

test("roles list in hierarchy order for display", t => {
  const { roles } = fixture(t);
  roles.ensureRoomRoles("commons");
  roles.createRole("commons", { name: "Helper", rank: 150, capabilities: ["verify"] }, "owner");
  const names = roles.listRoles("commons").map(r => r.name);
  assert.deepEqual(names, [DEFAULT_ROLE_NAMES.moderator, DEFAULT_ROLE_NAMES.member, "Helper", DEFAULT_ROLE_NAMES.guest]);
});

// Test-audit gate:
// 1. Behavior: setMemberRole writes the role-union through to the member's
//    stored permission bits via the member.access_changed command — the
//    bits stay the enforcement substrate.
// 2. Credible regression: assignment updates the role rows but never the
//    bits, so roles silently stop governing anything enforcement reads.
// 3. Existing coverage: the service tests cover union computation only;
//    nothing else exercises the bit write-through.
// 4. No test-only seams: public store.command path with a real owner key.
test("setMemberRole writes the role union through to the member permission bits", t => {
  const { store, roles, ownerId } = fixture(t);
  roles.ensureRoomRoles("commons");
  const ownerKey = store.issueAccessKey("commons", ownerId);
  const addMember = (memberId, permissions) => store.command(ownerKey, "commons", {
    id: randomUUID(), type: T.MEMBER_ADDED, data: { memberId, displayName: memberId, kind: "human", permissions },
  });
  addMember("m2", ["accept_work"]);
  addMember("m3", ["steer"]);

  const memberRole = roleByName(roles, DEFAULT_ROLE_NAMES.member);
  const before = store.room("commons");
  const result = store.setMemberRole(ownerKey, "commons", { roleId: memberRole.id, memberId: "m2", assign: true });
  assert.deepEqual(result.permissions, [...INVITATION_ROLES.member]);
  const after = store.room("commons").state.members.m2;
  assert.deepEqual(after.permissions, [...INVITATION_ROLES.member],
    "the stored permission bits follow the role union");
  assert.ok(after.revision > before.state.members.m2.revision, "a member.access_changed event advanced the revision");
  assert.ok(result.sequence > before.sequence, "the write-through command appended an event");

  // Unassigning the last role keeps the snapshot (no wipe of the bits).
  const unassigned = store.setMemberRole(ownerKey, "commons", { roleId: memberRole.id, memberId: "m2", assign: false });
  assert.deepEqual(unassigned.permissions, [...INVITATION_ROLES.member]);
  assert.deepEqual(store.room("commons").state.members.m2.permissions, [...INVITATION_ROLES.member]);

  // A member without manage_members cannot manage roles.
  const m3Key = store.issueAccessKey("commons", "m3");
  assert.throws(
    () => store.setMemberRole(m3Key, "commons", { roleId: memberRole.id, memberId: "m2", assign: true }),
    error => error.code === "access_denied",
    "role management needs manage_members");
  assert.deepEqual(store.room("commons").state.members.m2.permissions, [...INVITATION_ROLES.member],
    "the refused call changed nothing");
});
