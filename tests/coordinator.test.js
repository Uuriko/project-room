// Coordinator assign, ask, and stop. Observable over the assistant HTTP
// route and the work-claim registry: who may write, which claim moves,
// when the hop and hour caps refuse, and that Stop leaves a halted ask.
import test from "node:test";
import assert from "node:assert/strict";
import { createRoomServer } from "../server/http.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { demoteToReadonly, setTier } from "../server/autonomy-tiers.mjs";
import { HEARTBEAT_STALE_AFTER_MS } from "../server/agent-heartbeats.mjs";
import { claimHistoryLength, claimWork, createWork, updateWork } from "../server/work-claims.mjs";
import { COORDINATOR_ACTIONS_PER_HOUR, COORDINATOR_MAX_HOPS } from "../server/coordinator.mjs";
import { COORDINATOR_RANKING_VERSION } from "../server/coordinator-ranking.mjs";

async function fixture(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const add = (memberId, permissions) => store.command(ownerKey, "commons", {
    id: `add-${memberId}`, type: "member.added",
    data: { memberId, displayName: memberId, kind: "agent", permissions }
  });
  add("coord", ["accept_work", "complete_work"]);
  add("helper", ["accept_work", "complete_work"]);
  add("reader", ["steer"]);
  const keys = {
    owner: ownerKey,
    coord: store.issueAccessKey("commons", "coord"),
    helper: store.issueAccessKey("commons", "helper"),
    reader: store.issueAccessKey("commons", "reader")
  };
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (actor, body, method = "POST") => {
    const response = await fetch(`${origin}/api/rooms/commons/assistant`, {
      method,
      headers: { authorization: `Bearer ${keys[actor]}`, "content-type": "application/json" },
      body: method === "POST" ? JSON.stringify(body) : undefined
    });
    return { status: response.status, body: await response.json() };
  };
  await call("owner", {
    requestId: "cfg-coord", action: "configure", name: "Room",
    coordinatorMemberId: "coord", expectedRevision: 0
  });
  return { store, call, keys };
}

function putClaim(store, fields) {
  const item = createWork({ id: fields.id, title: fields.title ?? fields.id, files: fields.files, dependsOn: fields.dependsOn }, { now: store.now(), agentId: "owner" });
  store.workClaims.set("commons", item);
  return store.workClaims.get("commons", fields.id);
}

function roundOf(item) {
  return { expectedClaimedAt: item.claimedAt, expectedHistoryLength: claimHistoryLength(item) };
}

function assignBody(item, target, requestId, extra = {}) {
  return { requestId, action: "assign", workClaimId: item.id, targetMemberId: target, ...roundOf(item), ...extra };
}

test("published hop and hour caps", () => {
  assert.equal(COORDINATOR_MAX_HOPS, 4);
  assert.equal(COORDINATOR_ACTIONS_PER_HOUR, 30);
});

test("owner names the coordinator and a non-coordinator cannot assign", async t => {
  const { store, call } = await fixture(t);
  const named = await call("helper", null, "GET");
  assert.equal(named.status, 200);
  assert.equal(named.body.assistant.coordinatorMemberId, "coord");
  assert.equal(named.body.assistant.coordinatorActions, undefined);
  assert.equal(named.body.assistant.stoppedAt, undefined);

  const item = putClaim(store, { id: "open-1" });
  const refused = await call("owner", assignBody(item, "helper", "owner-assign"));
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, "assistant_denied");
  assert.ok(Array.isArray(refused.body.next) && refused.body.next.length >= 1);
  assert.equal(store.workClaims.get("commons", "open-1").state, "unclaimed");

  const cleared = await call("owner", {
    requestId: "cfg-clear", action: "configure", name: "Room",
    coordinatorMemberId: null, expectedRevision: 1
  });
  assert.equal(cleared.status, 200);
  const after = await call("coord", null, "GET");
  assert.equal(after.body.assistant.coordinatorMemberId, null);
  const missing = await call("coord", assignBody(store.workClaims.get("commons", "open-1"), "helper", "no-coord"));
  assert.equal(missing.status, 409);
  assert.equal(missing.body.error.code, "assistant_not_connected");
  assert.equal(store.workClaims.get("commons", "open-1").owner, null);
});

