// Equivalence battery for the write path: the landed write-through
// projection cache (#3853, watch-invalidation design) plus WRITE-PATH-WINS
// wins 2-5. The cases are the divergence shapes named in
// cmd-persist-profile.md §7 (the object serialized mid-command is not
// always the final committed state: same-transaction follow-up writes,
// state replaced after the persist point, at-rest form divergence) plus
// one case per ported win where its sharing/release shortcut could bite.
//
// The cache tripwire: fixtures open the store with verifyProjectionCache
// (env ROOM_VERIFY_PROJECTION_CACHE=1), so every room() hit is checked
// against a fresh read of the stored row inside the store itself; the
// tests additionally compare room() against the raw stored bytes.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T, applyEvent, event, replay } from "../src/events.js";
import { seedEvents } from "../src/seed.js";
import { storedProjection, hydrateProjection } from "../server/projection-at-rest.mjs";
import { archiveMarker } from "../server/messages-store.mjs";
import { readConversation } from "../server/conversation-sync.mjs";

const command = (type, data, id = randomUUID()) => ({ id, type, data });
const big = (tag, n = 6000) => `${tag}:` + "x".repeat(n);

function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-write-through-"));
  const file = join(directory, "room.sqlite");
  const store = new RoomStore(file, { verifyProjectionCache: true, ...options });
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  const raw = () => store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection;
  const bodies = () => store.db.prepare("SELECT sha, body FROM projection_bodies WHERE room_id='commons'").all();
  t.after(() => { try { store.close(); } catch { /* closed */ } rmSync(directory, { recursive: true, force: true }); });
  return { store, owner, file, raw, bodies };
}

// --- §7: the landed cache against mid-transaction divergence -------------

test("§7 two writes in one transaction: only the final committed state is ever served", t => {
  const { store, owner, raw } = fixture(t);
  store.command(owner, "commons", command(T.MESSAGE_POSTED, { messageId: "m1", body: "kept" }));
  // The §7 shape (resumeRoundLimitPauses is the product instance): a state
  // is serialized and written, then replaced before the transaction ends.
  store.transaction(() => {
    const base = store.room("commons").state;
    const first = structuredClone(base); first.room.title = "FIRST (never committed alone)";
    store.db.prepare("UPDATE rooms SET projection=? WHERE id=?").run(store.storedProjection("commons", first), "commons");
    const second = structuredClone(base); second.room.title = "SECOND (committed)";
    store.db.prepare("UPDATE rooms SET projection=? WHERE id=?").run(store.storedProjection("commons", second), "commons");
  });
  const served = store.room("commons");
  assert.equal(served.state.room.title, "SECOND (committed)");
  assert.equal(store.room("commons"), served, "the second read is the cache hit and agrees");
  assert.deepEqual(JSON.parse(JSON.stringify(served.state)), JSON.parse(raw()), "served state equals the stored bytes");
});

test("§7 a rolled-back write never reaches the cache", t => {
  const { store, owner } = fixture(t);
  store.command(owner, "commons", command(T.MESSAGE_POSTED, { messageId: "m1", body: "kept" }));
  const before = store.room("commons").state;
  assert.throws(() => store.transaction(() => {
    const changed = structuredClone(before); changed.room.title = "ROLLED BACK";
    store.db.prepare("UPDATE rooms SET projection=? WHERE id=?").run(store.storedProjection("commons", changed), "commons");
    throw new Error("boom");
  }), /boom/);
  const after = store.room("commons");
  assert.equal(after.state.room.title, before.room.title);
  assert.deepEqual(after.state.messages.map(m => m.id), ["m1"]);
});

test("§7 post then delete: the in-transaction redaction follow-up (PRIV-1) is what the cache serves", t => {
  const { store, owner, raw } = fixture(t);
  store.command(owner, "commons", command(T.MESSAGE_POSTED, { messageId: "secret", body: "msg-0 body" }));
  // MESSAGE_DELETED is the MSG-0 shape: command() first persists the
  // delete and queues that state as a cache candidate, then
  // commitMessageRedaction rewrites the log and replaces the state in
  // the SAME transaction. The cache must serve the final committed
  // state, never the mid-transaction candidate.
  store.command(owner, "commons", command(T.MESSAGE_DELETED, { messageId: "secret", expectedMessageRevision: 0, reason: "redact" }));
  const served = store.room("commons").state;
  const message = served.messages.find(m => m.id === "secret");
  assert.equal(message.body, null);
  assert.equal(message.redacted, true);
  assert.deepEqual(JSON.parse(JSON.stringify(served)), JSON.parse(raw()), "served state equals the stored bytes after the redaction follow-up");
});

