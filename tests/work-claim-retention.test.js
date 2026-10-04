// Retention response mechanics (research brief 2026-09-28, agent-retention
// #1 first-contribution response SLA, #2 no-zero-reply watchdog).
//
// Authoring gate (per .agents/skills/test-audit/SKILL.md):
// 1. Contracts: the SLA status computation (pending/breached/answered), the
//    first-contribution detection, the ack stamp shape, the zero-reply watch
//    list + rate, the median first-response latency, and the retention
//    dashboard shape served at GET /work-claims/retention.
// 2. Credible regressions: the ack dropped from the claim route (contribution
//    sits at zero replies), an inverted firstness check (every claim flagged
//    first, or none), SLA math that never breaches, the route not wired in
//    server/http.mjs (404), the dashboard shape drifting from docs.
// 3. No existing coverage: new module, new route — nothing else asserts this.
// 4. No production seams: the pure functions are imported directly; the
//    handler tests go through handleWorkClaims with an in-memory registry.
import test from "node:test";
import assert from "node:assert/strict";
import {
  FIRST_RESPONSE_SLA_HOURS,
  ZERO_REPLY_WINDOW_HOURS,
  isFirstContribution,
  retentionAck,
  assessFirstContributionSla,
  assessZeroReply,
  firstResponseLatency,
  retentionReport,
} from "../server/retention-response.mjs";
import { createWork, claimWork, updateWork, recordReview } from "../server/work-claims.mjs";
import { createWorkClaimRegistry, handleWorkClaims } from "../server/work-claim-routes.mjs";

const H = 3600 * 1000;
const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const iso = ms => new Date(ms).toISOString();
const stamp = (atMs, agentId, action, note = null) =>
  ({ at: iso(atMs), agentId, action, note });
const itemOf = (id, owner, history, state = "claimed") =>
  ({ id, title: id, state, owner, history });

// A claimed item built through the real state machine, then optionally
// extended with review/done stamps at controlled times.
const claimedItem = (id, memberId, claimAtMs) => {
  const created = createWork({ id }, { now: claimAtMs - H });
  return claimWork(created, memberId, { now: claimAtMs });
};
const withStamps = (item, ...stamps) => ({
  ...item,
  history: [...item.history, ...stamps],
});
// The machine needs claimed -> in_progress -> done; doneAtMs lands on the
// "state:done" stamp either way.
const doneItem = (id, memberId, claimAtMs, doneAtMs) => {
  const started = updateWork(claimedItem(id, memberId, claimAtMs), memberId,
    { state: "in_progress", now: claimAtMs + H });
  return updateWork(started, memberId, { state: "done", now: doneAtMs });
};

// --- isFirstContribution ---

test("isFirstContribution: true on an empty room, false after any trace", () => {
  assert.equal(isFirstContribution([], "newbie"), true);
  const items = [itemOf("w1", "newbie", [stamp(T0, "newbie", "claimed")])];
  assert.equal(isFirstContribution(items, "newbie"), false);
  // A bare history authorship (note, review) counts as a prior contribution.
  const noted = [itemOf("w2", "owner", [stamp(T0, "system", "claimed"), stamp(T0 + H, "newbie", "noted")])];
  assert.equal(isFirstContribution(noted, "newbie"), false);
  // System stamps never count as a member's contribution.
  const sysOnly = [itemOf("w3", null, [stamp(T0, "system", "created")], "unclaimed")];
  assert.equal(isFirstContribution(sysOnly, "newbie"), true);
  assert.equal(isFirstContribution(sysOnly, "system"), false);
});

// --- retentionAck ---

