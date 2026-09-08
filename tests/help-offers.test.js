import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { auditRecovery } from "../server/recovery.mjs";
import { applyEvent, emptyRoomState, event, EVENT_TYPES } from "../src/events.js";
import { HELP_OFFER_OPENED as OPEN, HELP_OFFER_UPDATED as UPDATE, MAX_HELP_OFFERS,
  helpOfferFromEvent, helpOfferAvailability, helpOfferContext, validateHelpOffer, validateHelpOfferData } from "../src/help-offers.js";

const NOW = "2026-09-08T12:00:00.000Z", later = ms => new Date(Date.parse(NOW) + ms).toISOString();
function fixture() {
  let state = emptyRoomState(), serial = 0;
  const incoming = (type, actorId, data, at = NOW) => event({ id: `event-${++serial}`, type, actorId, data, at, roomId: "room", idempotencyKey: `key-${serial}` });
  const send = (type, actor, data, at) => { state = applyEvent(state, incoming(type, actor, data, at)); };
  send("room.created", "owner", { roomId: "room", ownerId: "owner", title: "Room", purpose: "Synthetic contract tests" });
  for (const [memberId, kind, permissions] of [["owner", "human", ["manage_members", "steer", "accept_work"]],
    ["producer", "agent", ["accept_work", "complete_work"]], ["helper", "agent", []], ["helper2", "agent", []],
    ["human", "human", []], ["reviewer", "agent", ["verify"]]]) {
    send("member.added", "owner", { memberId, displayName: memberId, kind, permissions });
  }
  const work = (type, data = {}, id = "job") => send(type, "producer", { workItemId: id, expectedRevision: state.workItems[id].revision, ...data });
  const help = (status = "open", id = "job", at = NOW) => send("work.help_updated", "producer", {
    workItemId: id, expectedRevision: state.workItems[id].revision, expectedHelpRevision: state.workItems[id].helpWanted?.revision ?? 0, status,
    ...(status === "open" ? { scope: "Two agenda items", expiresAt: later(3600000) } : {}) }, at);
  const job = (id = "job") => {
    send("work.proposed", "owner", { workItemId: id, title: "Agenda", definitionOfDone: "Two items", accountableMemberId: "producer",
      verifierMemberId: "reviewer", independentVerificationRequired: true, mode: "read" });
    work("work.accepted", {}, id); help("open", id);
  };
  job();
  const offerEvent = (actor = "helper", id = "offer", workId = "job", at = NOW) => incoming(OPEN, actor, {
    offerId: id, workItemId: workId, expectedRevision: state.workItems[workId].revision,
    expectedHelpRevision: state.workItems[workId].helpWanted.revision, helpEventId: state.workItems[workId].helpWanted.eventId,
    plan: "I can draft two options. 🪷" }, at);
  const updateEvent = (status, offerId = "offer", actor = status === "withdrawn" ? "helper" : "producer", at = NOW) => {
    const offer = state.helpOffers[offerId], item = state.workItems[offer.workItemId];
    return incoming(UPDATE, actor, { offerId, workItemId: item.id, expectedRevision: item.revision, expectedOfferRevision: offer.revision,
      status, reason: "Explicit coordination decision", ...(status === "selected" ? { expectedHelpRevision: item.helpWanted.revision, helpEventId: item.helpWanted.eventId } : {}),
      ...(status === "released" ? { externalActivityUnverified: true } : {}) }, at);
  };
  const commit = e => {
    const offer = helpOfferFromEvent(state, e);
    state = structuredClone(state); state.helpOffers ??= {}; state.helpOffers[offer.id] = offer; return offer;
  };
  return { get state() { return state; }, send, work, help, job, incoming, offerEvent, updateEvent, commit,
    available: (actor = "helper", id = "job", at = NOW) => helpOfferAvailability(state, id, actor, at),
    context: (actor = "producer", id = "offer", at = NOW) => helpOfferContext(state, id, actor, at) };
}

