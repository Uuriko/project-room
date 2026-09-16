// Growth and retention measurement over a replayed Room state.
//
// Read-only and dependency-free on purpose. This module never mutates state,
// never emits an event, never opens a socket and never writes a file. It reads
// the membership graph and the event log the Room already keeps, so measuring
// growth costs no new storage, no third-party pixel and no identifier that is
// not already a member id inside this Room.
//
// The event names below are duplicated as frozen literals rather than imported
// so that a metrics read can never pull the whole command engine (and its
// in-flight edits) into a reader. tests/growth-metrics.test.js pins them
// against EVENT_TYPES and fails loudly if the canonical names ever drift.

export const TYPES = Object.freeze({
  ROOM_CREATED: "room.created",
  MEMBER_ADDED: "member.added",
  MEMBER_JOINED_VIA_INVITATION: "member.joined_via_invitation",
  MEMBER_ACCESS_CHANGED: "member.access_changed",
  MESSAGE_POSTED: "message.posted",
  WORK_PROPOSED: "work.proposed",
  WORK_ACCEPTED: "work.accepted",
  WORK_STARTED: "work.started",
  WORK_BLOCKED: "work.blocked",
  WORK_BLOCKER_RESOLVED: "work.blocker_resolved",
  WORK_COMPLETED: "work.completed",
  WORK_SUPERSEDED: "work.superseded",
  CLAIM_ACQUIRED: "claim.acquired",
  CLAIM_RELEASED: "claim.released",
  VERIFICATION_RECORDED: "verification.recorded",
  OWNER_DECISION_RECORDED: "owner.decision_recorded"
});

// Membership bookkeeping is not participation. A member who was added by the
// owner and never said anything must not read as active.
const MEMBERSHIP_TYPES = Object.freeze([
  TYPES.MEMBER_ADDED, TYPES.MEMBER_JOINED_VIA_INVITATION, TYPES.MEMBER_ACCESS_CHANGED
]);

const CONTRIBUTION_TYPES = Object.freeze([
  TYPES.MESSAGE_POSTED, TYPES.WORK_PROPOSED, TYPES.WORK_ACCEPTED, TYPES.WORK_STARTED,
  TYPES.WORK_BLOCKED, TYPES.WORK_BLOCKER_RESOLVED, TYPES.WORK_COMPLETED, TYPES.WORK_SUPERSEDED,
  TYPES.CLAIM_ACQUIRED, TYPES.CLAIM_RELEASED, TYPES.VERIFICATION_RECORDED, TYPES.OWNER_DECISION_RECORDED
]);

export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;

// Thresholds below which a ratio is arithmetic, not evidence. Every public
// function reports the shortfall instead of returning a confident number from
// two data points. A preview Room with persistence "none" will trip all of them.
const MIN_INVITERS = 3;
const MIN_JOINS = 5;
const MIN_WITNESSES = 3;
const MIN_COHORT = 5;

// Deliberately absent, with the reason. Adding any of these would make the
// number go up without making the Room more useful, which is the failure mode
// this product's goal document rules out.
export const NOT_MEASURED = Object.freeze({
  "time in app": "Rewards a Room that is hard to leave, not one worth returning to.",
  "messages per day": "Counts noise as progress. Work completed and obligations resolved already carry the signal.",
  "notification opens": "Optimising it means sending notifications nobody needed.",
  "streaks": "Manufactures obligation the Room did not actually create.",
  "cross-site identity": "No pixel, no third party, no identifier beyond a member id in this Room."
});

const list = (value) => (Array.isArray(value) ? value : []);
const events = (state) => list(state?.eventLog);
const memberList = (state) => Object.values(state?.members ?? {});
const workItems = (state) => Object.values(state?.workItems ?? {});
const replyRequests = (state) => Object.values(state?.replyRequests ?? {});
const time = (value) => { const ms = Date.parse(value); return Number.isFinite(ms) ? ms : null; };
const ratio = (numerator, denominator) => (denominator > 0 ? numerator / denominator : null);

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function shortfall(actual, required, label) {
  return actual >= required ? null : `${label}: ${actual} of ${required} needed before this ratio means anything`;
}

