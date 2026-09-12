import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-autonomy-client-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  for (const memberId of ["agent", "agent-two"]) {
    store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
      data: { memberId, displayName: memberId, kind: "agent", permissions: ["accept_work", "complete_work"] } });
  }
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.WORK_PROPOSED, data: {
    workItemId: "auto-task", title: "Autonomy probe", definitionOfDone: "Claimed through the client",
    accountableMemberId: "agent", mode: "read"
  } });
  const keys = {};
  for (const memberId of ["agent", "agent-two"]) keys[memberId] = store.issueAccessKey("commons", memberId);
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const client = memberId => new RoomAgentClient({ version: 1, origin, roomId: "commons", memberId, token: keys[memberId] });
  return { origin, client, keys };
}

test("agent client: presence, capabilities, and session claims end to end", async t => {
  const { client } = await fixture(t);
  const me = client("agent");

  // Idle at first: nobody on the roster.
  assert.deepEqual((await me.presence()).members, []);

  // Advertise and read back through the registry.
  const receipt = await me.advertiseCapabilities(["web-research", " code-review ", "web-research"]);
  assert.ok(Number.isSafeInteger(receipt.sequence));
  const registry = await me.capabilities();
  const entry = registry.members.find(row => row.memberId === "agent");
  assert.deepEqual(entry.capabilities, ["web-research", "code-review"]);

  // Local validation refuses bad lists without a network call.
  assert.throws(() => me.advertiseCapabilities([]), /1 to 30/);
  assert.throws(() => me.advertiseCapabilities(["x".repeat(81)]), /1 to 80/);

  // The proposed task surfaces as a queued session card.
  const cards = await me.workSessions();
  const card = cards.sessions.find(item => item.workItemId === "auto-task");
  assert.equal(card.status, "queued");

  // Atomic claim: queued -> processing, recorded as this worker.
  const claim = await me.claimSession("auto-task");
  assert.equal(claim.duplicate, false);
  const after = (await me.workSessions({ status: "processing" })).sessions;
  assert.equal(after[0].worker_member_id, "agent");

  // A second agent driving the same session hits structural anti-collision.
  const rival = client("agent-two");
  await assert.rejects(
    rival.workSessionAction({ requestId: randomUUID(), workItemId: "auto-task",
      expectedRevision: card.revision, action: "set_status", status: "processing" }),
    error => error.code === "session_claimed");

  // Presence now shows the worker and what they hold.
  const present = (await me.presence()).members;
  assert.equal(present.length, 1);
  assert.equal(present[0].memberId, "agent");
  assert.equal(present[0].workingOn[0].workItemId, "auto-task");

  // Claiming twice is a local no-op signal, not a server round trip.
  await assert.rejects(() => me.claimSession("auto-task"), /No queued session card/);

  // Client-side action validation.
  assert.throws(() => me.workSessionAction({ requestId: "x".repeat(43), workItemId: "auto-task",
    expectedRevision: 0, action: "delete_everything" }), /set_status or request_stop/);
});

test("agent inbox CLI exposes the autonomy primitives", async t => {
  const { origin, keys } = await fixture(t);
  const env = { ROOM_AGENT_ORIGIN: origin, ROOM_AGENT_ROOM: "commons",
    ROOM_AGENT_MEMBER: "agent", ROOM_AGENT_TOKEN: keys.agent };
  const run = async args => {
    const clean = { ...process.env };
    for (const name of Object.keys(clean)) if (name.startsWith("ROOM_AGENT_")) delete clean[name];
    try { return { ...(await promisify(execFile)(process.execPath, ["scripts/agent-inbox.mjs", ...args],
      { env: { ...clean, ...env }, encoding: "utf8", timeout: 15000 })), status: 0 }; }
    catch (error) { return { stdout: error.stdout, stderr: error.stderr, status: error.code }; }
  };
  for (const args of [["presence"], ["capabilities"], ["advertise", "web-research"], ["sessions"]]) {
    const result = await run(args);
    assert.equal(result.status, 0, `${args[0]}: ${result.stderr}`);
    assert.ok(!result.stdout.includes(keys.agent), "CLI never echoes the token");
  }
  const claimed = await run(["claim", "auto-task"]);
  assert.equal(claimed.status, 0, claimed.stderr);
  const busy = await run(["sessions", "processing"]);
  assert.equal(busy.status, 0, busy.stderr);
  assert.ok(JSON.parse(busy.stdout).sessions.some(item => item.workItemId === "auto-task" && item.worker_member_id === "agent"));
  const moved = await run(["session", "auto-task", "active"]);
  assert.equal(moved.status, 0, moved.stderr);
});
