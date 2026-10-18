// #3342 Owner Cockpit slice 1 — GET /api/owner/overview acceptance tests
// (spec project-room-owner-cockpit.md §11, Slice 1 tests 1–7) plus the
// partial-failure, empty-state and exception-signal contracts.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AccessRequests, accessRequestSchema } from "../server/access-requests.mjs";
import { createRateLimiter } from "../server/identity-ratelimit.mjs";
import { bountyEscrowSchema } from "../server/bounty-escrow.mjs";
import { createRoomServer } from "../server/http.mjs";
import { ownerOverview } from "../server/owner-overview.mjs";
import { spendAllowanceReport } from "../server/spend-allowance.mjs";
import { foldSessionEvents } from "../server/usage-summary.mjs";
import { BountyEscrow } from "../server/bounty-escrow.mjs";
import { createReceiptSigner, generateReceiptKeyPair, verifyBountyReceipt } from "../server/bounty-receipts.mjs";
import { agentHeartbeatSchema } from "../server/agent-heartbeats.mjs";
import { makeTestSigner } from "../scripts/helpers/signed-evidence.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";
import { createWork, claimWork } from "../server/work-claims.mjs";
import { claimIdle } from "../server/agent-fleet.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const DAY = 24 * 3600 * 1000;

function setup(t, { serve = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-overview-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("room-a"));
  store.initialize(initialRoom("room-b"));
  store.db.exec(accessRequestSchema);
  store.db.exec(bountyEscrowSchema);
  const accessRequests = new AccessRequests(store, { rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 }) });
  // Bind the account before issuing room keys: a key issued to a human
  // member first creates a provisional account binding that a later
  // bindHumanAccount to a different account would (rightly) refuse.
  store.createAccount("owner-account");
  store.bindHumanAccount("room-a", "owner", "owner-account");
  store.bindHumanAccount("room-b", "owner", "owner-account");
  const keys = { a: store.issueAccessKey("room-a", "owner"), b: store.issueAccessKey("room-b", "owner") };
  const send = (key, roomId, type, data) => store.command(key, roomId, { id: randomUUID(), type, data });
  const accountSession = account => {
    const key = store.issueAccountAccessKey(account);
    const slot = store.createAccountSessionSlot();
    const session = store.loginAccountSession(slot.token, key, 0);
    return { slot, session, headers: { Cookie: `account_session=${slot.token}`, "X-Session-Binding": session.sessionBinding } };
  };
  const owner = accountSession("owner-account");
  const signEvidence = makeTestSigner(store);
  const fixture = { directory, store, accessRequests, keys, send, owner, accountSession, signEvidence };
  if (serve) {
    fixture.server = createRoomServer({ store });
    return new Promise(resolve => fixture.server.listen(0, "127.0.0.1", () => {
      fixture.origin = `http://127.0.0.1:${fixture.server.address().port}`;
      t.after(async () => {
        fixture.server.closeStreams(); fixture.server.closeAllConnections();
        await new Promise(done => fixture.server.close(done));
        store.close(); rmSync(directory, { recursive: true, force: true });
      });
      resolve(fixture);
    }));
  }
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return fixture;
}

function seedRequest(f, roomId, { requestId, displayName = "Joiner", ageMs = 0 } = {}) {
  const identity = f.store.identities.create(displayName);
  const created = f.accessRequests.request(roomId, { identityId: identity.identityId, displayName,
    requestedPermissions: ["accept_work"], requestId }, identity.secret);
  if (ageMs) f.store.db.prepare("UPDATE access_requests SET created_at=? WHERE request_id=?").run(Date.now() - ageMs, requestId);
  return created;
}