/** Who is in the Room, who invited whom, and which human is answerable for each agent. */
export function membershipGraph(state) {
  const members = memberList(state);
  const humans = members.filter((member) => member.kind === "human");
  const agents = members.filter((member) => member.kind === "agent");
  const invites = members
    .filter((member) => member.membershipOrigin?.kind === "invitation")
    .map((member) => ({
      memberId: member.id,
      inviterId: member.membershipOrigin.invitedByMemberId,
      invitationId: member.membershipOrigin.invitationId
    }));
  // Every agent names an accountable human. That edge is what makes an agent's
  // usefulness attributable to a person, and it is the one this product has
  // that a bot directory does not.
  const sponsorships = agents
    .filter((agent) => agent.accountableHumanId)
    .map((agent) => ({ agentId: agent.id, sponsorId: agent.accountableHumanId }));
  const sponsors = new Set(sponsorships.map((edge) => edge.sponsorId));
  return {
    humans: humans.map((member) => member.id),
    agents: agents.map((member) => member.id),
    activeHumans: humans.filter((member) => member.active !== false).map((member) => member.id),
    activeAgents: agents.filter((member) => member.active !== false).map((member) => member.id),
    invites,
    sponsorships,
    humansSponsoringAnAgent: [...sponsors],
    agentsPerHuman: ratio(agents.length, humans.length)
  };
}

/** When each member joined, and when they first did something of their own. */
export function memberTimeline(state) {
  const joinedAt = new Map();
  const firstMessageAt = new Map();
  const firstWorkAt = new Map();
  const lastActivityAt = new Map();

  for (const entry of events(state)) {
    const at = time(entry.at);
    if (at === null) continue;
    if (entry.type === TYPES.MEMBER_ADDED || entry.type === TYPES.MEMBER_JOINED_VIA_INVITATION) {
      const memberId = entry.data?.memberId;
      if (memberId && !joinedAt.has(memberId)) joinedAt.set(memberId, at);
      continue;
    }
    if (MEMBERSHIP_TYPES.includes(entry.type)) continue;
    const actorId = entry.actorId;
    if (!actorId) continue;
    if (entry.type === TYPES.MESSAGE_POSTED && !firstMessageAt.has(actorId)) firstMessageAt.set(actorId, at);
    if (entry.type !== TYPES.MESSAGE_POSTED && CONTRIBUTION_TYPES.includes(entry.type) && !firstWorkAt.has(actorId)) {
      firstWorkAt.set(actorId, at);
    }
    if (!lastActivityAt.has(actorId) || at > lastActivityAt.get(actorId)) lastActivityAt.set(actorId, at);
  }

  return memberList(state).map((member) => {
    const joined = joinedAt.get(member.id) ?? null;
    const firstMessage = firstMessageAt.get(member.id) ?? null;
    const firstWork = firstWorkAt.get(member.id) ?? null;
    const firstContribution = [firstMessage, firstWork].filter((value) => value !== null).sort((a, b) => a - b)[0] ?? null;
    return {
      memberId: member.id,
      kind: member.kind,
      active: member.active !== false,
      invited: member.membershipOrigin?.kind === "invitation",
      inviterId: member.membershipOrigin?.invitedByMemberId ?? null,
      sponsorId: member.kind === "agent" ? member.accountableHumanId ?? null : null,
      joinedAt: joined,
      firstMessageAt: firstMessage,
      firstWorkAt: firstWork,
      firstContributionAt: firstContribution,
      lastActivityAt: lastActivityAt.get(member.id) ?? null,
      timeToFirstContributionMs: joined !== null && firstContribution !== null ? firstContribution - joined : null
    };
  });
}

/**
 * Activation: did a member ever say or do anything, and how long did it take.
 * A member who never contributed cannot retain and cannot refer, so this is the
 * gate every other loop sits behind.
 */
