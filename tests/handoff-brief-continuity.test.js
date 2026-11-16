import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { createWorkBrief, compareWorkBriefs } from "../client/work-brief.mjs";
import { thinWorkForContext } from "../server/current-work-summary.mjs";
import { workProgress, resumeMarkdown, workPacket, packetMarkdown } from "../src/work-packet.js";

// Continuity after a handoff: a different authorized reader must recover the
// saved handoff through the normal selected-work read and its retained brief —
// what was done, the next action, why work stopped, who recorded it and when,
// who it is addressed to, and the saved partial-evidence reference — while
// current task/claim state stays authoritative over the member-reported text.
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-handoff-continuity-"));
  const store = new RoomStore(join(directory, "fixture.sqlite"));
  store.initialize(initialRoom());
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const ownerKey = store.issueAccessKey("commons", "owner");
  const add = (id, memberId, permissions) => store.command(ownerKey, "commons", { id, type: T.MEMBER_ADDED, data: {
    memberId, displayName: memberId, kind: "agent", permissions, accountableHumanId: "owner" } });
  add("add-producer", "producer", ["accept_work", "complete_work"]);
  add("add-successor", "successor", ["accept_work", "complete_work"]);
  const keys = { owner: ownerKey, producer: store.issueAccessKey("commons", "producer"),
    successor: store.issueAccessKey("commons", "successor") };
  const send = (key, id, type, data) => store.command(key, "commons", { id, type, data });
  send(ownerKey, "propose", T.WORK_PROPOSED, { workItemId: "handoff-demo", title: "Parse feeds",
    definitionOfDone: "All five feeds parsed", accountableMemberId: "producer", mode: "read",
    independentVerificationRequired: false, ownerDecisionRequired: false });
  send(keys.producer, "accept", T.WORK_ACCEPTED, { workItemId: "handoff-demo", expectedRevision: 0 });
  send(keys.producer, "start", T.WORK_STARTED, { workItemId: "handoff-demo", expectedRevision: 1 });
  send(keys.producer, "handoff-1", T.WORK_HANDOFF_RECORDED, { workItemId: "handoff-demo", expectedRevision: 2,
    doneSummary: "3 of 5 feeds parsed; adapter feed untouched",
    nextAction: "Parse the adapter feed, then re-run the feed suite",
    limitReason: "context window exhausted",
    evidenceUrl: "https://example.invalid/partial-parse", evidenceVersion: "partial-v1",
    toMemberId: "successor" });
  const item = () => store.room("commons").state.workItems["handoff-demo"];
  const contextFor = member => store.workContext(keys[member], "commons", "handoff-demo");
  return { store, keys, send, item, contextFor };
}

test("successor's selected read and retained brief carry the full saved handoff", async t => {
  const f = fixture(t);
  const context = f.contextFor("successor");
  // The full selected read already carries the record; the brief must not lose it.
  assert.equal(context.work.handoff.doneSummary, "3 of 5 feeds parsed; adapter feed untouched");
  assert.equal(context.work.handoff.actorId, "producer");
  const brief = await createWorkBrief(context);
  const handoff = brief.sections.progress.handoff;
  assert.equal(handoff.open, true);
  assert.equal(handoff.doneSummary, "3 of 5 feeds parsed; adapter feed untouched");
  assert.equal(handoff.nextAction, "Parse the adapter feed, then re-run the feed suite");
  assert.equal(handoff.limitReason, "context window exhausted");
  assert.equal(handoff.actorId, "producer", "brief names who recorded the handoff");
  assert.ok(Number.isFinite(Date.parse(handoff.at)), "brief records when the handoff was saved");
  assert.equal(handoff.at, context.work.handoff.at);
  assert.equal(handoff.triageMemberId, "successor", "brief names who the handoff is addressed to");
  assert.equal(handoff.evidenceUrl, "https://example.invalid/partial-parse", "brief keeps the saved evidence reference");
  assert.equal(handoff.evidenceVersion, "partial-v1");
  // Current state stays authoritative and distinct from the reported text.
  assert.equal(brief.sections.objective.state, "working");
  assert.equal(brief.sections.progress.next.action, "triaged_handoff");
  assert.equal(brief.sections.progress.next.memberId, "successor");
});

test("normalized thin summary keeps what was done, not only the next step", t => {
  const f = fixture(t);
  const thin = thinWorkForContext(f.item());
  assert.equal(thin.handoff.doneSummary, "3 of 5 feeds parsed; adapter feed untouched");
  assert.equal(thin.handoff.nextAction, "Parse the adapter feed, then re-run the feed suite");
  assert.equal(thin.handoff.actorId, "producer");
});

