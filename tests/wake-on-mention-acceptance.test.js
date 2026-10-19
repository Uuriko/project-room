// WAKE0-0 acceptance spine for wake-on-mention Step 0
// (~/workspace/strategy-2026-10/wake-step0-spec.md §4, WAKE0-1 slice here;
// WAKE0-2 extends this file with delivery + discharge legs).
//
// The spec's cast, at store level over the acceptance fixture (the same
// shape tests/agent-heartbeats.test.js uses): runtime A (the room owner)
// posts a directed request mentioning runtime B; B is a seated member
// whose host has gone stale — a member, and nothing is listening. The
// Step-0 contract under test:
//   1. a `wake` intent is emitted for (B, room) — kind `wake`, pointer
//      payload, cause = the triggering message — only when B is offline
//      AND a delivery target exists (§2.1);
//   2. repeated mentions coalesce into ONE outstanding intent whose cause
//      tracks the latest trigger (§2.1 coalesce, §2.4 "latest cause");
//   3. suppressions are counted, never silent: no target →
//      suppressed_no_target, wake-paused → suppressed_policy (§2.1(4),
//      §2.7); online or hostless → no intent (the existing gates stand).
//
// Authoring gate: each test names the observable contract, the credible
// regression, and why existing coverage misses it. Existing wake suites
// predate the kind: WAKE_KINDS rejected `wake` at the CHECK constraint,
// so no test could observe an intent row at all.
//
// Synthetic fixtures only — no external calls or real credentials.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import {
  AgentHeartbeats, WAKE_KINDS, agentHeartbeatSchema, convergeWakeSignalRoomScope,
  HEARTBEAT_STALE_AFTER_MS,
} from "../server/agent-heartbeats.mjs";
import { enqueueClaimWake } from "../server/work-claim-events.mjs";
import { listMentionReceipts } from "../server/mention-receipts.mjs";

const ROOM = "commons";
const WAKE_URL = "https://agent.example.test/wake";

function setup() {
  const f = createAcceptanceFixture();
  let at = Date.now();
  f.store.now = () => at;
  return { f, advance: ms => { at += ms; } };
}

function addMember(f, memberId, displayName = memberId) {
  const identity = f.store.identities.create(displayName);
  f.store.identities.link(f.keys.owner, ROOM, {
    identityId: identity.identityId, memberId, displayName, permissions: ["accept_work"],
  });
  return identity;
}

// B registers a wakeable host (optionally with a wakeUrl), then goes stale:
// a member whose runtime is not listening — the §4 cast.
function registerHost(f, identity, { wakeUrl = null } = {}) {
  f.store.agentHeartbeats.heartbeat({
    agentId: identity.identityId, hostId: "host-1", mode: "wakeable", wakeUrl,
  });
}

function armSubscription(f, identity) {
  return f.store.agentPlugin.subscribeWebhook({
    identityId: identity.identityId, url: "https://agent.example.test/hook",
    events: ["agent.wake"], secret: "wake0-test-secret",
  });
}

function goOffline(advance) { advance(HEARTBEAT_STALE_AFTER_MS + 1000); }

function mention(f, messageId, body) {
  return f.store.command(f.keys.owner, ROOM, {
    id: randomUUID(), type: "message.posted", data: { messageId, body },
  });
}

const wakeRows = (f, agentId) => f.store.db.prepare(
  "SELECT signal_id AS signalId, kind, room_id AS roomId, message_id AS messageId, delivered_at AS deliveredAt FROM agent_wake_signals WHERE agent_id=? AND kind='wake' ORDER BY created_at"
).all(agentId);

const signalsOf = (f, agentId, kind) => f.store.db.prepare(
  "SELECT signal_id AS signalId, message_id AS messageId, delivered_at AS deliveredAt FROM agent_wake_signals WHERE agent_id=? AND kind=? ORDER BY created_at"
).all(agentId, kind);

const counter = (f, event, kind = "wake") => f.store.db.prepare(
  "SELECT COALESCE(SUM(n),0) AS n FROM agent_wake_counters WHERE event=? AND kind=?"
).get(event, kind)?.n ?? 0;