test("assign respects a held claim, a stale round, unmet dependencies, the member cap, and a file lease", async t => {
  const { store, call } = await fixture(t);
  const open = putClaim(store, { id: "open-2" });
  const assigned = await call("coord", assignBody(open, "helper", "assign-open", { note: "take this" }));
  assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
  assert.equal(assigned.body.result.status, "applied");
  assert.equal(assigned.body.result.hop, 1);
  assert.equal(assigned.body.result.claim.state, "claimed");
  assert.equal(assigned.body.result.claim.owner, "helper");
  assert.equal(store.workClaims.get("commons", "open-2").owner, "helper");

  const again = await call("coord", assignBody(store.workClaims.get("commons", "open-2"), "coord", "assign-held"));
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, "work_claim_conflict");
  assert.match(again.body.error.message, /held by helper —/);
  assert.equal(store.workClaims.get("commons", "open-2").owner, "helper");

  const staleItem = putClaim(store, { id: "stale-1" });
  const stale = await call("coord", { ...assignBody(staleItem, "helper", "assign-stale"), expectedHistoryLength: 99 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, "work_claim_conflict");
  assert.equal(store.workClaims.get("commons", "stale-1").state, "unclaimed");

  putClaim(store, { id: "dep-1" });
  const blocked = putClaim(store, { id: "needs-dep", dependsOn: ["dep-1"] });
  const unmet = await call("coord", assignBody(blocked, "helper", "assign-dep"));
  assert.equal(unmet.status, 409);
  assert.equal(unmet.body.error.code, "work_claim_dependencies_unmet");
  assert.match(unmet.body.error.message, /dep-1/);
  assert.equal(store.workClaims.get("commons", "needs-dep").state, "unclaimed");

  store.workClaims.configure("commons", { maxMemberOpenClaims: 1 });
  const capped = putClaim(store, { id: "capped-1" });
  const cap = await call("coord", assignBody(capped, "helper", "assign-cap"));
  assert.equal(cap.status, 409);
  assert.equal(cap.body.error.code, "too_many_open_claims");
  assert.equal(store.workClaims.get("commons", "capped-1").owner, null);
  store.workClaims.configure("commons", { maxMemberOpenClaims: 20 });

  const held = putClaim(store, { id: "leased", files: ["server/lane.mjs"] });
  store.workClaims.set("commons", claimWork(held, "helper", { now: store.now(), room: { workClaims: store.workClaims.rawConfig("commons") } }));
  const overlap = putClaim(store, { id: "overlap", files: ["server/lane.mjs"] });
  const lease = await call("coord", assignBody(overlap, "coord", "assign-lease"));
  assert.equal(lease.status, 409);
  assert.equal(lease.body.error.code, "file_lease_conflict");
  assert.match(lease.body.error.message, /server\/lane\.mjs/);
  assert.equal(store.workClaims.get("commons", "overlap").state, "unclaimed");

  const missing = await call("coord", assignBody({ id: "missing-claim", claimedAt: null, history: [{}] }, "helper", "assign-missing"));
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, "work_claim_not_found");

  const retry = await call("coord", assignBody(open, "helper", "assign-open", { note: "take this" }));
  assert.equal(retry.status, 200);
  assert.equal(retry.body.result.claim.owner, "helper");
  const history = store.workClaims.get("commons", "open-2").history.filter(stamp => String(stamp.action).startsWith("reassigned"));
  assert.equal(history.length, 1);

  const clash = await call("coord", assignBody(open, "coord", "assign-open"));
  assert.equal(clash.status, 409);
  assert.equal(clash.body.error.code, "assistant_retry_conflict");
  assert.equal(store.workClaims.get("commons", "open-2").owner, "helper");
});