test("a changed handoff refreshes the brief's progress section; unrelated traffic does not", async t => {
  const f = fixture(t);
  const first = await createWorkBrief(f.contextFor("successor"));
  f.send(f.keys.producer, "unrelated", T.MESSAGE_POSTED, { messageId: "unrelated-1", body: "Unrelated conversation" });
  const afterTraffic = await createWorkBrief(f.contextFor("successor"));
  assert.equal(compareWorkBriefs(first, afterTraffic).status, "same");
  f.send(f.keys.producer, "handoff-2", T.WORK_HANDOFF_RECORDED, { workItemId: "handoff-demo",
    expectedRevision: f.item().revision, doneSummary: "3 of 5 feeds parsed; adapter feed untouched",
    nextAction: "Parse the adapter feed, then re-run the feed suite", limitReason: "context window exhausted",
    evidenceUrl: "https://example.invalid/partial-parse-2", evidenceVersion: "partial-v2", toMemberId: "successor" });
  const refreshed = await createWorkBrief(f.contextFor("successor"));
  const diff = compareWorkBriefs(first, refreshed);
  // The handoff lives in progress; its evidence reference is also listed in
  // the brief's evidence records, so both sections refresh — nothing else does.
  assert.deepEqual(diff.changedSections, ["progress", "evidence"]);
  assert.equal(diff.requiresFreshRead, true);
  assert.equal(refreshed.sections.progress.handoff.evidenceVersion, "partial-v2");
});

test("later progress closes the handoff marker; the brief reports current state, not the old suggestion as current", async t => {
  const f = fixture(t);
  f.send(f.keys.producer, "block", T.WORK_BLOCKED, { workItemId: "handoff-demo", expectedRevision: f.item().revision,
    reason: "Adapter feed credentials missing", nextAction: "Owner supplies adapter credentials" });
  const brief = await createWorkBrief(f.contextFor("successor"));
  assert.equal(brief.sections.objective.state, "blocked");
  assert.equal(brief.sections.progress.handoff.open, false, "closed handoff is historical, not open");
  assert.notEqual(brief.sections.progress.next.action, "triaged_handoff");
  assert.equal(brief.sections.progress.blocker.nextAction, "Owner supplies adapter credentials");
});

test("brief text (resume) names the handoff's source, time, addressee and evidence; ownership is unchanged by the handoff", async t => {
  const f = fixture(t);
  assert.equal(f.item().claim, null, "a handoff records no claim and transfers no ownership");
  assert.equal(f.item().accountableMemberId, "producer");
  const progress = workProgress(f.item());
  assert.equal(progress.handoff.actorId, "producer");
  assert.equal(progress.handoff.triageMemberId, "successor");
  assert.equal(progress.claim, "none");
  assert.equal(progress.handoff.evidenceUrl, "https://example.invalid/partial-parse");
  assert.equal(progress.handoff.evidenceVersion, "partial-v1");
  assert.ok(Number.isFinite(Date.parse(progress.handoff.at)));
  const text = resumeMarkdown(progress);
  assert.match(text, /Handoff recorded at: /);
  // The portable packet stays narrower than this authenticated resume:
  // its text and progress carry no handoff author, addressee or evidence URL.
  const state = f.store.room("commons").state;
  const packet = workPacket(state, "handoff-demo", { includeProgress: true });
  const packetText = packetMarkdown(packet);
  assert.equal(packetText.includes("https://example.invalid/partial-parse"), false);
  assert.equal(packet.progress.handoff.actorId, undefined);
  assert.equal(packet.progress.handoff.evidenceUrl, undefined);
  assert.match(packetText, /Handoff recorded at: /);
  // After later progress the same text demotes the handoff to history.
  f.send(f.keys.producer, "block-2", T.WORK_BLOCKED, { workItemId: "handoff-demo", expectedRevision: f.item().revision,
    reason: "Adapter feed credentials missing", nextAction: "Owner supplies adapter credentials" });
  const closed = resumeMarkdown(workProgress(f.item()));
  assert.match(closed, /Previous handoff \(closed\)/);
  assert.match(closed, /Historical handoff suggestion:/);
});

test("reading and briefing are read-only", async t => {
  const f = fixture(t);
  const before = f.store.snapshot(f.keys.owner, "commons");
  await createWorkBrief(f.contextFor("successor"));
  thinWorkForContext(f.item());
  assert.deepEqual(f.store.snapshot(f.keys.owner, "commons"), before);
});