export function activation(state, { windowMs = WEEK_MS } = {}) {
  const timeline = memberTimeline(state);
  const consider = (rows) => {
    const activated = rows.filter((row) =>
      row.timeToFirstContributionMs !== null && row.timeToFirstContributionMs <= windowMs);
    return {
      members: rows.length,
      activated: activated.length,
      rate: ratio(activated.length, rows.length),
      neverContributed: rows.filter((row) => row.firstContributionAt === null).length,
      medianTimeToFirstContributionMs: median(activated.map((row) => row.timeToFirstContributionMs))
    };
  };
  return {
    windowMs,
    all: consider(timeline),
    humans: consider(timeline.filter((row) => row.kind === "human")),
    agents: consider(timeline.filter((row) => row.kind === "agent")),
    invited: consider(timeline.filter((row) => row.invited)),
    byMember: timeline
  };
}

/**
 * The human invite loop.
 *
 * Honest limitation, stated in the return value: the Room's event log records
 * accepted joins, not invitations sent. Send-to-accept conversion lives in the
 * invitation journal, so `acceptedPerInviteCapableMember` is a floor on the true
 * coefficient, never a ceiling. Reporting it as "K" without this note would be
 * a flattering number rather than a measurement.
 */
export function inviteLoop(state, { activationWindowMs = WEEK_MS } = {}) {
  const graph = membershipGraph(state);
  const timeline = new Map(memberTimeline(state).map((row) => [row.memberId, row]));
  const inviteCapable = memberList(state).filter((member) =>
    member.kind === "human" && member.active !== false && list(member.permissions).includes("manage_members"));

  const joins = graph.invites.map((edge) => {
    const row = timeline.get(edge.memberId);
    return {
      ...edge,
      activated: Boolean(row && row.timeToFirstContributionMs !== null && row.timeToFirstContributionMs <= activationWindowMs)
    };
  });
  const activatedJoins = joins.filter((join) => join.activated);

  const byInviter = new Map();
  for (const join of joins) {
    const current = byInviter.get(join.inviterId) ?? { inviterId: join.inviterId, joins: 0, activatedJoins: 0 };
    current.joins += 1;
    if (join.activated) current.activatedJoins += 1;
    byInviter.set(join.inviterId, current);
  }

  const warnings = [
    shortfall(inviteCapable.length, MIN_INVITERS, "invite-capable members"),
    shortfall(joins.length, MIN_JOINS, "invited joins")
  ].filter(Boolean);
  warnings.push("Invitations sent are not in the Room event log; this is a floor, not a true K. Join the invitation journal to measure send-to-accept conversion.");

  return {
    inviteCapableMembers: inviteCapable.length,
    invitedJoins: joins.length,
    activatedInvitedJoins: activatedJoins.length,
    // An invited member who never spoke cannot invite the next one, so the loop
    // is carried by activated joins alone.
    acceptedPerInviteCapableMember: ratio(joins.length, inviteCapable.length),
    activatedPerInviteCapableMember: ratio(activatedJoins.length, inviteCapable.length),
    joinActivationRate: ratio(activatedJoins.length, joins.length),
    byInviter: [...byInviter.values()].sort((a, b) => b.activatedJoins - a.activatedJoins),
    insufficientData: warnings.length > 1,
    warnings
  };
}

/**
 * The agent witness loop, the one no ordinary chat product can run.
 *
 * In a Room where agents are members with an accountable human, a person who
 * watches an agent finish real work has seen a capability attached to someone
 * they know. The question that matters for growth is whether that sighting
 * turns into them bringing an agent of their own.
 *
 * "Witnessed" is a proxy: a human who was already a member when an agent
 * finished something, and who acted in the Room within the window afterwards,
 * had the opportunity to see it. Someone who joined later could not have, and
 * is excluded. It cannot prove attention, and the return value says so.
 */
