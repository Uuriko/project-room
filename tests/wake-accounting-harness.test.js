// Live-shaped wake-reliability harness (#3345; charter B-5 step 1).
//
// Drives the production surfaces end to end — real RoomStore, real HTTP
// server, REST heartbeat/poll/ack doors, the hosted MCP wake tools, room
// commands for mentions/DMs/claims/work — through one scripted
// multi-agent scenario with an exact attempt tally, then reconciles the
// accounting the fabric now emits against that tally.
//
// The measured result this harness exists to produce (printed below):
//   - fabric loss: owed attempts that errored on a swallowing path
//     (event "failed") — the class the B-5 fold kill criterion reads;
//   - addressability loss: owed attempts whose target member has no
//     identity link (suppressed_no_identity) — pre-#3266 these silently
//     became undrainable rows under the bare memberId;
//   - designed suppressions (no_host / policy) — reported, never lost.
// Every other owed attempt must end acked: emitted == acked, pending == 0.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { installFakeWebhookDns } from "./helpers/fake-webhook-dns.mjs";

const roundOf = c => ({ expectedClaimedAt: (c.claim ?? c).claimedAt,
  expectedHistoryLength: ((c.claim ?? c).history?.length ?? 0) + ((c.claim ?? c).historyOmitted ?? 0) });

async function fixture(t) {
  const store = new RoomStore(":memory:");
  installFakeWebhookDns(store);
  let at = Date.now();
  store.now = () => at;
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const owner = new RoomAgentClient({ origin, roomId: "commons", token: ownerKey });
  const enroll = name => {
    const identity = store.identities.create(name);
    store.identities.link(ownerKey, "commons", { identityId: identity.identityId,
      memberId: name, displayName: name, permissions: ["accept_work", "complete_work"] });
    return { ...identity, memberId: name };
  };
  const post = async (path, body, secret) => {
    const response = await fetch(`${origin}${path}`, { method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify(body) });
    return { status: response.status, value: await response.json() };
  };
  const poll = async secret => {
    const response = await fetch(`${origin}/api/agent-wakes/poll?hostId=host-1&waitMs=0`,
      { headers: { authorization: `Bearer ${secret}` } });
    return { status: response.status, value: await response.json() };
  };
  const mcp = async (name, args, secret) => {
    const response = await fetch(`${origin}/room/mcp`, { method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: "h", method: "tools/call", params: { name, arguments: args } }) });
    const body = await response.json();
    return body.result?.structuredContent;
  };
  const say = (body, extra = {}) => store.command(ownerKey, "commons",
    { id: randomUUID(), type: "message.posted", data: { messageId: randomUUID(), body, ...extra } });
  return { store, owner, ownerKey, enroll, post, poll, mcp, say, advance: ms => { at += ms; } };
}

