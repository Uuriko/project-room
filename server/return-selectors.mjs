import { WORK_STATES } from "../src/events.js";
// needsAttention / workInvolvingMe, ported VERBATIM from the reviewed r3 selector slice
// (branch instinct/push/needs-attention-b3; review closed at 5557676251 - "wired unchanged"
// per the return-brief wiring disposition 5557850637). Only the error class is local to this
// module so the wired package does not depend on the unwired return-cursor contract module.

export class CursorError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const REQUEST_ROLES = ["accountableMemberId", "verifierMemberId", "humanDecisionMakerId"];

// Two independent return facts (matrix refinement 4): unread-since-cursor and
// unresolved-work-involving-me are SEPARATE derivations. The cursor governs what is
// new; it never hides older work that is still open.
//
// Two projections (disposition 5557593390), both selecting from the CURRENT
// work-item projection (src/events.js), never a reconstruction - the projection's
// receipt, verification and decision are version-bound to the exact current
// completion, so a historical PASS or approval can never hide reopened work:
//
// - workInvolvingMe: any current role on non-superseded, non-approved work.
//   Context, including normal running work. Produces no attention badge.
// - needsAttention: the CURRENT STEP belongs to this member:
//   accountable -> accept (proposed), start (accepted), revise (blocked: includes
//   verification-failure blocks and rejected/changes-requested decisions, whose
//   reducer path already routes the next action to the accountable member);
//   designated verifier -> verify (current completion unchecked);
//   designated human -> decide (current completion's verification gate satisfied,
//   no current decision). A normally running item and a completed item with no
//   remaining required gate produce NO attention.
// Requirement-aware terminality (disposition 5557635532): involvement is ONGOING
// context, not a completion archive. Terminal means: superseded; owner decision
// required and approved; or no owner decision required and the current completion's
// verification requirement is satisfied (PASS) or absent. Terminal work stays
// discoverable under the fixed-horizon "What changed" view and in record history -
// it never masquerades as open work here.
function involvementTerminal(item) {
  if (item.supersededBy) return true;
  if (item.ownerDecisionRequired) return item.decision?.decision === "approved";
  return item.state === WORK_STATES.COMPLETED && (!item.independentVerificationRequired || item.verification?.result === "pass");
}

export function workInvolvingMe({ workItems, memberId }) {
  if (!workItems || typeof workItems !== "object" || Array.isArray(workItems)) throw new CursorError("cursor.work_items_required", "workInvolvingMe requires the current work-item projection map");
  if (!memberId) throw new CursorError("cursor.member_required", "workInvolvingMe requires a memberId");
  const out = [];
  for (const item of Object.values(workItems)) {
    if (!item || typeof item !== "object") continue;
    const roles = REQUEST_ROLES.filter(field => item[field] === memberId);
    if (roles.length === 0 || involvementTerminal(item)) continue;
    out.push(Object.freeze({ workItemId: item.id, action: item.title ?? null, roles: Object.freeze(roles), state: item.state }));
  }
  return Object.freeze(out);
}

export function needsAttention({ workItems, memberId }) {
  if (!workItems || typeof workItems !== "object" || Array.isArray(workItems)) throw new CursorError("cursor.work_items_required", "needsAttention requires the current work-item projection map");
  if (!memberId) throw new CursorError("cursor.member_required", "needsAttention requires a memberId");
  const out = [];
  for (const item of Object.values(workItems)) {
    if (!item || typeof item !== "object" || item.supersededBy) continue;
    if (item.decision?.decision === "approved") continue;
    const push = (role, step) => out.push(Object.freeze({ workItemId: item.id, action: item.title ?? null, role, step }));
    if (item.accountableMemberId === memberId) {
      if (item.state === WORK_STATES.PROPOSED) push("accountable", "accept");
      else if (item.state === WORK_STATES.ACCEPTED) push("accountable", "start");
      else if (item.state === WORK_STATES.BLOCKED) push("accountable", "revise");
    }
    if (item.state === WORK_STATES.COMPLETED) {
      const verificationSatisfied = !item.independentVerificationRequired || item.verification?.result === "pass";
      if (item.verifierMemberId === memberId && item.independentVerificationRequired && !verificationSatisfied) push("verifier", "verify");
      if (item.humanDecisionMakerId === memberId && item.ownerDecisionRequired && verificationSatisfied && !item.decision) push("decision_maker", "decide");
    }
  }
  return Object.freeze(out);
}
