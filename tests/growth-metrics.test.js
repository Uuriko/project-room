import test from "node:test";
import assert from "node:assert/strict";
import { EVENT_TYPES, replay } from "../src/events.js";
import { seedEvents } from "../src/seed.js";
import {
  TYPES, NOT_MEASURED, membershipGraph, memberTimeline, activation, inviteLoop, agentAttachment,
  agentWitnessLoop, openObligations, obligationSummary, retentionCohorts, loopHealth, formatReport
} from "../src/growth-metrics.js";

const SEED_NOW = Date.parse("2026-09-05T12:00:00.000Z");
const at = (minute) => `2026-09-05T09:${String(minute).padStart(2, "0")}:00.000Z`;
const e = (id, type, actorId, minute, data) => ({
  id, idempotencyKey: `growth-${id}`, roomId: "room-project-room-v0",
  type, actorId, at: at(minute), causationId: null, data
});

// The invitation role policy is the authority on these permissions; a join event
// whose permissions do not match it exactly is rejected by the command engine.
const MEMBER_ROLE_PERMISSIONS = ["accept_work", "complete_work", "verify"];
const join = (memberId, minute, invitationId) =>
  e(`evt-join-${memberId}`, EVENT_TYPES.MEMBER_JOINED_VIA_INVITATION, memberId, minute, {
    memberId, displayName: memberId, role: "member", permissions: MEMBER_ROLE_PERMISSIONS,
    invitedByMemberId: "potter", invitationId, rolePolicyVersion: 1, authorityPolicyVersion: 2
  });
const say = (memberId, minute) =>
  e(`evt-say-${memberId}-${minute}`, EVENT_TYPES.MESSAGE_POSTED, memberId, minute, { body: `${memberId} speaking` });

// Seed ends with codex (an agent) having completed work-spec-review at 09:14.
// Maya was already a member then and speaks afterwards, so she is the only
// member who could have witnessed it. Nina, Omar and Pia arrive later.
const extendedEvents = [
  ...seedEvents,
  say("maya", 40),
  join("nina", 41, "inv-nina"),
  join("omar", 42, "inv-omar"),
  join("pia", 43, "inv-pia"),
  say("nina", 44),
  say("omar", 45),
  e("evt-member-muse", EVENT_TYPES.MEMBER_ADDED, "potter", 50, {
    memberId: "muse", displayName: "Muse", kind: "agent",
    accountableHumanId: "maya", permissions: ["accept_work", "complete_work"]
  })
];

test("metric event names stay pinned to the command engine", () => {
  for (const [key, value] of Object.entries(TYPES)) {
    assert.equal(value, EVENT_TYPES[key], `TYPES.${key} has drifted from EVENT_TYPES.${key}`);
  }
});

test("membership graph reads people, agents and who is answerable for each agent", () => {
  const graph = membershipGraph(replay(seedEvents));
  assert.deepEqual(graph.humans.sort(), ["maya", "potter"]);
  assert.deepEqual(graph.agents.sort(), ["codex", "instinct"]);
  assert.deepEqual(graph.invites, [], "the seed Room has no invitation joins");
  // No explicit sponsor means the Room owner carries the agent.
  assert.deepEqual(graph.humansSponsoringAnAgent, ["potter"]);
  assert.equal(graph.agentsPerHuman, 1);
});

test("a member is activated by contributing, not by being added", () => {
  const state = replay(seedEvents);
  const summary = activation(state).all;
  assert.equal(summary.members, 4);
  assert.equal(summary.activated, 4);
  assert.equal(summary.neverContributed, 0);
  assert.ok(summary.medianTimeToFirstContributionMs > 0);

  const timeline = new Map(memberTimeline(state).map((row) => [row.memberId, row]));
  // Being added is bookkeeping by the owner; it must not register as the member acting.
  assert.ok(timeline.get("maya").firstContributionAt > timeline.get("maya").joinedAt);
});

test("a member added but silent never counts as activated", () => {
  const state = replay([...seedEvents, join("quiet", 41, "inv-quiet")]);
  const summary = activation(state).all;
  assert.equal(summary.neverContributed, 1);
  assert.equal(summary.activated, 4, "the silent join does not inflate activation");
  assert.equal(summary.rate, 4 / 5);
});

test("invite loop counts accepted joins and separates the ones that came alive", () => {
  const loop = inviteLoop(replay(extendedEvents));
  assert.equal(loop.invitedJoins, 3);
  assert.equal(loop.activatedInvitedJoins, 2, "Pia joined and never spoke");
  assert.equal(loop.joinActivationRate, 2 / 3);
  assert.equal(loop.byInviter.length, 1);
  assert.equal(loop.byInviter[0].inviterId, "potter");
  assert.equal(loop.byInviter[0].activatedJoins, 2);
  // One invite-capable member is not a coefficient, and the report must say so.
  assert.equal(loop.insufficientData, true);
  assert.ok(loop.warnings.some((warning) => /invitations sent are not in the room event log/i.test(warning)),
    "the floor-not-K limitation is always stated");
});

