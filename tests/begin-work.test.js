import test from "node:test";
import assert from "node:assert/strict";
import { beginRequestId, beginSelectedWork, planBegin } from "../client/begin-work.mjs";
import { roomTools, validRoomToolArguments } from "../client/mcp-stdio.mjs";
import { HOSTED_ROOM_MCP_TOOLS } from "../src/room-mcp-join.js";

const member = { id: "producer", active: true, permissions: ["accept_work", "complete_work"] };
const scope = { repository: "Uuriko/project-room", ref: "grok/together-begin-20260925", paths: ["src/workflow.js"], expiresAt: "2026-09-26T00:00:00.000Z" };

test("Begin keeps a stable request id and does not call a disconnected host working", async () => {
  let reads = 0, writes = 0;
  const disconnected = await beginSelectedWork({
    connected: false,
    read: async () => { reads += 1; return null; },
    execute: async () => { writes += 1; return { status: "recorded" }; }
  });
  assert.equal(disconnected.working, false);
  assert.equal(disconnected.stopped, "disconnected");
  assert.equal(disconnected.invented, false);
  assert.equal(reads, 0);
  assert.equal(writes, 0);
  const id = beginRequestId("work", "room_start_work", 2);
  assert.equal(beginRequestId("work", "room_start_work", 2), id);
  assert.notEqual(beginRequestId("work", "room_start_work", 3), id);
});

test("Begin accepts then starts read work only after the start read confirms working", async () => {
  const states = [
    { work: { id: "work", state: "proposed", mode: "read", revision: 0, accountableMemberId: "producer" }, viewer: member },
    { work: { id: "work", state: "accepted", mode: "read", revision: 1, accountableMemberId: "producer" }, viewer: member },
    { work: { id: "work", state: "working", mode: "read", revision: 2, accountableMemberId: "producer" }, viewer: member }
  ];
  const calls = [];
  const result = await beginSelectedWork({
    connected: true,
    read: async () => states[Math.min(calls.length, states.length - 1)],
    execute: async stage => {
      calls.push(stage);
      return { status: "recorded", eventId: `evt-${calls.length}` };
    }
  });
  assert.deepEqual(calls.map(stage => stage.action), ["room_accept_work", "room_start_work"]);
  assert.equal(calls[0].requestId, beginRequestId("work", "room_accept_work", 0));
  assert.equal(calls[1].args.expectedRevision, 1);
  assert.equal(result.working, true);
  assert.equal(result.stopped, null);
  assert.equal(result.invented, false);
  assert.equal(result.confirmed.length, 2);
});

test("an unknown start keeps the same request id and does not mark the host working", async () => {
  const item = { id: "work", state: "accepted", mode: "read", revision: 2, accountableMemberId: "producer" };
  const result = await beginSelectedWork({
    connected: true,
    read: async () => ({ work: item, viewer: member }),
    execute: async () => ({ status: "unconfirmed" })
  });
  assert.equal(result.working, false);
  assert.equal(result.stopped, "unknown");
  assert.equal(result.invented, false);
  assert.equal(result.confirmed.length, 0);
  assert.equal(result.resume.requestId, beginRequestId("work", "room_start_work", 2));
  assert.equal(result.resume.args.expectedRevision, 2);
});

test("write work without an exact scope does not start", async () => {
  const writer = { ...member, permissions: [...member.permissions, "write_external"] };
  const item = { id: "work", state: "accepted", mode: "write", revision: 3, accountableMemberId: "producer", claim: null };
  const plan = planBegin(item, writer, {});
  assert.equal(plan.reason, "exact_scope_required");
  assert.equal(plan.stage, null);
  let writes = 0;
  const result = await beginSelectedWork({
    connected: true,
    read: async () => ({ work: item, viewer: writer }),
    execute: async () => { writes += 1; return { status: "recorded" }; }
  });
  assert.equal(writes, 0);
  assert.equal(result.working, false);
  assert.equal(result.stopped, "exact_scope_required");
  assert.deepEqual(result.resume.needs, ["repository", "ref", "paths", "expiresAt"]);
  const claimed = planBegin(item, writer, { scope });
  assert.equal(claimed.stage.action, "room_acquire_claim");
  assert.deepEqual(claimed.stage.args.paths, scope.paths);
});

test("room_begin_work is a hosted tool and rejects a guessed extra field", async () => {
  await import("../server/mcp-hosted-tools.mjs");
  const tool = roomTools.find(entry => entry.name === "room_begin_work");
  assert.equal(tool.annotations.destructiveHint, true);
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.doesNotMatch(tool.description, /Checks this host/);
  assert.match(tool.description, /Room work state/);
  assert.match(tool.description, /does not invoke Begin/);
  assert.equal(validRoomToolArguments("room_begin_work", { workItemId: "together-begin-20260925", invocationRequestId: "begin-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }), true);
  assert.equal(HOSTED_ROOM_MCP_TOOLS.includes("room_begin_work"), true);
  assert.equal(validRoomToolArguments("room_begin_work", { workItemId: "together-begin-20260925" }), true);
  assert.equal(validRoomToolArguments("room_begin_work", { workItemId: "together-begin-20260925", repository: "Uuriko/project-room" }), true);
  assert.equal(validRoomToolArguments("room_begin_work", { workItemId: "together-begin-20260925", token: "nope" }), false);
});