function seedVerificationWork(f, roomId = "room-a") {
  const key = roomId === "room-a" ? f.keys.a : f.keys.b;
  f.send(key, roomId, T.MEMBER_ADDED, { memberId: "agent", displayName: "Worker", kind: "agent",
    permissions: ["accept_work", "complete_work", "write_external"], accountableHumanId: "owner" });
  f.send(key, roomId, T.MEMBER_ADDED, { memberId: "verifier", displayName: "Verifier", kind: "human", permissions: [] });
  setTier(f.store.db, roomId, "agent", "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  const agentKey = f.store.issueAccessKey(roomId, "agent");
  const item = () => f.store.room(roomId).state.workItems["w-verify"];
  f.send(key, roomId, T.WORK_PROPOSED, { workItemId: "w-verify", title: "Verify me", definitionOfDone: "done",
    accountableMemberId: "agent", mode: "read", independentVerificationRequired: true, verifierMemberId: "verifier",
    ownerDecisionRequired: false });
  f.send(agentKey, roomId, T.WORK_ACCEPTED, { workItemId: "w-verify", expectedRevision: item().revision });
  f.send(agentKey, roomId, T.WORK_STARTED, { workItemId: "w-verify", expectedRevision: item().revision });
  f.send(agentKey, roomId, T.WORK_COMPLETED, { workItemId: "w-verify", expectedRevision: item().revision,
    summary: "did it", evidenceUrl: "https://example.com/evidence", evidenceVersion: "v1", nextAction: "none",
    signedEvidence: f.signEvidence() });
}

function seedDispute(f, roomId, { bountyId, disputeId, title, amountMillis, openedMs }) {
  const nowIso = new Date().toISOString();
  f.store.db.prepare(`INSERT INTO bounty_records (bounty_id, room_id, title, criteria, amount_millis, poster, state,
    state_changed_ms, deadline_ms, dispute_id, dispute_opened_ms, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(bountyId, roomId, title, "Ship it", amountMillis, "owner", "disputed", openedMs, openedMs + 30 * DAY, disputeId, openedMs, nowIso, nowIso);
  f.store.db.prepare("INSERT INTO bounty_disputes (dispute_id, room_id, body, updated_at) VALUES (?,?,?,?)")
    .run(disputeId, roomId, JSON.stringify({ disputeId, bountyId, bountyAmount: amountMillis, kind: "economic",
      bondSnapshot: 100, state: "opened", tier: 0, raisedBy: "owner", reason: "Work not delivered",
      evidence: [], decider: null, escalations: [], recordedCost: 0, forfeitedBond: 0, resolution: null, unavailable: null }), nowIso);
}

async function getOverview(f, headers, query = "") {
  const response = await fetch(`${f.origin}/api/owner/overview${query}`, { headers });
  return { status: response.status, body: await response.json() };
}

test("1: two owned rooms merge into one sorted Decisions queue with roomId + working actions", async t => {
  const f = await setup(t, { serve: true });
  seedVerificationWork(f, "room-a");
  seedRequest(f, "room-a", { requestId: "ar-a", displayName: "Fresh Joiner" });
  seedRequest(f, "room-b", { requestId: "ar-b", displayName: "Older Joiner", ageMs: 2 * DAY });
  seedDispute(f, "room-b", { bountyId: "bnty-1", disputeId: "disp-1", title: "Landing page build",
    amountMillis: 5000, openedMs: Date.now() - 15 * DAY });

  const { status, body } = await getOverview(f, f.owner.headers);
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.decisions.total, 4);
  assert.equal(body.decisions.waiting, 4);
  assert.equal(body.decisions.overdue, 1);
  assert.deepEqual(body.rooms, { considered: 2, included: 2, label: null, nextCursor: null });
  assert.deepEqual(body.roomErrors, []);

  const items = body.decisions.items;
  // §4.2: overdue dispute first; then nearest consequence (room-b request
  // lapses in 5d, room-a request in 7d); the deadline-free verification last.
  assert.deepEqual(items.map(item => [item.kind, item.roomId]), [
    ["dispute", "room-b"],
    ["access_request", "room-b"],
    ["access_request", "room-a"],
    ["verification", "room-a"],
  ]);
  for (const item of items) {
    assert.equal(typeof item.roomId, "string");
    assert.ok(item.actions.length >= 1, `${item.kind} carries an action`);
    assert.ok(item.consequence, `${item.kind} carries a consequence line`);
    assert.equal(typeof item.ageMs, "number");
  }
  const [dispute, olderRequest, freshRequest] = items;
  assert.equal(dispute.amountMillis, 5000);
  assert.equal(dispute.bountyId, "bnty-1");
  assert.ok(dispute.timeToConsequenceMs < 0, "dispute is past its default deadline");
  assert.equal(dispute.actions[0].path, "/api/rooms/room-b/bounties");
  assert.ok(Math.abs(olderRequest.timeToConsequenceMs - 5 * DAY) < 60_000);
  assert.deepEqual(olderRequest.actions.map(action => action.action), ["approve", "deny"]);
  assert.equal(olderRequest.actions[0].path, "/api/rooms/room-b/access-requests/ar-b/decide");
  assert.ok(Math.abs(freshRequest.timeToConsequenceMs - 7 * DAY) < 60_000);
  // The overdue dispute is also a critical exception (defaults on its own).
  assert.ok(body.exceptions.items.some(item => item.kind === "dispute_nearing_default" && item.severity === "critical"));
});

test("2: non-owner account is refused; a manage_members admin sees only access requests", async t => {
  const f = await setup(t, { serve: true });
  seedRequest(f, "room-a", { requestId: "ar-a", displayName: "Joiner" });
  seedDispute(f, "room-a", { bountyId: "bnty-a", disputeId: "disp-a", title: "Secret dispute",
    amountMillis: 9000, openedMs: Date.now() - DAY });
  f.send(f.keys.a, "room-a", T.MEMBER_ADDED, { memberId: "member", displayName: "Plain", kind: "human", permissions: [] });
  f.send(f.keys.a, "room-a", T.MEMBER_ADDED, { memberId: "admin", displayName: "Avery", kind: "human", permissions: ["manage_members"] });
  f.store.createAccount("member-account"); f.store.bindHumanAccount("room-a", "member", "member-account");
  f.store.createAccount("admin-account"); f.store.bindHumanAccount("room-a", "admin", "admin-account");

  const member = await getOverview(f, f.accountSession("member-account").headers);
  assert.equal(member.status, 403, JSON.stringify(member.body));
  assert.equal(member.body.error.code, "owner_required");

  const admin = await getOverview(f, f.accountSession("admin-account").headers);
  assert.equal(admin.status, 200, JSON.stringify(admin.body));
  assert.equal(admin.body.decisions.total, 1);
  assert.equal(admin.body.decisions.items[0].kind, "access_request");
  assert.equal(admin.body.decisions.items[0].roomId, "room-a");
  // §10: an admin-everywhere viewer gets the queue only — no exceptions.
  assert.equal(admin.body.exceptions.total, 0);
});

test("3: approving from the Cockpit hits the existing decide endpoint and the item leaves the queue", async t => {
  const f = await setup(t, { serve: true });
  seedRequest(f, "room-a", { requestId: "ar-a", displayName: "Joiner" });
  const before = await getOverview(f, f.owner.headers);
  const item = before.body.decisions.items.find(entry => entry.kind === "access_request");
  assert.ok(item, "the request is in the queue");
  const approve = item.actions.find(action => action.action === "approve");

  const response = await fetch(`${f.origin}${approve.path}`, { method: approve.method,
    headers: { ...f.owner.headers, "X-Project-Room-Auth": "account", "X-CSRF-Token": f.owner.session.csrf,
      Origin: f.origin, "Content-Type": "application/json" },
    body: JSON.stringify(approve.body) });
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));

  const after = await getOverview(f, f.owner.headers);
  assert.equal(after.body.decisions.items.some(entry => entry.id === "ar-a"), false);
  assert.equal(after.body.decisions.total, 0);
});

test("4: one broken room is a stub in roomErrors + Exceptions; totals are labelled N of M", async t => {
  const f = setup(t);
  seedRequest(f, "room-a", { requestId: "ar-a", displayName: "Joiner" });
  const sabotaged = new Proxy(f.store, { get(target, prop) {
    if (prop === "room") return id => {
      if (id === "room-b") { const error = new Error("projection exploded"); error.code = "projection_broken"; throw error; }
      return target.room(id);
    };
    const value = target[prop];
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const doc = ownerOverview({ store: sabotaged, accessRequests: f.accessRequests, jobHealth: null },
    f.owner.slot.token, f.owner.session.sessionBinding, Date.now(), {});
  assert.equal(doc.rooms.considered, 2);
  assert.equal(doc.rooms.included, 1);
  assert.equal(doc.rooms.label, "1 of 2 rooms");
  assert.deepEqual(doc.roomErrors, [{ roomId: "room-b", error: "projection_broken" }]);
  assert.ok(doc.exceptions.items.some(item => item.kind === "room_read_failed" && item.roomId === "room-b" && item.severity === "warn"));
  assert.ok(doc.decisions.items.every(item => item.roomId === "room-a"));
  assert.equal(doc.decisions.total, 1);
});

test("5: an open dispute carries amount + time-to-default; inside 48h it is also a critical exception", async t => {
  const f = await setup(t, { serve: true });
  seedDispute(f, "room-b", { bountyId: "bnty-9", disputeId: "disp-9", title: "API integration",
    amountMillis: 7500, openedMs: Date.now() - 13.5 * DAY });
  const { status, body } = await getOverview(f, f.owner.headers);
  assert.equal(status, 200, JSON.stringify(body));
  const dispute = body.decisions.items.find(item => item.kind === "dispute");
  assert.ok(dispute);
  assert.equal(dispute.amountMillis, 7500);
  assert.ok(Math.abs(dispute.timeToConsequenceMs - 0.5 * DAY) < 60_000, `time-to-default ~12h, got ${dispute.timeToConsequenceMs}`);
  assert.equal(body.decisions.overdue, 0);
  const exception = body.exceptions.items.find(item => item.kind === "dispute_nearing_default");
  assert.ok(exception);
  assert.equal(exception.severity, "critical");
  assert.equal(exception.subjectId, "disp-9");
});

test("6: a request past its TTL is absent from Decisions and counted as lapsed in Exceptions", async t => {
  const f = await setup(t, { serve: true });
  seedRequest(f, "room-a", { requestId: "ar-old", displayName: "Ghost", ageMs: 8 * DAY });
  seedRequest(f, "room-a", { requestId: "ar-new", displayName: "Fresh" });
  const { status, body } = await getOverview(f, f.owner.headers);
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body.decisions.items.map(item => item.id), ["ar-new"]);
  const lapsed = body.exceptions.items.find(item => item.kind === "lapsed_access_requests");
  assert.ok(lapsed, JSON.stringify(body.exceptions));
  assert.equal(lapsed.count, 1);
  assert.equal(lapsed.severity, "info");
});

test("7: no response object mixes cents and milli-credit fields", async t => {
  const f = await setup(t, { serve: true });
  seedVerificationWork(f, "room-a");
  seedRequest(f, "room-a", { requestId: "ar-a" });
  seedDispute(f, "room-b", { bountyId: "bnty-1", disputeId: "disp-1", title: "Build",
    amountMillis: 5000, openedMs: Date.now() - DAY });
  const { body } = await getOverview(f, f.owner.headers);
  const walk = (value, path) => {
    if (Array.isArray(value)) return value.forEach((entry, i) => walk(entry, `${path}/${i}`));
    if (value && typeof value === "object") {
      const keys = Object.keys(value);
      assert.ok(!(keys.some(key => /Cents/.test(key)) && keys.some(key => /Millis/.test(key))),
        `mixed currency fields at ${path}: ${keys.join(",")}`);
      for (const [key, entry] of Object.entries(value)) walk(entry, `${path}/${key}`);
    }
  };
  walk(body, "");
  const dispute = body.decisions.items.find(item => item.kind === "dispute");
  assert.equal(dispute.amountMillis, 5000);
  assert.equal("amountCents" in dispute, false);
});

test("empty owned rooms: honest zeros, no fabricated sections", async t => {
  const f = await setup(t, { serve: true });
  const { status, body } = await getOverview(f, f.owner.headers);
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.decisions.total, 0);
  assert.deepEqual(body.decisions.items, []);
  assert.equal(body.decisions.overdue, 0);
  assert.equal(body.exceptions.total, 0);
  assert.deepEqual(body.roomErrors, []);
  assert.equal(body.rooms.label, null);
});

test("exceptions: failing jobs grade by consecutive failures; stale claims warn then go critical", t => {
  const f = setup(t);
  f.send(f.keys.a, "room-a", T.MEMBER_ADDED, { memberId: "agent", displayName: "Worker", kind: "agent",
    permissions: ["accept_work"], accountableHumanId: "owner" });
  const now = Date.now();
  let warnClaim = createWork({ id: "claim-warn", title: "Stale warm" }, { now: new Date(now - 3 * 3600 * 1000), agentId: "owner" });
  warnClaim = claimWork(warnClaim, "agent", { now: new Date(now - 3 * 3600 * 1000) });
  f.store.workClaims.set("room-a", warnClaim);
  let criticalClaim = createWork({ id: "claim-critical", title: "Stale cold" }, { now: new Date(now - 25 * 3600 * 1000), agentId: "owner" });
  criticalClaim = claimWork(criticalClaim, "agent", { now: new Date(now - 25 * 3600 * 1000) });
  f.store.workClaims.set("room-a", criticalClaim);

  const doc = ownerOverview({ store: f.store, accessRequests: f.accessRequests,
    jobHealth: () => [
      { name: "integrity", enabled: true, consecutiveFailures: 1, lastErrorAt: new Date(now).toISOString() },
      { name: "claim-prs", enabled: true, consecutiveFailures: 4, lastErrorAt: new Date(now).toISOString() },
      { name: "reseeding", enabled: true, consecutiveFailures: 1, lastErrorAt: new Date(now).toISOString() },
      { name: "healthy", enabled: true, consecutiveFailures: 0, lastErrorAt: null },
    ] }, f.owner.slot.token, f.owner.session.sessionBinding, now, {});
  const byKind = kind => doc.exceptions.items.filter(item => item.kind === kind);
  const jobs = Object.fromEntries(byKind("job_health").map(item => [item.subjectId, item.severity]));
  assert.deepEqual(jobs, { integrity: "critical", "claim-prs": "critical", reseeding: "warn" });
  const stale = Object.fromEntries(byKind("stale_claim").map(item => [item.subjectId, item.severity]));
  assert.deepEqual(stale, { "claim-warn": "warn", "claim-critical": "critical" });
  // Severity order: criticals lead the feed.
  assert.equal(doc.exceptions.items[0].severity, "critical");
});

test("window parameter is validated", async t => {
  const f = await setup(t, { serve: true });
  const bad = await getOverview(f, f.owner.headers, "?window=99d");
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error.code, "invalid_overview_query");
  const ok = await getOverview(f, f.owner.headers, "?window=24h");
  assert.equal(ok.status, 200);
  assert.equal(ok.body.window.key, "24h");
});

// --- Slice 2 (#3343): Money + Roster ---------------------------------------

function seedAgentMember(f, roomId, memberId = "agent", displayName = "Worker") {
  const key = roomId === "room-a" ? f.keys.a : f.keys.b;
  f.send(key, roomId, T.MEMBER_ADDED, { memberId, displayName, kind: "agent",
    permissions: ["accept_work", "complete_work", "write_external"], accountableHumanId: "owner" });
  setTier(f.store.db, roomId, memberId, "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  return f.store.issueAccessKey(roomId, memberId);
}

function proposeAndAccept(f, roomId, agentKey, workItemId, title) {
  const key = roomId === "room-a" ? f.keys.a : f.keys.b;
  f.send(key, roomId, T.WORK_PROPOSED, { workItemId, title, definitionOfDone: "done",
    accountableMemberId: "agent", mode: "read", independentVerificationRequired: false,
    ownerDecisionRequired: false });
  const revision = () => f.store.room(roomId).state.workItems[workItemId].revision;
  f.send(agentKey, roomId, T.WORK_ACCEPTED, { workItemId, expectedRevision: revision() });
  return revision;
}

function runSession(f, roomId, agentKey, workItemId, revision, body) {
  return f.store.mutateWorkSession(agentKey, roomId,
    { requestId: randomUUID(), workItemId, expectedRevision: revision(), action: "set_status", ...body });
}

test("slice2-1: Panel C matches spendAllowanceReport exactly (golden comparison)", async t => {
  const f = await setup(t, { serve: true });
  const agentKey = seedAgentMember(f, "room-a");
  f.send(f.keys.a, "room-a", T.ROOM_SPEND_ALLOWANCE_SET, { allowanceCents: 10000, periodDays: 30 });
  const revision = proposeAndAccept(f, "room-a", agentKey, "w-panel", "Panel run");
  runSession(f, "room-a", agentKey, "w-panel", revision, { status: "processing", budget: { maxSpendCents: 6120 } });

  const golden = spendAllowanceReport(f.store.room("room-a").state, Date.now());
  assert.equal(golden.committedCents, 6120);
  const { status, body } = await getOverview(f, f.owner.headers);
  assert.equal(status, 200, JSON.stringify(body));
  const room = body.money.cents.rooms.find(entry => entry.roomId === "room-a");
  assert.ok(room, "room-a Panel C entry exists");
  assert.equal(room.allowanceCents, golden.allowance.allowanceCents);
  assert.equal(room.spentCents, golden.spentCents);
  assert.equal(room.reservedCents, golden.reservedCents);
  assert.equal(room.heldCents, golden.heldCents);
  assert.equal(room.committedCents, golden.committedCents);
  assert.equal(room.headroomCents, golden.headroomCents);
  assert.equal(room.overCents, golden.overCents);
  assert.equal(room.burnFraction, 6120 / 10000);
  assert.equal(body.money.cents.source, "agent-reported");
  // The attribution fold agrees with foldSessionEvents on the same events.
  const rows = f.store.db.prepare(
    `SELECT json_extract(body,'$.type') AS type, json_extract(body,'$.data.workItemId') AS workItemId,
            json_extract(body,'$.data.spendCents') AS spendCents, json_extract(body,'$.data.budgetEnforced') AS budgetEnforced
     FROM events WHERE room_id='room-a' AND json_extract(body,'$.type') IN ('session.started','session.status_changed','session.stopped')
     ORDER BY sequence`).all();
  const folded = foldSessionEvents(rows);
  assert.equal(body.money.cents.totals.reportedCents, folded.spend.reportedCents);
  assert.equal(body.money.cents.totals.unreportedAttempts, folded.spend.sessionsUnreported);
});

test("slice2-2: Panel R locked total equals the escrow-ledger sum; no field mixes the panels", async t => {
  const f = await setup(t, { serve: true });
  const nowIso = new Date().toISOString();
  f.store.db.prepare(`INSERT INTO bounty_records (bounty_id, room_id, title, criteria, amount_millis, poster, state,
    state_changed_ms, deadline_ms, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run("bnty-funded", "room-a", "Funded work", "Ship it", 4000, "owner", "funded", Date.now(), Date.now() + 30 * DAY, nowIso, nowIso);
  seedDispute(f, "room-a", { bountyId: "bnty-disputed", disputeId: "disp-r", title: "Disputed work",
    amountMillis: 2500, openedMs: Date.now() - DAY });

  const ledgerSum = f.store.db.prepare(
    `SELECT COALESCE(SUM(amount_millis),0) AS total FROM bounty_records
     WHERE room_id='room-a' AND state IN ('funded','claimed','submitted','accepted','disputed')`).get().total;
  assert.equal(ledgerSum, 6500);
  const { status, body } = await getOverview(f, f.owner.headers);
  assert.equal(status, 200, JSON.stringify(body));
  const room = body.money.credits.rooms.find(entry => entry.roomId === "room-a");
  assert.equal(room.lockedMillis, ledgerSum);
  assert.equal(room.disputedMillis, 2500);
  assert.deepEqual(room.byGroup.funded, { count: 1, amountMillis: 4000 });
  assert.deepEqual(room.byGroup["in-review"], { count: 1, amountMillis: 2500 });
  assert.equal(body.money.credits.totals.lockedMillis, 6500);
  assert.equal(body.money.credits.unit, "milli-credits");
  assert.equal(body.money.cents.unit, "cents");
  const walk = (value, path) => {
    if (Array.isArray(value)) return value.forEach((entry, i) => walk(entry, `${path}/${i}`));
    if (value && typeof value === "object") {
      const keys = Object.keys(value);
      assert.ok(!(keys.some(key => /Cents/.test(key)) && keys.some(key => /Millis/.test(key))),
        `mixed currency fields at ${path}: ${keys.join(",")}`);
      for (const [key, entry] of Object.entries(value)) walk(entry, `${path}/${key}`);
    }
  };
  walk(body.money, "money"); walk(body.roster, "roster");
});

test("slice2-3: an unreported session renders unknown everywhere, is counted, and is never zeroed", async t => {
  const f = await setup(t, { serve: true });
  const agentKey = seedAgentMember(f, "room-b");
  const revision = proposeAndAccept(f, "room-b", agentKey, "w-silent", "Silent run");
  runSession(f, "room-b", agentKey, "w-silent", revision, { status: "processing" });

  const { status, body } = await getOverview(f, f.owner.headers);
  assert.equal(status, 200, JSON.stringify(body));
  const task = body.money.cents.tasks.find(entry => entry.workItemId === "w-silent");
  assert.ok(task, "the silent task has a Panel C row");
  assert.equal(task.spendCents, "unknown");
  assert.equal(task.unreportedAttempts, 1);
  assert.ok(!JSON.stringify(task).includes('"spendCents":0'), "no zero is rendered for the unreported attempt");
  const agentCut = body.money.cents.agents.find(entry => entry.roomId === "room-b" && entry.memberId === "agent");
  assert.equal(agentCut.periodCostCents, "unknown");
  assert.equal(agentCut.unreportedAttempts, 1);
  assert.equal(body.money.cents.totals.reportedCents, "unknown");
  assert.ok(body.money.cents.totals.unreportedAttempts >= 1);
  const rosterRow = body.roster.rows.find(entry => entry.roomId === "room-b" && entry.memberId === "agent");
  assert.equal(rosterRow.periodCostCents, "unknown");
  assert.equal(rosterRow.unreportedAttempts, 1);
});

test("slice2-4: cost per accepted outcome shows the ratio at n=2 and suppresses it at n=0", async t => {
  const f = await setup(t, { serve: true });
  const agentKey = seedAgentMember(f, "room-a");
  const complete = workItemId => {
    const revision = proposeAndAccept(f, "room-a", agentKey, workItemId, `Done ${workItemId}`);
    f.send(agentKey, "room-a", T.WORK_STARTED, { workItemId, expectedRevision: revision() });
    const rev2 = () => f.store.room("room-a").state.workItems[workItemId].revision;
    f.send(agentKey, "room-a", T.WORK_COMPLETED, { workItemId, expectedRevision: rev2(),
      summary: "did it", evidenceUrl: "https://example.com/evidence", evidenceVersion: "v1",
      nextAction: "none", signedEvidence: f.signEvidence() });
  };
  complete("w-done-1"); complete("w-done-2");
  const revision = proposeAndAccept(f, "room-a", agentKey, "w-spend", "Spend run");
  runSession(f, "room-a", agentKey, "w-spend", revision, { status: "processing", budget: { maxSpendCents: 2000 } });
  const revSpend = () => f.store.room("room-a").state.workItems["w-spend"].revision;
  runSession(f, "room-a", agentKey, "w-spend", revSpend, { status: "active", spendCents: 1000 });
  runSession(f, "room-a", agentKey, "w-spend", revSpend, { status: "done", spendCents: 1000 });

  const { status, body } = await getOverview(f, f.owner.headers);
  assert.equal(status, 200, JSON.stringify(body));
  const outcome = body.money.cents.costPerAcceptedOutcome;
  assert.equal(outcome.status, "ok");
  assert.equal(outcome.acceptedOutcomes, 2);
  assert.equal(outcome.ratioCents, 500);
  assert.equal(outcome.label, "$5.00 / accepted outcome (n=2, 0 unreported)");
  const rosterRow = body.roster.rows.find(entry => entry.roomId === "room-a" && entry.memberId === "agent");
  assert.equal(rosterRow.lifetimeAcceptedOutcomes, 2);

  const empty = await setup(t, { serve: true });
  const none = await getOverview(empty, empty.owner.headers);
  assert.equal(none.body.money.cents.costPerAcceptedOutcome.status, "no_outcomes");
  assert.equal(none.body.money.cents.costPerAcceptedOutcome.ratioCents, null);
  assert.equal(none.body.money.cents.costPerAcceptedOutcome.label, "no accepted outcomes in window");
});

test("slice2-5: roster derivations agree with presence() and claimIdle on the same fixture", async t => {
  const f = await setup(t, { serve: true });
  const agentKey = seedAgentMember(f, "room-a", "agent", "Working Agent");
  seedAgentMember(f, "room-a", "agent-stalled", "Stalled Agent");
  seedAgentMember(f, "room-a", "agent-offline", "Offline Agent");

  const revision = proposeAndAccept(f, "room-a", agentKey, "w-live", "Live task");
  runSession(f, "room-a", agentKey, "w-live", revision, { status: "processing" });

  const now = Date.now();
  let claim = createWork({ id: "claim-stale", title: "Untouched claim" }, { now: new Date(now - 3 * 3600 * 1000), agentId: "owner" });
  claim = claimWork(claim, "agent-stalled", { now: new Date(now - 3 * 3600 * 1000) });
  f.store.workClaims.set("room-a", claim);
  assert.equal(claimIdle(claim, now), true, "fixture claim is idle per claimIdle");

  const identity = f.store.identities.create("Offline Agent");
  f.store.db.exec(agentHeartbeatSchema);
  f.store.db.prepare("INSERT INTO identity_links (room_id, member_id, identity_id, linked_at) VALUES (?,?,?,?)")
    .run("room-a", "agent-offline", identity.identityId, now);
  f.store.agentHeartbeats.heartbeat({ agentId: identity.identityId, hostId: "host-offline", mode: "pull-only" });
  f.store.db.prepare("UPDATE agent_hosts SET last_seen_at=? WHERE agent_id=?")
    .run(now - 3600 * 1000, identity.identityId);

  const presenceDoc = f.store.presence(f.keys.a, "room-a", []);
  const presenceAgent = presenceDoc.members.find(member => member.memberId === "agent");
  assert.equal(presenceAgent.state, "working");
  assert.equal(presenceAgent.workingOn[0].title, "Live task");
  const presenceOffline = presenceDoc.members.find(member => member.memberId === "agent-offline");
  assert.equal(presenceOffline.presence.status, "offline");

  const { status, body } = await getOverview(f, f.owner.headers);
  assert.equal(status, 200, JSON.stringify(body));
  const rowOf = memberId => body.roster.rows.find(entry => entry.roomId === "room-a" && entry.memberId === memberId);
  const working = rowOf("agent");
  assert.equal(working.workState, "working");
  assert.equal(working.currentWork.title, "Live task");
  assert.equal(working.currentWork.title, presenceAgent.workingOn[0].title);
  assert.equal(working.identityId, null);
  assert.equal(rowOf("agent-stalled").workState, "stalled");
  const offline = rowOf("agent-offline");
  assert.equal(offline.workState, "offline");
  assert.equal(offline.hostStatus, "offline");
  assert.equal(offline.identityId, identity.identityId);
  assert.equal(offline.hostStatus, presenceOffline.presence.status);
  assert.equal(body.roster.counts.working, 1);
  assert.equal(body.roster.counts.stalled, 1);
  assert.equal(body.roster.counts.offline, 1);
  // Owner-only: the human owner never appears as a roster row.
  assert.ok(body.roster.rows.every(entry => entry.memberId !== "owner"));
});

test("slice2-6: the roster last-receipt payload names a receipt verifyBountyReceipt accepts", async t => {
  const f = await setup(t, { serve: true });
  seedAgentMember(f, "room-a", "agent", "Receipt Agent");
  const keyPair = generateReceiptKeyPair();
  const signer = createReceiptSigner({ seedHex: keyPair.seedHex, ref: "test-operator" });
  const escrow = new BountyEscrow(f.store, { now: () => Date.now(), receipts: signer });
  escrow.ensureGenesis("room-a");
  const posted = escrow.postBounty("room-a", { poster: "owner", title: "Receipt work", criteria: "done",
    amount: 5, deadline: new Date(Date.now() + 30 * DAY).toISOString() });
  escrow.fundBounty("room-a", posted.bounty.bountyId, { funder: "owner" });
  const claimed = escrow.claimBounty("room-a", posted.bounty.bountyId, { claimant: "agent" });
  const receipt = claimed.receipt.signed[0];
  assert.ok(receipt, "claim issued a signed receipt");
  const journal = { entryHash: id => f.store.db.prepare(
    "SELECT hash FROM bounty_journal WHERE entry_id=?").get(id)?.hash ?? null };
  assert.equal(verifyBountyReceipt(receipt, { expectedPubkey: keyPair.pubkeyHex, journal }).ok, true);
  const tampered = { ...receipt, amountMillis: "1" };
  assert.equal(verifyBountyReceipt(tampered, { expectedPubkey: keyPair.pubkeyHex, journal }).ok, false);

  const { status, body } = await getOverview(f, f.owner.headers);
  assert.equal(status, 200, JSON.stringify(body));
  const row = body.roster.rows.find(entry => entry.roomId === "room-a" && entry.memberId === "agent");
  assert.ok(row.lastReceipt, "roster row carries the last receipt linkage");
  assert.equal(row.lastReceipt.receiptId, receipt.receiptId);
  assert.equal(row.lastReceipt.bountyId, posted.bounty.bountyId);
  assert.ok(row.lastReceipt.drill.path.includes(posted.bounty.bountyId));
  // Panel R sees the same escrow: the funded+claimed bounty is locked, and
  // the agent's bond sits in its journal balance.
  const creditRoom = body.money.credits.rooms.find(entry => entry.roomId === "room-a");
  assert.equal(creditRoom.lockedMillis, 5000);
  const agentBalance = body.money.credits.agents.find(entry => entry.roomId === "room-a" && entry.accountId === "agent");
  assert.ok(agentBalance && agentBalance.lockedMillis >= 1000, "claim bond is locked for the agent");
});

test("slice2-admin: an admin-everywhere viewer gets no money and no roster", async t => {
  const f = await setup(t, { serve: true });
  seedAgentMember(f, "room-a");
  f.send(f.keys.a, "room-a", T.MEMBER_ADDED, { memberId: "admin", displayName: "Avery", kind: "human", permissions: ["manage_members"] });
  f.store.createAccount("admin2-account"); f.store.bindHumanAccount("room-a", "admin", "admin2-account");
  const admin = await getOverview(f, f.accountSession("admin2-account").headers);
  assert.equal(admin.status, 200, JSON.stringify(admin.body));
  assert.equal(admin.body.money, null);
  assert.equal(admin.body.roster, null);
});