test("retentionAck appends the bot's structured receipt", () => {
  const item = claimedItem("w1", "newbie", T0);
  const before = item.history.length;
  // The receipt carries the actor's id (not "system") so content-trust marks
  // it like the claim stamp it rides with; the SLA/watchdog exclude it by
  // action, so it never answers itself.
  const acked = retentionAck(item, { now: T0, first: true, agentId: "newbie" });
  assert.equal(acked.history.length, before + 1);
  const ack = acked.history[acked.history.length - 1];
  assert.equal(ack.agentId, "newbie");
  assert.equal(ack.action, "retention_ack");
  assert.equal(ack.at, iso(T0));
  assert.match(ack.note, /^retention-ack seen=1 first=1 sla_due=2026-10-02T00:00:00\.000Z$/);
  assert.ok(Object.isFrozen(acked) && Object.isFrozen(acked.history) && Object.isFrozen(ack));
  assert.throws(() => retentionAck(item, { now: T0 }), /agentId/);
  assert.throws(() => retentionAck(item, { now: T0, agentId: "system" }), /agentId/);
  // Non-first claims get seen-but-no-SLA.
  const acked2 = retentionAck(item, { now: T0, agentId: "newbie" });
  assert.match(acked2.history[acked2.history.length - 1].note, /^retention-ack seen=1 first=0$/);
  assert.throws(() => retentionAck(null), /needs a work-claim item/);
  assert.throws(() => retentionAck({ id: "w1" }, { now: "not-a-time", agentId: "newbie" }), /ms epoch/);
});

// --- assessFirstContributionSla ---

test("SLA: first claim pending inside the window, breached past it", () => {
  const items = [claimedItem("w1", "newbie", T0)];
  const pending = assessFirstContributionSla(items, { now: T0 + 12 * H });
  assert.deepEqual(pending.entries.map(e => [e.memberId, e.kind, e.status]),
    [["newbie", "first-claim", "pending"]]);
  assert.equal(pending.entries[0].dueAt, iso(T0 + FIRST_RESPONSE_SLA_HOURS * H));
  const breached = assessFirstContributionSla(items, { now: T0 + 25 * H });
  assert.equal(breached.entries[0].status, "breached");
  assert.ok(!("answeredAt" in breached.entries[0]));
});

test("SLA: a verdict-class review inside the window answers it", () => {
  let item = claimedItem("w1", "newbie", T0);
  item = recordReview(item, "reviewer", { verdict: "approve", summary: "looks good", now: T0 + 6 * H });
  const out = assessFirstContributionSla([item], { now: T0 + 30 * H });
  const entry = out.entries.find(e => e.kind === "first-claim");
  assert.equal(entry.status, "answered");
  assert.equal(entry.answeredBy, "reviewer");
  assert.equal(entry.latencyMs, 6 * H);
});

test("SLA: only the member's earliest claim is tracked", () => {
  const first = claimedItem("w1", "newbie", T0);
  const second = claimedItem("w2", "newbie", T0 + 48 * H);
  const out = assessFirstContributionSla([first, second], { now: T0 + 72 * H });
  const claims = out.entries.filter(e => e.kind === "first-claim");
  assert.deepEqual(claims.map(e => e.itemId), ["w1"]);
});

test("SLA: completion inside the window answers it; completion after does not erase the breach", () => {
  const fast = doneItem("w1", "newbie", T0, T0 + 20 * H);
  const fastOut = assessFirstContributionSla([fast], { now: T0 + 30 * H });
  const fastEntry = fastOut.entries.find(e => e.kind === "first-claim");
  assert.equal(fastEntry.status, "answered");
  assert.equal(fastEntry.answeredBy, "completion");
  const slow = doneItem("w2", "newbie", T0, T0 + 30 * H);
  const slowOut = assessFirstContributionSla([slow], { now: T0 + 31 * H });
  assert.equal(slowOut.entries.find(e => e.kind === "first-claim").status, "breached");
});

test("SLA: the author's own stamps and system stamps never answer it", () => {
  const self = withStamps(claimedItem("w1", "newbie", T0), stamp(T0 + 2 * H, "newbie", "reviewed", "self note"));
  const sys = withStamps(claimedItem("w2", "newbie", T0), stamp(T0 + 2 * H, "system", "note", "system note"));
  // The bot's receipt carries the actor's id but is excluded by action: the
  // receipt itself never answers the SLA (regression: content-trust parity
  // needs the member id on the stamp, mcp-core-profile.test.js).
  const acked = withStamps(claimedItem("w3", "newbie", T0), stamp(T0 + 2 * H, "newbie", "retention_ack", "seen"));
  const out = assessFirstContributionSla([self, sys, acked], { now: T0 + 30 * H });
  assert.ok(out.entries.every(e => e.status === "breached"));
});