test("§4 S1: a mention of an offline member with a target emits exactly one wake intent", () => {
  // Contract: §2.1 — offline + target ⇒ one `wake` row for (B, room),
  // pointer messageId derived from the trigger. Regression: emission
  // wired to presence only (intents for target-less members — §2.1(4)
  // forbids) or to the signal alone (intents while B is online — noise).
  const { f, advance } = setup();
  const bob = addMember(f, "bob");
  registerHost(f, bob, { wakeUrl: WAKE_URL });
  armSubscription(f, bob);
  goOffline(advance);
  mention(f, "m-s1", "@bob CANARY — what is the canary word in this message?");
  const wakes = wakeRows(f, bob.identityId);
  assert.equal(wakes.length, 1, "one wake intent for (bob, commons)");
  assert.equal(wakes[0].roomId, ROOM);
  assert.equal(wakes[0].messageId, "wake:m-s1", "pointer carries the triggering message id");
  assert.equal(wakes[0].deliveredAt, null, "the intent is outstanding, not delivered");
  assert.equal(signalsOf(f, bob.identityId, "mention").length, 1, "the mention signal itself is untouched");
  assert.equal(counter(f, "emitted"), 1, "the emission is counted under kind wake");
});

test("N3: a member who is online gets no wake intent", () => {
  // Contract: §2.1(3) — a live host is already reachable via D1/D2; a
  // wake intent would be noise. Regression: presence checked against the
  // wrong window (or not at all) spams intents at listening runtimes.
  const { f } = setup();
  const bob = addMember(f, "bob");
  registerHost(f, bob, { wakeUrl: WAKE_URL });
  armSubscription(f, bob);
  mention(f, "m-n3", "@bob you are already here");
  assert.equal(wakeRows(f, bob.identityId).length, 0);
  assert.equal(signalsOf(f, bob.identityId, "mention").length, 1, "the mention signal still lands");
});

test("§2.1(4): offline with NO delivery target emits nothing and counts suppressed_no_target", () => {
  // Contract: the design never creates an intent it has no way to
  // attempt — and the refusal is visible in wake accounting, not silent.
  // Regression: intents accumulating for members nobody can reach, or
  // the suppression vanishing from the metrics vocabulary.
  const { f, advance } = setup();
  const bob = addMember(f, "bob");
  registerHost(f, bob); // wakeable host, no wakeUrl, no subscription, no push
  goOffline(advance);
  mention(f, "m-notarget", "@bob anyone home?");
  assert.equal(wakeRows(f, bob.identityId).length, 0);
  assert.equal(signalsOf(f, bob.identityId, "mention").length, 1, "the mention signal is unaffected");
  assert.equal(counter(f, "suppressed_no_target"), 1, "the suppression is counted under kind wake");
});

test("§2.7: a pull-only member is never a wake target, subscription or not", () => {
  // Contract: pull-only is an explicit do-not-wake declaration; if every
  // host is pull-only, §2.1(4) finds no target. Regression: subscription
  // existence alone counting as a target and waking pull-only members.
  const { f, advance } = setup();
  const bob = addMember(f, "bob");
  f.store.agentHeartbeats.heartbeat({ agentId: bob.identityId, hostId: "host-1", mode: "pull-only" });
  armSubscription(f, bob);
  goOffline(advance);
  mention(f, "m-pullonly", "@bob quiet please");
  assert.equal(wakeRows(f, bob.identityId).length, 0);
  assert.equal(counter(f, "suppressed_no_target"), 1);
});

test("§2.1(4): a wakeUrl alone (no subscription) is a delivery target", () => {
  const { f, advance } = setup();
  const bob = addMember(f, "bob");
  registerHost(f, bob, { wakeUrl: WAKE_URL });
  goOffline(advance);
  mention(f, "m-urlonly", "@bob ping via your wakeUrl");
  assert.equal(wakeRows(f, bob.identityId).length, 1);
});

test("§2.1(4): a push subscription alone (no wakeUrl, no webhook sub) is a delivery target", () => {
  const { f, advance } = setup();
  const bob = addMember(f, "bob");
  f.store.agentHeartbeats.heartbeat({
    agentId: bob.identityId, hostId: "host-1", mode: "wakeable",
    pushNotification: { url: "https://agent.example.test/push", token: "wake0-token" },
  });
  goOffline(advance);
  mention(f, "m-pushonly", "@bob ping via push");
  assert.equal(wakeRows(f, bob.identityId).length, 1);
});

