import test from "node:test";
import assert from "node:assert/strict";
import { applyEvent, emptyRoomState, event } from "../src/events.js";
import { HELP_MAX_DURATION_MS, HELP_SCOPE_LIMIT, WORK_HELP_UPDATED, helpFromEvent, validateHelp, validateHelpData, workHelpContext } from "../src/work-help.js";

const NOW = "2026-09-08T12:00:00.000Z";
const later = ms => new Date(Date.parse(NOW) + ms).toISOString();
const scope = "  Café 🪷\r\nSuggest two agenda items in this room.  ";

function fixture({ mode = "read", accountableId = "producer", accepted = true } = {}) {
  let state = emptyRoomState(), serial = 0;
  const incoming = (type, actorId, data, at = NOW) => event({ type, actorId, data, at, roomId: "room",
    id: `event-${++serial}`, idempotencyKey: `key-${serial}` });
  const send = (type, actorId, data, at) => { state = applyEvent(state, incoming(type, actorId, data, at)); return state; };
  send("room.created", "owner", { roomId: "room", ownerId: "owner", title: "Room", purpose: "Disposable contract checks" });
  for (const [memberId, kind, permissions] of [
    ["owner", "human", ["manage_members", "steer", "accept_work"]],
    ["producer", "agent", ["accept_work", "complete_work", "write_external"]],
    ["helper", "agent", []], ["human-helper", "human", []], ["reviewer", "agent", ["verify"]]
  ]) send("member.added", "owner", { memberId, displayName: memberId, kind, permissions });
  send("work.proposed", "owner", { workItemId: "job", title: "Agenda", definitionOfDone: "Two agenda items",
    accountableMemberId: accountableId, verifierMemberId: "reviewer", independentVerificationRequired: true, mode });
  if (accepted) send("work.accepted", accountableId, { workItemId: "job", expectedRevision: 0 });
  const open = (changes = {}) => ({ workItemId: "job", expectedRevision: state.workItems.job.revision,
    expectedHelpRevision: state.workItems.job.helpWanted?.revision ?? 0, status: "open", scope, expiresAt: later(3600000), ...changes });
  const withdrawal = () => ({ workItemId: "job", expectedRevision: state.workItems.job.revision,
    expectedHelpRevision: state.workItems.job.helpWanted?.revision ?? 0, status: "withdrawn" });
  // Unit checks exercise pure construction; service/migration tests separately
  // establish authenticated writes and recovery rather than assuming them here.
  const help = (data = open(), actor = accountableId, at = NOW) => {
    const e = incoming(WORK_HELP_UPDATED, actor, data, at), result = helpFromEvent(state, e);
    state = structuredClone(state); state.workItems.job.helpWanted = result;
    return { event: e, help: result };
  };
  return { get state() { return state; }, send, incoming, help, open, withdrawal,
    context: (viewer = "helper", at = NOW) => workHelpContext(state, "job", viewer, at),
    work: (type, extra = {}, actor = accountableId) => send(type, actor, { workItemId: "job", expectedRevision: state.workItems.job.revision, ...extra }) };
}

test("help is absent by default; reads are deterministic and do not change room state", () => {
  const f = fixture(), before = structuredClone(f.state), context = f.context();
  assert.equal(context.authority, "invitation_only"); assert.equal(context.status, "off");
  assert.equal(context.help, null); assert.equal(context.revision, 0); assert.equal(context.eventId, null);
  assert.equal(context.canOffer, false); assert.equal(context.canWithdraw, false); assert.equal(context.canPublish, false);
  assert.equal(f.context("producer").canPublish, true);
  assert.deepEqual(f.context(), context); assert.deepEqual(f.state, before);
  assert.equal(Object.hasOwn(f.state.workItems.job, "helpWanted"), false);
});

test("opening help preserves exact text, task ownership, work revision and surrounding state", () => {
  const f = fixture(), before = structuredClone(f.state), e = f.incoming(WORK_HELP_UPDATED, "producer", f.open());
  const help = helpFromEvent(f.state, e);
  assert.deepEqual(f.state, before); // Pure construction has no side effects.
  assert.equal(help.scope, scope); assert.equal(help.revision, 1); assert.equal(help.id, e.id);
  assert.equal(help.workBasisRevision, 1); assert.equal(help.accountableMemberId, "producer");
  assert.equal(help.accountableRevision, 0); assert.equal(help.completionEventId, null);
  const next = f.help().help;
  const withoutHelp = structuredClone(f.state); delete withoutHelp.workItems.job.helpWanted;
  assert.deepEqual(withoutHelp, before); assert.equal(next.openedById, "producer");
  assert.equal(f.context().canOffer, true); assert.equal(f.context("human-helper").canOffer, true);
  assert.equal(f.context("producer").canOffer, false); assert.equal(f.context("reviewer").canOffer, false);
  assert.equal(f.context("missing").canOffer, false);
  const copy = f.context(); copy.help.scope = "Only a copy"; assert.equal(f.context().help.scope, scope);
});

