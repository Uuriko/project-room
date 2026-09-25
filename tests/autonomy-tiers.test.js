import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { sessionRecord } from "../src/work-item-session.js";
import {
  getTier, setTier, demoteToReadonly, enforceAutonomyTiers, autonomyTierReport,
  AUTONOMY_TIERS, DEFAULT_AUTONOMY_TIER, ENROLLMENT_TIER,
} from "../server/autonomy-tiers.mjs";

// Graduated autonomy tiers: new agent members start t2_standard (full member
// access). The owner can demote one agent to t1_readonly, and that demotion
// is instant (the table is read fresh on every command). No tier row =
// t2_standard: invite redeem, share links, and members from before tiers.

async function serve(t, { start = Date.parse("2026-09-14T12:00:00Z") } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "room-autonomy-tiers-"));
  const clock = { now: start };
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock.now });
  store.initialize(initialRoom("commons"));
  const keys = { owner: store.issueAccessKey("commons", "owner") };
  const send = (actor, type, data, id = randomUUID()) => store.command(keys[actor], "commons", { id, type, data });
  send("owner", T.MEMBER_ADDED, { memberId: "guest", displayName: "Guest human", kind: "human", permissions: [] });
  send("owner", T.MEMBER_ADDED, { memberId: "agent", displayName: "Test agent", kind: "agent", permissions: ["accept_work", "complete_work"], accountableHumanId: "owner" });
  send("owner", T.MEMBER_ADDED, { memberId: "agent2", displayName: "Second agent", kind: "agent", permissions: ["accept_work", "complete_work"], accountableHumanId: "owner" });
  keys.guest = store.issueAccessKey("commons", "guest");
  keys.agent = store.issueAccessKey("commons", "agent");
  keys.agent2 = store.issueAccessKey("commons", "agent2");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { method = "GET", data, token } = {}) => fetch(origin + path, {
    method, headers: { Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) })
  }).then(async res => ({ status: res.status, json: await res.json().catch(() => null) }));
  const state = () => store.room("commons").state;
  const db = () => store.db;
  const propose = (title, accountableMemberId = "agent") => { const workItemId = `w-${randomUUID()}`; send("owner", T.WORK_PROPOSED, { workItemId, title, definitionOfDone: "done", accountableMemberId, mode: "read" }); return workItemId; };
  const startSession = (actor, workItemId, budget) => send(actor, T.SESSION_STARTED,
    { workItemId, expectedRevision: state().workItems[workItemId].revision, ...(budget ? { budget } : {}) });
  // Enrollment is already t2_standard. promote() is the explicit working
  // tier; demote() is the owner's per-agent stop.
  const promote = memberId => setTier(db(), "commons", memberId, "t2_standard", { updatedBy: "owner", nowMs: clock.now });
  const demote = memberId => demoteToReadonly(db(), "commons", memberId, { updatedBy: "owner", nowMs: clock.now });
  return { store, keys, clock, send, request, state, db, propose, startSession, promote, demote };
}

// assert.throws returns undefined on this Node; capture the error instead.
const capture = fn => { try { fn(); } catch (error) { return error; } throw new Error("expected the function to throw"); };

test("constants: two tiers, t2 legacy default, t2 enrollment default", async t => {
  const f = await serve(t);
  assert.deepEqual(AUTONOMY_TIERS, ["t1_readonly", "t2_standard"]);
  assert.equal(DEFAULT_AUTONOMY_TIER, "t2_standard");
  assert.equal(ENROLLMENT_TIER, "t2_standard");
  assert.ok(f);
});

test("enrollment default: new agent members start t2_standard; humans get no row", async t => {
  const f = await serve(t);
  const db = f.db();
  assert.equal(getTier(db, "commons", "agent").autonomyTier, "t2_standard", "agent enrolled at t2");
  assert.equal(getTier(db, "commons", "agent2").autonomyTier, "t2_standard");
  assert.equal(getTier(db, "commons", "guest"), null, "human members get no tier row");
  assert.equal(getTier(db, "commons", "owner"), null);
  f.send("agent", T.MESSAGE_POSTED, { messageId: randomUUID(), body: "full member access" });
  // A re-enrollment attempt for an existing tier keeps the current tier:
  // the hook is ON CONFLICT DO NOTHING, so a demoted agent cannot wash its
  // tier by leaving and rejoining. Exercise the hook directly (a real
  // re-add would fail at apply time, after the hook runs).
  demoteToReadonly(db, "commons", "agent", { updatedBy: "owner", nowMs: f.clock.now });
  enforceAutonomyTiers({ db, roomId: "commons", state: f.state(),
    command: { type: T.MEMBER_ADDED, data: { kind: "agent", memberId: "agent" } },
    actor: { id: "owner", kind: "human" }, nowMs: f.clock.now, fail: () => { throw new Error("must not fail"); } });
  assert.equal(getTier(db, "commons", "agent").autonomyTier, "t1_readonly", "a demotion survives re-enrollment");
});

