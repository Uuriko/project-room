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
import { makeTestSigner } from "../scripts/helpers/signed-evidence.mjs";
import { attentionReport } from "../server/owner-attention.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { setTier } from "../server/autonomy-tiers.mjs";

// #662: owner-only "needs your attention" rollup.
function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-attention-"));
  const clock = { now: Date.parse("2026-09-21T12:00:00Z") };
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock.now });
  store.initialize(initialRoom("commons"));
  store.db.exec(accessRequestSchema);
  const accessRequests = new AccessRequests(store, { rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 }) });
  const keys = { owner: store.issueAccessKey("commons", "owner") };
  const send = (actor, type, data, id = randomUUID()) => store.command(keys[actor], "commons", { id, type, data });
  send("owner", T.MEMBER_ADDED, { memberId: "member", displayName: "Regular human", kind: "human", permissions: [] });
  send("owner", T.MEMBER_ADDED, { memberId: "agent", displayName: "Test agent", kind: "agent", permissions: ["accept_work", "complete_work", "write_external"], accountableHumanId: "owner" });
  // Graduated autonomy tiers: the fixture agent is operator-promoted so the
  // attention tests exercise it as a working agent.
  setTier(store.db, "commons", "agent", "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  keys.member = store.issueAccessKey("commons", "member");
  keys.agent = store.issueAccessKey("commons", "agent");
  const report = () => attentionReport({ store, accessRequests }, keys.owner, "commons", null, clock.now);
  const signEvidence = makeTestSigner(store);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, accessRequests, keys, send, clock, report, signEvidence };
}

function proposeWork(f, id, overrides = {}) {
  f.send("owner", T.WORK_PROPOSED, { workItemId: id, title: `Work ${id}`, definitionOfDone: "done",
    accountableMemberId: "agent", mode: "read", independentVerificationRequired: false, ownerDecisionRequired: false, ...overrides });
  return id;
}
function completeWork(f, id) {
  f.send("agent", T.WORK_ACCEPTED, { workItemId: id, expectedRevision: f.store.room("commons").state.workItems[id].revision });
  f.send("agent", T.WORK_STARTED, { workItemId: id, expectedRevision: f.store.room("commons").state.workItems[id].revision });
  f.send("agent", T.WORK_COMPLETED, { workItemId: id, expectedRevision: f.store.room("commons").state.workItems[id].revision,
    summary: "did it", evidenceUrl: "https://example.com/evidence", evidenceVersion: "v1", nextAction: "none",
    signedEvidence: f.signEvidence() });
}

test("empty room: zero items and owner-only gate", t => {
  const f = setup(t);
  const report = f.report();
  assert.equal(report.roomId, "commons");
  assert.equal(report.itemCount, 0);
  assert.deepEqual(report.items, []);
  assert.throws(() => attentionReport({ store: f.store, accessRequests: f.accessRequests }, f.keys.member, "commons"),
    { status: 403, code: "owner_required" }, "a non-owner member is refused");
  assert.throws(() => attentionReport({ store: f.store, accessRequests: f.accessRequests }, f.keys.agent, "commons"),
    { status: 403, code: "owner_required" }, "an agent member is refused");
});

test("pending access request carries inline approve/deny actions", t => {
  const f = setup(t);
  const identity = f.store.identities.create("Joiner");
  const created = f.accessRequests.request("commons", { identityId: identity.identityId, displayName: "Joiner",
    requestedPermissions: ["accept_work", "complete_work"], requestId: "ar_one" });
  const report = f.report();
  assert.equal(report.itemCount, 1);
  const [item] = report.items;
  assert.equal(item.kind, "access_request");
  assert.equal(item.severity, "action");
  assert.equal(item.title, "Joiner asks to join");
  assert.deepEqual(item.actions.map(a => a.action), ["approve", "deny"]);
  // The advertised actions are executable contracts: run them through decide.
  const approve = item.actions[0];
  assert.equal(approve.method, "POST");
  assert.equal(approve.path, `/api/rooms/commons/access-requests/${created.requestId}/decide`);
  const decided = f.accessRequests.decide(f.keys.owner, "commons", created.requestId, approve.body);
  assert.equal(decided.status, "approved");
  assert.equal(f.report().itemCount, 0, "a decided request leaves the rollup");
});

test("deny action refuses through the same contract", t => {
  const f = setup(t);
  const identity = f.store.identities.create("Joiner Two");
  const created = f.accessRequests.request("commons", { identityId: identity.identityId, displayName: "Joiner Two",
    requestedPermissions: ["accept_work"], requestId: "ar_two" });
  const deny = f.report().items[0].actions[1];
  assert.equal(deny.body.decision, "deny");
  const decided = f.accessRequests.decide(f.keys.owner, "commons", created.requestId, deny.body);
  assert.equal(decided.status, "denied");
  assert.equal(f.report().itemCount, 0);
});

