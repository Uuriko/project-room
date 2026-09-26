// Issue #996: admin-class routes held by non-owner agents skip the
// t1_readonly gate — a demoted agent with invite_member/manage_members
// grants could still mint invites (and decide access / create share links).
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { demoteToReadonly } from "../server/autonomy-tiers.mjs";

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "admin-tier-"));
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => Date.parse("2026-09-26T12:00:00Z") });
  store.initialize(initialRoom("commons"));
  const keys = { owner: store.issueAccessKey("commons", "owner") };
  const send = (actor, type, data, id = randomUUID()) => store.command(keys[actor], "commons", { id, type, data });
  send("owner", T.MEMBER_ADDED, { memberId: "agent", displayName: "Delegated agent", kind: "agent", permissions: ["invite_member", "manage_members", "accept_work"], accountableHumanId: "owner" });
  keys.agent = store.issueAccessKey("commons", "agent");
  const demote = memberId => demoteToReadonly(store.db, "commons", memberId, { updatedBy: "owner", nowMs: Date.now() });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, keys, demote };
}

const capture = fn => { try { fn(); } catch (error) { return error; } throw new Error("expected the function to throw"); };

test("t2_standard agent with invite grant can mint invites", t => {
  const f = setup(t);
  const invite = f.store.invites.create(f.keys.agent, "commons", { permissions: ["accept_work"], displayName: "Peer" }, null);
  assert.ok(invite, "granted t2 agent should create invites");
});

test("t1_readonly agent with invite grant cannot mint invites", t => {
  const f = setup(t);
  f.demote("agent");
  const refused = capture(() => f.store.invites.create(f.keys.agent, "commons", { permissions: ["accept_work"], displayName: "Peer" }, null));
  assert.equal(refused.status, 403);
  assert.equal(refused.code, "agent_readonly");
});

test("owner is exempt from the tier gate on invites", t => {
  const f = setup(t);
  const invite = f.store.invites.create(f.keys.owner, "commons", { permissions: ["accept_work"], displayName: "Peer" }, null);
  assert.ok(invite, "owner should always create invites");
});