test("§7 at-rest form divergence: a slimmed stored row and the served state agree, verify on", t => {
  const { store, owner, raw, bodies } = fixture(t, { bodiesAtRest: true });
  const text = big("at-rest");
  store.command(owner, "commons", command(T.MESSAGE_POSTED, { messageId: "long", body: text }));
  store.command(owner, "commons", command(T.MESSAGE_POSTED, { messageId: "short", body: "hi" }));
  assert.equal(bodies().length, 1);
  assert.doesNotMatch(raw(), /at-rest:xxx/, "the stored row is slimmed");
  const served = store.room("commons").state;
  const hydrated = hydrateProjection(store.db, "commons", JSON.parse(raw())).state;
  assert.deepEqual(JSON.parse(JSON.stringify(served)), JSON.parse(JSON.stringify(hydrated)));
  assert.equal(served.messages.find(m => m.id === "long").body, text);
});

// --- Win 2: cloneStateForApply light message clones -----------------------

const ROOM_ID = "room-project-room-v0";
const ev = (id, type, actorId, data) => event({ id, idempotencyKey: id, roomId: ROOM_ID, type, actorId, at: "2026-10-17T00:00:00.000Z", data });
const baseState = () => replay(seedEvents);
const withMessage = () => applyEvent(baseState(), ev("post-m", T.MESSAGE_POSTED, "maya", { messageId: "m", body: "original body" }));
const withPoll = () => applyEvent(baseState(), ev("post-p", T.MESSAGE_POSTED, "maya", { messageId: "p", body: "Pick", kind: "poll", poll: { question: "Pick", options: ["a", "b"] } }));

test("win 2: applyEvent never mutates its input state, for every light-clone event type", () => {
  const cases = [
    ["message.posted", withMessage(), () => ev("post-m2", T.MESSAGE_POSTED, "maya", { messageId: "m2", body: "second" })],
    ["message.edited", withMessage(), () => ev("edit-m", T.MESSAGE_EDITED, "maya", { messageId: "m", body: "edited", expectedMessageRevision: 0 })],
    ["message.deleted", withMessage(), () => ev("del-m", T.MESSAGE_DELETED, "maya", { messageId: "m", expectedMessageRevision: 0, reason: "cleanup" })],
    ["message.redacted", withMessage(), () => ev("redact-m", T.MESSAGE_REDACTED, "potter", { messageId: "m" })],
    ["poll.voted", withPoll(), () => ev("vote-p", T.POLL_VOTED, "potter", { messageId: "p", option: 0, active: true })]
  ];
  for (const [name, state, make] of cases) {
    const snapshot = JSON.stringify(state);
    const next = applyEvent(state, make());
    assert.equal(JSON.stringify(state), snapshot, `${name} mutated its input state`);
    assert.notEqual(next, state);
  }
});

test("win 2: the addressed message and its :channel copy are cloned; earlier states keep the original text", () => {
  const posted = withMessage();
  const withCopy = structuredClone(posted);
  withCopy.messages.push({ ...withCopy.messages.find(m => m.id === "m"), id: "m:channel" });
  const snapshot = JSON.stringify(withCopy);
  const redacted = applyEvent(withCopy, ev("redact-m2", T.MESSAGE_REDACTED, "potter", { messageId: "m" }));
  assert.equal(JSON.stringify(withCopy), snapshot, "redact mutated its input (shared element leaked)");
  assert.equal(redacted.messages.find(m => m.id === "m").body, null);
  assert.equal(redacted.messages.find(m => m.id === "m:channel").body, null, "the channel copy is rewritten too");
  const edited = applyEvent(posted, ev("edit-m2", T.MESSAGE_EDITED, "maya", { messageId: "m", body: "edited body", expectedMessageRevision: 0 }));
  assert.equal(edited.messages.find(m => m.id === "m").body, "edited body");
  assert.equal(posted.messages.find(m => m.id === "m").body, "original body", "the pre-edit state still shows the original");
});