test("SLA: first receipt is answered at once by the room's receipt machinery", () => {
  const done = doneItem("w1", "newbie", T0, T0 + 2 * H);
  const out = assessFirstContributionSla([done], { now: T0 + 3 * H });
  const receipt = out.entries.find(e => e.kind === "first-receipt");
  assert.equal(receipt.status, "answered");
  assert.equal(receipt.answeredBy, "room-receipt-machinery");
  assert.equal(receipt.latencyMs, 0);
});

// --- assessZeroReply ---

test("watchdog: acked-but-unanswered claims are watched; unacked claims alert", () => {
  const acked = withStamps(claimedItem("w1", "quill", T0), stamp(T0, "quill", "retention_ack", "seen"));
  const naked = claimedItem("w2", "quill", T0); // bot failure: no ack at all
  const fresh = claimedItem("w3", "quill", T0 + 47 * H); // inside the window
  const answeredItem = withStamps(claimedItem("w4", "quill", T0),
    stamp(T0 + H, "reviewer", "reviewed", "nice"));
  const out = assessZeroReply([acked, naked, fresh, answeredItem], { now: T0 + ZERO_REPLY_WINDOW_HOURS * H + H });
  assert.deepEqual(out.watch.map(w => w.itemId), ["w1", "w2"]);
  assert.deepEqual(out.watch.map(w => w.unacked), [false, true]);
  assert.equal(out.watch[0].respondedAt, null);
  assert.equal(out.alert, true);
  assert.equal(out.unackedCount, 1);
});

test("watchdog: zero-reply rate runs over the trailing 30 days", () => {
  const old = claimedItem("w-old", "quill", T0 - 40 * 24 * H); // outside the metric window
  const recent = claimedItem("w-new", "quill", T0);
  const out = assessZeroReply([old, recent], { now: T0 + ZERO_REPLY_WINDOW_HOURS * H + H });
  assert.equal(out.contributions, 1);
  assert.equal(out.unanswered, 1);
  assert.equal(out.zeroReplyRate, 1);
  const answered = withStamps(claimedItem("w-ok", "quill", T0), stamp(T0 + H, "reviewer", "noted", "seen"));
  const out2 = assessZeroReply([answered], { now: T0 + ZERO_REPLY_WINDOW_HOURS * H + H });
  assert.equal(out2.zeroReplyRate, 0);
  assert.equal(out2.alert, false);
  assert.deepEqual(out2.watch, []);
});

test("watchdog: done claims are excluded from the watch and the rate", () => {
  // Completion closes the loop (same contract as the SLA's "answeredBy:
  // completion"): a claim finished past the reply window with no member
  // response is not a zero-reply contribution.
  const done = doneItem("w-done", "quill", T0, T0 + 60 * H);
  const open = claimedItem("w-open", "quill", T0);
  const out = assessZeroReply([done, open], { now: T0 + ZERO_REPLY_WINDOW_HOURS * H + H });
  assert.deepEqual(out.watch.map(w => w.itemId), ["w-open"]);
  assert.equal(out.contributions, 1);
  assert.equal(out.unanswered, 1);
  assert.equal(out.zeroReplyRate, 1);
  const onlyDone = assessZeroReply([done], { now: T0 + ZERO_REPLY_WINDOW_HOURS * H + H });
  assert.deepEqual(onlyDone.watch, []);
  assert.equal(onlyDone.contributions, 0);
  assert.equal(onlyDone.zeroReplyRate, 0);
  assert.equal(onlyDone.alert, false);
});

// --- firstResponseLatency ---

test("latency: median over responded claims in the window", () => {
  const a = withStamps(claimedItem("a", "m1", T0), stamp(T0 + 2 * H, "r", "reviewed"));
  const b = withStamps(claimedItem("b", "m2", T0), stamp(T0 + 8 * H, "r", "noted"));
  const c = claimedItem("c", "m3", T0); // never answered: excluded
  assert.deepEqual(firstResponseLatency([a, b, c], { now: T0 + 10 * H }), { medianMs: 5 * H, measured: 2 });
  assert.deepEqual(firstResponseLatency([c], { now: T0 + 10 * H }), { medianMs: null, measured: 0 });
});