export function agentWitnessLoop(state, { witnessWindowMs = 14 * DAY_MS } = {}) {
  const members = state?.members ?? {};
  const graph = membershipGraph(state);
  const agentIds = new Set(graph.agents);
  const entries = events(state);
  const joinedAt = new Map(memberTimeline(state).map((row) => [row.memberId, row.joinedAt]));

  const completions = entries
    .filter((entry) => entry.type === TYPES.WORK_COMPLETED && agentIds.has(entry.actorId))
    .map((entry) => ({ at: time(entry.at), agentId: entry.actorId, workItemId: entry.data?.workItemId ?? null }))
    .filter((completion) => completion.at !== null);

  const humanActivity = new Map();
  for (const entry of entries) {
    if (MEMBERSHIP_TYPES.includes(entry.type)) continue;
    const actor = members[entry.actorId];
    if (!actor || actor.kind !== "human") continue;
    const at = time(entry.at);
    if (at === null) continue;
    if (!humanActivity.has(actor.id)) humanActivity.set(actor.id, []);
    humanActivity.get(actor.id).push(at);
  }

  // First moment each human could have seen an agent finish something that was
  // not their own agent's work.
  const witnessedAt = new Map();
  for (const completion of completions) {
    const sponsorId = members[completion.agentId]?.accountableHumanId ?? null;
    for (const [humanId, times] of humanActivity) {
      if (humanId === sponsorId) continue;
      // Someone who joined after the work was finished cannot have seen it happen.
      const joined = joinedAt.get(humanId);
      if (joined === null || joined === undefined || joined > completion.at) continue;
      if (!times.some((at) => at > completion.at && at <= completion.at + witnessWindowMs)) continue;
      const existing = witnessedAt.get(humanId);
      if (existing === undefined || completion.at < existing) witnessedAt.set(humanId, completion.at);
    }
  }

  const agentAddedAt = new Map();
  for (const entry of entries) {
    if (entry.type !== TYPES.MEMBER_ADDED || entry.data?.kind !== "agent") continue;
    const at = time(entry.at);
    if (at !== null) agentAddedAt.set(entry.data.memberId, at);
  }

  const converted = [...witnessedAt.entries()].filter(([humanId, seenAt]) =>
    graph.sponsorships.some((edge) => edge.sponsorId === humanId && (agentAddedAt.get(edge.agentId) ?? -Infinity) > seenAt));

  const warnings = [shortfall(witnessedAt.size, MIN_WITNESSES, "humans who witnessed agent work")].filter(Boolean);
  if (!completions.length) warnings.push("No agent has completed work in this Room; the loop has not started.");
  warnings.push(`Witness is a proxy for opportunity to see, not proof of attention: already a member at completion, and acting again within ${Math.round(witnessWindowMs / DAY_MS)} days.`);

  return {
    witnessWindowMs,
    agentCompletions: completions.length,
    agentsThatCompletedWork: new Set(completions.map((completion) => completion.agentId)).size,
    humansWhoWitnessed: witnessedAt.size,
    witnessesWhoThenSponsoredAnAgent: converted.length,
    // Named so the ratio can be audited rather than trusted.
    witnesses: [...witnessedAt.keys()],
    convertedWitnesses: converted.map(([humanId]) => humanId),
    // The single number that says whether this product's own wedge is working.
    witnessToSponsorRate: ratio(converted.length, witnessedAt.size),
    insufficientData: witnessedAt.size < MIN_WITNESSES || !completions.length,
    warnings
  };
}

/**
 * What is actually waiting on one member.
 *
 * This is the return trigger worth building on. An unread message can be
 * ignored without cost; a verification only this member may record cannot.
 * Every entry here is a real commitment the Room already holds, not a nudge
 * invented to drive a session.
 */
