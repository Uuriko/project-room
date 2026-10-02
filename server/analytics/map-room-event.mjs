// Pure map from one room event to zero or more growth events.
// roomFacts is the caller's accumulator (member kinds, claim history, firsts).
// This module does no I/O. The tail rebuilds facts from events the cursor
// has already passed, then maps the new ones.
import { EVENT_TYPES as T } from "../../src/events.js";

const GITHUB_PULL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9]\d{0,9})$/;

export function emptyRoomFacts() {
  return {
    memberKind: Object.create(null),
    agentType: Object.create(null),
    accountId: Object.create(null),
    firsts: Object.create(null),
    claims: Object.create(null),
    inviteAt: Object.create(null),
    publicReceipts: false,
    excluded: false
  };
}

export function firstKey(kind, scope) {
  return `${kind}\0${scope}`;
}

function atMs(event) {
  const parsed = Date.parse(event?.at ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

function minutesBetween(start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.round((end - start) / 60000);
}

function actorKindOf(facts, actorId) {
  const kind = facts.memberKind?.[actorId];
  if (kind === "human" || kind === "agent") return kind;
  if (typeof actorId === "string" && (actorId.startsWith("ai_") || actorId.startsWith("guest-agent-"))) return "agent";
  return null;
}

function pullParts(pull) {
  const url = typeof pull === "string" ? pull : pull?.url;
  const match = typeof url === "string" ? GITHUB_PULL.exec(url) : null;
  if (!match) return null;
  return { repo: `${match[1]}/${match[2]}`, prNumber: Number(match[3]), outcome: pull?.outcome ?? null };
}

function invitationEvidence(data) {
  if (!data || typeof data !== "object") return null;
  if (typeof data.invitationId === "string" && data.invitationId) {
    return { id: data.invitationId, by: typeof data.invitedByMemberId === "string" ? data.invitedByMemberId : null };
  }
  const origin = data.membershipOrigin;
  if (origin && typeof origin === "object" && origin.kind === "invitation") {
    return {
      id: typeof origin.invitationId === "string" ? origin.invitationId : null,
      by: typeof origin.invitedByMemberId === "string" ? origin.invitedByMemberId : null
    };
  }
  if (typeof data.invitedByMemberId === "string" && data.invitedByMemberId) return { id: null, by: data.invitedByMemberId };
  return null;
}

function draft(name, event, fields) {
  const props = {};
  for (const [key, value] of Object.entries(fields.props ?? {})) {
    if (value !== null && value !== undefined) props[key] = value;
  }
  return {
    name,
    v: 1,
    at: fields.at,
    roomId: event.roomId ?? null,
    accountId: fields.accountId ?? null,
    actorKind: fields.actorKind,
    actorId: fields.actorId ?? null,
    agentClient: fields.agentClient ?? null,
    referrerArtifactId: fields.referrerArtifactId ?? null,
    refMemberId: fields.refMemberId ?? null,
    loopHint: fields.loopHint ?? null,
    props,
    roomEventId: event.id ?? null,
    roomSeq: Number.isInteger(event.sequence) ? event.sequence : null
  };
}

function seen(facts, kind, scope) {
  return Boolean(facts.firsts[firstKey(kind, scope)]);
}

function mark(facts, kind, scope, at) {
  const key = firstKey(kind, scope);
  if (!facts.firsts[key]) facts.firsts[key] = { at };
}

// A work-claim receipt (wcr_) exists when the claim is done and its pull
// request merged. A work-item receipt (wir_) exists when a completed work
// item carries a receipt object. Same rule as server/receipts-live.mjs.
export function workClaimReceiptDue(claim) {
  return Boolean(claim && claim.state === "done" && claim.pullRequest?.outcome === "merged");
}

export function workItemReceiptDue(item) {
  return Boolean(item && item.state === "completed" && item.receipt && typeof item.receipt === "object");
}

function roomCreated(event, facts, data, stamp) {
  const actorKind = actorKindOf(facts, event.actorId) ?? "human";
  const templateId = typeof data.templateId === "string" && data.templateId ? data.templateId : null;
  const kind = data.kind === "organization" ? "organization" : "personal";
  const createdVia = templateId ? "template" : actorKind === "agent" ? "agent" : "account";
  const events = [draft("room_created", event, {
    at: stamp,
    actorKind,
    actorId: event.actorId,
    accountId: facts.accountId[event.actorId] ?? null,
    referrerArtifactId: templateId ? `tmpl:${templateId}` : null,
    loopHint: templateId ? "template" : null,
    props: { kind, template_id: templateId, created_via: createdVia }
  })];
  if (templateId) {
    events.push(draft("template_forked", event, {
      at: stamp,
      actorKind,
      actorId: event.actorId,
      accountId: facts.accountId[event.actorId] ?? null,
      referrerArtifactId: `tmpl:${templateId}`,
      loopHint: "template",
      props: { template_id: templateId }
    }));
  }
  return events;
}

function memberAdded(event, facts, data, stamp) {
  const memberId = typeof data.memberId === "string" ? data.memberId : null;
  const kind = data.kind === "agent" ? "agent" : data.kind === "human" ? "human" : null;
  if (memberId && kind) {
    facts.memberKind[memberId] = kind;
    if (typeof data.agentType === "string" && data.agentType) facts.agentType[memberId] = data.agentType;
  }
  const events = [];
  const evidence = invitationEvidence(data);
  if (evidence && memberId && kind && !seen(facts, "invite_accepted", `${event.roomId}:${memberId}`)) {
    mark(facts, "invite_accepted", `${event.roomId}:${memberId}`, stamp);
    const inviteAt = evidence.id ? facts.inviteAt[evidence.id] : null;
    events.push(draft("invite_accepted", event, {
      at: stamp,
      actorKind: kind,
      actorId: memberId,
      accountId: facts.accountId[memberId] ?? null,
      referrerArtifactId: evidence.id ? `inv:${evidence.id}` : null,
      refMemberId: evidence.by,
      loopHint: kind === "agent" ? "agent_invite" : "invite",
      props: {
        invite_kind: "membership",
        invitee_kind: kind,
        minutes_since_invite: minutesBetween(inviteAt, stamp)
      }
    }));
  }
  if (kind === "agent" && memberId && !seen(facts, "agent_connected", `${event.roomId}:${memberId}`)) {
    mark(facts, "agent_connected", `${event.roomId}:${memberId}`, stamp);
    let connectPath = null;
    if (memberId.startsWith("guest-agent-")) connectPath = "guest";
    else if (evidence) connectPath = "share_link";
    else if (typeof data.referredBy === "string") connectPath = "referral";
    events.push(draft("agent_connected", event, {
      at: stamp,
      actorKind: "agent",
      actorId: memberId,
      accountId: facts.accountId[memberId] ?? null,
      agentClient: facts.agentType[memberId] ?? null,
      referrerArtifactId: evidence?.id ? `inv:${evidence.id}` : null,
      refMemberId: typeof data.referredBy === "string" ? data.referredBy : evidence?.by ?? null,
      loopHint: data.referredBy ? "referral" : evidence ? "agent_invite" : null,
      props: {
        agent_client: facts.agentType[memberId] ?? null,
        agentType: facts.agentType[memberId] ?? null,
        connect_path: connectPath
      }
    }));
  }
  return events;
}

function joinedViaInvitation(event, facts, data, stamp) {
  const memberId = typeof data.memberId === "string" ? data.memberId : event.actorId;
  facts.memberKind[memberId] = "human";
  if (seen(facts, "invite_accepted", `${event.roomId}:${memberId}`)) return [];
  mark(facts, "invite_accepted", `${event.roomId}:${memberId}`, stamp);
  const inviteAt = typeof data.invitationId === "string" ? facts.inviteAt[data.invitationId] : null;
  return [draft("invite_accepted", event, {
    at: stamp,
    actorKind: "human",
    actorId: memberId,
    accountId: facts.accountId[memberId] ?? null,
    referrerArtifactId: typeof data.invitationId === "string" ? `inv:${data.invitationId}` : null,
    refMemberId: typeof data.invitedByMemberId === "string" ? data.invitedByMemberId : null,
    loopHint: "invite",
    props: {
      invite_kind: "membership",
      invitee_kind: "human",
      minutes_since_invite: minutesBetween(inviteAt, stamp)
    }
  })];
}

function messagePosted(event, facts, stamp) {
  const actorId = event.actorId;
  if (facts.memberKind[actorId] !== "agent") return [];
  const scope = `${event.roomId}:${actorId}`;
  if (seen(facts, "agent_first_post", scope)) return [];
  mark(facts, "agent_first_post", scope, stamp);
  const connected = facts.firsts[firstKey("agent_connected", scope)];
  return [draft("agent_first_post", event, {
    at: stamp,
    actorKind: "agent",
    actorId,
    accountId: facts.accountId[actorId] ?? null,
    props: { minutes_since_connected: minutesBetween(connected?.at ?? null, stamp) }
  })];
}

function claimUpdated(event, facts, data, stamp) {
  const id = typeof data.workClaim === "string" ? data.workClaim : null;
  if (!id) return [];
  const actorKind = actorKindOf(facts, event.actorId) ?? "human";
  const prior = facts.claims[id] ?? { createdAt: null, claimedAt: null, pull: null, state: null, completed: false, receipt: false };
  const pull = pullParts(data.pullRequest);
  const events = [];
  const base = {
    at: stamp,
    actorKind,
    actorId: event.actorId,
    accountId: facts.accountId[event.actorId] ?? null
  };
  if (data.action === "created") {
    events.push(draft("claim_created", event, {
      ...base,
      props: {
        claim_kind: "board",
        has_files: Array.isArray(data.paths) && data.paths.length > 0,
        has_pr: Boolean(pull)
      }
    }));
  }
  if (data.action === "claimed") {
    events.push(draft("claim_claimed", event, {
      ...base,
      props: { claimer_kind: actorKind === "agent" ? "agent" : "human" }
    }));
  }
  if (pull && !prior.pull) {
    events.push(draft("pr_linked", event, {
      ...base,
      props: { repo: pull.repo, pr_number: pull.prNumber }
    }));
  }
  if (data.action === "pr_merged") {
    const start = prior.claimedAt ?? prior.createdAt;
    events.push(draft("pr_merged", event, {
      ...base,
      actorKind: actorKind === "agent" || actorKind === "human" ? actorKind : "system",
      props: { minutes_claim_to_merge: minutesBetween(start, stamp) }
    }));
  }
  const state = data.claimState;
  const becameDone = state === "done" && !prior.completed;
  if (becameDone) {
    events.push(draft("claim_completed", event, {
      ...base,
      props: {
        minutes_created_to_done: minutesBetween(prior.createdAt, stamp),
        closer_kind: actorKind,
        merged: data.action === "pr_merged" || pull?.outcome === "merged" || prior.pull?.outcome === "merged"
      }
    }));
  }
  const merged = data.action === "pr_merged" || pull?.outcome === "merged" || prior.pull?.outcome === "merged";
  const claimNow = { state, pullRequest: merged ? { outcome: "merged" } : pull ? { outcome: pull.outcome } : prior.pull ? { outcome: prior.pull.outcome } : null };
  if (!prior.receipt && workClaimReceiptDue(claimNow)) {
    events.push(draft("receipt_issued", event, {
      ...base,
      props: { receipt_kind: "wcr", public: facts.publicReceipts === true }
    }));
    prior.receipt = true;
  }
  if (data.action === "created" && prior.createdAt == null) prior.createdAt = stamp;
  if (data.action === "claimed" && prior.claimedAt == null) prior.claimedAt = stamp;
  if (prior.createdAt == null) prior.createdAt = stamp;
  if (pull) prior.pull = pull;
  if (state) prior.state = state;
  if (becameDone) prior.completed = true;
  facts.claims[id] = prior;
  return events;
}

function workCompleted(event, facts, data, stamp) {
  const actorKind = actorKindOf(facts, event.actorId) ?? "human";
  const workItemId = typeof data.workItemId === "string" ? data.workItemId : event.id;
  const events = [draft("claim_completed", event, {
    at: stamp,
    actorKind,
    actorId: event.actorId,
    accountId: facts.accountId[event.actorId] ?? null,
    props: {
      minutes_created_to_done: null,
      closer_kind: actorKind,
      merged: false,
      claim_kind: undefined
    }
  })];
  // completeWork always stores a receipt object, so the wir_ rule is met.
  const item = { state: "completed", receipt: data.receipt && typeof data.receipt === "object" ? data.receipt : { eventId: event.id } };
  if (workItemReceiptDue(item) && !seen(facts, "receipt_issued", `${event.roomId}:wir:${workItemId}`)) {
    mark(facts, "receipt_issued", `${event.roomId}:wir:${workItemId}`, stamp);
    events.push(draft("receipt_issued", event, {
      at: stamp,
      actorKind,
      actorId: event.actorId,
      accountId: facts.accountId[event.actorId] ?? null,
      props: { receipt_kind: "wir", public: facts.publicReceipts === true }
    }));
  }
  // claim_completed props must stay inside the catalog. Drop the extra key.
  delete events[0].props.claim_kind;
  if (events[0].props.minutes_created_to_done == null) delete events[0].props.minutes_created_to_done;
  return events;
}

function referralCompleted(event, facts, data, stamp) {
  const referee = typeof data.refereeMemberId === "string" ? data.refereeMemberId : null;
  const referrer = typeof data.referrerMemberId === "string" ? data.referrerMemberId : null;
  const kind = (referee && facts.memberKind[referee]) || actorKindOf(facts, referee) || "human";
  const via = data.via === "request" ? "request" : "invite";
  const events = [];
  if (referee && !seen(facts, "invite_accepted", `${event.roomId}:${referee}`)) {
    mark(facts, "invite_accepted", `${event.roomId}:${referee}`, stamp);
    events.push(draft("invite_accepted", event, {
      at: stamp,
      actorKind: kind === "agent" ? "agent" : "human",
      actorId: referee,
      accountId: facts.accountId[referee] ?? null,
      refMemberId: referrer,
      loopHint: "referral",
      props: { invite_kind: "referral", invitee_kind: kind === "agent" ? "agent" : "human" }
    }));
  }
  events.push(draft("referral_converted", event, {
    at: stamp,
    actorKind: kind === "agent" ? "agent" : "human",
    actorId: referee,
    accountId: facts.accountId[referee] ?? null,
    refMemberId: referrer,
    loopHint: "referral",
    props: { via, depth: Number.isFinite(data.depth) ? data.depth : null }
  }));
  return events;
}

function accessRequested(event, facts, data, stamp) {
  const actorId = typeof data.identityId === "string" ? data.identityId : event.actorId;
  const actorKind = actorKindOf(facts, actorId) ?? "agent";
  return [draft("member_invited", event, {
    at: stamp,
    actorKind: actorKind === "human" ? "human" : "agent",
    actorId,
    loopHint: "invite",
    props: { invite_kind: "access_request", invitee_kind: actorKind === "human" ? "human" : "agent" }
  })];
}

export function mapRoomEvent(event, facts = emptyRoomFacts()) {
  if (!event || typeof event !== "object") return [];
  const data = event.data && typeof event.data === "object" ? event.data : {};
  const stamp = atMs(event);
  if (stamp == null) return [];
  if (event.type === T.ROOM_PUBLIC_RECEIPTS_SET) {
    if (typeof data.enabled === "boolean") facts.publicReceipts = data.enabled;
    return [];
  }
  switch (event.type) {
    case T.ROOM_CREATED: return roomCreated(event, facts, data, stamp);
    case T.MEMBER_ADDED: return memberAdded(event, facts, data, stamp);
    case T.MEMBER_JOINED_VIA_INVITATION: return joinedViaInvitation(event, facts, data, stamp);
    case T.MESSAGE_POSTED: return messagePosted(event, facts, stamp);
    case T.WORK_CLAIM_UPDATED: return claimUpdated(event, facts, data, stamp);
    case T.WORK_COMPLETED: return workCompleted(event, facts, data, stamp);
    case T.REFERRAL_COMPLETED: return referralCompleted(event, facts, data, stamp);
    case T.ACCESS_REQUESTED: return accessRequested(event, facts, data, stamp);
    default: return [];
  }
}

// Facts-only walk for events the cursor has already consumed.
export function absorbRoomEvent(facts, event) {
  mapRoomEvent(event, facts);
}

export function activityNames() {
  return Object.freeze([
    "room_created", "invite_accepted", "agent_first_post",
    "claim_created", "claim_claimed", "pr_linked", "pr_merged", "claim_completed", "receipt_issued"
  ]);
}

export function closeNames() {
  return Object.freeze(["claim_completed", "pr_merged", "receipt_issued"]);
}
