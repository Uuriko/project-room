import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { buildRoomContext, ROOM_CONTEXT_OMITTED } from "../server/room-context.mjs";
import { EVENT_TYPES as T, PERMISSIONS } from "../src/events.js";
import { setTier } from "../server/autonomy-tiers.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { roomTools } from "../client/mcp-stdio.mjs";

const exec = promisify(execFile);
const SENTINELS = ["MESSAGE-BODY-SENTINEL", "DONE-SENTINEL", "DONE-SUMMARY-SENTINEL", "REASON-SENTINEL", "NATIVE-TEXT-SENTINEL", "SUMMARY-SENTINEL"];
const FORBIDDEN_KEYS = new Set(["body", "nativeText", "definitionOfDone", "doneSummary", "reason"]);

function walkKeys(value, found) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) { for (const item of value) walkKeys(item, found); return; }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) found.push(key);
    walkKeys(child, found);
  }
}

function assertNoBodies(value) {
  const text = JSON.stringify(value);
  for (const sentinel of SENTINELS) assert.equal(text.includes(sentinel), false, sentinel);
  const found = [];
  walkKeys(value, found);
  assert.deepEqual(found, []);
}

test("the projection keeps refs and drops message, file, and result bodies", () => {
  const now = Date.parse("2026-09-24T00:00:00.000Z");
  const state = {
    room: { id: "commons", ownerId: "owner", policy: { requireIndependentReview: true, requireOwnerDecision: false, revision: 2 } },
    members: {
      owner: { id: "owner", displayName: "Owner", kind: "human", active: true, permissions: ["steer", "decide"] },
      worker: { id: "worker", displayName: "Worker", kind: "agent", active: true, permissions: ["accept_work", "write_external"] }
    },
    messages: [{ id: "m", authorId: "owner", body: "MESSAGE-BODY-SENTINEL" }],
    workItems: {
      old: {
        id: "old", title: "Retired task", definitionOfDone: "DONE-SENTINEL", state: "superseded", revision: 2,
        mode: "read", accountableMemberId: "worker", supersededBy: "live",
        decision: { decision: "rejected", reason: "REASON-SENTINEL", actorId: "owner", eventId: "d1", completionEventId: "c1", evidenceVersion: "ev1" },
        receipt: { summary: "SUMMARY-SENTINEL", nativeText: "NATIVE-TEXT-SENTINEL", evidenceUrl: "https://example.test/result", evidenceVersion: "sha256:abc" }
      },
      live: {
        id: "live", title: "Live task", definitionOfDone: "DONE-SENTINEL", state: "working", revision: 3,
        mode: "write", accountableMemberId: "worker",
        claim: { holderId: "worker", status: "active", repository: "acme/room", ref: "main", paths: ["src/app.js"], expiresAt: "2099-01-01T00:00:00.000Z" },
        handoff: {
          open: true, eventId: "h1", at: "2026-09-24T00:00:00.000Z", actorId: "worker", triageMemberId: "owner",
          doneSummary: "DONE-SUMMARY-SENTINEL", nextAction: "Review the diff", limitReason: "context full", haltAll: false,
          evidenceUrl: "https://example.test/handoff", evidenceVersion: "hv1"
        }
      }
    }
  };
  const owner = buildRoomContext({ state, sequence: 12, viewerId: "owner", caughtUp: 4, now });
  const again = buildRoomContext({ state, sequence: 12, viewerId: "owner", caughtUp: 4, now: now + 5000 });
  assert.equal(owner.context_version, again.context_version, "the clock is not part of context_version");
  assert.notEqual(owner.evaluatedAt, again.evaluatedAt);
  assert.deepEqual(owner.omitted, [...ROOM_CONTEXT_OMITTED]);
  assert.equal(owner.handoffToYou.workItemId, "live");
  assert.equal(owner.handoffToYou.nextAction, "Review the diff");
  assert.equal(owner.handoffToYou.evidenceUrl, "https://example.test/handoff");
  assert.deepEqual(owner.deps, [{ workItemId: "old", supersededBy: "live" }]);
  assert.deepEqual(owner.decisions, [{ workItemId: "old", decision: "rejected", actorId: "owner", eventId: "d1", completionEventId: "c1", evidenceVersion: "ev1" }]);
  assert.ok(owner.focusWork.some(item => item.id === "live" && item.nextAction === "triaged_handoff" && item.nextMemberId === "owner"));
  assert.equal(owner.focusWork.some(item => item.id === "old"), false);
  assert.deepEqual(owner.policy, { requireIndependentReview: true, requireOwnerDecision: false, revision: 2 });
  assert.deepEqual(owner.cursors, { roomSequence: 12, caughtUp: 4, eventsQuery: "after", resumeAfter: 4 });
  assert.ok(owner.fileRefs.some(ref => ref.kind === "evidence" && ref.url === "https://example.test/result" && ref.record === "receipt"));
  assert.deepEqual(owner.locks.map(lock => [lock.holderId, lock.paths[0]]), [["worker", "src/app.js"]]);
  const worker = buildRoomContext({ state, sequence: 12, viewerId: "worker", caughtUp: 0, now });
  assert.equal(worker.handoffToYou, null);
  assert.deepEqual(worker.locks.map(lock => lock.workItemId), ["live"]);
  assert.deepEqual(worker.locks[0].paths, ["src/app.js"]);
  assert.ok(worker.focusWork.some(item => item.id === "live"));
  assert.notEqual(worker.context_version, owner.context_version);
  for (const view of [owner, worker]) assertNoBodies(view);
  owner.roster[0].displayName = "mutated";
  assert.equal(buildRoomContext({ state, sequence: 12, viewerId: "owner", caughtUp: 4, now }).roster.find(member => member.id === "owner").displayName, "Owner");
});

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-context-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  const send = (token, type, data, id = randomUUID()) => store.command(token, "commons", { id, type, data });
  send(ownerKey, T.MEMBER_ADDED, { memberId: "worker", displayName: "Worker", kind: "agent", permissions: ["accept_work", "write_external", "complete_work"] });
  // Graduated autonomy tiers: the fixture agent is operator-promoted so the
  // room-context test exercises it as a working agent.
  setTier(store.db, "commons", "worker", "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  const workerKey = store.issueAccessKey("commons", "worker");
  send(ownerKey, T.ROOM_POLICY_SET, { requireIndependentReview: true, requireOwnerDecision: false });
  send(ownerKey, T.MESSAGE_POSTED, { messageId: "secret-note", body: "MESSAGE-BODY-SENTINEL" });
  send(ownerKey, T.WORK_PROPOSED, {
    workItemId: "live", title: "Live task", definitionOfDone: "DONE-SENTINEL", accountableMemberId: "worker",
    verifierMemberId: "owner", mode: "write"
  });
  send(workerKey, T.WORK_ACCEPTED, { workItemId: "live", expectedRevision: 0 });
  send(workerKey, T.CLAIM_ACQUIRED, {
    workItemId: "live", expectedRevision: 1, repository: "acme/room", ref: "main", paths: ["src/app.js"],
    expiresAt: new Date(Date.now() + 86400000).toISOString()
  });
  send(workerKey, T.WORK_HANDOFF_RECORDED, {
    workItemId: "live", expectedRevision: 2, doneSummary: "DONE-SUMMARY-SENTINEL", nextAction: "Review the diff", limitReason: "context full"
  });
  send(ownerKey, T.WORK_PROPOSED, {
    workItemId: "old", title: "Retired task", definitionOfDone: "DONE-SENTINEL", accountableMemberId: "worker",
    verifierMemberId: "owner", mode: "read"
  });
  send(ownerKey, T.WORK_PROPOSED, {
    workItemId: "replacement", title: "Replacement task", definitionOfDone: "DONE-SENTINEL", accountableMemberId: "owner", verifierMemberId: "worker", mode: "read"
  });
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const request = (path, token) => fetch(origin + path, { headers: { Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  return { store, ownerKey, workerKey, send, origin, request };
}

test("get_room_context is not_modified when unchanged and never carries bodies", async t => {
  const f = await serve(t);
  const tool = roomTools.find(entry => entry.name === "get_room_context");
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.equal([...PERMISSIONS].includes("steer"), true);

  const anonymous = await f.request("/api/rooms/commons/context");
  assert.equal(anonymous.status, 401);
  const bad = await f.request("/api/rooms/commons/context?since_version=nope", f.ownerKey);
  assert.equal(bad.status, 422);
  assert.equal((await bad.json()).error.code, "invalid_context_version");
  const extra = await f.request("/api/rooms/commons/context?since_version=aa&limit=1", f.ownerKey);
  assert.equal(extra.status, 422);

  const owner = await (await f.request("/api/rooms/commons/context", f.ownerKey)).json();
  assertNoBodies(owner);
  assert.equal(owner.not_modified, undefined);
  assert.equal(owner.handoffToYou.workItemId, "live");
  assert.equal(owner.handoffToYou.nextAction, "Review the diff");
  assert.equal(owner.cursors.eventsQuery, "after");
  assert.equal(owner.cursors.resumeAfter, 0);
  assert.equal(owner.policy.requireIndependentReview, true);
  assert.ok(owner.roster.some(member => member.id === "worker" && member.kind === "agent"));
  assert.ok(owner.focusWork.some(item => item.id === "live" && item.title === "Live task"));
  assert.equal(owner.deps.length, 0);

  const workerClient = new RoomAgentClient({ origin: f.origin, roomId: "commons", token: f.workerKey, memberId: "worker" });
  const worker = await workerClient.roomContext();
  assert.equal(worker.viewerId, "worker");
  assert.equal(worker.handoffToYou, null);
  assert.deepEqual(worker.locks.map(lock => [lock.workItemId, lock.paths]), [["live", ["src/app.js"]]]);
  assert.ok(worker.focusWork.some(item => item.id === "old" && item.nextAction === "accept"));
  assertNoBodies(worker);

  const same = await workerClient.roomContext({ sinceVersion: worker.context_version });
  assert.equal(same.not_modified, true);
  assert.equal(same.context_version, worker.context_version);
  assert.equal(same.roomId, "commons");
  assert.equal(same.viewerId, "worker");
  assert.equal(Object.hasOwn(same, "roster"), false);
  assert.equal(Object.hasOwn(same, "focusWork"), false);
  assert.equal(Object.hasOwn(same, "locks"), false);
  assertNoBodies(same);

  const sequence = f.store.room("commons").sequence;
  f.store.markCaughtUp(f.workerKey, "commons", sequence);
  const moved = await workerClient.roomContext({ sinceVersion: worker.context_version });
  assert.equal(moved.not_modified, undefined);
  assert.equal(moved.cursors.resumeAfter, sequence);
  assert.equal(moved.cursors.eventsQuery, "after");
  assert.notEqual(moved.context_version, worker.context_version);

  f.send(f.ownerKey, T.MESSAGE_POSTED, { messageId: "later", body: "MESSAGE-BODY-SENTINEL" });
  const afterMessage = await (await f.request("/api/rooms/commons/context", f.ownerKey)).json();
  assert.notEqual(afterMessage.context_version, owner.context_version);
  assert.ok(afterMessage.cursors.roomSequence > owner.cursors.roomSequence);
  assertNoBodies(afterMessage);

  f.send(f.ownerKey, T.WORK_SUPERSEDED, { workItemId: "old", expectedRevision: 0, supersededByWorkItemId: "replacement", reason: "REASON-SENTINEL" });
  const afterDep = f.store.roomContext(f.ownerKey, "commons", {});
  assert.deepEqual(afterDep.deps, [{ workItemId: "old", supersededBy: "replacement" }]);
  assertNoBodies(afterDep);

  const cli = await exec(process.execPath, ["scripts/agent-inbox.mjs", "context"], {
    env: { PATH: process.env.PATH, ROOM_AGENT_ORIGIN: f.origin, ROOM_AGENT_ROOM: "commons", ROOM_AGENT_TOKEN: f.ownerKey },
    timeout: 15000
  });
  const printed = JSON.parse(cli.stdout);
  assert.equal(cli.stderr, "");
  assert.equal(printed.handoffToYou.workItemId, "live");
  assert.equal(printed.cursors.eventsQuery, "after");
  assertNoBodies(printed);
  const quiet = await exec(process.execPath, ["scripts/agent-inbox.mjs", "context", printed.context_version], {
    env: { PATH: process.env.PATH, ROOM_AGENT_ORIGIN: f.origin, ROOM_AGENT_ROOM: "commons", ROOM_AGENT_TOKEN: f.ownerKey },
    timeout: 15000
  });
  const unmodified = JSON.parse(quiet.stdout);
  assert.equal(unmodified.not_modified, true);
  assert.equal(unmodified.context_version, printed.context_version);
  assert.equal(Object.hasOwn(unmodified, "roster"), false);
});