test("the hop cap stops an assign and ask cycle, and the hour cap stops the room", async t => {
  const { store, call } = await fixture(t);
  const item = putClaim(store, { id: "loop-1" });
  const assigned = await call("coord", assignBody(item, "helper", "loop-assign"));
  assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
  for (let hop = 2; hop <= COORDINATOR_MAX_HOPS; hop += 1) {
    const asked = await call("coord", {
      requestId: `loop-ask-${hop}`, action: "ask", workClaimId: "loop-1", targetMemberId: "helper", note: "help"
    });
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    assert.equal(asked.body.result.status, "pending");
    assert.equal(asked.body.result.hop, hop);
    assert.equal(store.workClaims.get("commons", "loop-1").owner, "helper");
  }
  const self = await call("coord", { requestId: "loop-self", action: "ask", workClaimId: "loop-1", targetMemberId: "coord" });
  assert.equal(self.status, 403);
  assert.equal(self.body.error.code, "assistant_denied");
  const capped = await call("coord", { requestId: "loop-ask-over", action: "ask", workClaimId: "loop-1", targetMemberId: "helper" });
  assert.equal(capped.status, 409);
  assert.equal(capped.body.error.code, "assistant_loop_cap");
  assert.match(capped.body.error.message, /Stop the chain or choose another claim/);
  assert.equal(capped.body.next.length >= 1, true);

  putClaim(store, { id: "loop-2" });
  const otherAsk = await call("coord", { requestId: "loop-other", action: "ask", workClaimId: "loop-2", targetMemberId: "helper" });
  assert.equal(otherAsk.status, 200);

  let clock = store.now() + 3_600_001;
  store.now = () => clock;
  for (let n = 0; n < COORDINATOR_ACTIONS_PER_HOUR; n += 1) {
    const fresh = putClaim(store, { id: `hour-${n}` });
    const response = await call("coord", { requestId: `hour-ask-${n}`, action: "ask", workClaimId: fresh.id, targetMemberId: "helper" });
    assert.equal(response.status, 200, `${n} ${JSON.stringify(response.body)}`);
  }
  const blocked = putClaim(store, { id: "hour-over" });
  const over = await call("coord", { requestId: "hour-ask-over", action: "ask", workClaimId: blocked.id, targetMemberId: "helper" });
  assert.equal(over.status, 409);
  assert.equal(over.body.error.code, "assistant_loop_cap");
  assert.match(over.body.error.message, /hour/);
  assert.equal(over.headers, undefined);
  clock += 3_600_001;
  const later = await call("coord", { requestId: "hour-ask-later", action: "ask", workClaimId: blocked.id, targetMemberId: "helper" });
  assert.equal(later.status, 200, JSON.stringify(later.body));
  assert.equal(later.body.result.hop, 1);
});

test("Stop halts pending asks, blocks later coordinator writes, and configure clears it", async t => {
  const { store, call } = await fixture(t);
  const item = putClaim(store, { id: "stop-1" });
  assert.equal((await call("coord", assignBody(item, "helper", "stop-assign"))).status, 200);
  assert.equal((await call("coord", { requestId: "stop-ask", action: "ask", workClaimId: "stop-1", targetMemberId: "helper" })).status, 200);
  const stranger = await call("reader", { requestId: "stop-reader", action: "stop" });
  assert.equal(stranger.status, 403);
  assert.equal(stranger.body.error.code, "assistant_denied");

  const stopped = await call("owner", { requestId: "stop-owner", action: "stop" });
  assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
  assert.equal(stopped.body.result.halted, 1);
  assert.equal(store.workClaims.get("commons", "stop-1").owner, "helper");
  const view = await call("helper", null, "GET");
  assert.equal(view.body.assistant.stoppedAt, stopped.body.result.stoppedAt);
  const rows = view.body.assistant.coordinatorActions;
  assert.equal(rows.find(entry => entry.kind === "assign").status, "applied");
  assert.equal(rows.find(entry => entry.kind === "ask").status, "halted");

  const blocked = await call("coord", { requestId: "stop-ask-2", action: "ask", workClaimId: "stop-1", targetMemberId: "helper" });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, "assistant_host_paused");
  assert.equal(store.workClaims.get("commons", "stop-1").owner, "helper");

  const resumed = await call("owner", {
    requestId: "cfg-resume", action: "configure", name: "Room",
    coordinatorMemberId: "coord", expectedRevision: 1
  });
  assert.equal(resumed.status, 200);
  const open = await call("coord", null, "GET");
  assert.equal(open.body.assistant.stoppedAt, undefined);
  assert.equal(open.body.assistant.coordinatorActions.find(entry => entry.kind === "ask").status, "halted");
  const next = putClaim(store, { id: "stop-2" });
  const again = await call("coord", assignBody(next, "helper", "stop-assign-2"));
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(store.workClaims.get("commons", "stop-2").owner, "helper");
});

