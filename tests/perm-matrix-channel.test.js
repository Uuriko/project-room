// Permission matrix for room channels (200-hard-tasks #88).
//
// Owner boundary: the event reducer in src/events.js (createChannel /
// renameChannel / archiveChannel), which the HTTP /commands path funnels
// through. docs/openapi.yaml "Room channels (Phase 2)" is the documented
// contract under test:
//
//   - channel.created: ANY active member may create (owner, member, guest,
//     agent). Revoked members (active === false) may not.
//   - channel.renamed: owner-only. `general` cannot be renamed.
//   - channel.archived: owner-only. `general` cannot be archived.
//   - Archived channels reject new messages (409 channel_archived).
//
// tests/room-channels.test.js covers owner-vs-one-member lifecycle; this file
// is the full role x action matrix (guest and agent roles, revoked members,
// and the `general` protections it does not cover).
import test from "node:test";
import assert from "node:assert/strict";
import {
  EVENT_TYPES as T, DEFAULT_CHANNEL_ID, applyEvent, replay
} from "../src/events.js";
import { seedEvents } from "../src/seed.js";

const ROOM_ID = "room-project-room-v0";
const GUEST_ID = "guest-9f3a2b1c-4d5e-6f7a-8b9c-0d1e2f3a4b5c"; // link guest, [] permissions
const ROLES = ["potter", "maya", GUEST_ID, "codex", "riv"]; // owner, member, guest, agent, revoked
const roleName = id => ({ potter: "owner", maya: "member", [GUEST_ID]: "guest", codex: "agent", riv: "revoked" }[id]);

let n = 0;
const evt = (type, actorId, data) => {
  n += 1;
  const ss = String(n % 60).padStart(2, "0");
  const mm = String(11 + Math.floor(n / 60)).padStart(2, "0");
  return {
    id: `pm-${n}`, idempotencyKey: `pm-key-${n}`, roomId: ROOM_ID,
    type, actorId, at: `2026-09-05T${mm}:${ss}:00.000Z`,
    causationId: null, data
  };
};

// seedEvents gives: potter (owner, human), maya (member, human),
// codex (agent). Add a guest ([] permissions) and a revoked member.
function roomWithRoles() {
  let state = replay(seedEvents);
  state = applyEvent(state, evt(T.MEMBER_ADDED, "potter", {
    memberId: GUEST_ID, displayName: "Link Guest", kind: "human", permissions: []
  }));
  state = applyEvent(state, evt(T.MEMBER_ADDED, "potter", {
    memberId: "riv", displayName: "Riv", kind: "human",
    permissions: ["accept_work", "complete_work", "verify"]
  }));
  const riv = state.members.riv;
  state = applyEvent(state, evt(T.MEMBER_ACCESS_CHANGED, "potter", {
    memberId: "riv", expectedMemberRevision: riv.revision,
    permissions: riv.permissions, active: false
  }));
  return state;
}

const ok = (state, type, actorId, data) =>
  applyEvent(state, evt(type, actorId, data));

const denied = (state, type, actorId, data, why) => {
  assert.throws(() => applyEvent(state, evt(type, actorId, data)), why,
    `${roleName(actorId)} must be denied ${type}: ${JSON.stringify(data)}`);
};

test("matrix: create — any active member may create; revoked may not", () => {
  for (const actorId of ROLES) {
    const state = roomWithRoles();
    const data = { channelId: `pm-ch-${roleName(actorId)}`, name: `perm-${roleName(actorId)}` };
    if (actorId === "riv") {
      denied(state, T.CHANNEL_CREATED, actorId, data, /revoked|Member access/i);
    } else {
      const next = ok(state, T.CHANNEL_CREATED, actorId, data);
      assert.ok(next.channels[data.channelId], `${roleName(actorId)} created a channel`);
    }
  }
});

test("matrix: rename — owner-only", () => {
  for (const actorId of ROLES) {
    let state = roomWithRoles();
    state = ok(state, T.CHANNEL_CREATED, "potter", { channelId: "pm-design", name: "design" });
    const data = { channelId: "pm-design", name: `renamed-by-${roleName(actorId)}` };
    if (actorId === "potter") {
      const next = ok(state, T.CHANNEL_RENAMED, actorId, data);
      assert.equal(next.channels["pm-design"].name, `renamed-by-${roleName(actorId)}`);
    } else {
      denied(state, T.CHANNEL_RENAMED, actorId, data, actorId === "riv" ? /Member access revoked/ : /Only the Room owner/);
    }
  }
});

test("matrix: archive — owner-only", () => {
  for (const actorId of ROLES) {
    let state = roomWithRoles();
    state = ok(state, T.CHANNEL_CREATED, "potter", { channelId: "pm-design", name: "design" });
    if (actorId === "potter") {
      const next = ok(state, T.CHANNEL_ARCHIVED, actorId, { channelId: "pm-design" });
      assert.ok(next.channels["pm-design"].archivedAt, "archived");
    } else {
      denied(state, T.CHANNEL_ARCHIVED, actorId, { channelId: "pm-design" }, actorId === "riv" ? /Member access revoked/ : /Only the Room owner/);
    }
  }
});

test("matrix: `general` cannot be renamed by anyone, including the owner", () => {
  for (const actorId of ROLES) {
    const state = roomWithRoles();
    const why = actorId === "potter" ? /can't be renamed/ : /Only the Room owner|can't be renamed|Member access revoked/;
    denied(state, T.CHANNEL_RENAMED, actorId, { channelId: DEFAULT_CHANNEL_ID, name: "town-square" }, why);
  }
});

test("matrix: `general` cannot be archived by anyone, including the owner", () => {
  for (const actorId of ROLES) {
    const state = roomWithRoles();
    const why = actorId === "potter" ? /can't be archived/ : /Only the Room owner|can't be archived|Member access revoked/;
    denied(state, T.CHANNEL_ARCHIVED, actorId, { channelId: DEFAULT_CHANNEL_ID }, why);
  }
});

test("matrix: archived channels reject new messages from every role", () => {
  let state = roomWithRoles();
  state = ok(state, T.CHANNEL_CREATED, "potter", { channelId: "pm-design", name: "design" });
  state = ok(state, T.CHANNEL_ARCHIVED, "potter", { channelId: "pm-design" });
  for (const actorId of ["potter", "maya", GUEST_ID, "codex"]) {
    assert.throws(
      () => applyEvent(state, evt(T.MESSAGE_POSTED, actorId, { body: "hello", channelId: "pm-design" })),
      /archived/,
      `${roleName(actorId)} must not post into an archived channel`);
  }
});
