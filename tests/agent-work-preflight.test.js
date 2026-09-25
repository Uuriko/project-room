import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { auditRecovery } from "../server/recovery.mjs";
import { readPreparation, inspectCheckout, needsReview } from "../scripts/agent-work-preflight.mjs";

test("preparation reads every real discussion page without writing or exposing the connection", async t => {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(done => server.close(done));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  let at = Date.now();
  f.store.now = () => at;
  for (let n = 0; n < 56; n++) {
    at += 2000;
    f.store.command(f.keys.owner, "commons", {
      id: randomUUID(), type: "message.posted", data: { messageId: `prep-${n}`, body: `Context ${n}`, workItemId: "test-handoff" },
    });
  }
  const client = new RoomAgentClient({ version: 1, origin: `http://127.0.0.1:${server.address().port}`,
    roomId: "commons", memberId: "producer", token: f.keys.producer });
  const before = auditRecovery(f.store).dataSha256;
  const result = await readPreparation(client, "test-handoff");
  assert.equal(result.discussion.items.filter(row => row.message.id.startsWith("prep-")).length, 56);
  assert.equal(result.changedDuringRead, false);
  assert.equal(result.eventsAfterDiscussion, false);
  assert.equal(auditRecovery(f.store).dataSha256, before);
  assert.equal(JSON.stringify(result).includes(f.keys.producer), false);
  assert.deepEqual((await readPreparation(client, "test-handoff", result.discussion.checkpoint)).discussion.items, []);
});

test("changed task and later events are reported, while a stuck cursor refuses a partial brief", async () => {
  let reads = 0;
  const client = {
    workContext: async () => ({ work: { revision: reads++ }, evaluatedThrough: reads === 1 ? 4 : 6 }),
    workDiscussion: async () => ({ discussion: { items: [], hasMore: false, checkpoint: 4 } }),
  };
  const result = await readPreparation(client, "work");
  assert.equal(result.changedDuringRead, true);
  assert.equal(result.eventsAfterDiscussion, true);
  client.workDiscussion = async () => ({ discussion: { items: [], hasMore: true, nextCursor: "stuck" } });
  await assert.rejects(readPreparation(client, "work"), /did not advance/);
  await assert.rejects(readPreparation(client, "work", -1), /Invalid checkpoint/);
});

test("checkout review fails closed for remote uncertainty, drift, dirty trees and failed guard", () => {
  const sha = "a".repeat(40), calls = [];
  let remoteStatus = 0, ancestryStatus = 0, dirty = false, guardStatus = 0;
  const run = (program, args) => {
    calls.push([program, ...args]);
    if (program !== "git") return { status: guardStatus, stdout: "" };
    if (args[0] === "rev-parse") return { status: 0, stdout: sha + "\n" };
    if (args[0] === "ls-remote") return { status: remoteStatus, stdout: sha + "\trefs/heads/main\n" };
    if (args[0] === "merge-base") return { status: ancestryStatus, stdout: "" };
    if (args[0] === "status") return { status: 0, stdout: dirty ? " M example.js\n" : "" };
    throw new Error("Unexpected command");
  };
  assert.equal(needsReview({}, inspectCheckout("/repo", run)), false);
  remoteStatus = 1;
  assert.equal(inspectCheckout("/repo", run).mainRelationship, "unknown");
  assert.equal(needsReview({}, inspectCheckout("/repo", run)), true);
  remoteStatus = 0; ancestryStatus = 128;
  assert.equal(inspectCheckout("/repo", run).mainRelationship, "fetch-needed");
  ancestryStatus = 1;
  assert.equal(inspectCheckout("/repo", run).mainRelationship, "behind-or-diverged");
  ancestryStatus = 0; dirty = true;
  assert.equal(needsReview({}, inspectCheckout("/repo", run)), true);
  dirty = false; guardStatus = 1;
  assert.equal(needsReview({}, inspectCheckout("/repo", run)), true);
  assert.ok(calls.every(call => !["fetch", "push", "merge", "checkout"].includes(call[1])));
});