test("win 2: sharing-invariance — a mixed sequence gives identical states with and without shared elements", () => {
  const sequence = [
    () => ev("s1", T.MESSAGE_POSTED, "maya", { messageId: "a", body: "first" }),
    () => ev("s2", T.MESSAGE_POSTED, "maya", { messageId: "b", body: "Pick", kind: "poll", poll: { question: "Pick", options: ["a", "b"] } }),
    () => ev("s3", T.POLL_VOTED, "potter", { messageId: "b", option: 1, active: true }),
    () => ev("s4", T.MESSAGE_EDITED, "maya", { messageId: "a", body: "first (edited)", expectedMessageRevision: 0 }),
    () => ev("s5", T.MESSAGE_POSTED, "potter", { messageId: "c", body: "third" }),
    () => ev("s6", T.MESSAGE_REDACTED, "potter", { messageId: "c" }),
    () => ev("s7", T.MEMBER_ADDED, "potter", { memberId: "newbie", displayName: "New Bie", kind: "agent", permissions: ["accept_work"] }),
    () => ev("s8", T.MESSAGE_DELETED, "maya", { messageId: "a", expectedMessageRevision: 1, reason: "done" })
  ];
  let chained = baseState();
  for (const make of sequence) chained = applyEvent(chained, make());
  let isolated = baseState();
  for (const make of sequence) isolated = applyEvent(structuredClone(isolated), make());
  assert.deepEqual(isolated, chained, "light-clone sharing changed the result of the sequence");
});

// --- Win 2 / S-2: the light rule extends to every audited event type -------
// HUNT-SCALE-2 S-2: cloneStateForApply used to deep-clone the whole
// messages array for every non-message command. The extension rests on a
// handler-by-handler audit: no handler outside the rewrite set mutates a
// message element (the message-touching ones read — propose's .some,
// claim.renew's find, nativeTextEvidence, requirePublicDecisionSource,
// pin/unpin — and the receipt sweeps range over workItems, which keeps
// its full structuredClone). These cases pin input immutability on the
// success path for each newly light family; the canary below pins it on
// rejection paths for every registered type.

const evAt = (id, type, actorId, data, at = "2026-10-17T00:00:00.000Z") =>
  event({ id, idempotencyKey: id, roomId: ROOM_ID, type, actorId, at, data });
const chain = (state, ...makes) => makes.reduce((s, make) => applyEvent(s, make()), state);
const withProposed = () => chain(baseState(),
  () => evAt("wp-1", T.WORK_PROPOSED, "potter", { workItemId: "w-battery", title: "Battery item", definitionOfDone: "Done", accountableMemberId: "codex", verifierMemberId: "instinct" }));
const withAccepted = () => chain(withProposed(),
  () => evAt("wa-1", T.WORK_ACCEPTED, "codex", { workItemId: "w-battery", expectedRevision: 0 }));
const withStarted = () => chain(withAccepted(),
  () => evAt("ws-1", T.WORK_STARTED, "codex", { workItemId: "w-battery", expectedRevision: 1 }));
const withCompleted = () => chain(withStarted(),
  () => evAt("wc-1", T.WORK_COMPLETED, "codex", { workItemId: "w-battery", expectedRevision: 2, summary: "done", evidenceVersion: "v-battery", nextAction: "verify" }));
const withBlocked = () => chain(withStarted(),
  () => evAt("wb-1", T.WORK_BLOCKED, "codex", { workItemId: "w-battery", expectedRevision: 2, reason: "stuck", nextAction: "unblock" }));
const withClaim = () => chain(
  chain(baseState(),
    () => evAt("wp-2", T.WORK_PROPOSED, "potter", { workItemId: "w-write", title: "Write item", definitionOfDone: "Done", accountableMemberId: "codex", mode: "write" }),
    () => evAt("wa-2", T.WORK_ACCEPTED, "codex", { workItemId: "w-write", expectedRevision: 0 })),
  () => evAt("wcl-1", T.CLAIM_ACQUIRED, "codex", { workItemId: "w-write", expectedRevision: 1, repository: "Uuriko/project-room", ref: "battery", paths: ["src/**"], expiresAt: "2026-10-18T00:00:00.000Z" }));
