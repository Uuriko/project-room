import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { event } from "../src/events.js";
import { readCurrentWorkSummaryForViewer } from "../server/current-room-repository.mjs";
import { readCurrentWorkSnapshot } from "../server/current-work-snapshot.mjs";
import { createWorkBrief } from "../client/work-brief.mjs";

// Privacy boundary for handoffs on private-request work, exercised against a
// real normalized RoomStore through the viewer-scoped read paths (not the
// shape-only thinWorkForContext helper):
//   - readCurrentWorkSummaryForViewer: the normalized summary projection the
//     work list, overview window and inbox discovery serve per viewer.
//   - store.workContext: the full selected read, plus the retained brief
//     built from it (client/work-brief.mjs).
//   - readCurrentWorkSnapshot: the normalized snapshot/orientation read.
// Rule under test (the repository's existing one, unchanged): on work with a
// policy-stamped private reply request, only private-request parties and
// established work-role holders (proposedBy, accountable, verifier,
// humanDecisionMaker, claim holder) receive the work's member-authored
// content — title, definition of done, and the handoff with its provenance
// and evidence reference. Being named as the handoff's triage addressee does
// not by itself authorize a member.
const SENTINELS = {
  title: "PRIVATE-TITLE-SENTINEL",
  definitionOfDone: "PRIVATE-DOD-SENTINEL",
  doneSummary: "PRIVATE-DONE-SENTINEL",
  nextAction: "PRIVATE-NEXT-SENTINEL",
  limitReason: "PRIVATE-REASON-SENTINEL",
  evidenceUrl: "https://example.invalid/PRIVATE-EVIDENCE-SENTINEL",
  evidenceVersion: "PRIVATE-EVIDENCE-VERSION-SENTINEL",
  blockerNext: "BLOCKER-NEXT-SENTINEL",
};
const ALL_PRIVATE = Object.values(SENTINELS);

function fixture(t) {
  const store = new RoomStore(":memory:");
  t.after(() => store.close());
  const events = initialRoom();
  const add = (type, data, actorId = "owner") =>
    events.push(event({ id: "fx-" + events.length, roomId: "commons", actorId, type, data }));
  for (const [memberId, permissions] of [["producer", ["accept_work", "complete_work"]],
      ["successor", ["accept_work", "complete_work"]], ["verifier", []], ["observer", []]])
    add("member.added", { memberId, displayName: memberId, kind: "agent", permissions, accountableHumanId: "owner" });
  store.initialize(events, { representation: "normalized-current-v1" });
  const keys = Object.fromEntries(["owner", "producer", "successor", "verifier", "observer"]
    .map(id => [id, store.issueAccessKey("commons", id)]));
  const send = (key, id, type, data) => store.command(key, "commons", { id, type, data });
  // Private-request work: producer is accountable and the request recipient,
  // verifier holds a work role but is not a request party, successor is the
  // handoff's triage addressee only, observer is unrelated.
  send(keys.owner, "propose-private", "work.proposed", { workItemId: "private-handoff",
    title: SENTINELS.title, definitionOfDone: SENTINELS.definitionOfDone,
    accountableMemberId: "producer", verifierMemberId: "verifier", mode: "read",
    independentVerificationRequired: false, ownerDecisionRequired: false });
  send(keys.owner, "ask-private", "message.posted", { messageId: "ask-private",
    toMemberId: "producer", workItemId: "private-handoff", requestKind: "reply",
    body: "PRIVATE-REQUEST-SENTINEL" });
  send(keys.producer, "accept-private", "work.accepted", { workItemId: "private-handoff", expectedRevision: 0 });
  send(keys.producer, "start-private", "work.started", { workItemId: "private-handoff", expectedRevision: 1 });
  send(keys.producer, "handoff-private", "work.handoff_recorded", { workItemId: "private-handoff", expectedRevision: 2,
    doneSummary: SENTINELS.doneSummary, nextAction: SENTINELS.nextAction, limitReason: SENTINELS.limitReason,
    evidenceUrl: SENTINELS.evidenceUrl, evidenceVersion: SENTINELS.evidenceVersion, toMemberId: "successor" });
  // Public work with its own handoff, no private request attached.
  send(keys.owner, "propose-public", "work.proposed", { workItemId: "public-handoff",
    title: "Public title", definitionOfDone: "Public done", accountableMemberId: "producer", mode: "read",
    independentVerificationRequired: false, ownerDecisionRequired: false });
  send(keys.producer, "accept-public", "work.accepted", { workItemId: "public-handoff", expectedRevision: 0 });
  send(keys.producer, "start-public", "work.started", { workItemId: "public-handoff", expectedRevision: 1 });
  send(keys.producer, "handoff-public", "work.handoff_recorded", { workItemId: "public-handoff", expectedRevision: 2,
    doneSummary: "PUBLIC-DONE-SENTINEL", nextAction: "PUBLIC-NEXT-SENTINEL", limitReason: "PUBLIC-REASON-SENTINEL",
    evidenceUrl: "https://example.invalid/PUBLIC-EVIDENCE-SENTINEL", evidenceVersion: "PUBLIC-EVIDENCE-VERSION-SENTINEL",
    toMemberId: "successor" });
  const summaryFor = viewer => readCurrentWorkSummaryForViewer(store.db, "commons", "private-handoff", viewer);
  const noPrivateLeak = (value, label) => {
    const text = JSON.stringify(value);
    for (const sentinel of ALL_PRIVATE) assert.equal(text.includes(sentinel), false, `${label} leaks ${sentinel}`);
  };
  return { store, keys, send, summaryFor, noPrivateLeak };
}

