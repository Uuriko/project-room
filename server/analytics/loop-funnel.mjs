// AN-FUNNEL-2: the activation loop funnel — entered -> directed/claimed ->
// reviewed -> accepted -> receipt held, from already-recorded data.
//
// Read-only aggregation. No new event types, no schema changes, no product
// behavior changes. Activation is DEFINED as first-receipt-held (charter
// Workstream C, R1): the terminal stage is an actor holding a receipt for
// their first loop, not a signup or a settings state.
//
// Inputs come from data the server already records:
//
//   members:      member.added / member.joined_via_invitation room events
//                 (the actor's entry into a room).
//   signups:      analytics rows derived from the accounts table (as AN-1).
//   memberships:  member_accounts rows binding HUMAN members to accounts.
//   claimEvents:  events rows with body.type='work_claim.updated' — the full
//                 board-claim lifecycle (created / claimed / reviewed with
//                 verdict / state changes / pr_merged), one row per update.
//   publicTasks:  public_work_tasks + the work-claims registry item history
//                 for each task's namespace + public_work_receipts +
//                 public_work_reviews state (verification / decision).
//
// The funnel subject is an ACTOR and their FIRST loop: the earliest claim
// they directed (posted) or claimed. Later stages are that claim's own
// progression, whoever performs them — the same counterparty-inclusive
// shape AN-FUNNEL-1 uses for first replies.
//
// Stage 2 of the charter funnel, "saw board", is deliberately absent: no
// surface records a board view today (see LOOP_FUNNEL_DEFINITIONS.sawBoard
// and the gap issue). Every other stage is measured from recorded data.

function minutesBetween(start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.round((end - start) / 60000);
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(rank, sorted.length - 1))];
}

const isAgentId = id => typeof id === "string" && (id.startsWith("ai_") || id.startsWith("guest-agent-"));

// Reconstruct one board claim's stage timeline from its update events.
function boardClaimTimeline(events) {
  const sorted = [...events].sort((a, b) => a.at - b.at);
  const timeline = {
    createdAt: null, creatorId: null,
    claimedAt: null, claimerId: null,
    reviews: [],
    doneAt: null, mergedAt: null
  };
  for (const event of sorted) {
    if (event.action === "created" && timeline.createdAt == null) {
      timeline.createdAt = event.at;
      timeline.creatorId = event.actorId;
    }
    if (event.action === "claimed" && timeline.claimedAt == null) {
      timeline.claimedAt = event.at;
      timeline.claimerId = event.actorId;
    }
    if (event.action === "reviewed") {
      timeline.reviews.push({
        actorId: event.actorId,
        at: event.at,
        verdict: event.verdict ?? null,
        // The event's ownerId is the claim's owner after the update; a
        // review stamp does not change ownership, so this is the worker
        // being reviewed. Reviews by the worker themself (attestations)
        // are not the loop's review stage.
        ownerId: event.ownerId ?? null
      });
    }
    if (event.claimState === "done" && timeline.doneAt == null) timeline.doneAt = event.at;
    if (event.action === "pr_merged" && timeline.mergedAt == null) timeline.mergedAt = event.at;
  }
  return timeline;
}

// The loop stages of one claim, from the perspective of a loop that starts
// at startAt (the actor's directed/claimed moment on this claim).
function boardLoopStages(timeline, startAt) {
  // A review counts only once there is a submission to review: at or after
  // the claim was claimed (or created, for claims that were never claimed).
  const reviewFloor = timeline.claimedAt != null ? Math.max(startAt, timeline.claimedAt) : startAt;
  const review = timeline.reviews.find(r => r.at >= reviewFloor && r.actorId !== r.ownerId) ?? null;
  const approve = timeline.reviews.find(r => r.at >= reviewFloor && r.verdict === "approve" && r.actorId !== r.ownerId) ?? null;
  let acceptedAt = null;
  let acceptedVia = null;
  if (approve) {
    acceptedAt = approve.at;
    acceptedVia = "review";
  } else if (timeline.doneAt != null && timeline.doneAt >= startAt) {
    // Merged-delivery claims complete without a verdict review; the done
    // transition is the acceptance the system records for them.
    acceptedAt = timeline.doneAt;
    acceptedVia = "completion";
  }
  // Same rule as server/analytics/map-room-event.mjs workClaimReceiptDue:
  // a wcr_ receipt exists when the claim is done and its PR merged. It
  // becomes due at the later of the two moments.
  const receiptAt = timeline.doneAt != null && timeline.mergedAt != null
    ? Math.max(timeline.doneAt, timeline.mergedAt)
    : null;
  return {
    reviewedAt: review?.at ?? null,
    reviewedBy: review?.actorId ?? null,
    acceptedAt,
    acceptedVia,
    receiptAt,
    receiptKind: receiptAt != null ? "wcr" : null
  };
}