const withTextReceipt = () => chain(
  chain(withStarted(),
    () => evAt("post-ev", T.MESSAGE_POSTED, "codex", { messageId: "ev-msg", body: "result text", workItemId: "w-battery" })),
  () => evAt("wc-text", T.WORK_COMPLETED, "codex", { workItemId: "w-battery", expectedRevision: 2, evidenceKind: "room_text", summary: "done", evidenceVersion: `sha256:${"a".repeat(64)}`, nextAction: "verify", evidenceMessageId: "ev-msg", evidenceMessageEventId: "post-ev", previousCompletionEventId: null, producerId: "codex" }));
const withReplyRequest = () => chain(baseState(),
  () => evAt("post-rq", T.MESSAGE_POSTED, "maya", { messageId: "rq-1", body: "please check", toMemberId: "potter", requestKind: "reply", requestPolicyVersion: 1 }));

test("win 2 / S-2: applyEvent never mutates its input state, for every newly light event type", () => {
  const cases = [
    ["room.policy_set", baseState(), () => evAt("c-policy", T.ROOM_POLICY_SET, "potter", { requireIndependentReview: false, requireOwnerDecision: false })],
    ["room.trust_set", baseState(), () => evAt("c-trust", T.ROOM_TRUST_SET, "potter", { enabled: true })],
    ["room.public_receipts_set", baseState(), () => evAt("c-receipts", T.ROOM_PUBLIC_RECEIPTS_SET, "potter", { enabled: true })],
    ["room.public_page_set", baseState(), () => evAt("c-page", T.ROOM_PUBLIC_PAGE_SET, "potter", { enabled: true })],
    ["room.join_link_set", baseState(), () => evAt("c-join", T.ROOM_JOIN_LINK_SET, "potter", { enabled: true })],
    ["room.history_visibility_set", baseState(), () => evAt("c-hist", T.ROOM_HISTORY_VISIBILITY_SET, "potter", { historyVisibility: "all" })],
    ["room.exported", baseState(), () => evAt("c-export", T.ROOM_EXPORTED, "potter", { format: "jsonl" })],
    ["room.archived", baseState(), () => evAt("c-archive", T.ROOM_ARCHIVED, "potter", { reason: "done" })],
    ["ownership.transferred", baseState(), () => evAt("c-owner", T.OWNERSHIP_TRANSFERRED, "potter", { toMemberId: "maya" })],
    ["member.public_name_set", baseState(), () => evAt("c-pubname", T.MEMBER_PUBLIC_NAME_SET, "maya", { enabled: true })],
    ["member.status_updated", baseState(), () => evAt("c-status", T.MEMBER_STATUS_UPDATED, "maya", { message: "heads down" })],
    ["member.mute_set", baseState(), () => evAt("c-mute", T.MEMBER_MUTE_SET, "maya", { memberId: "codex", muted: true })],
    ["notifications.preferences_set", baseState(), () => evAt("c-prefs", T.NOTIFICATION_PREFERENCES_SET, "maya", { preferences: { mentions: "mentions_only" } })],
    ["member.access_changed", baseState(), () => evAt("c-access", T.MEMBER_ACCESS_CHANGED, "potter", { memberId: "codex", expectedMemberRevision: 0, permissions: ["accept_work", "complete_work", "write_external"], active: true })],
    ["channel.created", baseState(), () => evAt("c-chan", T.CHANNEL_CREATED, "potter", { name: "battery-room" })],
    ["channel.renamed", chain(baseState(), () => evAt("c-chan", T.CHANNEL_CREATED, "potter", { name: "battery-room" })), () => evAt("c-rename", T.CHANNEL_RENAMED, "potter", { channelId: "c-chan", name: "battery-two" })],
    ["channel.archived", chain(baseState(), () => evAt("c-chan", T.CHANNEL_CREATED, "potter", { name: "battery-room" })), () => evAt("c-chanarch", T.CHANNEL_ARCHIVED, "potter", { channelId: "c-chan" })],
    ["work.proposed", baseState(), () => evAt("c-propose", T.WORK_PROPOSED, "potter", { workItemId: "w-new", title: "New", definitionOfDone: "Done", accountableMemberId: "codex", sourceMessageId: "evt-message-1" })],
    ["work.accepted", withProposed(), () => evAt("c-accept", T.WORK_ACCEPTED, "codex", { workItemId: "w-battery", expectedRevision: 0 })],
    ["work.started", withAccepted(), () => evAt("c-start", T.WORK_STARTED, "codex", { workItemId: "w-battery", expectedRevision: 1 })],
    ["work.blocked", withStarted(), () => evAt("c-block", T.WORK_BLOCKED, "codex", { workItemId: "w-battery", expectedRevision: 2, reason: "stuck", nextAction: "unblock" })],
    ["work.blocker_resolved", withBlocked(), () => evAt("c-resolve", T.WORK_BLOCKER_RESOLVED, "codex", { workItemId: "w-battery", expectedRevision: 3, resolution: "unstuck" })],
    ["work.handoff_recorded", withStarted(), () => evAt("c-handoff", T.WORK_HANDOFF_RECORDED, "codex", { workItemId: "w-battery", expectedRevision: 2, doneSummary: "part", nextAction: "rest", limitReason: "time" })],
    ["work.completed", withStarted(), () => evAt("c-complete", T.WORK_COMPLETED, "codex", { workItemId: "w-battery", expectedRevision: 2, summary: "done", evidenceVersion: "v-battery", nextAction: "verify" })],
    ["work.superseded", withProposed(), () => evAt("c-supersede", T.WORK_SUPERSEDED, "potter", { workItemId: "w-battery", expectedRevision: 0, supersededByWorkItemId: "work-spec-review", reason: "replaced" })],
    ["work.public_set", withProposed(), () => evAt("c-pubtask", T.WORK_PUBLIC_SET, "potter", { workItemId: "w-battery", enabled: true })],
    ["claim.acquired", chain(baseState(),
      () => evAt("wp-2", T.WORK_PROPOSED, "potter", { workItemId: "w-write", title: "Write item", definitionOfDone: "Done", accountableMemberId: "codex", mode: "write" }),
      () => evAt("wa-2", T.WORK_ACCEPTED, "codex", { workItemId: "w-write", expectedRevision: 0 })),
      () => evAt("c-claim", T.CLAIM_ACQUIRED, "codex", { workItemId: "w-write", expectedRevision: 1, repository: "Uuriko/project-room", ref: "battery", paths: ["src/**"], expiresAt: "2026-10-18T00:00:00.000Z" })],
    ["claim.released", withClaim(), () => evAt("c-release", T.CLAIM_RELEASED, "codex", { workItemId: "w-write", expectedRevision: 2 })],
    ["claim.renewed", chain(withClaim(),
      () => evAt("post-prog", T.MESSAGE_POSTED, "codex", { messageId: "prog-1", body: "progress" }, "2026-10-17T01:00:00.000Z")),
      () => evAt("c-renew", T.CLAIM_RENEWED, "codex", { workItemId: "w-write", expectedRevision: 2, expiresAt: "2026-10-19T00:00:00.000Z", progressMessageId: "prog-1" }, "2026-10-17T02:00:00.000Z")],
    ["verification.recorded", withCompleted(), () => evAt("c-verify", T.VERIFICATION_RECORDED, "instinct", { workItemId: "w-battery", expectedRevision: 3, result: "pass", completionEventId: "wc-1", evidenceVersion: "v-battery", summary: "checked" })],
    ["owner.decision_recorded", baseState(), () => evAt("c-decide", T.OWNER_DECISION_RECORDED, "potter", { workItemId: "work-spec-review", decision: "approved", completionEventId: "evt-work-review-completed", evidenceVersion: "58875941ed50d01edacbdc91f1edebe85ba6b53e", reason: "sound", sourceMessageId: "evt-message-1" })],
    ["decision.recorded", baseState(), () => evAt("c-decision", T.DECISION_RECORDED, "potter", { sourceMessageId: "evt-message-1", statement: "We ship the slice." })],
    ["message.pinned", withMessage(), () => evAt("c-pin", T.MESSAGE_PINNED, "potter", { messageId: "m" })],
    ["message.unpinned", chain(withMessage(), () => evAt("c-pin", T.MESSAGE_PINNED, "potter", { messageId: "m" })), () => evAt("c-unpin", T.MESSAGE_UNPINNED, "potter", { messageId: "m" })],
    ["receipt.evidence_withdrawn", withTextReceipt(), () => evAt("c-withdraw", T.RECEIPT_EVIDENCE_WITHDRAWN, "potter", { messageId: "ev-msg", evidence: "removed" })],
    ["reply_request.cancelled", withReplyRequest(), () => evAt("c-cancel", T.REPLY_REQUEST_CANCELLED, "maya", { requestMessageId: "rq-1", expectedRequestRevision: 0, reason: "no longer needed" })],
    ["capabilities.advertised", baseState(), () => evAt("c-caps", T.CAPABILITIES_ADVERTISED, "codex", { capabilities: ["code-review"] })],
    ["access.requested", baseState(), () => evAt("c-accessreq", T.ACCESS_REQUESTED, "potter", { requestId: "req-1", identityId: "id-req-1", displayName: "Requester", permissions: [] })],
    ["referral.completed", baseState(), () => evAt("c-referral", T.REFERRAL_COMPLETED, "potter", { referrerMemberId: "potter", refereeMemberId: "maya", via: "invite", completedAt: 1760000000000 })],
    ["bond.proposed", baseState(), () => evAt("c-bond", T.BOND_PROPOSED, "potter", { bondId: "bond-1", agentAId: "codex", agentBId: "instinct", proposerIdentityId: "potter", scopes: ["read"] })],
    ["dm.posted", baseState(), () => evAt("c-dm", T.DM_POSTED, "potter", { messageId: "dm-1", threadId: "th-1", bondId: "bond-1", fromIdentityId: "potter", toIdentityId: "codex", body: "hello" })],
    ["room.starter_seeded", baseState(), () => evAt("c-seed", T.ROOM_STARTER_SEEDED, "potter", { templateSlug: "starter", intentKind: "welcome" })]
  ];
  for (const [name, state, make] of cases) {
    const snapshot = JSON.stringify(state);
    const next = applyEvent(state, make());
    assert.equal(JSON.stringify(state), snapshot, `${name} mutated its input state`);
    assert.notEqual(next, state);
    // The light path itself: unaddressed message elements are shared with
    // the input (a full clone here would mean the type silently fell out
    // of the light set and the S-2 premium is back).
    if (state.messages.length) {
      assert.ok(next.messages.some((m, i) => m === state.messages[i]),
        `${name} did not take the light message path`);
    }
  }
});