test("wake fabric accounting reconciles a scripted multi-agent scenario exactly", async t => {
  const f = await fixture(t);
  const worker = f.enroll("worker");
  const reviewer = f.enroll("reviewer");
  const ghost = f.enroll("ghost");
  // The ghost keeps its membership but loses its identity link — the
  // legacy member shape whose claim wakes used to strand under memberId.
  f.store.db.prepare("DELETE FROM identity_links WHERE room_id=? AND member_id=?").run("commons", "ghost");
  void ghost;

  // Registration on the heartbeat door.
  assert.equal((await f.post("/api/agent-heartbeats", { hostId: "host-1", mode: "pull-only" }, worker.secret)).status, 200);
  assert.equal((await f.post("/api/agent-heartbeats", { hostId: "host-1", mode: "pull-only" }, reviewer.secret)).status, 200);

  // Phase A — claim wakes: lane-1 reassigned to worker (emitted), lane-2
  // created for the ghost (addressability loss, counted — no phantom row).
  await f.owner.workClaimCreate({ id: "lane-1", title: "Lane 1" });
  await f.owner.claimWorkItem("lane-1");
  await f.owner.reassignWorkItem("lane-1", { newOwner: "worker", ...roundOf(await f.owner.workClaimGet("lane-1")) });
  await f.owner.workClaimCreate({ id: "lane-2", title: "Lane 2", assignee: "ghost" });
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM agent_wake_signals WHERE agent_id='ghost'").get().n, 0,
    "no signal is addressed to the bare memberId");
  const aPoll = await f.poll(worker.secret);
  assert.equal(aPoll.value.pendingWakes.length, 1);
  assert.equal(aPoll.value.pendingWakes[0].reason, "assigned");
  const aAck = await f.post("/api/agent-heartbeats/ack", { signalIds: [aPoll.value.pendingWakes[0].signalId] }, worker.secret);
  assert.deepEqual(aAck.value.acknowledged, [aPoll.value.pendingWakes[0].signalId]);

  // Phase B — work wake: opt the host in, propose, read on heartbeat, ack.
  await f.post("/api/agent-heartbeats", { hostId: "host-1", mode: "pull-only", workWakes: true }, worker.secret);
  f.store.command(f.ownerKey, "commons", { id: randomUUID(), type: "work.proposed",
    data: { workItemId: "w1", title: "Synthetic work", definitionOfDone: "Done", mode: "read", accountableMemberId: "worker" } });
  const bBeat = await f.post("/api/agent-heartbeats", { hostId: "host-1", mode: "pull-only" }, worker.secret);
  const workWake = bBeat.value.pendingWakes.find(w => w.kind === "work");
  assert.ok(workWake, "the work wake rides the heartbeat door");
  const bAck = await f.post("/api/agent-heartbeats/ack", { signalIds: [workWake.signalId] }, worker.secret);
  assert.deepEqual(bAck.value.acknowledged, [workWake.signalId]);

  // Phase C — mention wakes worker (acked on the MCP door); DM wakes
  // reviewer (delivered on poll, acked on REST).
  f.say("please look @worker");
  const cSet = await f.mcp("heartbeat.set", { hostId: "host-1", mode: "pull-only" }, worker.secret);
  assert.equal(cSet.pendingWakes.length, 1);
  assert.equal(cSet.pendingWakes[0].kind, "mention");
  const cAck = await f.mcp("heartbeat.ack", { signalIds: [cSet.pendingWakes[0].signalId] }, worker.secret);
  assert.deepEqual(cAck.acknowledged, [cSet.pendingWakes[0].signalId]);
  f.say("a direct note", { toMemberId: "reviewer" });
  const cPoll = await f.poll(reviewer.secret);
  assert.equal(cPoll.value.pendingWakes.length, 1);
  assert.equal(cPoll.value.pendingWakes[0].kind, "dm");
  await f.post("/api/agent-heartbeats/ack", { signalIds: [cPoll.value.pendingWakes[0].signalId] }, reviewer.secret);

  // Phase D — explicit ack: worker acks its own mention signal by id.
  f.say("one more @worker");
  const dPending = f.store.agentHeartbeats.pendingWakes(worker.identityId);
  assert.equal(dPending.length, 1);
  await f.post("/api/agent-heartbeats/ack", { signalIds: [dPending[0].signalId] }, worker.secret);
  assert.equal(f.store.agentHeartbeats.pendingWakes(worker.identityId).length, 0, "the ack cleared the signal");

  // Phase E — push doorbell fault: reviewer goes stale with a dead push
  // endpoint; the mention still lands durably and acks normally after.
  f.store.agentHeartbeats.setPushTransport({
    fetchImpl: async () => ({ status: 500, headers: { get: () => null }, text: async () => "down" }),
    dnsResolvers: { resolve4: async () => ["93.184.216.34"], resolve6: async () => [] },
  });
  // Push targets are wakeable hosts only (pull-only hosts pull), so this
  // heartbeat re-registers the host as wakeable with the subscription.
  await f.post("/api/agent-heartbeats", { hostId: "host-1", mode: "wakeable",
    pushNotification: { url: "https://push.example.test/hooks/room", token: "opaque-push-token-123" } }, reviewer.secret);
  f.advance(200_000); // past the 180s reachability floor: reviewer reads offline
  f.say("urgent @reviewer");
  await f.store.agentHeartbeats.flushPushes();
  const eBeat = await f.post("/api/agent-heartbeats", { hostId: "host-1", mode: "pull-only" }, reviewer.secret);
  // WAKE0-1: reviewer is wakeable-with-push and stale, so the mention
  // also emits a wake intent — the page carries mention + intent (2).
  assert.equal(eBeat.value.pendingWakes.length, 2, "the durable signal survived the dead doorbell");
  await f.post("/api/agent-heartbeats/ack", { signalIds: eBeat.value.pendingWakes.map(w => w.signalId) }, reviewer.secret);

  // Phase F — truncation parity at 55 pending, then ack-and-repeat drain.
  // (Posts are spread in fake time: the chat flood guard is real and a
  // same-instant burst of 55 is exactly what it exists to refuse.)
  for (let i = 0; i < 55; i++) { f.say(`bulk @reviewer ${i}`); f.advance(2500); }
  const fPoll = await f.poll(reviewer.secret);
  assert.equal(fPoll.value.pendingWakes.length, 50);
  assert.equal(fPoll.value.more, true, "poll door reports truncation (#3265)");
  const fBeat = await f.post("/api/agent-heartbeats", { hostId: "host-1", mode: "pull-only" }, reviewer.secret);
  assert.equal(fBeat.value.pendingWakes.length, 50);
  assert.equal(fBeat.value.more, true, "heartbeat door reports truncation");
  const fSet = await f.mcp("heartbeat.set", { hostId: "host-1", mode: "pull-only" }, reviewer.secret);
  assert.equal(fSet.pendingWakes.length, 50);
  assert.equal(fSet.more, true, "MCP door reports truncation (#3265)");
  await f.post("/api/agent-heartbeats/ack", { signalIds: fPoll.value.pendingWakes.map(w => w.signalId) }, reviewer.secret);
  const fRest = await f.poll(reviewer.secret);
  assert.equal(fRest.value.pendingWakes.length, 5);
  assert.equal(fRest.value.more, false);
  await f.post("/api/agent-heartbeats/ack", { signalIds: fRest.value.pendingWakes.map(w => w.signalId) }, reviewer.secret);
  assert.equal((await f.poll(reviewer.secret)).value.pendingWakes.length, 0);

  // Reconciliation against the scripted tally.
  const acct = f.store.agentHeartbeats.accounting();
  const s = acct.byStore.signals, w = acct.byStore.work;
  const ackedTotal = Object.values(s.ackedByDoor).reduce((a, b) => a + b, 0);
  console.log("wake-accounting harness:", JSON.stringify({
    signals: { emitted: s.emitted, coalesced: s.coalesced, suppressedNoHost: s.suppressed_no_host,
      suppressedNoIdentity: s.suppressed_no_identity, suppressedPolicy: s.suppressed_policy, failed: s.failed,
      deliveredByDoor: s.deliveredByDoor, ackedByDoor: s.ackedByDoor,
      doorbellDelivered: s.doorbell_delivered, doorbellFailed: s.doorbell_failed },
    work: { emitted: w.emitted, invalidated: w.invalidated, ackedByDoor: w.ackedByDoor },
    stock: acct.stock, failures: acct.failures.byReason, loss: acct.loss,
  }, null, 1));
  // Signals tally: A1 + C2 + D1 + E2 (mention + its WAKE0-1 wake
  // intent) + F55 = 61 emitted, all acked.
  assert.equal(s.emitted, 61);
  assert.equal(s.coalesced, 0);
  assert.equal(s.failed, 0, "fabric loss: no owed attempt errored on a swallowing path");
  assert.equal(s.suppressed_no_identity, 1, "exactly the ghost's claim wake");
  assert.equal(ackedTotal, 61, "every emitted signal was acked");
  assert.equal(acct.stock.signalsPending, 0);
  assert.equal(acct.stock.signalsAcked, 61);
  assert.equal(s.ackedByDoor.rest, 60);
  assert.equal(s.ackedByDoor.mcp, 1);
  assert.ok(s.deliveredByDoor.heartbeat >= 51 && s.deliveredByDoor.poll >= 57 && s.deliveredByDoor.mcp >= 51,
    "deliveries counted on every pull door");
  assert.equal(s.doorbell_failed, 1);
  assert.equal(s.doorbell_delivered, 0);
  assert.deepEqual(acct.failures.byReason, { no_identity_link: 1, push_delivery_failed: 1 });
  // Work store tally: one emitted work wake, acked once via REST.
  assert.equal(w.emitted, 1);
  assert.equal(w.ackedByDoor.rest, 1);
  // The council number, decomposed: fabric failure (failed) is 0 of 63
  // owed attempts (61 signal emissions + 1 work emission + 1 lost
  // attempt); including the addressability class the rate is 1/63 — and
  // the two classes are never blended in the accounting itself.
  assert.equal(acct.loss.lostAttempts, 1);
  assert.equal(acct.loss.owedAttempts, 63);
  assert.ok(Math.abs(acct.loss.failureRate - 1 / 63) < 1e-12);
});