test("offer construction is pure, bound to exact scope and separate from assignment or messages", () => {
  const f = fixture(), before = structuredClone(f.state), e = f.offerEvent();
  const offer = helpOfferFromEvent(f.state, e);
  assert.deepEqual(f.state, before); assert.equal(offer.status, "offered"); assert.equal(offer.revision, 0);
  assert.deepEqual(offer.invitation, before.workItems.job.helpWanted);
  assert.equal(offer.plan, e.data.plan); assert.equal(offer.offererId, "helper");
  f.commit(e); const context = f.context();
  assert.equal(context.canSelect, true); assert.equal(context.authority, "coordination_only"); assert.equal(context.externalExecution, false);
  assert.deepEqual(f.state.workItems, before.workItems); assert.deepEqual(f.state.messages, before.messages);
  context.offer.plan = "Mutated copy"; assert.equal(f.context().offer.plan, e.data.plan);
});

test("human and agent helpers can offer, while accountable workers and independent reviewers cannot", () => {
  for (const actor of ["owner", "producer", "helper", "helper2", "human", "reviewer"]) {
    const f = fixture(), eligible = !["producer", "reviewer"].includes(actor);
    assert.equal(f.available(actor).canOffer, eligible);
    if (eligible) f.commit(f.offerEvent(actor));
    else assert.throws(() => f.commit(f.offerEvent(actor)), /invitation_unavailable/);
  }
});

test("strict offer inputs reject stale work/help identity, privilege fields and malformed plans", () => {
  const f = fixture(), original = f.offerEvent();
  const changes = [{ expectedRevision: 0 }, { expectedHelpRevision: 0 }, { helpEventId: "different" },
    { plan: "" }, { plan: " " }, { plan: "x".repeat(601) }, { plan: "\ud800" }, { actorId: "owner" }, { offerId: "__proto__" }];
  for (const change of changes) assert.throws(() => f.commit({ ...original, data: { ...original.data, ...change } }));
  assert.throws(() => validateHelpOfferData(OPEN, { ...original.data, plan: null }));
  assert.equal(f.state.helpOffers, undefined);
});

test("one immutable offer per member and invitation version survives decline or withdrawal", () => {
  for (const status of ["declined", "withdrawn"]) {
    const f = fixture(); f.commit(f.offerEvent()); f.commit(f.updateEvent(status));
    assert.equal(f.available().reason, "already_offered"); assert.equal(f.available().existingOfferId, "offer");
    assert.throws(() => f.commit(f.offerEvent("helper", "another-id")), /already_offered/);
    f.help(); assert.equal(f.available().canOffer, true);
    f.commit(f.offerEvent("helper", "new-version"));
    assert.equal(Object.keys(f.state.helpOffers).length, 2);
  }
});

test("five current offers per work and per member bound the actionable queue", () => {
  const f = fixture();
  for (let i = 0; i < 6; i++) {
    const actor = `extra-${i}`;
    f.send("member.added", "owner", { memberId: actor, displayName: actor, kind: "agent", permissions: [] });
    if (i < 5) f.commit(f.offerEvent(actor, `extra-offer-${i}`));
    else { assert.equal(f.available(actor).reason, "work_offer_limit"); assert.throws(() => f.commit(f.offerEvent(actor, "sixth")), /work_offer_limit/); }
  }
  f.commit(f.updateEvent("declined", "extra-offer-0"));
  assert.equal(f.available("extra-5").canOffer, true);
  const g = fixture();
  for (let i = 0; i < 6; i++) {
    const id = `job-${i}`; g.job(id);
    if (i < 5) g.commit(g.offerEvent("helper", `offer-${i}`, id));
    else { assert.equal(g.available("helper", id).reason, "member_offer_limit"); assert.throws(() => g.commit(g.offerEvent("helper", "sixth", id)), /member_offer_limit/); }
  }
});

for (const first of ["offer", "other"]) test(`serial revalidation permits only one selection when ${first} wins`, () => {
  const f = fixture(); f.commit(f.offerEvent()); f.commit(f.offerEvent("helper2", "other"));
  const a = f.updateEvent("selected", first), b = f.updateEvent("selected", first === "offer" ? "other" : "offer");
  f.commit(a);
  assert.throws(() => f.commit(b), /transition unavailable/);
  assert.equal(f.context("producer", first).selectedOfferId, first);
  assert.equal(f.available("human").reason, "helper_selected");
  assert.equal(f.state.workItems.job.accountableMemberId, "producer"); assert.equal(f.state.workItems.job.revision, 1);
  // Real concurrent database transactions and idempotent receipts remain service integration gates.
});