test("win 2 / S-2: no event type mutates its input state, even on a rejection path", () => {
  const state = withMessage();
  const snapshot = JSON.stringify(state);
  for (const type of [...Object.values(T), "message.reaction_set"]) {
    try { applyEvent(state, evAt(`canary-${type}`, type, "potter", {})); } catch { /* rejection is the expected path here */ }
    assert.equal(JSON.stringify(state), snapshot, `${type} mutated its input state on a rejection path`);
  }
});

test("win 2 / S-2: sharing-invariance — a non-message-heavy sequence matches the isolated run", () => {
  const sequence = [
    () => evAt("n1", T.ROOM_POLICY_SET, "potter", { requireIndependentReview: false, requireOwnerDecision: false }),
    () => evAt("n2", T.WORK_PROPOSED, "potter", { workItemId: "w-seq", title: "Sequence item", definitionOfDone: "Done", accountableMemberId: "codex", verifierMemberId: "instinct", sourceMessageId: "evt-message-1" }),
    () => evAt("n3", T.MESSAGE_POSTED, "maya", { messageId: "seq-m", body: "sequence note" }),
    () => evAt("n4", T.MESSAGE_PINNED, "potter", { messageId: "seq-m" }),
    () => evAt("n5", T.WORK_ACCEPTED, "codex", { workItemId: "w-seq", expectedRevision: 0 }),
    () => evAt("n6", T.CHANNEL_CREATED, "potter", { name: "seq-room" }),
    () => evAt("n7", T.WORK_STARTED, "codex", { workItemId: "w-seq", expectedRevision: 1 }),
    () => evAt("n8", T.MEMBER_STATUS_UPDATED, "maya", { message: "reviewing" }),
    () => evAt("n9", T.WORK_COMPLETED, "codex", { workItemId: "w-seq", expectedRevision: 2, summary: "done", evidenceVersion: "v-seq", nextAction: "verify" }),
    () => evAt("n10", T.VERIFICATION_RECORDED, "instinct", { workItemId: "w-seq", expectedRevision: 3, result: "pass", completionEventId: "n9", evidenceVersion: "v-seq", summary: "checked" }),
    () => evAt("n11", T.DECISION_RECORDED, "potter", { sourceMessageId: "seq-m", statement: "Sequence stands." }),
    () => evAt("n12", T.MESSAGE_UNPINNED, "potter", { messageId: "seq-m" }),
    () => evAt("n13", T.MESSAGE_EDITED, "maya", { messageId: "seq-m", body: "sequence note (edited)", expectedMessageRevision: 0 }),
    () => evAt("n14", T.MESSAGE_DELETED, "maya", { messageId: "seq-m", expectedMessageRevision: 1, reason: "done" })
  ];
  let chained = baseState();
  for (const make of sequence) chained = applyEvent(chained, make());
  let isolated = baseState();
  for (const make of sequence) isolated = applyEvent(structuredClone(isolated), make());
  assert.deepEqual(isolated, chained, "light-clone sharing changed the result of the non-message sequence");
});

