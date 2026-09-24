// Lease-renewal check-ins: a claim's lease extends only when the holder cites
// their own public progress message, posted in the room after the current
// lease window began. Renewals are discussed in the channel — never silent
// extensions — so a stale holder can't hold scope indefinitely without
// showing work.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { EVENT_TYPES as T, applyEvent, event } from '../src/events.js';
import { changeDescription } from '../src/workflow.js';
import { createWorkClaimRegistry, handleWorkClaims } from "../server/work-claim-routes.mjs";
import { claimWork, renewWork, updateWork, ClaimError } from "../server/work-claims.mjs";

const H = 3600 * 1000;
const T0 = Date.parse("2026-09-24T07:00:00.000Z");
const iso = ms => new Date(ms).toISOString();
const command = (type, data, id = crypto.randomUUID()) => ({ id, type, data });
const throwsCode = (fn, code) => assert.throws(fn, err => err instanceof ClaimError && err.code === code);
const capture = fn => { try { fn(); } catch (err) { return err; } assert.fail("expected a throw"); };

// ---------------------------------------------------------------------------
// Part 1: the event-sourced claim.renewed reducer
// ---------------------------------------------------------------------------
function fixture(t) {
  let nowMs = T0;
  const directory = mkdtempSync(join(tmpdir(), 'project-room-leaserenew-'));
  const store = new RoomStore(join(directory, 'room.sqlite'), { now: () => nowMs });
  store.initialize(initialRoom());
  const owner = store.issueAccessKey('commons', 'owner');
  for (const [id, kind] of [['human', 'human'], ['agent', 'agent']]) {
    store.command(owner, 'commons', command(T.MEMBER_ADDED, { memberId: id, displayName: id, kind,
      permissions: ['accept_work', 'complete_work', 'write_external'] }));
  }
  const human = store.issueAccessKey('commons', 'human');
  const agent = store.issueAccessKey('commons', 'agent');
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const advance = ms => { nowMs += ms; };
  return { store, owner, human, agent, advance };
}

function readyWithClaim(f, workItemId, { expiryMs = T0 + 24 * H } = {}) {
  const { store, owner, human, advance } = f;
  store.command(owner, 'commons', command(T.WORK_PROPOSED, { workItemId, title: `title-${workItemId}`,
    definitionOfDone: 'done', accountableMemberId: 'human', verifierMemberId: 'agent',
    independentVerificationRequired: false, ownerDecisionRequired: false, humanDecisionMakerId: 'owner',
    mode: 'write' }));
  store.command(human, 'commons', command(T.WORK_ACCEPTED, { workItemId, expectedRevision: 0 }));
  store.command(human, 'commons', command(T.CLAIM_ACQUIRED, { workItemId, expectedRevision: 1,
    repository: 'o/r', ref: 'main', paths: ['a/**'], expiresAt: iso(expiryMs) }));
  advance(H); // an hour of work passes
  store.command(human, 'commons', command(T.MESSAGE_POSTED, { messageId: `progress-${workItemId}`, body: 'Progress: half done.' }));
  return { revision: 2 }; // the next expected revision after the claim
}

const readClaim = (f, workItemId) => f.store.snapshot(f.owner, 'commons').state.workItems[workItemId];

function renew(f, workItemId, { revision = 2, progressMessageId = `progress-${workItemId}`, expiresAt = iso(T0 + 48 * H) } = {}) {
  return f.store.command(f.human, 'commons', command(T.CLAIM_RENEWED,
    { workItemId, expectedRevision: revision, progressMessageId, expiresAt }));
}

test("renewal without a progress message id is refused at the command boundary", t => {
  const f = fixture(t);
  readyWithClaim(f, 'w-noid');
  assert.throws(() => f.store.command(f.human, 'commons', command(T.CLAIM_RENEWED,
    { workItemId: 'w-noid', expectedRevision: 2, expiresAt: iso(T0 + 48 * H) })),
    err => err.code === "claim_renewal_source_required" && /progress update/i.test(err.message));
});

test("a renewal citing the holder's public progress message extends the lease", t => {
  const f = fixture(t);
  readyWithClaim(f, 'w-ok');
  renew(f, 'w-ok');
  const claim = readClaim(f, 'w-ok').claim;
  assert.equal(claim.expiresAt, iso(T0 + 48 * H));
  assert.equal(claim.renewedAt, iso(T0 + H));
  assert.equal(claim.renewals, 1);
  assert.equal(claim.progressMessageId, 'progress-w-ok');
  assert.equal(claim.status, 'active');
  assert.equal(readClaim(f, 'w-ok').revision, 3);
});