function publicLoopStages(task) {
  const history = [...(task.history ?? [])].sort((a, b) => a.at - b.at);
  const claim = history.find(entry => entry.action === "claimed") ?? null;
  const claimedAt = claim?.at ?? null;
  // The public receipt is a SUBMISSION receipt: it is issued at finish,
  // before any review. The funnel reports its real position in the loop
  // rather than forcing the board order onto it (see definitions).
  const receiptAt = task.receipt?.at ?? null;
  const reviewedAt = [task.verification?.at, task.decision?.at]
    .filter(at => Number.isFinite(at) && (claimedAt == null || at >= claimedAt))
    .sort((a, b) => a - b)[0] ?? null;
  const acceptedAt = task.decision?.decision === "accepted" ? task.decision.at : null;
  return {
    claimedAt,
    claimerId: claim?.actorId ?? task.receipt?.identityId ?? null,
    reviewedAt,
    acceptedAt,
    acceptedVia: acceptedAt != null ? "review" : null,
    receiptAt,
    receiptId: task.receipt?.receiptId ?? null,
    receiptKind: receiptAt != null ? "pwr" : null
  };
}

export function loopFunnel({ members = [], signups = [], memberships = [], claimEvents = [], publicTasks = [], identityLinks = [] } = {}) {
  const signupAt = new Map();
  for (const row of signups) {
    if (typeof row?.accountId !== "string" || !Number.isFinite(row?.at)) continue;
    const prior = signupAt.get(row.accountId);
    if (prior == null || row.at < prior) signupAt.set(row.accountId, row.at);
  }
  const accountOf = new Map();
  for (const row of memberships) {
    if (typeof row?.memberId === "string" && typeof row?.accountId === "string" && !accountOf.has(row.memberId)) {
      accountOf.set(row.memberId, row.accountId);
    }
  }
  const memberOfIdentity = new Map();
  for (const row of identityLinks) {
    if (typeof row?.identityId === "string" && typeof row?.memberId === "string" && !memberOfIdentity.has(row.identityId)) {
      memberOfIdentity.set(row.identityId, row.memberId);
    }
  }

  // Actors: room members first (entry + kind are recorded facts about them).
  const actors = new Map();
  const actorFor = (actorId) => {
    let actor = actors.get(actorId);
    if (!actor) {
      actor = {
        actorId,
        kind: null,
        accountId: accountOf.get(actorId) ?? null,
        enteredAt: null,
        enteredBasis: null,
        loop: null
      };
      actors.set(actorId, actor);
    }
    return actor;
  };
  for (const row of members) {
    if (typeof row?.memberId !== "string" || !Number.isFinite(row?.at)) continue;
    const actor = actorFor(row.memberId);
    if (row.kind === "human" || row.kind === "agent") {
      if (actor.kind == null) actor.kind = row.kind;
    }
    if (actor.enteredAt == null || row.at < actor.enteredAt) {
      actor.enteredAt = row.at;
      actor.enteredBasis = "member_entry";
    }
  }
  // A human's loop clock starts at signup when the account predates the
  // member entry (AN-FUNNEL-1 uses the same cohort start).
  for (const actor of actors.values()) {
    if (actor.accountId && signupAt.has(actor.accountId)) {
      const at = signupAt.get(actor.accountId);
      if (actor.enteredAt == null || at < actor.enteredAt) {
        actor.enteredAt = at;
        actor.enteredBasis = "signup";
      }
    }
    if (actor.kind == null) actor.kind = isAgentId(actor.actorId) ? "agent" : "unknown";
  }

  // Board claims: group the update events per claim.
  const claimsByKey = new Map();
  for (const event of claimEvents) {
    if (typeof event?.roomId !== "string" || typeof event?.claimId !== "string" || !Number.isFinite(event?.at)) continue;
    const key = `${event.roomId}\0${event.claimId}`;
    let list = claimsByKey.get(key);
    if (!list) {
      list = [];
      claimsByKey.set(key, list);
    }
    list.push(event);
  }
  const boardLoops = [];
  for (const [key, events] of claimsByKey) {
    const [roomId, claimId] = key.split("\0");
    const timeline = boardClaimTimeline(events);
    boardLoops.push({ system: "board", roomId, claimId, timeline });
  }

  // Candidate first loops per actor. A claim counts for its creator
  // (directed) and for its claimer (claimed); the actor's first loop is
  // the earliest such involvement at or after their entry (earlier rows
  // are clock-skew noise, as in AN-FUNNEL-1).
  const considerLoop = (actorId, loop) => {
    if (typeof actorId !== "string" || !actorId) return;
    const actor = actorFor(actorId);
    if (actor.enteredAt != null && loop.directedOrClaimedAt < actor.enteredAt) return;
    if (!actor.loop || loop.directedOrClaimedAt < actor.loop.directedOrClaimedAt) actor.loop = loop;
  };
  for (const { roomId, claimId, timeline } of boardLoops) {
    if (timeline.createdAt != null) {
      const stages = boardLoopStages(timeline, timeline.createdAt);
      considerLoop(timeline.creatorId, {
        system: "board", ref: claimId, roomId, role: "director",
        directedOrClaimedAt: timeline.createdAt,
        ...stages,
        receiptId: stages.receiptAt != null ? `rc_${claimId}` : null
      });
    }
    if (timeline.claimedAt != null) {
      const stages = boardLoopStages(timeline, timeline.claimedAt);
      considerLoop(timeline.claimerId, {
        system: "board", ref: claimId, roomId, role: "claimer",
        directedOrClaimedAt: timeline.claimedAt,
        ...stages,
        receiptId: stages.receiptAt != null ? `rc_${claimId}` : null
      });
    }
  }

  const publicSummary = { tasks: publicTasks.length, claimed: 0, submitted: 0, reviewed: 0, accepted: 0 };
  for (const task of publicTasks) {
    const stages = publicLoopStages(task);
    if (stages.claimedAt != null) publicSummary.claimed += 1;
    if (stages.receiptAt != null) publicSummary.submitted += 1;
    if (stages.reviewedAt != null) publicSummary.reviewed += 1;
    if (stages.acceptedAt != null) publicSummary.accepted += 1;
    if (stages.claimedAt == null || stages.claimerId == null) continue;
    const actorId = memberOfIdentity.get(stages.claimerId) ?? stages.claimerId;
    const actor = actorFor(actorId);
    if (actor.enteredAt == null || stages.claimedAt < actor.enteredAt) {
      // The public board has no membership: a public action can be an
      // actor's first recorded moment, even before any room entry.
      actor.enteredAt = stages.claimedAt;
      actor.enteredBasis = "first_board_action";
    }
    considerLoop(actorId, {
      system: "public", ref: task.taskId, roomId: task.roomId ?? null, role: "claimer",
      directedOrClaimedAt: stages.claimedAt,
      reviewedAt: stages.reviewedAt,
      acceptedAt: stages.acceptedAt,
      acceptedVia: stages.acceptedVia,
      receiptAt: stages.receiptAt,
      receiptId: stages.receiptId,
      receiptKind: stages.receiptKind
    });
  }

  const boardSummary = {
    claims: boardLoops.length,
    claimed: boardLoops.filter(l => l.timeline.claimedAt != null).length,
    reviewed: boardLoops.filter(l => l.timeline.reviews.some(r => r.actorId !== r.ownerId)).length,
    approved: boardLoops.filter(l => l.timeline.reviews.some(r => r.verdict === "approve" && r.actorId !== r.ownerId)).length,
    done: boardLoops.filter(l => l.timeline.doneAt != null).length,
    receipts: boardLoops.filter(l => l.timeline.doneAt != null && l.timeline.mergedAt != null).length
  };

  const rows = [...actors.values()]
    .filter(actor => actor.enteredAt != null)
    .sort((a, b) => a.enteredAt - b.enteredAt)
    .map(actor => {
      const loop = actor.loop;
      return {
        actorId: actor.actorId,
        kind: actor.kind ?? (isAgentId(actor.actorId) ? "agent" : "unknown"),
        accountId: actor.accountId,
        enteredAt: actor.enteredAt,
        enteredBasis: actor.enteredBasis,
        sawBoardAt: null,
        loopSystem: loop?.system ?? null,
        loopRef: loop?.ref ?? null,
        loopRole: loop?.role ?? null,
        directedOrClaimedAt: loop?.directedOrClaimedAt ?? null,
        reviewedAt: loop?.reviewedAt ?? null,
        acceptedAt: loop?.acceptedAt ?? null,
        acceptedVia: loop?.acceptedVia ?? null,
        receiptAt: loop?.receiptAt ?? null,
        receiptId: loop?.receiptId ?? null,
        receiptKind: loop?.receiptKind ?? null,
        minutesToReceipt: loop ? minutesBetween(actor.enteredAt, loop.receiptAt) : null,
        minutesClaimToReceipt: loop ? minutesBetween(loop.directedOrClaimedAt, loop.receiptAt) : null
      };
    });

  const stageCount = (rowsFor, key) => rowsFor.filter(row => row[key] != null).length;
  const summarize = (subset) => {
    const toReceipt = subset.map(r => r.minutesToReceipt).filter(v => v != null);
    const claimToReceipt = subset.map(r => r.minutesClaimToReceipt).filter(v => v != null);
    return {
      actors: subset.length,
      withLoop: stageCount(subset, "directedOrClaimedAt"),
      reviewed: stageCount(subset, "reviewedAt"),
      accepted: stageCount(subset, "acceptedAt"),
      receipts: stageCount(subset, "receiptAt"),
      loopRate: subset.length ? stageCount(subset, "directedOrClaimedAt") / subset.length : null,
      receiptRate: subset.length ? stageCount(subset, "receiptAt") / subset.length : null,
      medianMinutesToReceipt: median(toReceipt),
      p90MinutesToReceipt: percentile(toReceipt, 90),
      medianMinutesClaimToReceipt: median(claimToReceipt)
    };
  };

  return {
    actors: rows,
    summary: {
      ...summarize(rows),
      humans: summarize(rows.filter(r => r.kind === "human")),
      agents: summarize(rows.filter(r => r.kind === "agent")),
      board: boardSummary,
      public: publicSummary
    }
  };
}

