import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { Bridge } from "../room-acp/src/bridge.mjs";
import { RoomClient } from "../room-acp/src/room.mjs";
import { join } from "../room-acp/src/join.mjs";
import { startRoom } from "./room-acp-fixture.mjs";

const signal = { signalId: "assigned-1", workClaim: "work", reason: "assigned" };
function setup(t) {
  const home = mkdtempSync(pathJoin(tmpdir(), "claim-retry-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const counts = { prompts: 0, notes: [], acks: 0 };
  const make = (overrides = {}) => {
    const bridge = new Bridge({ connection: { apiBase: "http://localhost", roomId: "r", memberId: "agent", hostId: "h", ...overrides }, env: { ROOM_ACP_HOME: home }, host: {
      session: async () => ({ sessionId: "s" }),
      prompt: async () => { counts.prompts++; return { recorder: { text: "completed", tools: new Map() }, stopReason: "end_turn" }; },
    } });
    bridge.me = { id: "agent" }; bridge.ownerId = "owner"; bridge.members = { owner: { kind: "human", active: true } };
    bridge.fencingToken = "test-listener";
    bridge.room.checkListener = async () => ({ listener: { valid: true } });
    bridge.room.room = async () => ({ state: { room: { ownerId: "owner" }, members: { owner: { id: "owner", kind: "human", active: true }, [bridge.connection.memberId]: { id: "agent", active: true } } } });
    bridge.room.claim = async () => ({ id: "work", owner: "agent", history: [{ action: "created", agentId: "owner" }] });
    bridge.room.claimNote = async (...args) => { counts.notes.push(args); };
    bridge.room.ack = async () => { counts.acks++; };
    return bridge;
  };
  return { make, counts, home };
}
async function deliver(bridge) { await bridge.accept(signal); await bridge.queue.idle(); }

test("lost ack retries only ack, including after restart", async t => {
  const { make, counts } = setup(t);
  const first = make();
  first.room.ack = async () => { throw new Error("lost ack"); };
  await deliver(first);
  await deliver(first);
  await deliver(make());
  assert.equal(counts.prompts, 1);
  assert.equal(counts.notes.length, 1);
  assert.equal(counts.acks, 1);
});

test("lost result response retries identical note and request ID after restart", async t => {
  const { make, counts, home } = setup(t);
  const first = make();
  first.room.claimNote = async (...args) => { counts.notes.push(args); throw new Error("lost response"); };
  await deliver(first);
  await deliver(make());
  assert.equal(counts.prompts, 1);
  assert.equal(counts.notes.length, 2);
  assert.deepEqual(counts.notes[0], counts.notes[1]);
  assert.match(counts.notes[0][2], /^[a-z0-9-]+$/);
  const receipt = pathJoin(home, "claim-turns", readdirSync(pathJoin(home, "claim-turns"))[0]);
  assert.equal(statSync(receipt).mode & 0o777, 0o600);
});

test("interruption during execution never reruns or acknowledges uncertain work", async t => {
  const { make, counts } = setup(t);
  const first = make();
  first.host.prompt = async () => { counts.prompts++; first.stop(); throw new Error("interrupted after side effect"); };
  await deliver(first);
  await deliver(make());
  assert.equal(counts.prompts, 1);
  assert.equal(counts.notes.length, 0);
  assert.equal(counts.acks, 0);
});

test("receipts isolate origin, room and member, but survive host changes", async t => {
  const { make, counts } = setup(t);
  await deliver(make());
  await deliver(make({ hostId: "replacement-host" }));
  await deliver(make({ apiBase: "https://other.example" }));
  await deliver(make({ roomId: "other-room" }));
  await deliver(make({ memberId: "other-agent" }));
  assert.equal(counts.prompts, 4);
});

test("actual claim-note API deduplicates the stable request ID", async t => {
  const fixture = await startRoom(t);
  const connection = await join({ link: fixture.invite().link, displayName: "Retry agent", env: fixture.env });
  const client = new RoomClient(connection);
  const create = await fetch(`${fixture.origin}/api/rooms/commons/work-claims`, {
    method: "POST", headers: { authorization: `Bearer ${fixture.ownerKey}`, "content-type": "application/json" },
    body: JSON.stringify({ id: "retry-work", title: "Retry work", assignee: connection.memberId }),
  });
  assert.equal(create.status, 201);
  await client.claimNote("retry-work", "Only one result", "stable-retry-id");
  await client.claimNote("retry-work", "Only one result", "stable-retry-id");
  const claim = await client.claim("retry-work");
  assert.equal(claim.history.filter(entry => entry.note === "Only one result").length, 1);
});