test("a renewal citing a missing message is rejected", t => {
  const f = fixture(t);
  readyWithClaim(f, 'w-missing');
  assert.throws(() => renew(f, 'w-missing', { progressMessageId: 'nope' }),
    /in the room first/);
});

test("a renewal citing a deleted message is rejected", t => {
  const f = fixture(t);
  const { revision } = readyWithClaim(f, 'w-deleted');
  f.store.command(f.human, 'commons', command(T.MESSAGE_DELETED, { messageId: 'progress-w-deleted', expectedMessageRevision: 0 }));
  assert.throws(() => renew(f, 'w-deleted', { revision }),
    /progress update/i);
});

test("a renewal citing another member's message is rejected", t => {
  const f = fixture(t);
  readyWithClaim(f, 'w-foreign');
  f.store.command(f.agent, 'commons', command(T.MESSAGE_POSTED, { messageId: 'progress-foreign', body: 'Not mine to cite.' }));
  assert.throws(() => renew(f, 'w-foreign', { progressMessageId: 'progress-foreign' }),
    /holder's own progress message/);
});

test("a renewal citing a message older than the lease start is rejected", t => {
  const f = fixture(t);
  const { store, owner, human, advance } = f;
  store.command(owner, 'commons', command(T.WORK_PROPOSED, { workItemId: 'w-stale', title: 'title-w-stale',
    definitionOfDone: 'done', accountableMemberId: 'human', verifierMemberId: 'agent',
    independentVerificationRequired: false, ownerDecisionRequired: false, humanDecisionMakerId: 'owner',
    mode: 'write' }));
  store.command(human, 'commons', command(T.WORK_ACCEPTED, { workItemId: 'w-stale', expectedRevision: 0 }));
  store.command(human, 'commons', command(T.MESSAGE_POSTED, { messageId: 'progress-w-stale', body: 'Early note.' }));
  advance(H);
  store.command(human, 'commons', command(T.CLAIM_ACQUIRED, { workItemId: 'w-stale', expectedRevision: 1,
    repository: 'o/r', ref: 'main', paths: ['a/**'], expiresAt: iso(T0 + 24 * H) }));
  assert.throws(() => renew(f, 'w-stale'),
    /newer than the current lease start/);
});

test("a renewal by a non-holder is rejected", t => {
  const f = fixture(t);
  readyWithClaim(f, 'w-holder');
  assert.throws(() => f.store.command(f.agent, 'commons', command(T.CLAIM_RENEWED,
    { workItemId: 'w-holder', expectedRevision: 2, progressMessageId: 'progress-w-holder', expiresAt: iso(T0 + 48 * H) })),
    /Only the claim holder/);
});

test("a renewal of a lapsed claim is rejected — claim it again instead", t => {
  const f = fixture(t);
  readyWithClaim(f, 'w-lapsed', { expiryMs: T0 + H });
  f.advance(2 * H); // the lease lapses while nobody renews
  assert.throws(() => renew(f, 'w-lapsed'),
    /No active claim to renew/);
});

test("a second renewal needs a check-in newer than the previous renewal", t => {
  const f = fixture(t);
  readyWithClaim(f, 'w-twice');
  renew(f, 'w-twice');
  f.advance(H);
  f.store.command(f.human, 'commons', command(T.MESSAGE_POSTED, { messageId: 'progress-w-twice-2', body: 'Progress: almost done.' }));
  // The first check-in is now stale — it predates the renewed lease window.
  assert.throws(() => renew(f, 'w-twice', { revision: 3 }),
    /newer than the current lease start/);
  renew(f, 'w-twice', { revision: 3, progressMessageId: 'progress-w-twice-2', expiresAt: iso(T0 + 72 * H) });
  const claim = readClaim(f, 'w-twice').claim;
  assert.equal(claim.renewals, 2);
  assert.equal(claim.expiresAt, iso(T0 + 72 * H));
});

test("a renewal citing a DM never counts as the public check-in", t => {
  const f = fixture(t);
  const { revision } = readyWithClaim(f, 'w-dm');
  // Build the DM case directly on a cloned projection: DM consent rules make
  // a live DM awkward in this fixture, and the reducer must refuse it either way.
  const state = structuredClone(f.store.snapshot(f.owner, 'commons').state);
  state.messages.push({ id: 'dm-note', authorId: 'human', body: 'Progress in private.', createdAt: iso(T0 + 2 * H), toMemberId: 'agent', revision: 0 });
  assert.throws(() => applyEvent(state, event({ type: T.CLAIM_RENEWED, actorId: 'human', roomId: 'commons',
    at: iso(T0 + 2 * H), data: { workItemId: 'w-dm', expectedRevision: revision,
      progressMessageId: 'dm-note', expiresAt: iso(T0 + 48 * H) } })),
    /public progress message/);
});

test("changeDescription labels a renewal 'Scope renewed'", () => {
  assert.equal(changeDescription({ type: T.CLAIM_RENEWED }), "Scope renewed");
});

// ---------------------------------------------------------------------------
// Part 2: the pure renewWork state machine
// ---------------------------------------------------------------------------
test("renewWork starts a fresh lease window from now", () => {
  const claimed = claimWork({ id: "w1" }, "quill", { leaseHours: 6, now: T0 });
  assert.equal(claimed.leaseStartAt, iso(T0));
  const renewed = renewWork(claimed, "quill", { now: T0 + 2 * H });
  assert.equal(renewed.leaseStartAt, iso(T0 + 2 * H));
  assert.equal(renewed.leaseExpiresAt, iso(T0 + 26 * H)); // the room's default 24h
  assert.equal(renewed.owner, "quill");
  assert.equal(renewed.state, "claimed");
  assert.equal(renewed.history.at(-1).action, "renewed");
  assert.match(renewed.history.at(-1).note, /lease: 24h/);
});

test("renewWork records the caller's note in history", () => {
  const claimed = claimWork({ id: "w1" }, "quill", { leaseHours: 6, now: T0 });
  const renewed = renewWork(claimed, "quill", { note: "still digging", now: T0 + H });
  assert.equal(renewed.history.at(-1).note, "still digging");
});

test("renewWork honors an explicit leaseHours", () => {
  const claimed = claimWork({ id: "w1" }, "quill", { leaseHours: 6, now: T0 });
  const renewed = renewWork(claimed, "quill", { leaseHours: 6, now: T0 + H });
  assert.equal(renewed.leaseExpiresAt, iso(T0 + 7 * H));
});

test("renewWork refuses a foreign owner, a non-active claim, a leaseless claim, and a lapsed lease", () => {
  const claimed = claimWork({ id: "w1" }, "quill", { leaseHours: 6, now: T0 });
  throwsCode(() => renewWork(claimed, "grok", { now: T0 + H }), "invalid_claim_input");
  throwsCode(() => renewWork(updateWork(claimed, "quill", { state: "done", now: T0 + H }), "quill", { now: T0 + H }), "invalid_claim_input");
  throwsCode(() => renewWork(claimWork({ id: "w2" }, "quill", { leaseHours: null, now: T0 }), "quill", { now: T0 + H }), "invalid_claim_input");
  throwsCode(() => renewWork(claimWork({ id: "w3" }, "quill", { leaseHours: 1, now: T0 }), "quill", { now: T0 + 2 * H }), "invalid_claim_input");
  assert.match(capture(() => renewWork(claimed, "grok", { now: T0 + H })).message, /only the owner/);
  assert.match(capture(() => renewWork(claimWork({ id: "w3" }, "quill", { leaseHours: 1, now: T0 }), "quill", { now: T0 + 2 * H })).message, /lease already lapsed/);
});

// ---------------------------------------------------------------------------
// Part 3: the HTTP /renew route
// ---------------------------------------------------------------------------
const fakeHelpers = () => {
  const calls = [];
  const reject = (status, code, message) => {
    const error = new Error(message); error.status = status; error.code = code; throw error;
  };
  const json = (res, status, value) => { calls.push({ status, value }); return { status, value }; };
  return { calls, json, reject, body: async req => req.body };
};
const runRoute = async ({ route, id, body = {}, memberId = "quill", registry, storeMessages = [] }) => {
  const helpers = fakeHelpers();
  const store = {
    roomAuthority: () => ({ members: { quill: { id: "quill" }, grok: { id: "grok" } } }),
    room: () => ({ sequence: 1, state: { messages: storeMessages } }),
  };
  try {
    const out = await handleWorkClaims({ req: { method: route === "list" ? "GET" : "POST", body }, res: {},
      url: {}, store, roomId: "room1", auth: { member: { id: memberId, kind: "agent", permissions: [] } },
      workClaimRoute: route, workClaimId: id, helpers, registry });
    return { out, error: null, calls: helpers.calls };
  } catch (error) {
    return { out: null, error, calls: helpers.calls };
  }
};
const liveMessage = (overrides = {}) => ({ id: "progress-1", authorId: "quill", body: "Half done.",
  createdAt: new Date(Date.now() + 60_000).toISOString(), revision: 0, ...overrides });
const claimedRegistry = async (claimBody = { leaseHours: 6 }) => {
  const registry = createWorkClaimRegistry();
  await runRoute({ route: "create", id: "w1", body: { id: "w1", title: "t" }, registry });
  const { error } = await runRoute({ route: "claim", id: "w1", body: claimBody, registry });
  assert.equal(error, null);
  return registry;
};

test("handler: renew extends the lease on a fresh public check-in", async () => {
  const registry = await claimedRegistry();
  const before = registry.get("room1", "w1").leaseExpiresAt;
  const { out, error } = await runRoute({ route: "renew", id: "w1", body: { progressMessageId: "progress-1" },
    storeMessages: [liveMessage()], registry });
  assert.equal(error, null);
  assert.ok(Date.parse(out.value.leaseExpiresAt) > Date.parse(before));
  assert.ok(Date.parse(out.value.leaseStartAt) >= Date.parse(out.value.claimedAt));
  assert.equal(out.value.history.at(-1).action, "renewed");
});

test("handler: renew without a progress message id is refused", async () => {
  const registry = await claimedRegistry();
  const { error } = await runRoute({ route: "renew", id: "w1", body: {}, registry });
  assert.equal(error.status, 422);
  assert.equal(error.code, "invalid_claim_input");
});

test("handler: renew with a DM check-in is refused", async () => {
  const registry = await claimedRegistry();
  const { error } = await runRoute({ route: "renew", id: "w1", body: { progressMessageId: "progress-1" },
    storeMessages: [liveMessage({ toMemberId: "grok" })], registry });
  assert.equal(error.status, 422);
  assert.equal(error.code, "claim_renewal_source_required");
  assert.match(error.message, /public room message/i);
});

test("handler: renew with another member's check-in is refused", async () => {
  const registry = await claimedRegistry();
  const { error } = await runRoute({ route: "renew", id: "w1", body: { progressMessageId: "progress-1" },
    storeMessages: [liveMessage({ authorId: "grok" })], registry });
  assert.equal(error.status, 403);
  assert.equal(error.code, "claim_renewal_source_foreign");
});

test("handler: renew with a stale check-in is refused", async () => {
  const registry = await claimedRegistry();
  const { error } = await runRoute({ route: "renew", id: "w1", body: { progressMessageId: "progress-1" },
    storeMessages: [liveMessage({ createdAt: new Date(Date.now() - 7 * H).toISOString() })], registry });
  assert.equal(error.status, 422);
  assert.equal(error.code, "claim_renewal_source_stale");
});

test("handler: renew by a non-owner is refused", async () => {
  const registry = await claimedRegistry();
  const { error } = await runRoute({ route: "renew", id: "w1", body: { progressMessageId: "progress-1" },
    memberId: "grok", storeMessages: [liveMessage()], registry });
  assert.equal(error.status, 403);
  assert.equal(error.code, "work_not_owner");
});

test("handler: renew of a leaseless claim is refused", async () => {
  // The HTTP claim route always takes a lease (null reads as "default"), so
  // the leaseless item is planted through the pure machine — the refusal is
  // what the renew route must enforce either way.
  const registry = createWorkClaimRegistry();
  registry.set("room1", claimWork({ id: "w1", title: "t" }, "quill", { leaseHours: null, now: Date.now() }));
  const { error } = await runRoute({ route: "renew", id: "w1", body: { progressMessageId: "progress-1" },
    storeMessages: [liveMessage()], registry });
  assert.equal(error.status, 422);
  assert.equal(error.code, "invalid_claim_input");
});