// --- Wins 3+4: serializer-side body release and hydration trust -----------

test("win 4: the json_each release trigger is gone; the room_gone trigger remains", t => {
  const { store } = fixture(t, { bodiesAtRest: true });
  const triggers = store.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='rooms'").all().map(row => row.name);
  assert.ok(triggers.includes("projection_bodies_room_gone"), "room deletion still clears body rows");
  assert.ok(!triggers.includes("projection_bodies_release"), "the per-write json_each trigger is retired");
});

test("win 4: two messages sharing one body share one row; the row is released only when the last reference goes", t => {
  const { store, owner, bodies } = fixture(t, { bodiesAtRest: true });
  const shared = big("shared");
  store.command(owner, "commons", command(T.MESSAGE_POSTED, { messageId: "one", body: shared }));
  store.command(owner, "commons", command(T.MESSAGE_POSTED, { messageId: "two", body: shared }));
  assert.equal(bodies().length, 1, "content-addressed: one row for two references");
  store.command(owner, "commons", command(T.MESSAGE_DELETED, { messageId: "one", expectedMessageRevision: 0, reason: "x" }));
  assert.equal(bodies().length, 1, "still referenced by the surviving message");
  assert.equal(store.room("commons").state.messages.find(m => m.id === "two").body, shared);
  store.command(owner, "commons", command(T.MESSAGE_DELETED, { messageId: "two", expectedMessageRevision: 0, reason: "x" }));
  assert.equal(bodies().length, 0, "released when the last reference is deleted");
});