test("validation: bad tiers and shapes are 422 invalid_autonomy_tier", async t => {
  const f = await serve(t);
  const db = f.db();
  assert.throws(() => setTier(db, "commons", "agent", "t3_admin"), { code: "invalid_autonomy_tier" });
  assert.throws(() => setTier(db, "commons", "agent", null), { code: "invalid_autonomy_tier" });
  assert.throws(() => setTier(db, "commons", "not a member!!", "t1_readonly"), { code: "invalid_autonomy_tier" });
  assert.equal(getTier(db, "commons", "agent").autonomyTier, "t2_standard", "rejected writes leave the enrollment row alone");
});

test("setTier / demoteToReadonly: upsert, frozen rows, instant effect", async t => {
  const f = await serve(t);
  const db = f.db();
  const two = setTier(db, "commons", "agent", "t2_standard", { updatedBy: "owner", nowMs: f.clock.now });
  assert.deepEqual({ ...two }, { roomId: "commons", memberId: "agent", autonomyTier: "t2_standard", updatedAt: f.clock.now, updatedBy: "owner" });
  assert.ok(Object.isFrozen(two), "tier rows are frozen");
  const one = demoteToReadonly(db, "commons", "agent", { updatedBy: "owner", nowMs: f.clock.now + 1 });
  assert.equal(one.autonomyTier, "t1_readonly");
  assert.equal(one.updatedAt, f.clock.now + 1);
  // Instant: no restart, no cache — the next command is refused.
  const refused = capture(() => f.send("agent", T.MESSAGE_POSTED, { messageId: randomUUID(), body: "x" }));
  assert.equal(refused.status, 403);
  assert.equal(refused.code, "agent_readonly");
});

test("enforcement: t1_readonly refuses writes but heartbeats, spend reports and stops land", async t => {
  const f = await serve(t);
  // Enrollment is full access. The owner's demotion is what restricts this agent.
  f.demote("agent");
  const refused = capture(() => f.send("agent", T.MESSAGE_POSTED, { messageId: randomUUID(), body: "chat" }));
  assert.equal(refused.status, 403);
  assert.equal(refused.code, "agent_readonly");
  assert.match(refused.message, /read-only autonomy tier/);
  const w = f.propose("readonly run");
  assert.throws(() => f.startSession("agent", w, { maxSpendCents: 100 }), { status: 403, code: "agent_readonly" }, "t1 cannot start sessions");
  assert.throws(() => f.send("agent", T.WORK_PROPOSED, { workItemId: `w-${randomUUID()}`, title: "x", definitionOfDone: "d", accountableMemberId: "agent", mode: "read" }),
    { status: 403, code: "agent_readonly" }, "t1 cannot propose work");
  // Downgrade path: a session started as t2 keeps reporting under t1, so
  // measured spend stays accurate and the session can always stop.
  f.promote("agent");
  f.startSession("agent", w, { maxSpendCents: 2000 });
  demoteToReadonly(f.db(), "commons", "agent", { updatedBy: "owner", nowMs: f.clock.now });
  f.send("agent", T.SESSION_STATUS_CHANGED, { workItemId: w, expectedRevision: f.state().workItems[w].revision, status: "active", spendCents: 100 });
  assert.equal(sessionRecord(f.state().workItems[w]).spend_cents, 100, "heartbeat with spend report lands under t1");
  f.send("agent", T.SESSION_STOPPED, { workItemId: w, expectedRevision: f.state().workItems[w].revision, status: "done", spendCents: 150 });
  assert.equal(sessionRecord(f.state().workItems[w]).status, "done", "stop lands under t1");
  // Promotion restores full writes immediately.
  f.promote("agent");
  f.send("agent", T.MESSAGE_POSTED, { messageId: randomUUID(), body: "promoted" });
});