test("summary read: unrelated observer receives no protected handoff text or references", t => {
  const f = fixture(t);
  const summary = f.summaryFor("observer");
  assert.equal(summary.title, null);
  assert.equal(summary.definitionOfDone, null, "definition of done is redacted alongside the title");
  assert.equal(summary.handoff, null, "observer summary carries no handoff record at all");
  f.noPrivateLeak(summary, "observer summary");
});

test("summary read: request parties and work-role holders keep the full handoff; triage addressee alone does not", t => {
  const f = fixture(t);
  // A: the producer is both a private-request party and the accountable role
  // holder; the owner is the requesting party. Both recover everything.
  for (const viewer of ["producer", "owner"]) {
    const summary = f.summaryFor(viewer);
    assert.equal(summary.title, SENTINELS.title, viewer);
    assert.equal(summary.handoff.doneSummary, SENTINELS.doneSummary, viewer);
    assert.equal(summary.handoff.nextAction, SENTINELS.nextAction, viewer);
    assert.equal(summary.handoff.limitReason, SENTINELS.limitReason, viewer);
    assert.equal(summary.handoff.actorId, "producer", viewer);
    assert.equal(summary.handoff.triageMemberId, "successor", viewer);
    assert.ok(Number.isFinite(Date.parse(summary.handoff.at)), viewer);
    assert.equal(typeof summary.handoff.eventId, "string", viewer);
    assert.equal(summary.handoff.evidenceUrl, SENTINELS.evidenceUrl, viewer);
    assert.equal(summary.handoff.evidenceVersion, SENTINELS.evidenceVersion, viewer);
    assert.equal(summary.handoff.open, true, viewer);
  }
  // C: the verifier holds an established work role but is not a request
  // party; the existing policy grants role holders the full record.
  const verifier = f.summaryFor("verifier");
  assert.equal(verifier.title, SENTINELS.title);
  assert.equal(verifier.handoff.doneSummary, SENTINELS.doneSummary);
  assert.equal(verifier.handoff.evidenceUrl, SENTINELS.evidenceUrl);
  // The triage addressee is named by the handoff but holds no role and is
  // not a request party: the existing model does not authorize them, and
  // this change does not silently grant it.
  const successor = f.summaryFor("successor");
  assert.equal(successor.title, null);
  assert.equal(successor.handoff, null);
  f.noPrivateLeak(successor, "successor summary");
});

test("selected read and retained brief: observer sees no handoff; authorized producer keeps it in full", async t => {
  const f = fixture(t);
  const observerContext = f.store.workContext(f.keys.observer, "commons", "private-handoff");
  assert.equal(observerContext.work.title, null);
  assert.equal(observerContext.work.handoff, null);
  assert.equal(observerContext.resume.handoff, null);
  f.noPrivateLeak(observerContext, "observer selected read");
  const observerBrief = await createWorkBrief(observerContext);
  assert.equal(observerBrief.sections.progress.handoff, null);
  f.noPrivateLeak(observerBrief, "observer brief");

  const producerContext = f.store.workContext(f.keys.producer, "commons", "private-handoff");
  assert.equal(producerContext.work.handoff.doneSummary, SENTINELS.doneSummary);
  assert.equal(producerContext.work.handoff.actorId, "producer");
  assert.equal(producerContext.work.handoff.triageMemberId, "successor");
  assert.equal(producerContext.work.handoff.evidenceUrl, SENTINELS.evidenceUrl);
  assert.equal(producerContext.next.action, "triaged_handoff");
  assert.equal(producerContext.next.memberId, "successor");
  const producerBrief = await createWorkBrief(producerContext);
  assert.equal(producerBrief.sections.progress.handoff.doneSummary, SENTINELS.doneSummary);
  assert.equal(producerBrief.sections.progress.handoff.evidenceVersion, SENTINELS.evidenceVersion);
});

