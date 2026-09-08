import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { AssignmentWatcher, attentionNotices } from "../client/assignment-watcher.mjs";
import { WatchJournal } from "../client/watch-journal.mjs";

// Actual domain/service persistence; only the transport is a read-only adapter.
// Credentials remain in this disposable fixture, never in journal state/output.
function fixture(t, viewer = "agent") {
  let time = 1800000000000;
  const directory = mkdtempSync(join(tmpdir(), "room-assignment-watch-test-"));
  const store = new RoomStore(":memory:", { now: () => time });
  store.initialize(initialRoom());
  const keys = { owner: store.issueAccessKey("commons", "owner") };
  const send = (actor, type, data) => store.command(keys[actor], "commons", { id: randomUUID(), type, data });
  for (const memberId of ["agent", "reviewer"]) {
    send("owner", T.MEMBER_ADDED, { memberId, displayName: memberId, kind: "agent", accountableHumanId: "owner",
      permissions: ["accept_work", "complete_work", "verify", "write_external"] });
    keys[memberId] = store.issueAccessKey("commons", memberId);
  }
  const calls = [], emitted = [];
  const clientFor = (memberId = viewer, token = keys[memberId]) => ({
    async snapshot() { calls.push({ operation: "snapshot", memberId }); return store.snapshot(token, "commons"); },
    async changes(after, limit) { calls.push({ operation: "changes", memberId, after, limit }); return store.eventsAfter(token, "commons", after, limit); }
  });
  let journal = new WatchJournal(join(directory, "watch"));
  const client = clientFor();
  const f = {
    store, keys, calls, emitted, client, send,
    now: () => time,
    advance(ms) { time += ms; },
    item: workItemId => store.room("commons").state.workItems[workItemId],
    snapshot: memberId => store.snapshot(keys[memberId ?? viewer], "commons"),
    clientFor,
    get journal() { return journal; },
    reopenJournal() { journal.close(); journal = new WatchJournal(join(directory, "watch")); },
    work(workItemId = "work", details = {}) {
      return send("owner", T.WORK_PROPOSED, { workItemId, title: `Synthetic ${workItemId}`, definitionOfDone: "A checked fixture result",
        accountableMemberId: "agent", mode: "read", ...details });
    },
    mutate(actor, type, workItemId = "work", details = {}) {
      return send(actor, type, { workItemId, expectedRevision: f.item(workItemId).revision, ...details });
    },
    complete(workItemId = "work", version = "v1", actor = "agent") {
      return f.mutate(actor, T.WORK_COMPLETED, workItemId, { summary: "Synthetic fixture evidence", producerId: actor,
        evidenceVersion: version, evidenceUrl: "https://example.invalid/watcher-fixture", nextAction: "Review this fixture result" });
    },
    watcher(options = {}) {
      return new AssignmentWatcher({ client, journal, origin: "http://127.0.0.1:1234", roomId: "commons", now: f.now,
        emit: async notice => { emitted.push(structuredClone(notice)); }, ...options });
    }
  };
  t.after(() => { journal.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return f;
}

const codes = code => error => error.code === code;
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

test("attention follows actual accountable, verifier and human decision gates without changing work", t => {
  const f = fixture(t);
  f.work("work", { verifierMemberId: "reviewer", independentVerificationRequired: true,
    humanDecisionMakerId: "owner", ownerDecisionRequired: true });
  f.work("someone-else", { accountableMemberId: "owner" });
  const notices = memberId => attentionNotices(f.snapshot(memberId), f.now());
  assert.deepEqual([...notices("agent").keys()], ["work"]);
  assert.equal(notices("agent").get("work").payload.next.action, "accept");
  f.mutate("agent", T.WORK_ACCEPTED);
  assert.equal(notices("agent").get("work").payload.next.action, "start");
  f.mutate("agent", T.WORK_STARTED);
  assert.equal(notices("agent").size, 0);
  f.complete();
  assert.equal(notices("agent").size, 0);
  assert.equal(notices("reviewer").get("work").payload.next.action, "verify");
  assert.equal(notices("owner").has("work"), false);
  const receipt = f.item("work").receipt;
  f.mutate("reviewer", T.VERIFICATION_RECORDED, "work", { result: "pass", completionEventId: receipt.eventId,
    evidenceVersion: receipt.evidenceVersion, summary: "Checked the exact fixture version" });
  assert.equal(notices("reviewer").size, 0);
  assert.equal(notices("owner").get("work").payload.next.action, "decide");
  f.mutate("owner", T.OWNER_DECISION_RECORDED, "work", { decision: "approved", completionEventId: receipt.eventId,
    evidenceVersion: receipt.evidenceVersion, reason: "Synthetic decision, no external action" });
  const before = f.store.room("commons");
  for (const actor of ["agent", "reviewer", "owner"]) assert.equal(notices(actor).has("work"), false);
  assert.deepEqual(f.store.room("commons"), before);
});

test("snapshot polling deduplicates chat and repeats only observed renewed attention, never marking read", async t => {
  const f = fixture(t); f.work();
  const watcher = f.watcher(), before = f.snapshot();
  assert.equal(await watcher.tick(), 1);
  assert.equal(f.emitted[0].reason, "initial");
  assert.equal(f.emitted[0].notifyOnly, true);
  assert.equal(f.emitted[0].next.action, "accept");
  assert.equal(await watcher.tick(), 0);
  assert.deepEqual(f.store.room("commons").state, before.state && { ...before.state, eventLog: [] });
  f.send("owner", T.MESSAGE_POSTED, { messageId: "chat", body: "Unrelated fixture conversation" });
  f.send("reviewer", T.MESSAGE_REACTION_SET, { messageId: "chat", reaction: "like", active: true });
  assert.equal(await watcher.tick(), 0);
  f.mutate("agent", T.WORK_ACCEPTED);
  assert.equal(await watcher.tick(), 1);
  const firstStart = f.emitted.at(-1).id;
  assert.equal(f.emitted.at(-1).reason, "changed");
  assert.equal(f.emitted.at(-1).next.action, "start");
  f.mutate("agent", T.WORK_STARTED);
  assert.equal(await watcher.tick(), 0);
  f.mutate("agent", T.WORK_BLOCKED, "work", { reason: "New fixture question", nextAction: "Clarify it" });
  assert.equal(await watcher.tick(), 1);
  assert.equal(f.emitted.at(-1).next.action, "revise");
  f.mutate("agent", T.WORK_BLOCKER_RESOLVED, "work", { resolution: "Fixture question resolved" });
  assert.equal(await watcher.tick(), 1);
  assert.equal(f.emitted.at(-1).next.action, "start");
  assert.notEqual(f.emitted.at(-1).id, firstStart);
  assert.equal(f.snapshot().cursor, before.cursor);
  assert.equal(f.journal.state().sequence, f.snapshot().sequence);
  assert.ok(f.calls.every(call => ["snapshot", "changes"].includes(call.operation)));
  for (const token of Object.values(f.keys)) assert.equal(JSON.stringify([f.journal.state(), f.emitted]).includes(token), false);
});

test("a historical review may advance work revision without repeating a current review request", async t => {
  const f = fixture(t, "reviewer");
  f.work("work", { verifierMemberId: "reviewer", independentVerificationRequired: true });
  f.mutate("agent", T.WORK_ACCEPTED); f.complete();
  const oldReceipt = f.item("work").receipt;
  f.mutate("agent", T.WORK_BLOCKED, "work", { reason: "Prepare a new version", nextAction: "Revise" });
  f.mutate("agent", T.WORK_BLOCKER_RESOLVED, "work", { resolution: "Revision understood" });
  f.complete("work", "v2");
  const watcher = f.watcher();
  assert.equal(await watcher.tick(), 1);
  const revision = f.item("work").revision;
  f.mutate("reviewer", T.VERIFICATION_RECORDED, "work", { result: "pass", completionEventId: oldReceipt.eventId,
    evidenceVersion: oldReceipt.evidenceVersion, summary: "Late review of the older fixture only" });
  assert.equal(f.item("work").revision, revision + 1);
  assert.equal(f.item("work").receipt.evidenceVersion, "v2");
  assert.equal(await watcher.tick(), 0);
  assert.equal(f.emitted.length, 1);
  assert.equal(f.journal.state().sequence, f.snapshot().sequence);
});

test("claim expiry creates attention at the same sequence and a later claim lifecycle can notify again", async t => {
  const f = fixture(t); f.work("work", { mode: "write" });
  f.mutate("agent", T.WORK_ACCEPTED);
  const claim = () => f.mutate("agent", T.CLAIM_ACQUIRED, "work", { repository: "fictional/watcher", ref: "fixture",
    paths: ["notes/fixture.md"], expiresAt: new Date(f.now() + 1000).toISOString() });
  claim(); f.mutate("agent", T.WORK_STARTED);
  const watcher = f.watcher();
  assert.equal(await watcher.tick(), 0);
  const sequence = f.snapshot().sequence;
  f.advance(1000);
  assert.equal(await watcher.tick(), 1);
  assert.equal(f.emitted[0].next.action, "claim");
  assert.equal(f.snapshot().sequence, sequence);
  assert.equal(f.journal.state().sequence, sequence);
  assert.equal(await watcher.tick(), 0);
  claim(); assert.equal(await watcher.tick(), 0);
  f.advance(1000); assert.equal(await watcher.tick(), 1);
  assert.notEqual(f.emitted[0].id, f.emitted[1].id);
});

test("history anchors reject replaced checkpoint evidence without advancing the journal", async t => {
  const f = fixture(t); f.work();
  await f.watcher().tick();
  const before = f.journal.state(), count = f.emitted.length;
  f.send("owner", T.MESSAGE_POSTED, { body: "A later event does not replace an earlier anchor" });
  const client = { ...f.client, async changes(after, limit) {
    const page = await f.client.changes(after, limit);
    if (after === before.sequence - 1) page.events[0].event.id = "different-checkpoint-event";
    return page;
  } };
  await assert.rejects(f.watcher({ client }).tick(), codes("history_changed"));
  assert.deepEqual(f.journal.state(), before);
  assert.equal(f.emitted.length, count);
});

test("initial anchor validation rejects missing, wrong-room, wrong-type and wrong-sequence evidence", async t => {
  for (const kind of ["missing", "wrong-room", "wrong-type", "wrong-sequence"]) await t.test(kind, async sub => {
    const f = fixture(sub); f.work();
    const client = { ...f.client, async changes(after, limit) {
      const page = await f.client.changes(after, limit);
      if (after === 0) {
        if (kind === "missing") page.events = [];
        if (kind === "wrong-room") page.events[0].event.roomId = "another-room";
        if (kind === "wrong-type") page.events[0].event.type = T.MESSAGE_POSTED;
        if (kind === "wrong-sequence") page.events[0].sequence += 1;
      }
      return page;
    } };
    await assert.rejects(f.watcher({ client }).tick(), codes("history_changed"));
    assert.equal(f.journal.state(), null);
    assert.deepEqual(f.emitted, []);
  });
});

test("a lower snapshot sequence requires reconciliation rather than silently rebasing", async t => {
  const f = fixture(t); f.work(); await f.watcher().tick();
  const before = f.journal.state();
  const client = { ...f.client, async snapshot() { const value = await f.client.snapshot(); value.sequence -= 1; return value; } };
  await assert.rejects(f.watcher({ client }).tick(), codes("history_changed"));
  assert.deepEqual(f.journal.state(), before);
});

test("revoked pinned keys stop; explicit same-member rotation resumes but another member cannot reuse state", async t => {
  const f = fixture(t); f.work(); const watcher = f.watcher(); await watcher.tick();
  const before = f.journal.state();
  const rotated = f.store.issueAccessKey("commons", "agent");
  await assert.rejects(watcher.tick(), error => error.status === 401);
  assert.deepEqual(f.journal.state(), before);
  f.reopenJournal();
  assert.equal(await f.watcher({ client: f.clientFor("agent", rotated) }).tick(), 0);
  const rebound = f.journal.state();
  await assert.rejects(f.watcher({ client: f.clientFor("reviewer") }).tick(), codes("identity_changed"));
  assert.deepEqual(f.journal.state(), rebound);
  assert.equal(f.emitted.length, 1);
});

test("account deactivation and re-enabling changes the bound auth epoch even for the same member", async t => {
  const f = fixture(t, "owner"); f.work("work", { accountableMemberId: "owner" }); await f.watcher().tick();
  const before = f.journal.state(), account = f.store.accountForMember("commons", "owner");
  f.store.changeAccountAccess(account.id, { expectedRevision: account.revision, active: false, reason: "Fixture access retirement" });
  f.store.changeAccountAccess(account.id, { expectedRevision: account.revision + 1, active: true, reason: "Fixture explicit re-enable" });
  const rotated = f.store.issueAccessKey("commons", "owner");
  await assert.rejects(f.watcher({ client: f.clientFor("owner", rotated) }).tick(), codes("identity_changed"));
  assert.deepEqual(f.journal.state(), before);
});

test("uncertain output remains pending across restart and replays one stable notification ID", async t => {
  const f = fixture(t); f.work(); const attempts = [];
  const uncertain = new Error("Synthetic stdout callback failure");
  await assert.rejects(f.watcher({ emit: async notice => { attempts.push(structuredClone(notice)); throw uncertain; } }).tick(), error => error === uncertain);
  const pending = f.journal.pending(), checkpoint = f.journal.state();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, attempts[0].id);
  f.reopenJournal();
  assert.deepEqual(f.journal.pending(), pending);
  assert.deepEqual(f.journal.state(), checkpoint);
  assert.equal(await f.watcher().tick(), 1);
  assert.equal(f.emitted[0].id, attempts[0].id);
  assert.deepEqual(f.journal.pending(), []);
  assert.equal(await f.watcher().tick(), 0);
});

test("restart drops queued attention that resolved before output instead of emitting an obsolete assignment", async t => {
  const f = fixture(t); f.work();
  await assert.rejects(f.watcher({ emit: async () => { throw new Error("Synthetic output unavailable"); } }).tick());
  assert.equal(f.journal.pending().length, 1);
  f.mutate("agent", T.WORK_ACCEPTED); f.complete();
  f.reopenJournal();
  assert.equal(await f.watcher().tick(), 0);
  assert.deepEqual(f.journal.pending(), []);
  assert.deepEqual(f.emitted, []);
  assert.equal(f.journal.state().sequence, f.snapshot().sequence);
});

test("the second snapshot suppresses a task resolved after it was queued by the first", async t => {
  const f = fixture(t); f.work(); let reads = 0;
  const client = { ...f.client, async snapshot() {
    if (++reads === 2) { f.mutate("agent", T.WORK_ACCEPTED); f.complete(); }
    return f.client.snapshot();
  } };
  assert.equal(await f.watcher({ client }).tick(), 0);
  assert.equal(reads, 2);
  assert.deepEqual(f.journal.pending(), []);
  assert.deepEqual(f.emitted, []);
});

test("stop during a delayed snapshot prevents late checkpoint and output writes", async t => {
  const f = fixture(t); f.work(); const started = deferred(), release = deferred(), controller = new AbortController();
  const client = { ...f.client, async snapshot() {
    const value = await f.client.snapshot(); started.resolve(); await release.promise; return value;
  } };
  const result = f.watcher({ client, signal: controller.signal }).tick();
  const rejected = assert.rejects(result, codes("stopped"));
  await started.promise; controller.abort(); release.resolve(); await rejected;
  assert.equal(f.journal.state(), null);
  assert.deepEqual(f.emitted, []);
  assert.deepEqual(f.calls.map(call => call.operation), ["snapshot"]);
});

test("stop after output but before acknowledgement preserves its ID for an explicit restart", async t => {
  const f = fixture(t); f.work(); const controller = new AbortController(), writes = [];
  await assert.rejects(f.watcher({ signal: controller.signal, emit: async notice => {
    writes.push(structuredClone(notice)); controller.abort();
  } }).tick(), codes("stopped"));
  assert.equal(writes.length, 1);
  assert.equal(f.journal.pending()[0].id, writes[0].id);
  f.reopenJournal(); assert.equal(await f.watcher().tick(), 1);
  assert.equal(f.emitted[0].id, writes[0].id);
});

test("draining output is bounded and preserves remaining pending assignments", async t => {
  const f = fixture(t);
  for (let i = 0; i < 21; i++) f.work(`work-${String(i).padStart(2, "0")}`);
  const watcher = f.watcher();
  assert.equal(await watcher.tick(), 20);
  assert.equal(f.journal.pending().length, 1);
  assert.equal(await watcher.tick(), 1);
  assert.equal(new Set(f.emitted.map(notice => notice.id)).size, 21);
  assert.deepEqual(f.journal.pending(), []);
});

for (const [name, alter] of [
  ["negative revision", snapshot => { snapshot.state.workItems.work.revision = -1; }],
  ["array work map", snapshot => { snapshot.state.workItems = Object.values(snapshot.state.workItems); }],
  ["work-map key and item ID mismatch", snapshot => { snapshot.state.workItems = { different: snapshot.state.workItems.work }; }]
]) test(`invalid snapshot: ${name} fails without checkpoint or output`, async t => {
  const f = fixture(t); f.work();
  const invalid = f.snapshot(); alter(invalid);
  assert.throws(() => attentionNotices(invalid, f.now()), codes("invalid_snapshot"));
  const client = { ...f.client, async snapshot() { return structuredClone(invalid); } };
  await assert.rejects(f.watcher({ client }).tick(), codes("invalid_snapshot"));
  assert.equal(f.journal.state(), null);
  assert.deepEqual(f.journal.pending(), []);
  assert.deepEqual(f.emitted, []);
});

test("overlapping ticks coalesce rather than emitting one pending notice twice", async t => {
  const f = fixture(t); f.work(); const started = deferred(), release = deferred(), attempts = [];
  const watcher = f.watcher({ emit: async notice => {
    attempts.push(structuredClone(notice)); started.resolve(); await release.promise;
  } });
  const results = Promise.all([watcher.tick(), watcher.tick()]);
  let attemptsBeforeRelease;
  try {
    await started.promise;
    // Allow every competing continuation to reach the blocked output callback.
    await new Promise(resolve => setImmediate(resolve));
    attemptsBeforeRelease = attempts.length;
  } finally { release.resolve(); }
  assert.deepEqual(await results, [1, 1]);
  assert.equal(attemptsBeforeRelease, 1);
  assert.equal(attempts.length, 1);
  assert.deepEqual(f.journal.pending(), []);
  assert.equal(await watcher.tick(), 0, "a settled tick does not leave a permanent in-flight result");
  f.work("new-work");
  assert.equal(await watcher.tick(), 1);
  assert.equal(attempts.at(-1).workItemId, "new-work");
});

test("a failed shared tick releases its single-flight guard and retries the same pending ID", async t => {
  const f = fixture(t); f.work(); const started = deferred(), release = deferred(), attempts = [];
  const unavailable = new Error("Synthetic shared output failure");
  let fail = true;
  const watcher = f.watcher({ emit: async notice => {
    attempts.push(structuredClone(notice));
    if (fail) { started.resolve(); await release.promise; throw unavailable; }
  } });
  const results = Promise.allSettled([watcher.tick(), watcher.tick()]);
  await started.promise; release.resolve();
  for (const result of await results) {
    assert.equal(result.status, "rejected");
    assert.equal(result.reason, unavailable);
  }
  assert.equal(attempts.length, 1);
  assert.equal(f.journal.pending()[0].id, attempts[0].id);
  fail = false;
  assert.equal(await watcher.tick(), 1);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[1].id, attempts[0].id);
  assert.deepEqual(f.journal.pending(), []);
});