test("N4: three mentions while B is down fold into ONE outstanding wake tracking the latest cause", () => {
  // Contract: §2.1 coalesce on (agent, room) — a wake's job is to bring
  // the runtime to the room once. Regression: one intent per mention
  // (a stopped runtime gets a summons pile), or a stale cause (the row
  // still points at the first mention after later ones land — §2.4's
  // expiry keys off the latest cause).
  const { f, advance } = setup();
  const bob = addMember(f, "bob");
  registerHost(f, bob, { wakeUrl: WAKE_URL });
  goOffline(advance);
  mention(f, "m-n4a", "@bob ping a");
  mention(f, "m-n4b", "@bob ping b");
  mention(f, "m-n4c", "@bob ping c");
  const wakes = wakeRows(f, bob.identityId);
  assert.equal(wakes.length, 1, "exactly one outstanding wake intent");
  assert.equal(wakes[0].messageId, "wake:m-n4c", "the cause tracks the latest trigger");
  assert.equal(signalsOf(f, bob.identityId, "mention").length, 3, "all three mention signals wait on B's page");
  assert.equal(counter(f, "emitted"), 1);
  assert.equal(counter(f, "coalesced"), 2, "the folded attempts are counted as coalesced");
});

test("N2: a wake-paused member gets no intent; the suppression is counted as policy", () => {
  // Contract: §2.7 — the wake pause gate is inherited; no intent for a
  // paused room. Regression: the new kind bypassing the pause the other
  // kinds respect, or the refusal going uncounted.
  const { f, advance } = setup();
  const bob = addMember(f, "bob");
  registerHost(f, bob, { wakeUrl: WAKE_URL });
  goOffline(advance);
  f.store.wakeQueue.pause(bob.secret, ROOM, { requestId: randomUUID(), reason: "wake0 test" });
  mention(f, "m-n2", "@bob paused check");
  assert.equal(wakeRows(f, bob.identityId).length, 0);
  assert.equal(counter(f, "suppressed_policy"), 1, "the pause suppression is counted under kind wake");
  assert.equal(signalsOf(f, bob.identityId, "mention").length, 1, "the mention signal is held, not dropped (R327-1)");
});

test("a hostless member gets no intent — the existing suppressed_no_host stands alone", () => {
  // Contract: §2.1(2) — a wake cannot invent an address; the underlying
  // attempt's counted suppression is the record (no second count under
  // kind wake). Regression: double-counting the same loss, or an intent
  // row for an identity with no host to ever drain it.
  const { f } = setup();
  const bob = addMember(f, "bob");
  mention(f, "m-hostless", "@bob you never registered");
  assert.equal(wakeRows(f, bob.identityId).length, 0);
  assert.equal(signalsOf(f, bob.identityId, "mention").length, 0, "no signal exists without a host");
  assert.equal(counter(f, "suppressed_no_target"), 0);
});

test("the DM cause: a targeted DM to an offline member emits a wake for the DM", () => {
  // Contract: §2.1 covers the M2 surface through the same helper as
  // mentions. Regression: wake-on-mention shipping for @mentions only,
  // leaving DMs — the other directed surface — unreached.
  const { f, advance } = setup();
  const bob = addMember(f, "bob");
  registerHost(f, bob, { wakeUrl: WAKE_URL });
  goOffline(advance);
  f.store.dmConsents.request(ROOM, "owner", "bob", "wake0 test");
  f.store.dmConsents.decide(ROOM, "bob", "owner", "approve");
  f.store.command(f.keys.owner, ROOM, {
    id: randomUUID(), type: "message.posted",
    data: { messageId: "dm-1", body: "direct ping", toMemberId: "bob" },
  });
  const wakes = wakeRows(f, bob.identityId);
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].messageId, "wake:dm-1");
  assert.equal(signalsOf(f, bob.identityId, "dm").length, 1);
});

test("the claim cause: a work-claim wake for an offline member emits a wake intent", () => {
  // Contract: M3 routes through the same helper (enqueueClaimWake).
  // Regression: claim wakes — the Board's addressing — silently excluded
  // from Step 0, the exact gap FLEET-SYNC measured for claim events.
  const { f, advance } = setup();
  const bob = addMember(f, "bob");
  registerHost(f, bob, { wakeUrl: WAKE_URL });
  goOffline(advance);
  const result = enqueueClaimWake(f.store, ROOM, "bob", "work-claim:TASK-9:assigned:1",
    { reason: "assigned", actorId: "owner" });
  assert.equal(result?.enqueued, true, "the claim signal itself enqueued");
  const wakes = wakeRows(f, bob.identityId);
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].messageId, "wake:work-claim:TASK-9:assigned:1");
});