test("agent witness loop excludes people who joined after the work was finished", () => {
  const witness = agentWitnessLoop(replay(extendedEvents));
  assert.equal(witness.agentCompletions, 1);
  // Nina and Omar act after the completion but were not members when it happened.
  assert.deepEqual(witness.witnesses, ["maya"]);
  assert.equal(witness.humansWhoWitnessed, 1);
  // Maya went on to sponsor Muse, which is the loop this product uniquely has.
  assert.deepEqual(witness.convertedWitnesses, ["maya"]);
  assert.equal(witness.witnessToSponsorRate, 1);
});

test("an agent's own sponsor is never counted as witnessing its work", () => {
  // Codex is sponsored by potter, so potter's later activity is not a sighting.
  const witness = agentWitnessLoop(replay(seedEvents));
  assert.ok(!witness.witnesses.includes("potter"));
});

test("a sighting only converts when the agent arrives afterwards", () => {
  // Muse is added before Maya could have seen anything, so she is not a convert.
  const early = [
    ...seedEvents.slice(0, 5),
    e("evt-member-muse-early", EVENT_TYPES.MEMBER_ADDED, "potter", 5, {
      memberId: "muse", displayName: "Muse", kind: "agent",
      accountableHumanId: "maya", permissions: ["accept_work", "complete_work"]
    }),
    ...seedEvents.slice(5),
    say("maya", 40)
  ];
  const witness = agentWitnessLoop(replay(early));
  assert.deepEqual(witness.witnesses, ["maya"]);
  assert.deepEqual(witness.convertedWitnesses, [], "an agent she already had is not a conversion");
});

test("obligations name what is genuinely waiting on one person", () => {
  const state = replay(seedEvents);
  // work-spec-review is complete and needs potter's decision; the slice is still
  // in flight and codex is accountable for it.
  assert.deepEqual(openObligations(state, "potter", { now: SEED_NOW }).map((entry) => entry.kind), ["decision_pending"]);
  assert.deepEqual(openObligations(state, "codex", { now: SEED_NOW }).map((entry) => entry.kind), ["work_accountable"]);
  assert.deepEqual(openObligations(state, "maya", { now: SEED_NOW }), [], "nothing is waiting on Maya");
  assert.deepEqual(openObligations(state, "instinct", { now: SEED_NOW }), [], "the verifier already verified");

  const [decision] = openObligations(state, "potter", { now: SEED_NOW });
  assert.equal(decision.workItemId, "work-spec-review");
  assert.ok(decision.whyYou.length > 0, "every obligation explains why it is yours");
  assert.ok(decision.ageMs > 0);
});

test("obligations go stale on the clock, not on a schedule we invent", () => {
  const state = replay(seedEvents);
  const fresh = obligationSummary(state, { now: SEED_NOW });
  assert.equal(fresh.totalOpen, 2);
  assert.equal(fresh.membersWithOpenObligations, 2);
  assert.equal(fresh.totalStale, 0);

  const later = obligationSummary(state, { now: SEED_NOW + 10 * 86_400_000 });
  assert.equal(later.totalOpen, 2, "waiting longer does not create new obligations");
  assert.equal(later.totalStale, 2, "it makes the existing ones stale");
});

test("retention is measured on join cohorts and admits when a cohort is too small", () => {
  const retention = retentionCohorts(replay(seedEvents), { now: SEED_NOW });
  assert.equal(retention.cohorts.length, 1);
  assert.equal(retention.cohorts[0].size, 4);
  assert.equal(retention.cohorts[0].retained[0], 1);
  assert.equal(retention.insufficientData, true);
});

test("reading the metrics never changes the Room", () => {
  const state = replay(extendedEvents);
  const before = structuredClone(state);
  loopHealth(state, { now: SEED_NOW });
  openObligations(state, "potter", { now: SEED_NOW });
  agentWitnessLoop(state);
  assert.deepEqual(state, before, "growth measurement is read-only");
});