test("a read-only coordinator may stop and may not assign, and a wake pause blocks assign", async t => {
  const { store, call, keys } = await fixture(t);
  demoteToReadonly(store.db, "commons", "coord");
  const item = putClaim(store, { id: "tier-1" });
  const refused = await call("coord", assignBody(item, "helper", "tier-assign"));
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, "agent_readonly");
  assert.equal(store.workClaims.get("commons", "tier-1").state, "unclaimed");
  const stopped = await call("coord", { requestId: "tier-stop", action: "stop" });
  assert.equal(stopped.status, 200, JSON.stringify(stopped.body));

  await call("owner", {
    requestId: "cfg-unstop", action: "configure", name: "Room",
    coordinatorMemberId: "coord", expectedRevision: 1
  });
  store.db.prepare("DELETE FROM agent_autonomy_tiers WHERE room_id=? AND member_id=?").run("commons", "coord");
  store.wakeQueue.pause(keys.owner, "commons", { requestId: "pause-coord", reason: "away" }, null, { memberId: "coord" });
  const paused = await call("coord", assignBody(store.workClaims.get("commons", "tier-1"), "helper", "pause-assign"));
  assert.equal(paused.status, 409);
  assert.equal(paused.body.error.code, "assistant_host_paused");
  assert.match(paused.body.error.message, /paused/);
  assert.equal(store.workClaims.get("commons", "tier-1").state, "unclaimed");
});

test("a coordinator action is recorded when the audit table exists", async t => {
  const { store, call } = await fixture(t);
  store.db.exec(`CREATE TABLE agent_audit_log (
    room_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    action TEXT NOT NULL,
    detail TEXT NOT NULL
  )`);
  const item = putClaim(store, { id: "audit-1" });
  const assigned = await call("coord", assignBody(item, "helper", "audit-assign"));
  assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
  const row = store.db.prepare("SELECT room_id, member_id, action, detail FROM agent_audit_log").get();
  assert.equal(row.room_id, "commons");
  assert.equal(row.member_id, "coord");
  assert.equal(row.action, "coordinator_assign");
  const detail = JSON.parse(row.detail);
  assert.deepEqual(detail, {
    kind: "assign", workClaimId: "audit-1", targetMemberId: "helper", status: "applied", hop: 1, requestId: "audit-assign"
  });
});

function connectLive(store, memberId, at) {
  const identityId = `ai-${memberId}`;
  store.db.prepare("INSERT INTO agent_identities (identity_id, secret_hash, display_name, created_at) VALUES (?,?,?,?)")
    .run(identityId, `hash-${identityId}`, memberId, at);
  store.db.prepare("INSERT INTO identity_links (room_id, identity_id, member_id, linked_at) VALUES (?,?,?,?)")
    .run("commons", identityId, memberId, at);
  store.db.prepare(`INSERT INTO agent_hosts (agent_id, host_id, mode, wake_url, last_seen_at, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?)`).run(identityId, "host", "pull-only", null, at, at, at);
  return identityId;
}