test("enforcement: no tier row means t2_standard — migration-safe for existing members", async t => {
  const f = await serve(t);
  // Simulate a member enrolled before tiers existed: no row, full writes.
  f.db().prepare("DELETE FROM agent_autonomy_tiers WHERE room_id=? AND member_id=?").run("commons", "agent");
  assert.equal(getTier(f.db(), "commons", "agent"), null);
  f.send("agent", T.MESSAGE_POSTED, { messageId: randomUUID(), body: "legacy agent" });
  const w = f.propose("legacy run");
  f.startSession("agent", w, { maxSpendCents: 100 });
  assert.equal(sessionRecord(f.state().workItems[w]).status, "processing");
});

test("enforcement: humans are never tier-restricted", async t => {
  const f = await serve(t);
  // The owner can always act, even with a (nonsensical) tier row present.
  setTier(f.db(), "commons", "owner", "t1_readonly", { updatedBy: "owner", nowMs: f.clock.now });
  f.send("owner", T.MESSAGE_POSTED, { messageId: randomUUID(), body: "owner acts" });
  const w = f.propose("owner run", "owner");
  f.startSession("owner", w, { maxSpendCents: 100 });
  f.send("guest", T.MESSAGE_POSTED, { messageId: randomUUID(), body: "human guest acts" });
});

test("enforceAutonomyTiers is a no-op for t2 agents and ignores malformed input", async t => {
  const f = await serve(t);
  // agent2 promoted to t2: enforcement is a silent pass-through.
  f.promote("agent2");
  const t2noop = () => enforceAutonomyTiers({ db: f.db(), roomId: "commons", state: f.state(),
    command: { type: T.MESSAGE_POSTED, data: {} }, actor: { id: "agent2", kind: "agent" }, nowMs: f.clock.now,
    fail: () => { throw new Error("must not fail"); } });
  assert.doesNotThrow(t2noop, "t2 agent: no behavior change");
  // A demoted agent is refused through fail().
  f.demote("agent");
  const refused = capture(() => enforceAutonomyTiers({ db: f.db(), roomId: "commons", state: f.state(),
    command: { type: T.MESSAGE_POSTED, data: {} }, actor: { id: "agent", kind: "agent" }, nowMs: f.clock.now,
    fail: (status, code) => { throw Object.assign(new Error(code), { status, code }); } }));
  assert.equal(refused.code, "agent_readonly");
  assert.equal(refused.status, 403);
  assert.doesNotThrow(() => enforceAutonomyTiers({}), "missing everything is a no-op");
});

test("API: owner can set and read; non-owner gets 403; shape is complete", async t => {
  const f = await serve(t);
  const path = "/api/rooms/commons/operator/agents/agent";
  for (const token of [f.keys.guest, f.keys.agent]) {
    const put = await f.request(path, { method: "PUT", token, data: { autonomyTier: "t2_standard" } });
    assert.equal(put.status, 403, "non-owner PUT refused");
    assert.equal(put.json.error.code, "owner_required");
    const get = await f.request(path, { method: "GET", token });
    assert.equal(get.status, 403, "non-owner GET refused");
    assert.equal(get.json.error.code, "owner_required");
  }
  const missing = await f.request("/api/rooms/commons/operator/agents/nobody", { method: "GET", token: f.keys.owner });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, "member_not_found");
  for (const data of [{ autonomyTier: "t9" }, {}, { autonomyTier: "t2_standard", extra: 1 }, { spendCapCents: 100 }]) {
    const bad = await f.request(path, { method: "PUT", token: f.keys.owner, data });
    assert.equal(bad.status, 422, JSON.stringify(data));
    assert.equal(bad.json.error.code, "invalid_autonomy_tier");
  }
  // A JSON null body never reaches the handler: the shared body parser
  // rejects non-objects with 400 invalid_json.
  const nullBody = await f.request(path, { method: "PUT", token: f.keys.owner, data: null });
  assert.equal(nullBody.status, 400);
  assert.equal(nullBody.json.error.code, "invalid_json");
  // Enrollment row reads back as full member access before the operator restricts anyone.
  const fresh = await f.request(path, { method: "GET", token: f.keys.owner });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.json.tier.autonomyTier, "t2_standard");
  assert.deepEqual(fresh.json.status, { autonomyTier: "t2_standard" });
  assert.equal(typeof fresh.json.evaluatedThrough, "number");
  // Promote then demote through the API; each takes effect immediately.
  const promoted = await f.request(path, { method: "PUT", token: f.keys.owner, data: { autonomyTier: "t2_standard" } });
  assert.equal(promoted.status, 200);
  assert.deepEqual(promoted.json.tier, { roomId: "commons", memberId: "agent", autonomyTier: "t2_standard", updatedAt: f.clock.now, updatedBy: "owner" });
  f.send("agent", T.MESSAGE_POSTED, { messageId: randomUUID(), body: "promoted via api" });
  const demoted = await f.request(path, { method: "PUT", token: f.keys.owner, data: { autonomyTier: "t1_readonly" } });
  assert.equal(demoted.status, 200);
  assert.equal(demoted.json.status.autonomyTier, "t1_readonly");
  assert.throws(() => f.send("agent", T.MESSAGE_POSTED, { messageId: randomUUID(), body: "x" }), { status: 403, code: "agent_readonly" });
});