test("work awaiting verification and owner decision surfaces with review links", t => {
  const f = setup(t);
  proposeWork(f, "w-verify", { independentVerificationRequired: true, verifierMemberId: "owner" });
  proposeWork(f, "w-decide", { ownerDecisionRequired: true, humanDecisionMakerId: "owner" });
  proposeWork(f, "w-clean");
  completeWork(f, "w-verify"); completeWork(f, "w-decide"); completeWork(f, "w-clean");
  const report = f.report();
  // The three thin shadow receipts (short summary, no recognized artifact
  // URL) also surface as informational jev_escalation items: the Jev
  // receipt gate journals every legacy work.completed completion.
  assert.equal(report.itemCount, 5, "verification + decision + 3 escalated shadow receipts");
  const kinds = report.items.map(i => i.kind).sort();
  assert.deepEqual(kinds, ["decision", "jev_escalation", "jev_escalation", "jev_escalation", "verification"]);
  for (const item of report.items) {
    if (item.kind === "jev_escalation") {
      assert.equal(item.severity, "info");
      assert.equal(item.actions.length, 1);
      assert.equal(item.actions[0].method, "GET");
      assert.ok(item.actions[0].path.startsWith("/api/rooms/commons/jev-shadow"), "shadow deep-link");
      continue;
    }
    assert.equal(item.severity, "action");
    assert.equal(item.actions.length, 1);
    assert.equal(item.actions[0].method, "GET");
    assert.ok(item.actions[0].path.startsWith("/api/rooms/commons/work-context?workItemId="), "review deep-link");
  }
});

test("spend headroom below 20% and over-allowance surface", t => {
  const f = setup(t);
  f.send("owner", T.ROOM_SPEND_ALLOWANCE_SET, { allowanceCents: 5000, periodDays: 30 });
  assert.equal(f.report().itemCount, 0, "full headroom is not attention-worthy");
  // Reserve 4500c via a budgeted work session.
  const wid = proposeWork(f, "w-spend", { mode: "write" });
  f.send("agent", T.WORK_ACCEPTED, { workItemId: wid, expectedRevision: f.store.room("commons").state.workItems[wid].revision });
  f.send("agent", T.CLAIM_ACQUIRED, { workItemId: wid, expectedRevision: f.store.room("commons").state.workItems[wid].revision,
    repository: "repo", ref: "main", paths: ["a"], expiresAt: new Date(f.clock.now + 3600000).toISOString() });
  const revision = f.store.room("commons").state.workItems[wid].revision;
  f.send("agent", T.SESSION_STARTED, { workItemId: wid, expectedRevision: revision, budget: { maxSpendCents: 4500 } });
  const [spendItem] = f.report().items.filter(i => i.kind === "spend");
  assert.ok(spendItem, "a spend item appears once headroom drops under 20%");
  assert.equal(spendItem.severity, "action");
  assert.ok(spendItem.actions[0].path.endsWith("/spend-allowance"));
});

test("claim lease expiring within 24h surfaces; distant leases stay quiet", t => {
  const f = setup(t);
  const soon = proposeWork(f, "w-soon", { mode: "write" });
  const far = proposeWork(f, "w-far", { mode: "write" });
  for (const wid of [soon, far]) {
    f.send("agent", T.WORK_ACCEPTED, { workItemId: wid, expectedRevision: f.store.room("commons").state.workItems[wid].revision });
  }
  const expires = ms => new Date(f.clock.now + ms).toISOString();
  f.send("agent", T.CLAIM_ACQUIRED, { workItemId: soon, expectedRevision: f.store.room("commons").state.workItems[soon].revision,
    repository: "repo", ref: "main", paths: ["a"], expiresAt: expires(2 * 3600000) });
  f.send("agent", T.CLAIM_ACQUIRED, { workItemId: far, expectedRevision: f.store.room("commons").state.workItems[far].revision,
    repository: "repo", ref: "main", paths: ["b"], expiresAt: expires(72 * 3600000) });
  const items = f.report().items.filter(i => i.kind === "claim_lease");
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "w-soon");
  assert.equal(items[0].severity, "info");
  assert.match(items[0].detail, /2h/);
});

test("report carries the viewer echo the browser client requires (no session kill)", async t => {
  // Regression for the #744 Cloudflare browser failure: the rollup response
  // lacked viewerId/viewerAccountId/viewerAuthEpoch/viewerSessionBinding, so
  // RoomClient.needsAttention()'s ownsResponse check failed and endAccess()
  // destroyed the owner's session right after login, re-hiding the invite button.
  const f = setup(t);
  const { RoomClient } = await import("../src/client.js");
  const created = f.store.createSession(f.keys.owner);
  const report = attentionReport({ store: f.store, accessRequests: f.accessRequests }, created.token, "commons");
  const auth = created.session;
  assert.equal(report.viewerId, "owner");
  assert.equal(typeof report.viewerSessionBinding, "string");
  const session = {
    authMode: "room",
    account: { id: auth.account.id, revision: auth.account.revision, authEpoch: auth.account.authEpoch },
    member: auth.member,
    roomId: "commons",
    csrf: auth.csrf,
    sessionBinding: auth.sessionBinding,
    sessionRevision: auth.sessionRevision ?? null,
  };
  const client = new RoomClient({});
  assert.equal(client.ownsResponse(report, session), true, "the rollup must survive the client identity check");
});