test("snapshot read: withheld private work carries no handoff; parties keep it", t => {
  const f = fixture(t);
  const observer = readCurrentWorkSnapshot(f.store, f.keys.observer, "commons", { view: "work" });
  assert.equal(observer.state.workItems["private-handoff"].title, null);
  assert.equal(observer.state.workItems["private-handoff"].handoff, null);
  f.noPrivateLeak(observer.state.workItems["private-handoff"], "observer snapshot record");
  const producer = readCurrentWorkSnapshot(f.store, f.keys.producer, "commons", { view: "work" });
  assert.equal(producer.state.workItems["private-handoff"].handoff.doneSummary, SENTINELS.doneSummary);
  assert.equal(producer.state.workItems["private-handoff"].handoff.evidenceUrl, SENTINELS.evidenceUrl);
});

test("public work exposes the useful handoff normally to any member", async t => {
  const f = fixture(t);
  const summary = readCurrentWorkSummaryForViewer(f.store.db, "commons", "public-handoff", "observer");
  assert.equal(summary.handoff.doneSummary, "PUBLIC-DONE-SENTINEL");
  assert.equal(summary.handoff.actorId, "producer");
  assert.equal(summary.handoff.triageMemberId, "successor");
  assert.equal(summary.handoff.evidenceUrl, "https://example.invalid/PUBLIC-EVIDENCE-SENTINEL");
  const context = f.store.workContext(f.keys.observer, "commons", "public-handoff");
  assert.equal(context.work.handoff.doneSummary, "PUBLIC-DONE-SENTINEL");
  const brief = await createWorkBrief(context);
  assert.equal(brief.sections.progress.handoff.doneSummary, "PUBLIC-DONE-SENTINEL");
});

test("viewer-scoped reads do not mutate stored state", async t => {
  const f = fixture(t);
  const stored = () => JSON.stringify(f.store.db.prepare(
    "SELECT domain, record_key, payload FROM current_room_records WHERE room_id='commons' AND domain IN ('workItems','workSummary') ORDER BY domain, record_key").all())
    + "|" + f.store.db.prepare("SELECT count(*) AS n FROM events WHERE room_id='commons'").get().n;
  const before = stored();
  for (const viewer of ["observer", "producer", "verifier", "successor", "owner"]) {
    f.summaryFor(viewer);
    readCurrentWorkSummaryForViewer(f.store.db, "commons", "public-handoff", viewer);
  }
  await createWorkBrief(f.store.workContext(f.keys.observer, "commons", "private-handoff"));
  await createWorkBrief(f.store.workContext(f.keys.producer, "commons", "private-handoff"));
  readCurrentWorkSnapshot(f.store, f.keys.observer, "commons", { view: "work" });
  assert.equal(stored(), before, "no read path writes or redacts the stored records");
});

test("a later block closes the handoff and the current next action comes from task state, not the old suggestion", async t => {
  const f = fixture(t);
  f.send(f.keys.producer, "block-private", "work.blocked", { workItemId: "private-handoff", expectedRevision: 3,
    reason: "BLOCKER-REASON-SENTINEL", nextAction: SENTINELS.blockerNext });
  // Authorized view: the handoff remains as closed history, but the live
  // next step is the blocker's, derived from current task state.
  const producer = f.summaryFor("producer");
  assert.equal(producer.handoff.open, false);
  assert.equal(producer.handoff.doneSummary, SENTINELS.doneSummary, "closed handoff stays readable to authorized viewers");
  const context = f.store.workContext(f.keys.producer, "commons", "private-handoff");
  assert.equal(context.work.state, "blocked");
  assert.notEqual(context.next.action, "triaged_handoff");
  const brief = await createWorkBrief(context);
  assert.equal(brief.sections.objective.state, "blocked");
  assert.equal(brief.sections.progress.handoff.open, false);
  assert.equal(brief.sections.progress.blocker.nextAction, SENTINELS.blockerNext);
  assert.notEqual(brief.sections.progress.next.action, "triaged_handoff");
  // The unrelated view stays redacted after the transition too.
  const observer = f.summaryFor("observer");
  assert.equal(observer.handoff, null);
  f.noPrivateLeak(observer, "observer summary after block");
});