test("win 4: a rolled-back write rolls the body release back with it", t => {
  const { store, owner, bodies } = fixture(t, { bodiesAtRest: true });
  const text = big("rollback");
  store.command(owner, "commons", command(T.MESSAGE_POSTED, { messageId: "m", body: text }));
  assert.equal(bodies().length, 1);
  assert.throws(() => store.transaction(() => {
    const emptied = structuredClone(store.room("commons").state);
    emptied.messages = [];
    store.db.prepare("UPDATE rooms SET projection=? WHERE id=?").run(store.storedProjection("commons", emptied), "commons");
    throw new Error("boom");
  }), /boom/);
  assert.equal(bodies().length, 1, "the release was inside the rolled-back transaction");
  assert.equal(store.room("commons").state.messages.find(m => m.id === "m").body, text);
});

test("win 3: hydration trusts the content-addressed key by default; verifyBodyHashes catches a tampered row", t => {
  const { store, owner, raw } = fixture(t, { bodiesAtRest: true });
  store.command(owner, "commons", command(T.MESSAGE_POSTED, { messageId: "m", body: big("trust") }));
  const parsed = JSON.parse(raw());
  store.db.prepare("UPDATE projection_bodies SET body='tampered text' WHERE room_id='commons'").run();
  const trusted = hydrateProjection(store.db, "commons", structuredClone(parsed));
  assert.deepEqual(trusted.missing, [], "the hot path does not re-hash (content-addressed rows are immutable through every write path)");
  assert.equal(trusted.state.messages.find(m => m.id === "m").body, "tampered text");
  const verified = hydrateProjection(store.db, "commons", structuredClone(parsed), { verifyBodyHashes: true });
  assert.deepEqual(verified.missing, ["m"], "the verification path (messages parity) still catches the tamper");
  store.db.prepare("DELETE FROM projection_bodies WHERE room_id='commons'").run();
  assert.deepEqual(hydrateProjection(store.db, "commons", structuredClone(parsed)).missing, ["m"], "a missing row is reported in both modes");
});