// --- retentionReport ---

test("retentionReport bundles the SLA queue, the watch, and latency", () => {
  const breached = claimedItem("w1", "newbie", T0);
  const report = retentionReport([breached], { now: T0 + 50 * H });
  assert.equal(report.slaHours, FIRST_RESPONSE_SLA_HOURS);
  assert.equal(report.zeroReplyWindowHours, ZERO_REPLY_WINDOW_HOURS);
  assert.equal(report.sla.breached, 1);
  assert.equal(report.sla.pending, 0);
  assert.equal(report.sla.queue[0].itemId, "w1");
  assert.equal(report.sla.queue[0].status, "breached");
  assert.equal(report.zeroReply.unacked, 1);
  assert.equal(report.zeroReply.alert, true);
  assert.equal(report.latency.measured, 0);
  assert.ok(Object.isFrozen(report) && Object.isFrozen(report.sla) && Object.isFrozen(report.zeroReply));
});

// --- handler wiring ---

const fakeHelpers = () => {
  const calls = [];
  const reject = (status, code, message) => {
    const error = new Error(message); error.status = status; error.code = code; throw error;
  };
  return {
    calls,
    json: (res, status, value) => { calls.push({ status, value }); return { status, value }; },
    reject,
    body: async req => req.body,
  };
};
const fakeStore = members => ({
  now: () => T0,
  roomAuthority: () => ({ ownerId: "owner", members }),
});
const memberEntry = (id, permissions = ["accept_work", "complete_work"]) =>
  ({ id, kind: "agent", active: true, permissions });
const authFor = id => ({ member: { id, kind: "agent", permissions: ["accept_work", "complete_work"] } });
const seedUnclaimed = (registry, id) => {
  registry.set("room1", createWork({ id, title: id }, { now: T0 - H }));
};

test("handler: claiming posts the ack; first-timers carry the SLA", async () => {
  const registry = createWorkClaimRegistry();
  seedUnclaimed(registry, "w-first");
  seedUnclaimed(registry, "w-second");
  const members = { owner: memberEntry("owner"), newbie: memberEntry("newbie") };
  const store = fakeStore(members);
  const claim = async (id, memberId, body = {}) => {
    const helpers = fakeHelpers();
    const out = await handleWorkClaims({ req: { method: "POST", body }, res: {},
      url: new URL("https://room.example/api/rooms/room1/work-claims/w-first/claim"),
      store, roomId: "room1", auth: authFor(memberId), workClaimRoute: "claim",
      workClaimId: id, helpers, registry });
    return out.value;
  };
  const first = await claim("w-first", "newbie");
  const ack = first.history[first.history.length - 1];
  assert.equal(ack.action, "retention_ack");
  assert.equal(ack.agentId, "newbie");
  assert.match(ack.note, /first=1 sla_due=/);
  // The stored item carries the ack too — the watch sees it, not a zero reply.
  const stored = registry.get("room1", "w-first");
  assert.equal(stored.history[stored.history.length - 1].action, "retention_ack");
  // A second claim by the same member is seen-but-not-first.
  const second = await claim("w-second", "newbie");
  assert.match(second.history[second.history.length - 1].note, /first=0/);
  assert.ok(!/sla_due/.test(second.history[second.history.length - 1].note));
});

// --- route-table wiring (server/routes/work-claims.mjs) ---
//
// Importing the dispatcher runs assertRouteTable(ROUTES) at module load: a
// malformed row fails the import itself.
import { dispatchRoute } from "../server/routes/dispatch.mjs";
import { getRetentionDashboard } from "../server/routes/work-claims.mjs";

const tableCtx = ({ memberId = "newbie", members, registry, authKind = "session", scopes = null } = {}) => {
  const captured = {};
  const reject = (status, code, message) => {
    const error = new Error(message);
    error.status = status; error.code = code;
    throw error;
  };
  return { captured,
    ctx: {
      params: { roomId: "room1" },
      req: { method: "GET", headers: {} },
      url: new URL("https://room.example/api/rooms/room1/work-claims/retention"),
      res: { headers: {}, setHeader(name, value) { this.headers[name] = value; } },
      store: {
        now: () => T0,
        roomAuthority: () => ({ members }),
        workClaims: registry,
      },
      roomCredentials: () => ({ mode: "room", bearer: authKind === "api-key" }),
      expectedBinding: () => ({}),
      accountBinding: () => ({}),
      roomAuth: () => ({ kind: authKind, member: { id: memberId }, credentialHash: "h",
        credentialScope: "room", ...(scopes ? { apiKeyScopes: scopes } : {}) }),
      rate: () => {},
      reject,
      json: (res, status, value) => { captured.status = status; captured.value = value; return captured; },
    } };
};