export function openObligations(state, memberId, { now = Date.now() } = {}) {
  const found = [];
  const add = (kind, since, detail) => {
    const at = time(since);
    // An obligation timestamped ahead of the reader's clock, from skew or from a
    // harness advancing its own clock, must not produce a negative age. That would
    // sort to the wrong end and print as nonsense like "oldest -8803s". Something
    // recorded in the future has been waiting for no time at all.
    found.push({ kind, memberId, since: since ?? null, ageMs: at === null ? null : Math.max(0, now - at), ...detail });
  };

  for (const item of workItems(state)) {
    const where = { workItemId: item.id, title: item.title };
    if (item.state === "completed" && item.verifierMemberId === memberId && !item.verification) {
      add("verification_pending", item.updatedAt, { ...where, whyYou: "You are the designated verifier and no verification is recorded." });
    }
    if (item.state === "completed" && item.ownerDecisionRequired && item.humanDecisionMakerId === memberId && !item.decision) {
      add("decision_pending", item.updatedAt, { ...where, whyYou: "You are the decision-maker and the work is complete." });
    }
    if (item.accountableMemberId === memberId && item.state === "blocked") {
      add("blocked_on_you", item.updatedAt, { ...where, whyYou: item.blocker?.nextAction ?? "You are accountable and the work is blocked." });
    } else if (item.accountableMemberId === memberId && ["proposed", "accepted", "working"].includes(item.state)) {
      add("work_accountable", item.updatedAt, { ...where, state: item.state, whyYou: "You are accountable for this work item." });
    }
  }

  for (const request of replyRequests(state)) {
    if (request.status === "open" && request.recipientId === memberId) {
      add("reply_requested", request.createdAt, { requestId: request.id, whyYou: "Someone asked you specifically for a reply." });
    }
  }

  return found.sort((a, b) => (b.ageMs ?? 0) - (a.ageMs ?? 0));
}

/** Roomwide view of the same thing: who is holding what, and what has gone stale. */
export function obligationSummary(state, { now = Date.now(), staleAfterMs = 3 * DAY_MS } = {}) {
  const perMember = memberList(state)
    .filter((member) => member.active !== false)
    .map((member) => {
      const open = openObligations(state, member.id, { now });
      return {
        memberId: member.id,
        kind: member.kind,
        open: open.length,
        oldestAgeMs: open.length ? Math.max(...open.map((entry) => entry.ageMs ?? 0)) : null,
        stale: open.filter((entry) => (entry.ageMs ?? 0) > staleAfterMs).length
      };
    });
  const withOpen = perMember.filter((row) => row.open > 0);
  return {
    staleAfterMs,
    membersWithOpenObligations: withOpen.length,
    totalOpen: perMember.reduce((sum, row) => sum + row.open, 0),
    totalStale: perMember.reduce((sum, row) => sum + row.stale, 0),
    // A Room where obligations pile up unaddressed is not retaining; it is
    // accumulating debt that will read as churn later.
    oldestAgeMs: withOpen.length ? Math.max(...withOpen.map((row) => row.oldestAgeMs ?? 0)) : null,
    byMember: perMember.sort((a, b) => b.open - a.open)
  };
}

/** Join-cohort retention: of the members who joined in a bucket, who was still acting N buckets later. */
export function retentionCohorts(state, { bucketMs = WEEK_MS, now = Date.now() } = {}) {
  const timeline = memberTimeline(state).filter((row) => row.joinedAt !== null);
  if (!timeline.length) return { bucketMs, cohorts: [], insufficientData: true, warnings: ["No members with a recorded join."] };

  const activityByMember = new Map();
  for (const entry of events(state)) {
    if (MEMBERSHIP_TYPES.includes(entry.type)) continue;
    const at = time(entry.at);
    if (at === null || !entry.actorId) continue;
    if (!activityByMember.has(entry.actorId)) activityByMember.set(entry.actorId, []);
    activityByMember.get(entry.actorId).push(at);
  }

  const origin = Math.min(...timeline.map((row) => row.joinedAt));
  const buckets = new Map();
  for (const row of timeline) {
    const key = Math.floor((row.joinedAt - origin) / bucketMs);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  }

  const lastBucket = Math.floor((now - origin) / bucketMs);
  const cohorts = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([key, rows]) => {
    const retained = [];
    for (let offset = 0; key + offset <= lastBucket; offset += 1) {
      const from = origin + (key + offset) * bucketMs;
      const to = from + bucketMs;
      const active = rows.filter((row) => (activityByMember.get(row.memberId) ?? []).some((at) => at >= from && at < to));
      retained.push(ratio(active.length, rows.length));
    }
    return { bucket: key, startedAt: new Date(origin + key * bucketMs).toISOString(), size: rows.length, retained };
  });

  const largest = Math.max(...cohorts.map((cohort) => cohort.size));
  return {
    bucketMs,
    cohorts,
    insufficientData: largest < MIN_COHORT,
    warnings: [shortfall(largest, MIN_COHORT, "largest join cohort")].filter(Boolean)
  };
}