test("win 3: the conversation read still recovers a tampered body row from the event log", t => {
  // The pinned contract (8956bc3b2) win 3 must not break: hydrateRecordText
  // detects the tamper per record, and its recovery source — a verified
  // room() read — repairs from the log instead of serving the tamper.
  const { store, owner, raw } = fixture(t, { bodiesAtRest: true });
  const text = big("recover-me");
  store.command(owner, "commons", command(T.MESSAGE_POSTED, { messageId: "m", body: text }));
  const sha = JSON.parse(raw()).messages.find(m => m.id === "m").bodyRef;
  store.db.prepare("UPDATE projection_bodies SET body=? WHERE room_id='commons' AND sha=?").run("x".repeat(6000), sha);
  const page = readConversation(store, owner, "commons", { limit: 10 });
  assert.equal(page.messages.find(m => m.id === "m")?.body, text, "the true body is served from the event log");
  assert.equal(store.room("commons").state.messages.find(m => m.id === "m").body, text, "the verified read also repaired the cache entry");
});

// --- Win 5: extraction probes ----------------------------------------------

test("win 5: archiveMarker answers absent fast, survives a body quoting the key, and reads a real marker", t => {
  const { store, owner } = fixture(t);
  const absent = { throughSeq: 0, count: 0, retainedIds: [], retainedJson: "[]" };
  assert.deepEqual(archiveMarker(store.db, "commons"), absent);
  store.command(owner, "commons", command(T.MESSAGE_POSTED, { messageId: "q", body: "look: \"messagesArchive\" is just text here" }));
  assert.deepEqual(archiveMarker(store.db, "commons"), absent, "a quoted key in a body is a probe false-positive, never a false marker");
  const state = JSON.parse(store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection);
  state.messagesArchive = { throughSeq: 7, count: 4, retainedIds: ["keep-1"] };
  store.db.prepare("UPDATE rooms SET projection=? WHERE id='commons'").run(JSON.stringify(state));
  assert.deepEqual(archiveMarker(store.db, "commons"), { throughSeq: 7, count: 4, retainedIds: ["keep-1"], retainedJson: "[\"keep-1\"]" });
});

test("win 5: roomAuthority reads the true authority even when member names quote the messages boundary", t => {
  const { store, owner } = fixture(t);
  const truth = store.room("commons").state;
  store.command(owner, "commons", command(T.MEMBER_ADDED, { memberId: "tricky", displayName: "x,\"messages\":[", kind: "agent", permissions: ["accept_work"] }));
  store.command(owner, "commons", command(T.MEMBER_ADDED, { memberId: "trickier", displayName: "a\"},\"messages\":[", kind: "agent", permissions: ["accept_work"] }));
  const authority = store.roomAuthority("commons");
  assert.equal(authority.ownerId, truth.room.ownerId);
  assert.deepEqual(Object.keys(authority.members).sort(), Object.keys(store.room("commons").state.members).sort());
  assert.equal(authority.members.tricky.displayName, "x,\"messages\":[");
});

// storedProjection is imported for the direct-serializer cases above; keep
// the module surface exercised at the unit level too.
test("serializer unit: storedProjection releases a body the new state drops, in the same call", t => {
  const { store, raw } = fixture(t, { bodiesAtRest: true });
  const state = store.room("commons").state;
  const withBody = structuredClone(state);
  withBody.messages = [{ id: "solo", authorId: "owner", body: big("solo"), channelId: "general", workItemId: null, replyToId: null, toMemberId: null, createdAt: 1 }];
  store.transaction(() => {
    store.db.prepare("UPDATE rooms SET projection=? WHERE id=?").run(storedProjection(store.db, "commons", withBody, { enabled: true }), "commons");
  });
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM projection_bodies WHERE room_id='commons'").get().n, 1);
  const emptied = structuredClone(withBody); emptied.messages = [];
  store.transaction(() => {
    store.db.prepare("UPDATE rooms SET projection=? WHERE id=?").run(storedProjection(store.db, "commons", emptied, { enabled: true }), "commons");
  });
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM projection_bodies WHERE room_id='commons'").get().n, 0);
  assert.doesNotMatch(raw(), /bodyRef/);
});
