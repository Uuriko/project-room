import { createHash } from "node:crypto";
import { ServiceError } from "./service-error.mjs";
import { enforceAutonomyTierForAction } from "./autonomy-tiers.mjs";
import { outsideAgentBody, planOutsideAgentRecord, assembleOutsideAgents, publicRef } from "../src/outside-agents.mjs";
export { outsideAgentBody, parseOutsideAgentBody, planOutsideAgentRecord, assembleOutsideAgents } from "../src/outside-agents.mjs";
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
  #view(room) {
    return {
      contractVersion: 1, grantsAccess: false, evaluatedThrough: room.sequence,
      agents: assembleOutsideAgents(room.state.messages ?? [], room.state.members ?? {})
    };
  }
  list(token, roomId, expectedSessionBinding = null) {
    const { room } = this.#open(token, roomId, expectedSessionBinding);
    return this.#view(room);
  }
  record(token, roomId, input, expectedSessionBinding = null) {
    const { auth, room } = this.#open(token, roomId, expectedSessionBinding);
    this.#refuse(auth, roomId, room);
    const plan = planOutsideAgentRecord(room.state.messages ?? [], room.state.members ?? {}, roomId, auth.member.id, input);
    if (plan.recorded === "replay") return { ...this.#view(room), recorded: "replay", externalRef: plan.externalRef };
    this.#post(token, roomId, plan.commandId, plan.record, expectedSessionBinding);
    return { ...this.list(token, roomId, expectedSessionBinding), recorded: plan.recorded, externalRef: plan.externalRef };
  }
  knows(token, roomId, input, expectedSessionBinding = null) {
    const { auth, room } = this.#open(token, roomId, expectedSessionBinding);
    this.#refuse(auth, roomId, room);
    const fromRef = publicRef(input?.fromRef), toRef = publicRef(input?.toRef);
    if (fromRef === toRef) fail(422, "invalid_outside_agent", "An agent cannot be related to itself");
    const known = new Set(this.#view(room).agents.map(agent => agent.externalRef));
    if (!known.has(fromRef) || !known.has(toRef)) fail(404, "outside_agent_not_found", "Introduce both agents before relating them");
    const from = this.#view(room).agents.find(agent => agent.externalRef === fromRef);
    if (![from.introducedBy, from.linkedMemberId].includes(auth.member.id)) fail(403, "outside_agent_forbidden", "Only the introducer or self-linked member may report this relationship");
    const already = from.knows.includes(toRef);
    if (already) return { ...this.#view(room), recorded: "replay", fromRef, toRef };
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
    const existing = this.#view(room).agents.find(agent => agent.externalRef === externalRef);
    if (!existing) fail(404, "outside_agent_not_found", "Introduce the agent before linking a joined member");
    if (existing.linkedMemberId === memberId) return { ...this.#view(room), recorded: "replay", externalRef, memberId };
    if (existing.linkedMemberId) fail(409, "outside_agent_changed", "This agent is already linked to a member");
    this.#post(token, roomId, commandId("link", roomId, externalRef), { v: 1, kind: "link", externalRef, memberId }, expectedSessionBinding);
    return { ...this.list(token, roomId, expectedSessionBinding), recorded: "link", externalRef, memberId };
  }
  #post(token, roomId, id, record, expectedSessionBinding) {
    const body = outsideAgentBody(record);
    return this.store.command(token, roomId, { id, type: "message.posted", data: { messageId: id, body } }, expectedSessionBinding);
  }
}