test("fabric: the wake kind round-trips the signal table and wakeIfOffline returns the intent", () => {
  // Contract: WAKE_KINDS + the table CHECK admit `wake`; the helper's
  // return carries the intent so call sites (WAKE0-2) can deliver it.
  // Regression: the kind added to the JS list but rejected by the SQL
  // CHECK (the baseline's finding), or vice versa.
  assert.ok(WAKE_KINDS.includes("wake"));
  const db = new DatabaseSync(":memory:");
  db.exec(agentHeartbeatSchema);
  const store = { db, now: () => 1_750_000_000_000, workWakes: null };
  const hb = new AgentHeartbeats(store);
  hb.heartbeat({ agentId: "ai_unit", hostId: "h1", mode: "wakeable", wakeUrl: WAKE_URL });
  store.now = () => 1_750_000_000_000 + HEARTBEAT_STALE_AFTER_MS + 1000;
  const { woken, wakeSignal } = hb.wakeIfOffline({
    agentId: "ai_unit", kind: "mention", roomId: "commons", messageId: "m-unit",
  });
  assert.equal(woken, true);
  assert.equal(wakeSignal?.kind, "wake");
  assert.equal(wakeSignal?.messageId, "wake:m-unit");
  const again = hb.enqueueWake({ agentId: "ai_unit", kind: "wake", roomId: "commons", messageId: "wake:other" });
  assert.equal(again.enqueued, true, "a second wake row with a distinct pointer inserts");
});