test("API: an agent room owner can restrict another agent", async t => {
  const f = await serve(t);
  const row = f.db().prepare("SELECT projection FROM rooms WHERE id=?").get("commons");
  const projection = JSON.parse(row.projection);
  projection.room.ownerId = "agent";
  f.db().prepare("UPDATE rooms SET projection=? WHERE id=?").run(JSON.stringify(projection), "commons");
  const path = "/api/rooms/commons/operator/agents/agent2";
  const put = await f.request(path, { method: "PUT", token: f.keys.agent, data: { autonomyTier: "t1_readonly" } });
  assert.equal(put.status, 200, JSON.stringify(put.json));
  assert.equal(put.json.status.autonomyTier, "t1_readonly");
  assert.equal(put.json.tier.updatedBy, "agent");
  const guest = await f.request(path, { method: "PUT", token: f.keys.guest, data: { autonomyTier: "t2_standard" } });
  assert.equal(guest.status, 403);
  assert.equal(guest.json.error.code, "owner_required");
});

test("join paths: invite redeem, share link, and access-request approve can post", async t => {
  const f = await serve(t);
  const post = (token, text) => f.store.command(token, "commons", {
    id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: randomUUID(), body: text },
  });

  const linkedIdentity = f.store.identities.create("Linked agent");
  const linked = f.store.identities.link(f.keys.owner, "commons", {
    identityId: linkedIdentity.identityId, permissions: [],
  });
  assert.equal(getTier(f.db(), "commons", linked.memberId).autonomyTier, "t2_standard", "access-request approve enrolls t2");
  post(linkedIdentity.secret, "approved agent posts");

  const minted = f.store.invites.create(f.keys.owner, "commons", { permissions: ["accept_work"], displayName: "Invited" });
  const redeemed = f.store.invites.redeem(minted.code, { displayName: "Invited Bot" });
  assert.equal(getTier(f.db(), "commons", redeemed.memberId), null, "invite redeem leaves no tier row");
  post(redeemed.secret, "redeemed agent posts");

  const linkToken = randomBytes(32).toString("base64url");
  f.store.shareLinks.create(f.keys.owner, "commons", {
    requestId: randomUUID(), linkToken, expiresAt: f.clock.now + 3600000, maxJoins: 2,
    expectedMemberRevision: f.state().members.owner.revision,
  }, null);
  const shareIdentity = f.store.identities.create("Share agent");
  const joined = f.store.shareLinks.joinAgent(shareIdentity.secret, linkToken, "Share agent");
  assert.equal(getTier(f.db(), "commons", joined.memberId), null, "share-link join leaves no tier row");
  post(shareIdentity.secret, "share-link agent posts");
});

test("autonomyTierReport: effective tier falls back to t2_standard without a row", async t => {
  const f = await serve(t);
  f.db().prepare("DELETE FROM agent_autonomy_tiers WHERE room_id=? AND member_id=?").run("commons", "agent");
  const report = autonomyTierReport(f.db(), "commons", f.state(), "agent", f.clock.now);
  assert.equal(report.tier, null);
  assert.deepEqual(report.status, { autonomyTier: "t2_standard" });
});
