import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore, PILOT_LIMITS } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { foldSessionEvents, parseUsageDays, USAGE_DEFAULT_DAYS, USAGE_MAX_DAYS } from "../server/usage-summary.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";

// F5: read-only usage summary per room.
const DAY = 86400000;

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-usage-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  store.initialize(initialRoom("lab"));
  let now = Date.parse("2026-09-14T12:00:00.000Z");
  store.now = () => now;
  const clock = { advance: ms => { now += ms; }, get: () => now };
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = (path, token) => fetch(origin + path, { headers: { Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  const cmd = (token, type, data, roomId = "commons") => store.command(token, roomId, { id: randomUUID(), type, data });
  const usage = async (query = "", token = ownerKey) => {
    const res = await get(`/api/rooms/commons/usage${query}`, token);
    return { status: res.status, body: await res.json() };
  };
  return { origin, ownerKey, store, get, cmd, usage, clock };
}

test("agents are never counted as human seats; identities are counted separately", async t => {
  const { ownerKey, store, cmd, usage } = await serve(t);
  cmd(ownerKey, T.MEMBER_ADDED, { memberId: "maya", displayName: "Maya", kind: "human", permissions: ["accept_work"] });
  cmd(ownerKey, T.MEMBER_ADDED, { memberId: "bot-a", displayName: "Bot A", kind: "agent", permissions: ["accept_work"] });
  cmd(ownerKey, T.MEMBER_ADDED, { memberId: "bot-b", displayName: "Bot B", kind: "agent", permissions: ["accept_work"] });
  const identity = store.identities.create("Roaming agent");
  store.identities.link(ownerKey, "commons", { identityId: identity.identityId, permissions: ["accept_work"] });

  const before = await usage();
  assert.equal(before.status, 200);
  assert.equal(before.body.roomId, "commons");
  assert.deepEqual(before.body.members, { humans: 2, agents: 3, inactive: 0, agentIdentities: 1 });

  // Deactivating an agent moves it out of the active count without touching seats.
  const botB = store.roomAuthority("commons").members["bot-b"];
  cmd(ownerKey, T.MEMBER_ACCESS_CHANGED, { memberId: "bot-b", expectedMemberRevision: botB.revision, permissions: botB.permissions, active: false });
  const after = await usage();
  assert.deepEqual(after.body.members, { humans: 2, agents: 2, inactive: 1, agentIdentities: 1 });
  // Caps count every member record the store counts, active or not.
  assert.equal(after.body.caps.members.used, 5);
});

test("caps match the store's pilot limits and headroom is what the store still accepts", async t => {
  const { ownerKey, cmd, usage, store } = await serve(t);
  const first = (await usage()).body;
  assert.equal(first.caps.members.limit, PILOT_LIMITS.membersPerRoom);
  assert.equal(first.caps.events.limit, PILOT_LIMITS.eventsPerRoom);
  assert.equal(first.caps.workItems.limit, PILOT_LIMITS.workItemsPerRoom);
  assert.equal(first.caps.projectionBytes.limit, PILOT_LIMITS.projectionBytes);
  assert.equal(first.caps.events.used, store.room("commons").sequence);
  assert.equal(first.caps.events.remaining, PILOT_LIMITS.eventsPerRoom - first.caps.events.used);
  assert.equal(first.caps.members.used, 1);
  assert.equal(first.caps.members.remaining, PILOT_LIMITS.membersPerRoom - 1);
  assert.ok(first.caps.projectionBytes.used > 0 && first.caps.projectionBytes.remaining < PILOT_LIMITS.projectionBytes);

  // Behavioural match: the reported headroom is exactly how many members the store still admits.
  let added = 0;
  for (;;) {
    try { cmd(ownerKey, T.MEMBER_ADDED, { memberId: `seat-${added}`, displayName: `Seat ${added}`, kind: "agent", permissions: ["accept_work"] }); added++; }
    catch (error) { assert.equal(error.code, "pilot_limit"); break; }
  }
  assert.equal(added, first.caps.members.remaining);
  const full = (await usage()).body;
  assert.equal(full.caps.members.used, PILOT_LIMITS.membersPerRoom);
  assert.equal(full.caps.members.remaining, 0);
  assert.equal(full.members.humans, 1, "seats filled by agents never become human seats");
});

test("sessions and spend follow the period; unreported spend is unknown, not zero", async t => {
  const { ownerKey, store, cmd, usage, clock } = await serve(t);
  cmd(ownerKey, T.MEMBER_ADDED, { memberId: "agent", displayName: "Agent", kind: "agent", permissions: ["accept_work", "complete_work"] });
  // Graduated autonomy tiers: the fixture agent is operator-promoted so the
  // usage test exercises it as a working agent.
  setTier(store.db, "commons", "agent", "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  const agentKey = store.issueAccessKey("commons", "agent");
  const propose = title => {
    const workItemId = `w-${randomUUID()}`;
    cmd(ownerKey, T.WORK_PROPOSED, { workItemId, title, definitionOfDone: "done", accountableMemberId: "agent", mode: "read" });
    cmd(agentKey, T.WORK_ACCEPTED, { workItemId, expectedRevision: 0 });
    return workItemId;
  };
  const session = (workItemId, body) => store.mutateWorkSession(agentKey, "commons", { requestId: randomUUID(), workItemId, action: "set_status", ...body });
  const revision = workItemId => store.room("commons").state.workItems[workItemId].revision;

  // An old session, well outside a 30-day window: started, spend reported,
  // stopped. Recorded 45 days back (keys live at most 30 days, so the clock
  // rewinds for the old run and returns rather than running ahead).
  clock.advance(-45 * DAY);
  const old = propose("Old run");
  session(old, { expectedRevision: revision(old), status: "processing" });
  session(old, { expectedRevision: revision(old), status: "active", spendCents: 500 });
  session(old, { expectedRevision: revision(old), status: "done" });
  clock.advance(45 * DAY);

  // A fresh session that never reports spend.
  const silent = propose("Silent run");
  session(silent, { expectedRevision: revision(silent), status: "processing" });
  const empty = (await usage()).body;
  assert.equal(empty.period.days, USAGE_DEFAULT_DAYS);
  assert.equal(empty.period.since, new Date(clock.get() - USAGE_DEFAULT_DAYS * DAY).toISOString());
  assert.deepEqual(empty.sessions, { started: 1, stopped: 0, budgetStops: 0 });
  assert.deepEqual(empty.spend, { reportedCents: "unknown", sessionsReported: 0, sessionsUnreported: 1 });

  // A reporting session: cumulative reports count once, at their last value.
  const paid = propose("Paid run");
  session(paid, { expectedRevision: revision(paid), status: "processing", budget: { maxSpendCents: 1000 } });
  session(paid, { expectedRevision: revision(paid), status: "active", spendCents: 60 });
  session(paid, { expectedRevision: revision(paid), status: "processing", spendCents: 90 });
  session(paid, { expectedRevision: revision(paid), status: "done", spendCents: 120 });
  const partial = (await usage()).body;
  assert.deepEqual(partial.sessions, { started: 2, stopped: 1, budgetStops: 0 });
  assert.deepEqual(partial.spend, { reportedCents: 120, sessionsReported: 1, sessionsUnreported: 1 });

  // A budget trip-wire stop is counted as such.
  const tripped = propose("Over budget");
  session(tripped, { expectedRevision: revision(tripped), status: "processing", budget: { maxSpendCents: 100 } });
  session(tripped, { expectedRevision: revision(tripped), status: "active", spendCents: 50 });
  // The report that trips the wire is refused, so the forced stop keeps the last accepted number.
  assert.throws(() => session(tripped, { expectedRevision: revision(tripped), status: "processing", spendCents: 150 }), /budget/);
  const enforced = (await usage()).body;
  assert.deepEqual(enforced.sessions, { started: 3, stopped: 2, budgetStops: 1 });
  assert.deepEqual(enforced.spend, { reportedCents: 170, sessionsReported: 2, sessionsUnreported: 1 });

  // Widening the period brings the old session back; a narrow one drops the early runs.
  const wide = (await usage("?days=60")).body;
  assert.equal(wide.period.days, 60);
  assert.deepEqual(wide.sessions, { started: 4, stopped: 3, budgetStops: 1 });
  assert.equal(wide.spend.reportedCents, 670);
  clock.advance(2 * DAY);
  const narrow = (await usage("?days=1")).body;
  assert.deepEqual(narrow.sessions, { started: 0, stopped: 0, budgetStops: 0 });
  assert.equal(narrow.spend.reportedCents, "unknown");

  // Period parsing: whole days only, capped, one parameter.
  assert.equal((await usage("?days=100000")).body.period.days, USAGE_MAX_DAYS);
  for (const query of ["?days=0", "?days=-3", "?days=1.5", "?days=abc", "?days=", "?days=7&days=8", "?since=2026"]) {
    const bad = await usage(query);
    assert.equal(bad.status, 422, query);
    assert.equal(bad.body.error.code, "invalid_usage_period", query);
  }
  assert.equal(parseUsageDays(null), USAGE_DEFAULT_DAYS);
  assert.equal(parseUsageDays("400"), USAGE_MAX_DAYS);
  assert.throws(() => parseUsageDays("07"), /days must be/);
});

test("the spend allowance ledger rides along so allowance, spent, reserved and headroom read in one place", async t => {
  const { ownerKey, store, cmd, usage, get } = await serve(t);
  cmd(ownerKey, T.MEMBER_ADDED, { memberId: "agent", displayName: "Agent", kind: "agent", permissions: ["accept_work", "complete_work"] });
  setTier(store.db, "commons", "agent", "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  const agentKey = store.issueAccessKey("commons", "agent");
  const none = (await usage()).body.spendAllowance;
  assert.deepEqual([none.allowance, none.headroomCents, none.period.days, none.spentCents], [null, null, 30, 0], "no allowance: null, never zero headroom");
  cmd(ownerKey, T.ROOM_SPEND_ALLOWANCE_SET, { allowanceCents: 5000, periodDays: 7 });
  const workItemId = "w-capped";
  cmd(ownerKey, T.WORK_PROPOSED, { workItemId, title: "Capped run", definitionOfDone: "done", accountableMemberId: "agent", mode: "read" });
  cmd(agentKey, T.WORK_ACCEPTED, { workItemId, expectedRevision: 0 });
  const revision = () => store.room("commons").state.workItems[workItemId].revision;
  store.mutateWorkSession(agentKey, "commons", { requestId: randomUUID(), workItemId, expectedRevision: revision(), action: "set_status", status: "processing", budget: { maxSpendCents: 2000 } });
  store.mutateWorkSession(agentKey, "commons", { requestId: randomUUID(), workItemId, expectedRevision: revision(), action: "set_status", status: "active", spendCents: 500 });
  const { body } = await usage("?days=1");
  const ledger = body.spendAllowance;
  assert.equal(ledger.allowance.allowanceCents, 5000);
  assert.deepEqual([ledger.period.days, ledger.spentCents, ledger.reservedCents, ledger.heldCents, ledger.committedCents, ledger.headroomCents, ledger.overCents, ledger.sessions.live],
    [7, 500, 1500, 0, 2000, 3000, 0, 1]);
  assert.equal(body.period.days, 1, "the usage period follows ?days=; the ledger keeps the allowance's own period");
  assert.deepEqual(body.spend, { reportedCents: 500, sessionsReported: 1, sessionsUnreported: 0 }, "the existing spend figures are untouched");
  // The same figures as the standalone route, so the two reads never disagree.
  const { roomId, evaluatedThrough, ...standalone } = await (await get("/api/rooms/commons/spend-allowance", ownerKey)).json();
  assert.equal(roomId, "commons"); assert.equal(typeof evaluatedThrough, "number");
  assert.deepEqual(ledger, standalone);
});

test("foldSessionEvents attributes spend per attempt and keeps unknown separate", () => {
  const S = "session.started", C = "session.status_changed", X = "session.stopped";
  const folded = foldSessionEvents([
    { type: S, workItemId: "a", spendCents: null, budgetEnforced: null },
    { type: C, workItemId: "a", spendCents: 10, budgetEnforced: null },
    { type: C, workItemId: "a", spendCents: 25, budgetEnforced: null },
    { type: X, workItemId: "a", spendCents: null, budgetEnforced: null },
    { type: S, workItemId: "a", spendCents: null, budgetEnforced: null },   // second attempt, never reports
    { type: C, workItemId: "carried", spendCents: 7, budgetEnforced: null }, // started before the period
    { type: X, workItemId: "carried", spendCents: 9, budgetEnforced: 1 }
  ]);
  assert.deepEqual(folded, {
    sessions: { started: 2, stopped: 2, budgetStops: 1 },
    spend: { reportedCents: 34, sessionsReported: 2, sessionsUnreported: 1 }
  });
  assert.deepEqual(foldSessionEvents([]), { sessions: { started: 0, stopped: 0, budgetStops: 0 }, spend: { reportedCents: "unknown", sessionsReported: 0, sessionsUnreported: 0 } });
});

test("non-members are refused and the response carries no secrets or hashes", async t => {
  const { ownerKey, store, get, usage } = await serve(t);
  assert.equal((await get("/api/rooms/commons/usage")).status, 401);
  const stranger = store.identities.create("Unlinked identity");
  assert.equal((await get("/api/rooms/commons/usage", stranger.secret)).status, 401);
  const labOwner = store.issueAccessKey("lab", "owner");
  assert.equal((await get("/api/rooms/commons/usage", labOwner)).status, 403);

  const identity = store.identities.create("Linked identity");
  store.identities.link(ownerKey, "commons", { identityId: identity.identityId, permissions: ["accept_work"] });
  const { status, body } = await usage();
  assert.equal(status, 200);
  const text = JSON.stringify(body);
  assert.doesNotMatch(text, /[a-f0-9]{64}/, "no sha-256 hashes");
  assert.doesNotMatch(text, /\bpri_[A-Za-z0-9_-]{43,}|\bai_[A-Za-z0-9_-]{16}\b/, "no identity ids or secrets");
  for (const secret of [ownerKey, labOwner, identity.secret, identity.identityId]) assert.ok(!text.includes(secret), "no credentials");
  const keys = [];
  (function walk(value) { if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { keys.push(k); walk(v); } })(body);
  assert.ok(keys.every(k => !/hash|secret|token|key|displayName|memberId|accountId/i.test(k)), `unexpected field among ${keys.join(",")}`);
  assert.deepEqual(Object.keys(body).sort(), ["caps", "members", "period", "roomId", "sessions", "spend", "spendAllowance"]);

  // A linked identity (an agent principal) may read the summary like any member.
  const asIdentity = await get("/api/rooms/commons/usage", identity.secret);
  assert.equal(asIdentity.status, 200);
  // Read family rate limit headers appear on refusal only; the route sits on the shared member read path.
  assert.equal((await get("/api/rooms/commons/usage?days=1", ownerKey)).status, 200);
});
