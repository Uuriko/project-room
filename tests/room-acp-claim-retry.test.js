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
    bridge.me = { id: bridge.connection.memberId }; bridge.ownerId = "owner"; bridge.members = { owner: { kind: "human", active: true } };
    bridge.fencingToken = "test-listener";
    bridge.room.checkListener = async () => ({ listener: { valid: true } });
    bridge.room.room = async () => ({ state: { room: { ownerId: "owner" }, members: { owner: { id: "owner", kind: "human", active: true }, [bridge.connection.memberId]: { id: bridge.connection.memberId, active: true } } } });
    bridge.room.claim = async () => ({ id: "work", owner: bridge.connection.memberId, history: [{ action: "created", agentId: "owner" }] });
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

test("fresh wake for a terminal claim acks and skips without a turn or note", async t => {
  const { make, counts } = setup(t);
  // First, a live claim runs exactly one turn (the census baseline: 1 -> 2 was the bug).
  let state = "claimed";
  const first = make();
  first.room.claim = async () => ({ id: "work", owner: "agent", state, history: [{ action: "created", agentId: "owner" }] });
  await deliver(first);
  assert.equal(counts.prompts, 1);
  assert.equal(counts.notes.length, 1);
  assert.equal(counts.acks, 1);
  // The claim reaches a terminal state; a FRESH signalId naming it (reassign-after-done,
  // admin re-wake, wake regeneration) must ack-and-skip, not run a second turn.
  // Same-signalId redelivery is already deduped by the TurnReceipt and is not this case.
  state = "done";
  await first.accept({ signalId: "assigned-fresh-9", workClaim: "work", reason: "assigned" });
  await first.queue.idle();
  assert.equal(counts.prompts, 1);
  assert.equal(counts.notes.length, 1);
  assert.equal(counts.acks, 2);
  assert.equal(first.stats.skipped, 1);
  // "closed" is the other terminal state in server/work-claims.mjs
  // (there is no "cancelled" claim state: cancel is a verb into "closed").
  const closedBridge = make();
  closedBridge.room.claim = async () => ({ id: "work", owner: "agent", state: "closed", history: [{ action: "created", agentId: "owner" }] });
  await closedBridge.accept({ signalId: "assigned-fresh-10", workClaim: "work", reason: "assigned" });
  await closedBridge.queue.idle();
  assert.equal(counts.prompts, 1);
  assert.equal(counts.notes.length, 1);
  assert.equal(counts.acks, 3);
  assert.equal(closedBridge.stats.skipped, 1);
});

// Acceptance is not an execution lease: a second signal can wait behind a
// running turn while a human completes or closes the claim.
for (const state of ["done", "closed"]) test(`claim becoming ${state} while queued never executes another turn`, async t => {
  const { make, counts } = setup(t);
  const bridge = make();
  let claimState = "claimed";
  bridge.room.claim = async () => ({ id: "work", owner: "agent", state: claimState, history: [{ action: "created", agentId: "owner" }] });
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  t.after(() => finish.resolve());
  bridge.host.prompt = async () => {
    counts.prompts++;
    started.resolve();
    await finish.promise;
    return { recorder: { text: "completed", tools: new Map() }, stopReason: "end_turn" };
  };
  await bridge.accept(signal);
  await started.promise;
  await bridge.accept({ ...signal, signalId: "assigned-queued" });
  claimState = state;
  finish.resolve();
  await bridge.queue.idle();
  assert.equal(counts.prompts, 1, "the queued wake must not start work on a terminal claim");
  assert.equal(counts.notes.length, 1, "the already-running turn may still deliver its result");
  assert.equal(counts.acks, 2, "both the completed turn and skipped queued wake are acknowledged");
});

for (const state of ["done", "closed"]) test(`claim becoming ${state} during session startup never executes`, async t => {
  const { make, counts } = setup(t);
  const bridge = make();
  let claimState = "claimed";
  bridge.room.claim = async () => ({ id: "work", owner: "agent", state: claimState, history: [{ action: "created", agentId: "owner" }] });
  bridge.host.session = async () => { claimState = state; return { sessionId: "s" }; };
  await deliver(bridge);
  assert.equal(counts.prompts, 0);
  assert.equal(counts.notes.length, 0);
  assert.equal(counts.acks, 1);
});

test("a skipped terminal wake retries a lost acknowledgement without executing after reopening", async t => {
  const { make, counts } = setup(t);
  const first = make();
  let state = "claimed";
  first.room.claim = async () => ({ id: "work", owner: "agent", state, history: [{ action: "created", agentId: "owner" }] });
  first.host.session = async () => { state = "done"; return { sessionId: "s" }; };
  first.room.ack = async () => { throw new Error("lost ack"); };
  await deliver(first);
  // A restart sees the retained discard receipt even if the same claim was
  // reopened. A new assignment needs a new signal, not a repeated old wake.
  await deliver(make());
  assert.equal(counts.prompts, 0);
  assert.equal(counts.notes.length, 0);
  assert.equal(counts.acks, 1);
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