test("only accountable humans or agents with accept_work may publish; owner cannot volunteer someone else", () => {
  const f = fixture(), before = structuredClone(f.state);
  for (const actor of ["owner", "helper", "reviewer", "missing"]) assert.throws(() => f.help(f.open(), actor));
  assert.deepEqual(f.state, before);
  const human = fixture({ accountableId: "owner" }); assert.equal(human.help().help.openedById, "owner");
  f.send("member.access_changed", "owner", { memberId: "producer", expectedMemberRevision: 0, active: true, permissions: [] });
  assert.equal(f.context("producer").canPublish, false); assert.throws(() => f.help(), /accountable/);
});

test("help changes have their own revisions; starting work does not invalidate an invitation", () => {
  const f = fixture(), first = f.help().help, staleWork = f.open();
  f.work("work.started");
  assert.equal(f.context().status, "open"); assert.equal(f.context().help.workBasisRevision, 1);
  assert.equal(f.state.workItems.job.revision, 2); assert.throws(() => f.help(staleWork), /Stale Work Item/);
  const updated = f.help(f.open({ scope: "Suggest just one item." })).help;
  assert.equal(updated.revision, 2); assert.equal(updated.id, first.id); assert.notEqual(updated.eventId, first.eventId);
  assert.equal(updated.workBasisRevision, 2); assert.equal(f.state.workItems.job.revision, 2);
});

test("update versus withdrawal rejects the losing intent in either order", () => {
  for (const withdrawFirst of [false, true]) {
    const f = fixture(); f.help(); const update = f.open({ scope: "Different scope" }), withdraw = f.withdrawal();
    f.help(withdrawFirst ? withdraw : update, withdrawFirst ? "owner" : "producer");
    const before = structuredClone(f.state);
    assert.throws(() => f.help(withdrawFirst ? update : withdraw), /Stale help invitation/);
    assert.deepEqual(f.state, before);
    assert.equal(f.context().status, withdrawFirst ? "withdrawn" : "open");
  }
});

test("late create and old update cannot replace newer help; withdrawal never erases context", () => {
  const f = fixture(), create = f.open(); const first = f.help(create).help;
  const update = f.open({ scope: "New scope" }); f.help(update);
  f.help(f.withdrawal(), "owner"); const withdrawn = f.context();
  assert.equal(withdrawn.status, "withdrawn"); assert.equal(withdrawn.canOffer, false);
  assert.equal(withdrawn.help.scope, "New scope"); assert.equal(withdrawn.help.updatedById, "owner");
  assert.equal(withdrawn.help.id, first.id); assert.equal(withdrawn.help.openedById, "producer");
  assert.throws(() => f.help(create), /Stale help invitation/); assert.throws(() => f.help(update), /Stale help invitation/);
  assert.throws(() => f.help(f.withdrawal()), /no open/);
  assert.equal(f.help().help.revision, 4); assert.equal(f.context().status, "open");
});

test("withdrawal remains available after expiry, closure or loss of publishing permission", () => {
  for (const change of ["expired", "closed", "permission"]) {
    const f = fixture(); f.help();
    if (change === "closed") f.work("work.completed", { summary: "Done", evidenceUrl: "https://example.test/result", evidenceVersion: "v1", nextAction: "Review" });
    if (change === "permission") f.send("member.access_changed", "owner", { memberId: "producer", expectedMemberRevision: 0, active: true, permissions: [] });
    const time = change === "expired" ? later(3600000) : NOW;
    assert.equal(f.context("producer", time).canWithdraw, true);
    assert.equal(f.help(f.withdrawal(), "producer", time).help.status, "withdrawn");
  }
  const f = fixture(); f.help();
  f.send("member.access_changed", "owner", { memberId: "producer", expectedMemberRevision: 0, active: false, permissions: [] });
  assert.throws(() => f.help(f.withdrawal(), "producer"), /access/);
  assert.throws(() => f.help(f.withdrawal(), "helper"), /Only/);
  assert.equal(f.context("owner").canWithdraw, true); assert.equal(f.help(f.withdrawal(), "owner").help.status, "withdrawn");
});