test("fabric: a deployed DB with the pre-wake CHECK converges without losing rows", () => {
  // Contract: widening the kind CHECK uses the #2913 convergence
  // machinery — the table rebuilds row-preserving at boot. Regression:
  // deployed rooms bricking on verifySchema, or wake rows (and every
  // other signal) vanishing in the rebuild.
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE agent_wake_signals (
    signal_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('mention','dm','bond','assignment','land')),
    room_id TEXT, message_id TEXT,
    created_at INTEGER NOT NULL, delivered_at INTEGER
  );`);
  db.prepare("INSERT INTO agent_wake_signals VALUES ('ws_old','ai_unit','mention','commons','m-old',1,NULL)").run();
  assert.throws(() => db.prepare(
    "INSERT INTO agent_wake_signals VALUES ('ws_x','ai_unit','wake','commons','wake:m-old',2,NULL)").run(),
    /CHECK/, "the pre-wake schema really does reject the kind");
  convergeWakeSignalRoomScope(db);
  db.exec(agentHeartbeatSchema);
  const kept = db.prepare("SELECT kind, message_id AS messageId FROM agent_wake_signals WHERE signal_id='ws_old'").get();
  assert.deepEqual({ ...kept }, { kind: "mention", messageId: "m-old" }, "existing rows survive convergence");
  db.prepare("INSERT INTO agent_wake_signals VALUES ('ws_new','ai_unit','wake','commons','wake:m-old',2,NULL)").run();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agent_wake_signals").get().n, 2);
});

// ---- WAKE0-2: delivery + discharge (spec §2.3, §2.4, §2.6) ----

const deliveriesFor = (f, agentId) => f.store.db.prepare(
  "SELECT event_id AS eventId, target_url AS targetUrl, payload_json AS payload FROM agent_webhook_deliveries WHERE agent_id=? AND event_type='agent.wake'"
).all(agentId).map(row => ({ ...row, signal: JSON.parse(row.payload)?.data?.signal ?? null }));

const deliveredViaWakeDoor = f => f.store.db.prepare(
  "SELECT COALESCE(SUM(n),0) AS n FROM agent_wake_counters WHERE event='delivered' AND kind='wake' AND door='wake'"
).get()?.n ?? 0;

const receiptFor = (f, memberId) =>
  listMentionReceipts(f.store, f.keys.owner, ROOM).receipts.find(r => r.memberId === memberId);

function armedOfflineBob(f, advance) {
  const bob = addMember(f, "bob");
  registerHost(f, bob, { wakeUrl: WAKE_URL });
  armSubscription(f, bob);
  goOffline(advance);
  return bob;
}

test("§4 S2: the wake intent is delivered — a journaled agent.wake ping carries the wake signal", () => {
  // Contract: §2.3 — deliverWakePing carries the wake signal through the
  // same journaled delivery as the underlying mention (event-push door),
  // including the wakeUrl fan-out. Regression: the intent row existing
  // but no ping ever journaled for it — the runtime is never summoned,
  // which is the whole Step-0 gap.
  const { f, advance } = setup();
  const bob = armedOfflineBob(f, advance);
  mention(f, "m-s2", "@bob canary check");
  const [intent] = wakeRows(f, bob.identityId);
  const deliveries = deliveriesFor(f, bob.identityId);
  const wakePings = deliveries.filter(d => d.signal?.kind === "wake");
  assert.ok(wakePings.length >= 1, "a journaled ping carries the wake signal");
  assert.ok(wakePings.some(d => d.eventId === intent.signalId), "the ping's event id is the wake row's signal id");
  assert.ok(wakePings.some(d => d.signal?.messageId === "wake:m-s2"), "the ping payload is the wake pointer");
  assert.ok(wakePings.some(d => d.targetUrl === WAKE_URL), "the wakeUrl fan-out carries the wake ping too");
  assert.ok(deliveries.some(d => d.signal?.kind === "mention"), "the underlying mention ping still journals");
});

test("§2.3: the DM and claim causes deliver their wake pings through the same door", () => {
  const { f, advance } = setup();
  const bob = armedOfflineBob(f, advance);
  // Claim first, while no intent stands: the claim's emission journals
  // its own wake ping carrying the claim pointer.
  const result = enqueueClaimWake(f.store, ROOM, "bob", "work-claim:TASK-10:assigned:1",
    { reason: "assigned", actorId: "owner" });
  assert.equal(result?.enqueued, true);
  assert.ok(deliveriesFor(f, bob.identityId).some(d => d.signal?.kind === "wake" && d.signal?.messageId === "wake:work-claim:TASK-10:assigned:1"),
    "the claim's wake intent is journaled for delivery");
  // A DM while the intent stands coalesces onto the SAME row: the
  // journal dedupes by signal id (one outstanding intent, one journaled
  // summons per subscription), and the row the ping names now carries
  // the DM as its latest cause.
  f.store.dmConsents.request(ROOM, "owner", "bob", "wake0 test");
  f.store.dmConsents.decide(ROOM, "bob", "owner", "approve");
  f.store.command(f.keys.owner, ROOM, {
    id: randomUUID(), type: "message.posted",
    data: { messageId: "dm-2", body: "direct ping", toMemberId: "bob" },
  });
  const [intent] = wakeRows(f, bob.identityId);
  assert.equal(intent.messageId, "wake:dm-2", "the intent re-pointed at the DM");
  assert.ok(deliveriesFor(f, bob.identityId).some(d => d.signal?.kind === "wake" && d.eventId === intent.signalId),
    "the journaled summons names the standing intent");
});

test("§4 S3: connecting discharges the intent on the heartbeat door — wake rows only", () => {
  // Contract: §2.4 — discharge-on-connect. The runtime's arrival retires
  // the summons; the underlying mention keeps its own ack lifecycle.
  // Regression: intents staying outstanding after arrival (stale
  // receipts, blocked coalesce), or discharge swallowing real signals.
  const { f, advance } = setup();
  const bob = armedOfflineBob(f, advance);
  mention(f, "m-s3", "@bob come back");
  f.store.agentHeartbeats.heartbeat({ agentId: bob.identityId, hostId: "host-1", mode: "wakeable", wakeUrl: WAKE_URL });
  const [intent] = wakeRows(f, bob.identityId);
  assert.notEqual(intent.deliveredAt, null, "the intent is discharged on connect");
  assert.equal(signalsOf(f, bob.identityId, "mention")[0].deliveredAt, null,
    "the mention signal is NOT discharged — it leaves only through ack");
  assert.equal(deliveredViaWakeDoor(f), 1, "the discharge is accounted delivered through the wake door");
  const pendingKinds = f.store.agentHeartbeats.pendingWakes(bob.identityId, {}).map(s => s.kind);
  assert.ok(!pendingKinds.includes("wake"), "the discharged intent never rides a pending page");
  assert.ok(pendingKinds.includes("mention"), "the mention still rides the page for ack");
});

test("§4 S3: connecting discharges the intent on the poll door too", () => {
  const { f, advance } = setup();
  const bob = armedOfflineBob(f, advance);
  mention(f, "m-s3p", "@bob come back via poll");
  const poll = f.store.agentHeartbeats.notePoll({ agentId: bob.identityId, roomId: ROOM, hostId: "host-1" });
  assert.notEqual(wakeRows(f, bob.identityId)[0].deliveredAt, null, "the poll discharges the intent");
  assert.ok(!poll.pendingWakes.some(s => s.kind === "wake"), "the discharging poll does not serve the intent on its own page");
  assert.equal(deliveredViaWakeDoor(f), 1);
});

test("§4 S4: another agent's connect does not discharge the intent", () => {
  const { f, advance } = setup();
  const bob = armedOfflineBob(f, advance);
  const carol = addMember(f, "carol");
  registerHost(f, carol, { wakeUrl: WAKE_URL });
  mention(f, "m-s4", "@bob only you");
  f.store.agentHeartbeats.heartbeat({ agentId: carol.identityId, hostId: "host-1", mode: "wakeable", wakeUrl: WAKE_URL });
  f.store.agentHeartbeats.notePoll({ agentId: carol.identityId, roomId: ROOM, hostId: "host-1" });
  assert.equal(wakeRows(f, bob.identityId)[0].deliveredAt, null, "bob's intent survives carol's activity");
  assert.equal(deliveredViaWakeDoor(f), 0);
});

test("§2.4/N1: expiry is lazy — the timeout flip alone does not discharge; the receipt reads expired; connect discharges", () => {
  // Contract: §4 N1 + §2.4 — when the mention times out the intent is
  // expired FOR THE RECEIPT, but the row itself is discharged by the
  // wake surface (connect / resolution), not by the mention surface's
  // flip. Regression: flipExpiredMentions mutating wake rows (the
  // surfaces corrupting each other's lifecycles), or receipts hiding
  // the expiry.
  const { f, advance } = setup();
  const bob = armedOfflineBob(f, advance);
  f.store.setMentionTimeout(f.keys.owner, ROOM, 60_000, null);
  mention(f, "m-n1", "@bob time-sensitive");
  advance(61_000);
  const receipt = receiptFor(f, "bob");
  assert.equal(receipt.state, "timed_out");
  assert.equal(receipt.wakeState, "expired", "the receipt computes the intent's expiry");
  assert.equal(wakeRows(f, bob.identityId)[0].deliveredAt, null,
    "N1: the flip + a receipt read leave the intent row outstanding");
  f.store.agentHeartbeats.heartbeat({ agentId: bob.identityId, hostId: "host-1", mode: "wakeable", wakeUrl: WAKE_URL });
  assert.notEqual(wakeRows(f, bob.identityId)[0].deliveredAt, null, "connect discharges the expired intent");
});

test("§2.6: receipts show the wake state — summoned, then discharged after connect", () => {
  const { f, advance } = setup();
  const bob = armedOfflineBob(f, advance);
  mention(f, "m-r1", "@bob receipt check");
  assert.equal(receiptFor(f, "bob").wakeState, "summoned");
  f.store.agentHeartbeats.heartbeat({ agentId: bob.identityId, hostId: "host-1", mode: "wakeable", wakeUrl: WAKE_URL });
  assert.equal(receiptFor(f, "bob").wakeState, "discharged");
});

test("§2.6: a mention that produced no intent shows no wake state", () => {
  const { f } = setup();
  const bob = addMember(f, "bob");
  registerHost(f, bob, { wakeUrl: WAKE_URL });
  armSubscription(f, bob);
  mention(f, "m-r0", "@bob you are online, no summons");
  assert.equal(receiptFor(f, "bob").wakeState, null);
});

test("§2.4: resolution discharges — a reply to the mention retires the intent without a heartbeat", () => {
  // Contract: the mention_states transition to responded discharges the
  // intent at the transition — the runtime answered, so the summons is
  // moot even though it never heartbeated. Regression: the intent
  // outliving its own resolution (a later connect would re-summon for
  // work already done).
  const { f, advance } = setup();
  const bob = armedOfflineBob(f, advance);
  mention(f, "m-res", "@bob please do the thing");
  const bobKey = f.store.issueAccessKey(ROOM, "bob");
  f.store.command(bobKey, ROOM, {
    id: randomUUID(), type: "message.posted",
    data: { messageId: "r-res", body: "on it", replyToId: "m-res" },
  });
  assert.notEqual(wakeRows(f, bob.identityId)[0].deliveredAt, null, "the reply discharged the intent");
  const receipt = receiptFor(f, "bob");
  assert.equal(receipt.state, "responded");
  assert.equal(receipt.wakeState, "discharged");
  assert.equal(deliveredViaWakeDoor(f), 1);
});