export const LOOP_FUNNEL_DEFINITIONS = Object.freeze({
  activation: "Activation is first-receipt-held: an actor is activated when their first loop ends with a receipt held (receiptAt set). Signups, entries and claims are funnel stages, not activation.",
  entered: "Earliest recorded entry: account signup (humans, when the account predates member entry), first member.added / member.joined_via_invitation event, or — for public-board-only identities, who have no membership — their first recorded board action.",
  sawBoard: "UNMEASURED in this version: no surface records a board view (public board list, in-room available-work list and the MCP available-work tools all serve reads without recording them), so the claimable-count snapshot at view time does not exist. Reported as null for every actor until the gap is closed; see the filed gap issue.",
  directedOrClaimed: "The actor's first loop starts: earliest board claim they created (role director) or claimed (role claimer), or earliest public task they claimed (role claimer), at or after entry. Only this first claim's progression is followed.",
  reviewed: "Board: earliest reviewed-action event on the loop claim by someone other than the claim's owner (a verdict review or an attestation stamp; the owner's own stamps do not count). Public: earliest verification or decision recorded on the loop task's submission.",
  accepted: "Board: earliest approve verdict on the loop claim; when no verdict review exists, the claim's done transition (merged-delivery completion is the acceptance the system records). Public: the review decision 'accepted' — public submission receipts alone never count as acceptance.",
  receiptHeld: "Board: the wcr_ receipt, due when the claim is done and its pull request merged (same rule as the analytics mapper); receiptAt is the later of those two moments, receipt id rc_<claimId>. Public: the pwr_ submission receipt recorded at finish — note it is issued BEFORE review on this door, so receiptAt can precede reviewedAt/acceptedAt here. Work-item (wir_) loops are not reconstructed in this version: their lifecycle lives in room state, not the event stream."
});