test("expiry is read-only, explicit and exclusive; clock rollback never exposes future consent", () => {
  const f = fixture(); f.help(); const before = structuredClone(f.state);
  assert.equal(f.context("helper", later(-1)).status, "not_started");
  assert.equal(f.context("helper", later(3599999)).canOffer, true);
  assert.equal(f.context("helper", later(3600000)).status, "expired");
  assert.equal(f.context("helper", later(3600001)).canOffer, false);
  assert.deepEqual(f.state, before);
  assert.throws(() => f.context("helper", "invalid"), /evaluation time/);
  assert.throws(() => f.help(f.open(), "producer", later(-1)), /clock moved backwards/);
  f.help(f.open({ expiresAt: later(7200000) }), "producer", later(3600001));
  assert.equal(f.context("helper", later(3600001)).status, "open");
});

test("publishing bounds expiry and scope without truncating or normalizing input", () => {
  const f = fixture();
  assert.equal(helpFromEvent(f.state, f.incoming(WORK_HELP_UPDATED, "producer", f.open({ expiresAt: later(HELP_MAX_DURATION_MS), scope: "x".repeat(HELP_SCOPE_LIMIT) }))).scope.length, HELP_SCOPE_LIMIT);
  for (const changes of [{ expiresAt: NOW }, { expiresAt: later(-1) }, { expiresAt: later(HELP_MAX_DURATION_MS + 1) },
    { expiresAt: "2026-09-08" }, { expiresAt: 123 }, { scope: " " }, { scope: "x".repeat(HELP_SCOPE_LIMIT + 1) },
    { scope: "\ud800" }, { scope: null }]) assert.throws(() => f.help(f.open(changes)));
});

test("completion then rework does not resurrect help; explicit reopening anchors the new work cycle", () => {
  const f = fixture(); f.help();
  const done = { summary: "Done", evidenceUrl: "https://example.test/result", evidenceVersion: "v1", nextAction: "Review" };
  f.work("work.completed", done); assert.equal(f.context().status, "work_closed"); assert.equal(f.context().canOffer, false);
  f.work("work.blocked", { reason: "Needs changes", nextAction: "Revise" });
  assert.equal(f.context().status, "consent_changed");
  const completion = f.state.workItems.job.receipt.eventId;
  f.work("work.blocker_resolved", { resolution: "Clear plan" }); assert.equal(f.context().canOffer, false);
  f.help(); assert.equal(f.context().status, "open"); assert.equal(f.context().help.completionEventId, completion);
  f.work("work.completed", { ...done, evidenceVersion: "v2" });
  f.work("work.blocked", { reason: "More changes", nextAction: "Revise again" });
  assert.equal(f.context().status, "consent_changed");
});

test("membership revocation then restoration requires renewed consent", () => {
  const f = fixture(); f.help();
  const permissions = [...f.state.members.producer.permissions];
  f.send("member.access_changed", "owner", { memberId: "producer", expectedMemberRevision: 0, active: false, permissions });
  assert.equal(f.context().status, "accountable_unavailable");
  f.send("member.access_changed", "owner", { memberId: "producer", expectedMemberRevision: 1, active: true, permissions });
  assert.equal(f.context().status, "consent_changed"); assert.equal(f.context().canOffer, false);
  assert.equal(f.help().help.accountableRevision, 2); assert.equal(f.context().canOffer, true);
  f.send("member.access_changed", "owner", { memberId: "helper", expectedMemberRevision: 0, active: false, permissions: [] });
  assert.equal(f.context().status, "open"); assert.equal(f.context().canOffer, false);
});

test("proposed work requires acceptance; replacement work never inherits an invitation", () => {
  const proposed = fixture({ accepted: false });
  assert.equal(proposed.context("producer").canPublish, false); assert.throws(() => proposed.help(), /accepted work/);
  const f = fixture(); f.help();
  f.send("work.proposed", "owner", { workItemId: "replacement", title: "Different agenda", definitionOfDone: "Three items", accountableMemberId: "producer" });
  f.work("work.superseded", { supersededByWorkItemId: "replacement", reason: "Different request" }, "owner");
  assert.equal(f.context().status, "work_closed"); assert.equal(f.context("producer").canPublish, false);
  assert.throws(() => f.help(), /accepted work/);
  assert.equal(workHelpContext(f.state, "replacement", "helper", NOW).status, "off");
  assert.equal(Object.hasOwn(f.state.workItems.replacement, "helpWanted"), false);
  assert.equal(f.help(f.withdrawal(), "owner").help.status, "withdrawn");
});