test("route table: GET /api/rooms/{roomId}/work-claims/retention serves the dashboard; non-members get 403", async () => {
  const registry = createWorkClaimRegistry();
  registry.set("room1", claimedItem("w1", "newbie", T0 - 50 * H)); // breached, unacked
  const members = { owner: memberEntry("owner"), newbie: memberEntry("newbie") };
  const { ctx, captured } = tableCtx({ members, registry });
  const handled = await dispatchRoute(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.route.handler, getRetentionDashboard);
  assert.equal(captured.status, 200);
  assert.equal(captured.value.sla.breached, 1);
  assert.equal(captured.value.sla.queue[0].memberId, "newbie");
  assert.equal(captured.value.zeroReply.unacked, 1);
  assert.equal(captured.value.zeroReply.alert, true);
  const denied = tableCtx({ memberId: "stranger", members, registry });
  const error = await dispatchRoute(denied.ctx).catch(e => e);
  assert.equal(error.code, "not_member");
  assert.equal(error.status, 403);
});

test("route table: unauthenticated callers get 401; scoped API keys are honored", async () => {
  const registry = createWorkClaimRegistry();
  const members = { newbie: memberEntry("newbie") };
  const anon = tableCtx({ members, registry, authKind: "account" });
  const anonError = await dispatchRoute(anon.ctx).catch(e => e);
  assert.equal(anonError.status, 401);
  const scoped = tableCtx({ members, registry, authKind: "api-key", scopes: ["rooms:read"] });
  const ok = await dispatchRoute(scoped.ctx);
  assert.equal(ok, true);
  assert.equal(scoped.captured.status, 200);
  const unscoped = tableCtx({ members, registry, authKind: "api-key", scopes: ["inbox:read"] });
  const scopeError = await dispatchRoute(unscoped.ctx).catch(e => e);
  assert.equal(scopeError.code, "insufficient_scope");
  assert.equal(scopeError.status, 403);
});

test("route table: wrong method on the retention path is a 405, not a claimId read", async () => {
  const { ctx } = tableCtx({ members: { newbie: memberEntry("newbie") }, registry: createWorkClaimRegistry() });
  ctx.req.method = "POST";
  const error = await dispatchRoute(ctx).catch(e => e);
  assert.equal(error.code, "method_not_allowed");
  assert.equal(error.status, 405);
});

// --- regression: claim route firstness vs the item's own created stamp ---
//
// QA 2026-10-03 (buildqa lane, live local journey): a member who creates an
// item and claims it in the same flow got `first=0` on the ack, while the
// dashboard's SLA queue still listed the claim as their first-claim. The
// created stamp is not a prior contribution; firstness must exclude the
// item being claimed.

test("handler: claiming an item you created yourself is still a first contribution", async () => {
  const registry = createWorkClaimRegistry();
  registry.set("room1", createWork({ id: "w-mine", title: "w-mine" }, { now: T0 - H, agentId: "newbie" }));
  const members = { owner: memberEntry("owner"), newbie: memberEntry("newbie") };
  const store = fakeStore(members);
  const out = await handleWorkClaims({ req: { method: "POST", body: {} }, res: {},
    url: new URL("https://room.example/api/rooms/room1/work-claims/w-mine/claim"),
    store, roomId: "room1", auth: authFor("newbie"), workClaimRoute: "claim",
    workClaimId: "w-mine", helpers: fakeHelpers(), registry });
  const history = out.value.history;
  const ack = history[history.length - 1];
  assert.equal(ack.action, "retention_ack");
  assert.equal(ack.agentId, "newbie");
  assert.match(ack.note, /first=1 sla_due=/);
});