test("selection is explicit: a normal answer cannot become a choice", () => {
  const f = fixture(); f.commit(f.offerEvent());
  f.send("message.posted", "producer", { body: "Yes, sounds useful", workItemId: "job", toMemberId: "helper" });
  assert.equal(f.context().offer.status, "offered");
  assert.throws(() => f.commit(f.updateEvent("selected", "offer", "owner")), /transition unavailable/);
  assert.throws(() => f.commit(f.updateEvent("selected", "offer", "helper")), /transition unavailable/);
  f.commit(f.updateEvent("selected")); assert.equal(f.context().offer.status, "selected");
});

test("changed or expired invitations invalidate pending offers without deleting them", () => {
  for (const change of ["update", "withdraw", "expiry"]) {
    const f = fixture(); f.commit(f.offerEvent());
    if (change !== "expiry") f.help(change === "withdraw" ? "withdrawn" : "open");
    const at = change === "expiry" ? later(3600000) : NOW;
    assert.equal(f.context("producer", "offer", at).status, "unavailable");
    assert.throws(() => f.commit(f.updateEvent("selected", "offer", "producer", at)), /transition unavailable/);
    f.commit(f.updateEvent("withdrawn", "offer", "helper", at));
    assert.equal(f.context("producer", "offer", at).offer.status, "withdrawn");
  }
});

test("selected coordination persists across withdrawal and expiry until explicit acknowledged release", () => {
  const f = fixture(); f.commit(f.offerEvent()); f.commit(f.updateEvent("selected"));
  f.help("withdrawn"); f.help();
  assert.equal(f.context().status, "selection_needs_review"); assert.equal(f.available("helper2").reason, "helper_selected");
  const release = f.updateEvent("released", "offer", "owner", later(3600000));
  assert.throws(() => f.commit({ ...release, data: { ...release.data, externalActivityUnverified: false } }), /does not confirm/);
  const row = f.commit(release); assert.equal(row.status, "released"); assert.equal(row.externalActivityUnverified, true);
  assert.equal(f.context("producer", "offer", later(3600000)).canRelease, false);
  assert.equal(f.available("helper2").canOffer, true);
});

test("work completion/rework and restored helper access cannot silently resume old offers", () => {
  const f = fixture(); f.commit(f.offerEvent());
  f.send("member.access_changed", "owner", { memberId: "helper", expectedMemberRevision: 0, active: false, permissions: [] });
  f.send("member.access_changed", "owner", { memberId: "helper", expectedMemberRevision: 1, active: true, permissions: [] });
  assert.equal(f.context().status, "unavailable"); assert.equal(f.context().canSelect, false);
  f.help(); f.commit(f.offerEvent("helper", "fresh")); f.commit(f.updateEvent("selected", "fresh"));
  f.work("work.completed", { summary: "Agenda", evidenceUrl: "https://example.invalid/result", evidenceVersion: "v1", producerId: "producer", nextAction: "Review" });
  f.work("work.blocked", { reason: "Revise", nextAction: "Discuss" }); f.help();
  assert.equal(f.context("producer", "fresh").status, "selection_needs_review");
  assert.equal(f.available("helper2").reason, "helper_selected");
});

test("ordinary progress preserves offers; stale or backwards-time updates do not mutate them", () => {
  const f = fixture(); f.commit(f.offerEvent());
  const stale = f.updateEvent("selected"); f.work("work.started");
  assert.equal(f.context().canSelect, true);
  assert.throws(() => f.commit(stale), /Stale Work Item/);
  assert.throws(() => f.commit(f.updateEvent("selected", "offer", "producer", later(-1))), /clock moved backwards/);
  f.commit(f.updateEvent("selected"));
  assert.throws(() => f.commit(f.updateEvent("withdrawn")), /transition unavailable/);
  assert.throws(() => f.commit(f.updateEvent("released", "offer", "human")), /transition unavailable/);
  f.commit(f.updateEvent("released", "offer", "helper"));
  assert.throws(() => f.commit(f.updateEvent("selected")), /transition unavailable/);
});