/**
 * Time to first agent.
 *
 * There is no hosted model runtime here and autoEnroll is false, so an agent
 * only ever arrives in a Room because a person brought one. That makes "did
 * this human attach an agent, and how long did it take" the leading indicator
 * for the whole witness loop: no attachment, no agent work, nothing to witness.
 *
 * Attachment is credited to whoever added the agent, read from the event rather
 * than from the resolved member. addMember defaults accountableHumanId to the
 * Room owner when the event does not name one, so reading the member would
 * credit the owner for every agent anyone brought. The two can therefore
 * disagree, and the warning says so: attachment counts who brought it, while
 * the witness loop uses the stored sponsor, which is the field that governs
 * whose sighting counts.
 */
export function agentAttachment(state, { now = Date.now() } = {}) {
  const members = state?.members ?? {};
  const timeline = new Map(memberTimeline(state).map((row) => [row.memberId, row]));

  let explicit = 0;
  let unnamed = 0;
  const firstAgentAt = new Map();
  const agentCount = new Map();

  for (const entry of events(state)) {
    if (entry.type !== TYPES.MEMBER_ADDED || entry.data?.kind !== "agent") continue;
    const named = entry.data?.accountableHumanId ?? null;
    if (named) explicit += 1; else unnamed += 1;
    const attributedTo = named ?? entry.actorId;
    if (!attributedTo || members[attributedTo]?.kind !== "human") continue;
    agentCount.set(attributedTo, (agentCount.get(attributedTo) ?? 0) + 1);
    const at = time(entry.at);
    if (at === null) continue;
    const seen = firstAgentAt.get(attributedTo);
    if (seen === undefined || at < seen) firstAgentAt.set(attributedTo, at);
  }

  const byHuman = Object.values(members)
    .filter((member) => member.kind === "human")
    .map((member) => {
      const joined = timeline.get(member.id)?.joinedAt ?? null;
      const first = firstAgentAt.get(member.id) ?? null;
      return {
        memberId: member.id,
        joinedAt: joined,
        firstAgentAt: first,
        agentsAttached: agentCount.get(member.id) ?? 0,
        timeToFirstAgentMs: joined !== null && first !== null && first >= joined ? first - joined : null
      };
    });

  const attached = byHuman.filter((row) => row.agentsAttached > 0);
  const warnings = [];
  if (unnamed > 0) {
    warnings.push(`${unnamed} agent(s) were added without naming a sponsor, so the membership graph attributes them to the Room owner. Attachment credits whoever added them, so these two views can disagree until sponsors are named.`);
  }
  const shortfallHumans = shortfall(byHuman.length, 3, "human members");
  if (shortfallHumans) warnings.push(shortfallHumans);

  return {
    humans: byHuman.length,
    humansWhoAttachedAnAgent: attached.length,
    attachRate: ratio(attached.length, byHuman.length),
    medianTimeToFirstAgentMs: median(attached.map((row) => row.timeToFirstAgentMs)),
    explicitlySponsoredAgents: explicit,
    agentsWithNoNamedSponsor: unnamed,
    byHuman: byHuman.sort((a, b) => b.agentsAttached - a.agentsAttached),
    insufficientData: byHuman.length < 3,
    warnings
  };
}

