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