test("the report is printable and carries its own caveats", () => {
  const health = loopHealth(replay(extendedEvents), { now: SEED_NOW });
  const text = formatReport(health);
  assert.ok(text.includes("Agent witness loop"));
  assert.ok(text.includes("Obligations"));
  assert.ok(text.includes("Read with care"), "warnings travel with the numbers");
  assert.ok(!/undefined|NaN|\[object/.test(text), `report has an unformatted value:\n${text}`);
});

test("the vanity metrics we refuse to collect are recorded with reasons", () => {
  assert.ok(Object.isFrozen(NOT_MEASURED));
  assert.ok(Object.keys(NOT_MEASURED).length >= 4);
  for (const reason of Object.values(NOT_MEASURED)) assert.ok(reason.length > 20);
});

test("an empty Room reports nothing rather than guessing", () => {
  const health = loopHealth({ members: {}, eventLog: [], workItems: {} }, { now: SEED_NOW });
  assert.equal(health.membership.humans, 0);
  assert.equal(health.activation.rate, null);
  assert.equal(health.invite.acceptedPerInviteCapableMember, null);
  assert.equal(health.agentWitness.witnessToSponsorRate, null);
  assert.equal(health.retention.insufficientData, true);
  assert.ok(!/undefined|NaN/.test(formatReport(health)));
});

test("attachment credits whoever brought the agent, and flags unnamed sponsors", () => {
  // The seed owner adds two agents without naming a sponsor. They resolve to him
  // in the membership graph, and he is also the one who added them.
  const attachment = agentAttachment(replay(seedEvents));
  assert.equal(attachment.humans, 2);
  assert.equal(attachment.humansWhoAttachedAnAgent, 1);
  assert.equal(attachment.attachRate, 0.5, "Maya never brought one");
  assert.equal(attachment.medianTimeToFirstAgentMs, 60_000);
  assert.equal(attachment.explicitlySponsoredAgents, 0);
  assert.equal(attachment.agentsWithNoNamedSponsor, 2);
  assert.ok(attachment.warnings.some((w) => /without naming a sponsor/.test(w)));
});

test("a named sponsor is credited instead of the member who ran the add", () => {
  // Potter performs the add, but Muse is Maya's agent. Crediting Potter here
  // would make the owner look like the only person who ever brings anything.
  const attachment = agentAttachment(replay(extendedEvents));
  const maya = attachment.byHuman.find((row) => row.memberId === "maya");
  const potter = attachment.byHuman.find((row) => row.memberId === "potter");
  assert.equal(maya.agentsAttached, 1);
  assert.equal(potter.agentsAttached, 2, "still credited with the two he brought himself");
  assert.equal(attachment.explicitlySponsoredAgents, 1);
  // Maya joined at 09:04 and Muse was added at 09:50.
  assert.equal(maya.timeToFirstAgentMs, 46 * 60_000);
});

test("an agent attributed to a non-human is credited to nobody", () => {
  const odd = {
    room: { id: "r", ownerId: "potter" },
    members: { potter: { id: "potter", kind: "human", active: true, permissions: [] },
               bot: { id: "bot", kind: "agent", active: true, accountableHumanId: "potter" } },
    workItems: {},
    eventLog: [
      { id: "e1", type: TYPES.MEMBER_ADDED, actorId: "potter", at: "2026-09-05T09:00:00.000Z",
        data: { memberId: "potter", kind: "human" } },
      { id: "e2", type: TYPES.MEMBER_ADDED, actorId: "ghost", at: "2026-09-05T09:05:00.000Z",
        data: { memberId: "bot", kind: "agent" } }
    ]
  };
  const attachment = agentAttachment(odd);
  assert.equal(attachment.humansWhoAttachedAnAgent, 0);
  assert.equal(attachment.attachRate, 0);
});

test("attachment reaches the combined report and carries its warnings", () => {
  const health = loopHealth(replay(extendedEvents), { now: SEED_NOW });
  assert.equal(health.agentAttachment.humansWhoAttachedAnAgent, 2);
  assert.ok(health.warnings.some((w) => /without naming a sponsor/.test(w)));
  assert.ok(formatReport(health).includes("Agent attachment"));
});

test("an obligation recorded ahead of the clock ages zero, never negative", () => {
  const state = replay(seedEvents);
  // Reading a Room whose events sit in the future, which happens with clock skew
  // and with any harness that advances its own clock, used to print a negative age.
  const early = Date.parse("2026-09-05T09:00:00.000Z") - 60_000;
  const open = openObligations(state, "potter", { now: early });
  assert.ok(open.length > 0);
  for (const entry of open) assert.ok(entry.ageMs >= 0, `negative age: ${entry.ageMs}`);

  const summary = obligationSummary(state, { now: early });
  assert.equal(summary.oldestAgeMs, 0);
  assert.equal(summary.totalStale, 0, "nothing recorded in the future can already be stale");
  // Target durations and percentages specifically: the report is full of ISO dates,
  // so a bare hyphen-digit check flags "2026-09-05" and proves nothing.
  const text = formatReport(loopHealth(state, { now: early }));
  assert.ok(!/-\d+(\.\d+)?(s|m|h|d)\b/.test(text), `negative duration in the report:\n${text}`);
  assert.ok(!/-\d+%/.test(text), `negative percentage in the report:\n${text}`);
});
