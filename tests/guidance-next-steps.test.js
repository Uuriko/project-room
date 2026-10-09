// Guidance next-steps: the frozen action cards returned in `next` by
// presence(), capabilities() and workSessions(). The three builders share a
// single-item-or-empty shape; this pins both branches so the shape survives
// simplification.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

function fixture(t, now = () => Date.now()) {
  const directory = mkdtempSync(join(tmpdir(), "room-guidance-next-"));
  const dbPath = join(directory, "room.sqlite");
  const store = new RoomStore(dbPath, { now });
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, ownerKey, dbPath };
}

test("presence next: watcher online, then nobody live", t => {
  const { store, ownerKey, dbPath } = fixture(t);
  // A watcher is online -> DM them directly.
  assert.deepEqual(store.presence(ownerKey, "commons", ["owner"]).next, [{
    action: "dm-member",
    method: "POST",
    path: "/api/rooms/commons/commands",
    description: 'DM a member directly: send { id: <uuid>, type: "message.posted", data: { messageId: <uuid>, body: "hello", toMemberId: "owner" } }. Send your identity secret as the Bearer token.',
  }]);
  // Ten minutes later nobody is inside the live window -> the empty-state note.
  // (The first handle stays open; WAL allows the second open for reads.)
  const later = new RoomStore(dbPath, { now: () => Date.now() + 10 * 60 * 1000 });
  t.after(() => later.close());
  assert.deepEqual(later.presence(ownerKey, "commons", []).next, [{
    action: "watch-presence",
    description: "Nobody is online right now. Presence lists online members and who is holding work sessions.",
  }]);
});

test("capabilities next: nobody advertises, then an agent does", t => {
  const { store, ownerKey } = fixture(t);
  assert.deepEqual(store.capabilities(ownerKey, "commons").next, [{
    action: "advertise-capabilities",
    description: "No members advertise capabilities yet. Members publish theirs with the capabilities.advertised command.",
  }]);
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "agent", displayName: "agent", kind: "agent", permissions: ["accept_work", "complete_work"] } });
  const agentKey = store.issueAccessKey("commons", "agent");
  store.command(agentKey, "commons", { id: randomUUID(), type: T.CAPABILITIES_ADVERTISED, data: { capabilities: ["web-research"] } });
  assert.deepEqual(store.capabilities(ownerKey, "commons").next, [{
    action: "delegate-work",
    method: "POST",
    path: "/api/rooms/commons/collab/assignments",
    description: 'Assign a thread to agent: send { threadId: "<thread>", assignee: { kind: "agent", id: "agent" } }. Send your identity secret as the Bearer token.',
  }]);
});

test("workSessions next: no sessions, then a queued session", t => {
  const { store, ownerKey } = fixture(t);
  assert.deepEqual(store.workSessions(ownerKey, "commons").next, [{
    action: "register-work-item",
    method: "POST",
    path: "/api/rooms/commons/work-claims",
    description: 'No work sessions are open. Register a work item first: POST { id: "<slug>", title: "<task>", note: "<context>" } to this path, then claim it with the claim-session action above.',
  }]);
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "agent", displayName: "agent", kind: "agent", permissions: ["accept_work", "complete_work"] } });
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.WORK_PROPOSED, data: {
    workItemId: "probe-task", title: "Probe", definitionOfDone: "Claimed in the test",
    accountableMemberId: "agent", mode: "read" } });
  const sessions = store.workSessions(ownerKey, "commons");
  assert.equal(sessions.sessions.length, 1);
  const revision = sessions.sessions[0].revision ?? 0;
  assert.deepEqual(sessions.next, [{
    action: "claim-session",
    method: "POST",
    path: "/api/rooms/commons/work-sessions",
    description: `Claim "probe-task": send { requestId: "<uuid>", workItemId: "probe-task", expectedRevision: ${revision}, action: "set_status", status: "processing" }. Send your identity secret as the Bearer token.`,
  }]);
});