async function openRoom(t, specs) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  let now = store.now();
  store.now = () => now;
  const ownerKey = store.issueAccessKey("commons", "owner");
  const keys = { owner: ownerKey };
  for (const spec of specs) {
    store.command(ownerKey, "commons", {
      id: `add-${spec.id}`, type: "member.added",
      data: { memberId: spec.id, displayName: spec.id, kind: "agent", agentType: spec.agentType, permissions: ["accept_work", "complete_work"] }
    });
    keys[spec.id] = store.issueAccessKey("commons", spec.id);
    connectLive(store, spec.id, now);
    if (spec.coordinator) {
      store.command(keys[spec.id], "commons", {
        id: `caps-${spec.id}`, type: "capabilities.advertised",
        data: { capabilities: ["coordinator"] }
      });
    }
    if (spec.done) {
      const room = { workClaims: store.workClaims.rawConfig("commons") };
      let item = createWork({ id: `done-${spec.id}` }, { now, agentId: "owner" });
      item = claimWork(item, spec.id, { now, room });
      item = updateWork(item, spec.id, { state: "in_progress", now, authority: true });
      item = updateWork(item, spec.id, { state: "done", now, authority: true, policy: "self_attested" });
      store.workClaims.set("commons", item);
    }
  }
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (actor, body, method = "POST") => {
    const response = await fetch(`${origin}/api/rooms/commons/assistant`, {
      method,
      headers: { authorization: `Bearer ${keys[actor]}`, "content-type": "application/json" },
      body: method === "POST" ? JSON.stringify(body) : undefined
    });
    return { status: response.status, body: await response.json() };
  };
  const choices = async actor => {
    const response = await fetch(`${origin}/api/rooms/commons/events?after=0`, {
      headers: { authorization: `Bearer ${keys[actor]}` }
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return body.events.map(row => row.event).filter(event => event?.data?.coordinatorSource);
  };
  return { store, call, choices, advance(ms) { now += ms; } };
}

test("a room with no coordinator picks the highest-ranked live member", async t => {
  const room = await openRoom(t, [
    { id: "plain", agentType: "generic" },
    { id: "claude", agentType: "claude-code" }
  ]);
  const owner = await room.call("owner", null, "GET");
  assert.equal(owner.status, 200, JSON.stringify(owner.body));
  assert.equal(owner.body.assistant.coordinatorMemberId, "claude");
  assert.equal(owner.body.assistant.coordinatorSource, "auto");
  assert.equal(owner.body.assistant.revision, 0);
  assert.match(owner.body.assistant.coordinatorReason, /Claude Code \(claude\)/);
  assert.match(owner.body.assistant.coordinatorReason, /supports push wakes or webhooks/);
  assert.match(owner.body.assistant.coordinatorReason, /no claim attempts in this room/);
  assert.ok(owner.body.assistant.coordinatorReason.includes(`Ranking version ${COORDINATOR_RANKING_VERSION}.`));
  const agent = await room.call("plain", null, "GET");
  assert.equal(agent.body.assistant.coordinatorMemberId, owner.body.assistant.coordinatorMemberId);
  assert.equal(agent.body.assistant.coordinatorSource, "auto");
  assert.equal(agent.body.assistant.coordinatorReason, owner.body.assistant.coordinatorReason);
  const logged = await room.choices("plain");
  assert.equal(logged.length, 1);
  assert.equal(logged[0].type, "message.posted");
  assert.equal(logged[0].data.coordinatorSource, "auto");
  assert.equal(logged[0].data.coordinatorMemberId, "claude");
  assert.equal(logged[0].data.rankingVersion, COORDINATOR_RANKING_VERSION);
  assert.equal(logged[0].data.body, owner.body.assistant.coordinatorReason);
  assert.equal((await room.choices("owner")).length, 1);

  const finished = await openRoom(t, [
    { id: "idle", agentType: "generic" },
    { id: "closer", agentType: "generic", done: true }
  ]);
  const byWork = await finished.call("idle", null, "GET");
  assert.equal(byWork.status, 200, JSON.stringify(byWork.body));
  assert.equal(byWork.body.assistant.coordinatorMemberId, "closer");
  assert.match(byWork.body.assistant.coordinatorReason, /claim completion 1\/1/);
  assert.equal((await finished.choices("closer"))[0].data.body, byWork.body.assistant.coordinatorReason);

  const declared = await openRoom(t, [
    { id: "idle", agentType: "generic" },
    { id: "lead", agentType: "generic", coordinator: true }
  ]);
  const byAbility = await declared.call("idle", null, "GET");
  assert.equal(byAbility.status, 200, JSON.stringify(byAbility.body));
  assert.equal(byAbility.body.assistant.coordinatorMemberId, "lead");
  assert.match(byAbility.body.assistant.coordinatorReason, /declares coordinator/);
  assert.equal((await declared.choices("lead"))[0].data.coordinatorMemberId, "lead");
});

test("a stale automatic coordinator is replaced by the next live member", async t => {
  const room = await openRoom(t, [
    { id: "plain", agentType: "generic" },
    { id: "claude", agentType: "claude-code" }
  ]);
  const first = await room.call("owner", null, "GET");
  assert.equal(first.body.assistant.coordinatorMemberId, "claude");
  room.advance(HEARTBEAT_STALE_AFTER_MS + 1);
  room.store.db.prepare("UPDATE agent_hosts SET last_seen_at=? WHERE agent_id=?").run(room.store.now(), "ai-plain");
  const second = await room.call("plain", null, "GET");
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.assistant.coordinatorMemberId, "plain");
  assert.equal(second.body.assistant.coordinatorSource, "auto");
  assert.match(second.body.assistant.coordinatorReason, /Generic MCP or REST \(plain\)/);
  assert.match(second.body.assistant.coordinatorReason, /heartbeat went stale/);
  const logged = await room.choices("claude");
  assert.equal(logged.length, 2);
  assert.equal(logged[0].data.coordinatorMemberId, "claude");
  assert.equal(logged[1].data.coordinatorMemberId, "plain");
  assert.equal(logged[1].data.body, second.body.assistant.coordinatorReason);
  assert.equal(logged[1].data.coordinatorSource, "auto");
});