test("review-triggered rework needs new consent; reviewing older evidence does not cancel renewed help", () => {
  const f = fixture(); f.help();
  const done = { summary: "Done", evidenceUrl: "https://example.test/result", evidenceVersion: "v1", nextAction: "Review", producerId: "producer" };
  f.work("work.completed", done); const first = f.state.workItems.job.receipt.eventId;
  f.work("verification.recorded", { result: "fail", completionEventId: first, evidenceVersion: "v1", summary: "Missing item" }, "reviewer");
  assert.equal(f.context().status, "consent_changed");
  f.work("work.blocker_resolved", { resolution: "Add it" });
  f.work("work.completed", { ...done, evidenceVersion: "v2" });
  f.work("work.blocked", { reason: "Final polish", nextAction: "Ask for suggestions" });
  f.help(); const helpRevision = f.context().revision;
  f.work("verification.recorded", { result: "fail", completionEventId: first, evidenceVersion: "v1", summary: "Historical check" }, "reviewer");
  assert.equal(f.context().status, "open"); assert.equal(f.context().revision, helpRevision);
  assert.equal(f.state.workItems.job.verificationHistory.at(-1).historical, true);
});

test("even a permission-preserving accountable access change requires explicit reaffirmation", () => {
  const f = fixture(); f.help();
  f.send("member.access_changed", "owner", { memberId: "producer", expectedMemberRevision: 0, active: true, permissions: f.state.members.producer.permissions });
  assert.equal(f.context().status, "consent_changed"); assert.equal(f.context("producer").canPublish, true);
  assert.equal(f.context("producer").canWithdraw, true);
  f.help(); assert.equal(f.context().status, "open"); assert.equal(f.context().help.accountableRevision, 1);
});

test("claim release/reacquisition and ordinary blocking preserve consent but confer no execution permission", () => {
  const f = fixture({ mode: "write" }); f.help();
  const claim = { repository: "https://example.test/agenda", ref: "draft", paths: ["agenda.md"], expiresAt: later(1800000) };
  f.work("claim.acquired", claim); f.work("work.started"); f.work("claim.released");
  f.work("claim.acquired", { ...claim, expiresAt: later(3600000) });
  f.work("work.blocked", { reason: "Need input", nextAction: "Discuss" }); f.work("claim.released");
  assert.equal(f.context().status, "open"); assert.equal(f.context().help.workBasisRevision, 1);
  assert.equal(f.context().canOffer, true); assert.deepEqual(f.state.members.helper.permissions, []);
  assert.equal(f.state.workItems.job.accountableMemberId, "producer");
  assert.throws(() => f.work("work.started", { resolvedBlocker: "Try" }, "helper"), /accountable/);
});

test("strict contract rejects field smuggling, wrong rooms and malformed or cross-work projections", () => {
  const f = fixture();
  for (const changes of [{ expectedRevision: -1 }, { expectedHelpRevision: 0.5 }, { expectedHelpRevision: null },
    { expectedHelpRevision: Number.MAX_SAFE_INTEGER }, { status: "active" }, { workItemId: "constructor" },
    { actorId: "owner" }, { payment: "paid" }, { scope: undefined }]) assert.throws(() => validateHelpData(f.open(changes)));
  assert.throws(() => validateHelpData({ ...f.withdrawal(), scope: "hidden new scope" }));
  assert.throws(() => f.help(f.withdrawal()), /no open/);
  const e = f.incoming(WORK_HELP_UPDATED, "producer", f.open());
  assert.throws(() => helpFromEvent(f.state, { ...e, roomId: "elsewhere" }));
  assert.throws(() => helpFromEvent(f.state, { ...e, type: "message.posted" }));
  assert.throws(() => helpFromEvent(f.state, { ...e, id: "__proto__" }));
  const malformed = structuredClone(f.state); malformed.members.helper = { ...malformed.members.producer };
  assert.throws(() => helpFromEvent(malformed, { ...e, actorId: "helper" }), /participant/);
  assert.throws(() => workHelpContext(malformed, "job", "helper", NOW), /participant/);
  const valid = helpFromEvent(f.state, e);
  for (const help of [null, "yes", {}, { ...valid, workItemId: "other" }, { ...valid, workBasisRevision: 9 },
    { ...valid, revision: 0 }, { ...valid, openedById: "helper" }, { ...valid, extra: "ignored" }]) {
    const state = structuredClone(f.state); state.workItems.job.helpWanted = help;
    assert.throws(() => workHelpContext(state, "job", "helper", NOW));
  }
  assert.throws(() => validateHelp({ ...valid, createdAt: later(1) }));
});

test("registered help event is replayable and exactly idempotent without changing work revision", () => {
  const f = fixture(), before = structuredClone(f.state), e = f.incoming(WORK_HELP_UPDATED, "producer", f.open());
  const saved = applyEvent(f.state, e);
  assert.equal(saved.workItems.job.helpWanted.eventId, e.id);
  assert.equal(saved.workItems.job.revision, before.workItems.job.revision);
  assert.equal(saved.eventLog.length, before.eventLog.length + 1);
  assert.deepEqual(applyEvent(saved, e), saved); assert.deepEqual(f.state, before);
  assert.throws(() => applyEvent(saved, { ...e, data: { ...e.data, scope: "Different" } }), /Conflicting/);
});