/**
 * One object a person can read. Every ratio that rests on too little data keeps
 * its warning attached, so a quiet Room cannot be mistaken for a healthy one.
 */
export function loopHealth(state, { now = Date.now(), activationWindowMs = WEEK_MS, bucketMs = WEEK_MS } = {}) {
  const membership = membershipGraph(state);
  const invite = inviteLoop(state, { activationWindowMs });
  const activated = activation(state, { windowMs: activationWindowMs });
  const witness = agentWitnessLoop(state);
  const attachment = agentAttachment(state, { now });
  const obligations = obligationSummary(state, { now });
  const retention = retentionCohorts(state, { bucketMs, now });

  return {
    generatedAt: new Date(now).toISOString(),
    roomId: state?.room?.id ?? state?.room?.roomId ?? null,
    membership: {
      humans: membership.humans.length,
      agents: membership.agents.length,
      agentsPerHuman: membership.agentsPerHuman,
      humansSponsoringAnAgent: membership.humansSponsoringAnAgent.length
    },
    activation: activated.all,
    humanActivation: activated.humans,
    invite,
    agentAttachment: attachment,
    agentWitness: witness,
    obligations,
    retention,
    notMeasured: NOT_MEASURED,
    warnings: [...invite.warnings, ...attachment.warnings, ...witness.warnings, ...retention.warnings]
  };
}

const duration = (ms) => {
  if (ms === null || !Number.isFinite(ms)) return "n/a";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < DAY_MS) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / DAY_MS).toFixed(1)}d`;
};
const percent = (value) => (value === null ? "n/a" : `${Math.round(value * 100)}%`);
const number = (value) => (value === null ? "n/a" : (Math.round(value * 100) / 100).toString());

/** Plain-text report. No colour, no emoji, safe to paste into the agent channel. */
export function formatReport(health) {
  const lines = [
    `Project Room growth, ${health.generatedAt}`,
    "",
    `Members            ${health.membership.humans} human, ${health.membership.agents} agent (${number(health.membership.agentsPerHuman)} agents per human)`,
    `Activation         ${percent(health.activation.rate)} contributed within the window; median ${duration(health.activation.medianTimeToFirstContributionMs)}; ${health.activation.neverContributed} never did`,
    `Agent attachment   ${percent(health.agentAttachment.attachRate)} of people brought an agent; median ${duration(health.agentAttachment.medianTimeToFirstAgentMs)} after joining`,
    "",
    "Invite loop",
    `  invite-capable   ${health.invite.inviteCapableMembers}`,
    `  invited joins    ${health.invite.invitedJoins} (${health.invite.activatedInvitedJoins} activated, ${percent(health.invite.joinActivationRate)})`,
    `  activated/member ${number(health.invite.activatedPerInviteCapableMember)}`,
    "",
    "Agent witness loop",
    `  agent completions ${health.agentWitness.agentCompletions} by ${health.agentWitness.agentsThatCompletedWork} agent(s)`,
    `  humans who saw    ${health.agentWitness.humansWhoWitnessed}`,
    `  then sponsored    ${health.agentWitness.witnessesWhoThenSponsoredAnAgent} (${percent(health.agentWitness.witnessToSponsorRate)})`,
    "",
    "Obligations (the honest return trigger)",
    `  members holding  ${health.obligations.membersWithOpenObligations}`,
    `  open / stale     ${health.obligations.totalOpen} / ${health.obligations.totalStale}`,
    `  oldest           ${duration(health.obligations.oldestAgeMs)}`,
    ""
  ];
  if (health.retention.cohorts.length) {
    lines.push("Retention by join cohort");
    for (const cohort of health.retention.cohorts) {
      lines.push(`  ${cohort.startedAt.slice(0, 10)}  n=${cohort.size}  ${cohort.retained.map(percent).join(" ")}`);
    }
    lines.push("");
  }
  if (health.warnings.length) {
    lines.push("Read with care");
    for (const warning of health.warnings) lines.push(`  - ${warning}`);
  }
  return lines.join("\n");
}