test("an owner override sticks until the owner clears it", async t => {
  const room = await openRoom(t, [
    { id: "plain", agentType: "generic" },
    { id: "claude", agentType: "claude-code" }
  ]);
  const auto = await room.call("claude", null, "GET");
  assert.equal(auto.body.assistant.coordinatorMemberId, "claude");
  assert.equal(auto.body.assistant.revision, 0);
  const named = await room.call("owner", {
    requestId: "owner-pick", action: "configure", name: "Room",
    coordinatorMemberId: "plain", expectedRevision: 0
  });
  assert.equal(named.status, 200, JSON.stringify(named.body));
  room.advance(HEARTBEAT_STALE_AFTER_MS + 1);
  const stuck = await room.call("plain", null, "GET");
  assert.equal(stuck.status, 200, JSON.stringify(stuck.body));
  assert.equal(stuck.body.assistant.coordinatorMemberId, "plain");
  assert.equal(stuck.body.assistant.coordinatorSource, "owner");
  assert.equal(stuck.body.assistant.coordinatorReason, "The room owner named plain as coordinator.");
  const logged = await room.choices("claude");
  assert.ok(logged.some(event => event.data.coordinatorSource === "owner" && event.data.body === stuck.body.assistant.coordinatorReason));
  const cleared = await room.call("owner", {
    requestId: "owner-clear", action: "configure", name: "Room",
    coordinatorMemberId: null, expectedRevision: 1
  });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  room.store.db.prepare("UPDATE agent_hosts SET last_seen_at=? WHERE agent_id=?").run(room.store.now(), "ai-claude");
  const again = await room.call("owner", null, "GET");
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.assistant.coordinatorMemberId, "claude");
  assert.equal(again.body.assistant.coordinatorSource, "auto");
  assert.match(again.body.assistant.coordinatorReason, /Claude Code \(claude\)/);
  assert.equal((await room.choices("plain")).filter(event => event.data.coordinatorSource === "auto").length, 2);
});

test("an ask wakes the target, and that agent accepts or declines", async t => {
  const { store, call } = await fixture(t);
  connectLive(store, "helper", store.now());
  connectLive(store, "coord", store.now());
  const item = putClaim(store, { id: "ask-1" });
  const asked = await call("coord", { requestId: "wake-ask", action: "ask", workClaimId: item.id, targetMemberId: "helper", note: "look here" });
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  assert.equal(asked.body.result.status, "pending");
  assert.equal(asked.body.result.wake.enqueued, true);
  const helperWakes = store.agentHeartbeats.pendingWakes("ai-helper");
  assert.ok(helperWakes.some(signal => signal.messageId === "work-claim:ask-1:ask:wake-ask" && signal.reason === "ask"));
  const stranger = await call("coord", { requestId: "not-the-target", action: "accept", askRequestId: "wake-ask" });
  assert.equal(stranger.status, 403);
  assert.equal(stranger.body.error.code, "assistant_denied");
  const accepted = await call("helper", { requestId: "wake-accept", action: "accept", askRequestId: "wake-ask" });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.result.status, "accepted");
  assert.equal(accepted.body.result.wake.enqueued, true);
  assert.equal(store.workClaims.get("commons", "ask-1").state, "unclaimed");
  assert.ok(store.agentHeartbeats.pendingWakes("ai-coord").some(signal => signal.messageId === "work-claim:ask-1:ask_accepted:wake-ask"));
  const closed = await call("helper", { requestId: "wake-accept-2", action: "decline", askRequestId: "wake-ask" });
  assert.equal(closed.status, 409);
  assert.equal(closed.body.error.code, "assistant_ask_closed");

  const second = putClaim(store, { id: "ask-2" });
  assert.equal((await call("coord", { requestId: "wake-ask-2", action: "ask", workClaimId: second.id, targetMemberId: "helper" })).body.result.wake.enqueued, true);
  const declined = await call("helper", { requestId: "wake-decline", action: "decline", askRequestId: "wake-ask-2" });
  assert.equal(declined.status, 200, JSON.stringify(declined.body));
  assert.equal(declined.body.result.status, "declined");
  const view = await call("coord", null, "GET");
  assert.equal(view.body.assistant.coordinatorActions.find(entry => entry.id === "wake-ask").status, "accepted");
  assert.equal(view.body.assistant.coordinatorActions.find(entry => entry.id === "wake-ask-2").status, "declined");
});

