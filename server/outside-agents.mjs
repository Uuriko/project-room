import { createHash } from "node:crypto";
import { ServiceError } from "./service-error.mjs";
import { enforceAutonomyTierForAction } from "./autonomy-tiers.mjs";
import { memberCan } from "../src/events.js";
import { outsideAgentBody, planOutsideAgentRecord, planOutsideAgentVerify, assembleOutsideAgents, publicRef } from "../src/outside-agents.mjs";
export { outsideAgentBody, parseOutsideAgentBody, planOutsideAgentRecord, planOutsideAgentVerify, assembleOutsideAgents } from "../src/outside-agents.mjs";
const fail = (status, code, message) => { throw new ServiceError(status, code, message); };
const commandId = (kind, ...parts) => `oa-${kind}-` + createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);

export class OutsideAgents {
  constructor(store) { this.store = store; }
  #open(token, roomId, expectedSessionBinding) {
    const auth = this.store.authenticate(token, roomId, expectedSessionBinding);
    const room = this.store.room(roomId);
    return { auth, room };
  }
  #refuse(auth, roomId, room) {
    enforceAutonomyTierForAction({
      db: this.store.db, roomId, state: room.state, actor: auth.member, action: "outside-agent",
      fail: (status, code, message) => fail(status, code, message)
    });
  }
  #view(roomId, room) {
    const verifiers = this.#verifiers(room);
    const agents = assembleOutsideAgents(room.state.messages ?? [], room.state.members ?? {}, { verifiers });
    // Human approve/deny surface (1e hs2-outside-agent-approval): links
    // waiting on a decision, plus the verify step for each. Mirrors the
    // access-requests list/next[] pattern.
    const pendingVerifications = agents
      .filter(agent => agent.verificationPending)
      .map(agent => ({ externalRef: agent.externalRef, displayName: agent.displayName,
        linkedMemberId: agent.linkedMemberId, linkedBy: agent.linkedBy, introducedBy: agent.introducedBy }));
    const next = pendingVerifications.length === 0 ? [] : pendingVerifications.map(agent => Object.freeze({
      action: "verify", method: "POST", path: `/api/rooms/${roomId}/outside-agents`,
      description: `Decide ${agent.displayName}'s link (member ${agent.linkedMemberId}): send { action: "verify", externalRef: ${JSON.stringify(agent.externalRef)}, decision: "approved" } or "denied".`,
    }));
    return {
      contractVersion: 1, grantsAccess: false, evaluatedThrough: room.sequence,
      agents, pendingVerifications: Object.freeze(pendingVerifications), next: Object.freeze(next),
    };
  }
  // Who may decide on an outside-agent link: the room owner, members holding
  // manage_members, and agent identities holding an active membership-
  // administration grant. The same set gates assembly (forgery protection)
  // and the verify() write path below.
  #verifiers(room) {
    const verifiers = new Set();
    const ownerId = room.state?.room?.ownerId;
    if (typeof ownerId === "string" && ownerId) verifiers.add(ownerId);
    for (const [memberId, member] of Object.entries(room.state?.members ?? {})) {
      if (!member || member.active === false) continue;
      try { if (memberCan(room.state, memberId, "manage_members")) verifiers.add(memberId); }
      catch { /* not a manager */ }
      const identityId = member.identityId;
      if (typeof identityId === "string" && identityId
        && this.store.delegation?.hasGrant?.(room.id, identityId)) verifiers.add(memberId);
    }
    return verifiers;
  }
  list(token, roomId, expectedSessionBinding = null) {
    const { room } = this.#open(token, roomId, expectedSessionBinding);
    return this.#view(roomId, room);
  }
  record(token, roomId, input, expectedSessionBinding = null) {
    const { auth, room } = this.#open(token, roomId, expectedSessionBinding);
    this.#refuse(auth, roomId, room);
    const plan = planOutsideAgentRecord(room.state.messages ?? [], room.state.members ?? {}, roomId, auth.member.id, input);
    if (plan.recorded === "replay") return { ...this.#view(roomId, room), recorded: "replay", externalRef: plan.externalRef };
    this.#post(token, roomId, plan.commandId, plan.record, expectedSessionBinding);
    return { ...this.list(token, roomId, expectedSessionBinding), recorded: plan.recorded, externalRef: plan.externalRef };
  }
  knows(token, roomId, input, expectedSessionBinding = null) {
    const { auth, room } = this.#open(token, roomId, expectedSessionBinding);
    this.#refuse(auth, roomId, room);
    const fromRef = publicRef(input?.fromRef), toRef = publicRef(input?.toRef);
    if (fromRef === toRef) fail(422, "invalid_outside_agent", "An agent cannot be related to itself");
    const known = new Set(this.#view(roomId, room).agents.map(agent => agent.externalRef));
    if (!known.has(fromRef) || !known.has(toRef)) fail(404, "outside_agent_not_found", "Introduce both agents before relating them");
    const from = this.#view(roomId, room).agents.find(agent => agent.externalRef === fromRef);
    if (![from.introducedBy, from.linkedMemberId].includes(auth.member.id)) fail(403, "outside_agent_forbidden", "Only the introducer or self-linked member may report this relationship");
    const already = from.knows.includes(toRef);
    if (already) return { ...this.#view(roomId, room), recorded: "replay", fromRef, toRef };
    this.#post(token, roomId, commandId("knows", roomId, fromRef, toRef), { v: 1, kind: "knows", fromRef, toRef, externalRef: fromRef }, expectedSessionBinding);
    return { ...this.list(token, roomId, expectedSessionBinding), recorded: "knows", fromRef, toRef };
  }
  link(token, roomId, input, expectedSessionBinding = null) {
    const { auth, room } = this.#open(token, roomId, expectedSessionBinding);
    this.#refuse(auth, roomId, room);
    const externalRef = publicRef(input?.externalRef);
    const memberId = input?.memberId;
    if (memberId !== auth.member.id) fail(403, "outside_agent_forbidden", "A member may only assert their own outside-agent link; it remains unverified");
    if (!Object.hasOwn(room.state.members, memberId) || room.state.members[memberId].active === false)
      fail(404, "outside_agent_not_found", "Link only to a member who already joined. This does not grant access.");
    const existing = this.#view(roomId, room).agents.find(agent => agent.externalRef === externalRef);
    if (!existing) fail(404, "outside_agent_not_found", "Introduce the agent before linking a joined member");
    if (existing.linkedMemberId === memberId) return { ...this.#view(roomId, room), recorded: "replay", externalRef, memberId };
    if (existing.linkedMemberId) fail(409, "outside_agent_changed", "This agent is already linked to a member");
    this.#post(token, roomId, commandId("link", roomId, externalRef), { v: 1, kind: "link", externalRef, memberId }, expectedSessionBinding);
    return { ...this.list(token, roomId, expectedSessionBinding), recorded: "link", externalRef, memberId };
  }
  // 1e hs2-outside-agent-approval: the human decision on an outside agent's
  // connect (link) request. Owner-only plus membership-administration
  // delegates (the access-request decide precedent). Approval marks the link
  // verified; denial clears the link. The record is posted under the
  // approver's own credential, and assembly only honors verify records from
  // the verifier set, so a forged raw message cannot mint a verified link.
  verify(token, roomId, input, expectedSessionBinding = null) {
    const { auth, room } = this.#open(token, roomId, expectedSessionBinding);
    this.#refuse(auth, roomId, room);
    const verifiers = this.#verifiers(room);
    if (!verifiers.has(auth.member.id))
      fail(403, "outside_agent_forbidden", "Only the room owner or a membership administrator may decide on outside-agent links");
    const plan = planOutsideAgentVerify(room.state.messages ?? [], room.state.members ?? {}, roomId, auth.member.id, input, { verifiers });
    if (plan.recorded === "replay") return { ...this.#view(roomId, room), recorded: "replay", externalRef: plan.externalRef, decision: plan.decision };
    this.#post(token, roomId, plan.commandId, plan.record, expectedSessionBinding);
    return { ...this.list(token, roomId, expectedSessionBinding), recorded: plan.recorded, externalRef: plan.externalRef, decision: plan.decision };
  }
  #post(token, roomId, id, record, expectedSessionBinding) {
    const body = outsideAgentBody(record);
    return this.store.command(token, roomId, { id, type: "message.posted", data: { messageId: id, body } }, expectedSessionBinding);
  }
}