test("malformed projections fail closed instead of inventing available capacity", () => {
  const f = fixture(); f.commit(f.offerEvent());
  for (const mutate of [
    s => { s.helpOffers = null; }, s => { s.helpOffers.offer.plan = ""; }, s => { s.helpOffers.offer.invitation.scope = "Forged"; },
    s => { s.helpOffers.offer.workBasisRevision = 999; }, s => { s.helpOffers.offer.revision = 2; },
    s => { s.helpOffers.offer.offererRevision = 999; }, s => { delete s.members.helper; },
    s => { s.helpOffers.offer.offererId = "producer"; }, s => { s.helpOffers.offer.updatedAt = later(-1); },
    s => { s.helpOffers.copy = structuredClone(s.helpOffers.offer); s.helpOffers.copy.id = "copy"; }
  ]) {
    const state = structuredClone(f.state); mutate(state);
    assert.throws(() => helpOfferAvailability(state, "job", "human", NOW));
  }
  assert.throws(() => validateHelpOffer({ ...f.state.helpOffers.offer, unexpected: true }));
});

test("a corrupted second selection cannot be presented as valid coordination", () => {
  const f = fixture(); f.commit(f.offerEvent()); f.commit(f.offerEvent("helper2", "other"));
  f.commit(f.updateEvent("selected"));
  const broken = structuredClone(f.state), other = broken.helpOffers.other;
  Object.assign(other, { status: "selected", revision: 1, reason: "Forged choice", eventId: "forged-selection", updatedById: "producer" });
  assert.throws(() => helpOfferContext(broken, "offer", "helper", NOW), /Multiple selected helpers/);
});

test("historical capacity refuses new offers while keeping explicit cleanup available", () => {
  const f = fixture(); const initial = f.commit(f.offerEvent()), base = structuredClone(f.state);
  // Synthetic capacity projection, not a claimed valid event history or migration fixture.
  base.helpOffers = {};
  for (let i = 0; i < MAX_HELP_OFFERS; i++) {
    const offer = structuredClone(initial); offer.id = `capacity-${i}`;
    offer.invitation.revision = i + 1; offer.invitation.eventId = i ? `help-${i}` : initial.invitation.eventId;
    offer.openingEventId = `opened-${i}`; offer.eventId = `declined-${i}`;
    offer.status = "declined"; offer.revision = 1; offer.reason = "Not needed"; offer.updatedById = "producer";
    base.helpOffers[offer.id] = offer;
  }
  base.workItems.job.helpWanted = { ...initial.invitation, revision: MAX_HELP_OFFERS + 1, eventId: "current-help" };
  const pending = base.helpOffers["capacity-499"];
  pending.invitation = structuredClone(base.workItems.job.helpWanted); pending.status = "offered"; pending.revision = 0;
  pending.eventId = pending.openingEventId; pending.reason = null; pending.updatedById = pending.offererId;
  assert.equal(helpOfferAvailability(base, "job", "human", NOW).reason, "history_full");
  const update = f.incoming(UPDATE, "helper", { workItemId: "job", offerId: pending.id, expectedRevision: 1,
    expectedOfferRevision: 0, status: "withdrawn", reason: "Release the pending offer" });
  assert.equal(helpOfferFromEvent(base, update).status, "withdrawn");
});

test("offer events remain unregistered until writer and history support are integrated", () => {
  const f = fixture(), before = structuredClone(f.state);
  assert.equal(Object.values(EVENT_TYPES).includes(OPEN), false);
  assert.equal(Object.values(EVENT_TYPES).includes(UPDATE), false);
  assert.throws(() => applyEvent(f.state, f.offerEvent()));
  assert.deepEqual(f.state, before);
});

test("current schema13 service refuses future offer commands without writes", t => {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const before = auditRecovery(f.store).dataSha256;
  for (const type of [OPEN, UPDATE]) assert.throws(() => f.store.command(f.keys.owner, "commons", {
    id: crypto.randomUUID(), type, data: { workItemId: "test-handoff" }
  }), error => error.status === 422);
  assert.equal(auditRecovery(f.store).dataSha256, before);
});