test("MCP configure, assign, ask and stop use the assistant actions", async t => {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const lead = store.identities.create("Lead");
  const hand = store.identities.create("Hand");
  store.identities.link(ownerKey, "commons", { identityId: lead.identityId, memberId: "lead", displayName: "Lead", permissions: ["accept_work", "complete_work"] });
  store.identities.link(ownerKey, "commons", { identityId: hand.identityId, memberId: "hand", displayName: "Hand", permissions: ["accept_work", "complete_work"] });
  setTier(store.db, "commons", "lead", "t2_standard", { updatedBy: "owner", nowMs: store.now() });
  setTier(store.db, "commons", "hand", "t2_standard", { updatedBy: "owner", nowMs: store.now() });
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const rpc = async (secret, method, params) => {
    const response = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "mcp-1", method, params })
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return body;
  };
  const ownerCall = await fetch(`${origin}/api/rooms/commons/assistant`, {
    method: "POST",
    headers: { authorization: `Bearer ${ownerKey}`, "content-type": "application/json" },
    body: JSON.stringify({ requestId: "mcp-owner-cfg", action: "configure", name: "Room", coordinatorMemberId: "lead", expectedRevision: 0 })
  });
  assert.equal(ownerCall.status, 200, await ownerCall.text());
  const listed = await rpc(lead.secret, "tools/list", { focus: "work" });
  const names = listed.result.tools.map(tool => tool.name);
  for (const name of ["room_assistant_configure", "room_assistant_assign", "room_assistant_ask", "room_assistant_stop", "room_assistant_accept", "room_assistant_decline"]) {
    assert.ok(names.includes(name), name);
  }
  const item = putClaim(store, { id: "mcp-claim" });
  const round = roundOf(item);
  const assigned = await rpc(lead.secret, "tools/call", { name: "room_assistant_assign", arguments: {
    roomId: "commons", requestId: "mcp-assign", workClaimId: "mcp-claim", targetMemberId: "hand",
    expectedClaimedAt: round.expectedClaimedAt, expectedHistoryLength: round.expectedHistoryLength
  } });
  assert.equal(assigned.result?.isError, undefined, JSON.stringify(assigned));
  assert.equal(assigned.result.structuredContent.result.claim.owner, "hand");
  const asked = await rpc(lead.secret, "tools/call", { name: "room_assistant_ask", arguments: {
    roomId: "commons", requestId: "mcp-ask", workClaimId: "mcp-claim", targetMemberId: "hand", note: "a hand"
  } });
  assert.equal(asked.result.structuredContent.result.wake.enqueued, true, JSON.stringify(asked));
  assert.ok(store.agentHeartbeats.pendingWakes(hand.identityId).some(signal => signal.reason === "ask"));
  const accepted = await rpc(hand.secret, "tools/call", { name: "room_assistant_accept", arguments: {
    roomId: "commons", requestId: "mcp-accept", askRequestId: "mcp-ask"
  } });
  assert.equal(accepted.result.structuredContent.result.status, "accepted", JSON.stringify(accepted));
  const stopped = await rpc(lead.secret, "tools/call", { name: "room_assistant_stop", arguments: {
    roomId: "commons", requestId: "mcp-stop"
  } });
  assert.equal(stopped.result.structuredContent.result.stoppedBy, "lead", JSON.stringify(stopped));
  const blocked = await rpc(lead.secret, "tools/call", { name: "room_assistant_ask", arguments: {
    roomId: "commons", requestId: "mcp-ask-after", workClaimId: "mcp-claim", targetMemberId: "hand"
  } });
  assert.equal(blocked.result.isError, true, JSON.stringify(blocked));
});
