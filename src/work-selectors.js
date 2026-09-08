import { terminalWork, nextWorkStep, workActions } from "./workflow.js";
// One shared current-state derivation for the browser, return brief and agent client.

export class CursorError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const REQUEST_ROLES = ["accountableMemberId", "verifierMemberId", "humanDecisionMakerId"];

// Search only the supplied current Room projection. A hit is not an assignment,
// verified result or permission to act. No external evidence/history is fetched.
export function searchWork(state, query, limit = 25) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) throw new RangeError("Work search limit must be 1–25");
  const term = String(query).trim().slice(0, 200).toLocaleLowerCase();
  if (!term) return { work: [], total: 0 };
  const matches = [];
  for (const item of Object.values(state.workItems)) {
    const fields = [item.title, item.definitionOfDone, item.receipt?.summary, item.receipt?.nextAction, item.id,
      ...REQUEST_ROLES.map(role => state.members[item[role]]?.displayName)];
    const matched = fields.find(text => typeof text === "string" && text.toLocaleLowerCase().includes(term));
    if (matched === undefined) continue;
    const text = matched === item.title ? item.receipt?.summary || item.definitionOfDone : matched;
    const folded = text.toLocaleLowerCase(), offset = Math.max(0, folded.indexOf(term) - 60);
    let start = offset;
    // Case folding can expand characters (for example İ); convert the folded
    // offset back to original text rather than slicing beyond a valid match.
    if (folded.length !== text.length) {
      let position = 0; start = 0;
      for (const character of text) {
        const width = character.toLocaleLowerCase().length;
        if (position + width > offset) break;
        position += width; start += character.length;
      }
    }
    if (start && /[\uDC00-\uDFFF]/.test(text[start])) start--;
    const excerpt = [...text.slice(start)].slice(0, 240).join("");
    matches.push({ item, excerpt: `${start ? "…" : ""}${excerpt}${start + excerpt.length < text.length ? "…" : ""}` });
  }
  matches.sort((a, b) => Number(terminalWork(a.item)) - Number(terminalWork(b.item))
    || b.item.updatedAt.localeCompare(a.item.updatedAt) || a.item.id.localeCompare(b.item.id));
  return { work: matches.slice(0, limit), total: matches.length };
}

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
//   accountable -> establish producer provenance or resolve a verifier/producer conflict;
//   designated verifier -> verify (producer known and distinct, gate not yet satisfied);
//   designated human -> decide (current completion's verification gate satisfied,
//   no current decision). A normally running item and a completed item with no
//   remaining required gate produce NO attention.
// Requirement-aware terminality (disposition 5557635532): involvement is ONGOING
// context, not a completion archive. Terminal means: superseded; owner decision
// required and approved; or no owner decision required and the current completion's
// verification requirement is satisfied (PASS) or absent. Terminal work stays
// discoverable under the fixed-horizon "What changed" view and in record history -
// it never masquerades as open work here.
export function workInvolvingMe({ workItems, memberId }) {
  if (!workItems || typeof workItems !== "object" || Array.isArray(workItems)) throw new CursorError("cursor.work_items_required", "workInvolvingMe requires the current work-item projection map");
  if (!memberId) throw new CursorError("cursor.member_required", "workInvolvingMe requires a memberId");
  const out = [];
  for (const item of Object.values(workItems)) {
    if (!item || typeof item !== "object") continue;
    const roles = REQUEST_ROLES.filter(field => item[field] === memberId);
    if (roles.length === 0 || terminalWork(item)) continue;
    out.push(Object.freeze({ workItemId: item.id, action: item.title ?? null, roles: Object.freeze(roles), state: item.state }));
  }
  return Object.freeze(out);
}

export function needsAttention({ workItems, memberId, now = Date.now() }) {
  if (!workItems || typeof workItems !== "object" || Array.isArray(workItems)) throw new CursorError("cursor.work_items_required", "needsAttention requires the current work-item projection map");
  if (!memberId) throw new CursorError("cursor.member_required", "needsAttention requires a memberId");
  const out = [];
  for (const item of Object.values(workItems)) {
    if (!item || typeof item !== "object") continue;
    const next = nextWorkStep(item, now);
    if (next.needsAttention && next.memberId === memberId) out.push(Object.freeze({ workItemId: item.id, action: item.title ?? null, role: next.role, step: next.action }));
  }
  return Object.freeze(out);
}

// Presentation only: explicit requests and existing handoffs, never inferred
// assignments or permission grants. Reading/acknowledging updates cannot clear these.
export function contributionSteps(state, memberId, now = Date.now()) {
  const member = state?.members?.[memberId];
  if (!member || member.active === false) return [];
  const messages = new Map(state.messages.map(message => [message.id, message]));
  const requests = Object.values(state.replyRequests ?? {}).filter(request =>
    request.status === "open" && request.recipientId === memberId && messages.has(request.id));
  const steps = requests.map(request => ({ key: `request:${request.id}`, kind: "request", id: request.id,
    title: messages.get(request.id).body, label: "Reply requested", button: "Open request", priority: 1, at: request.createdAt }));
  for (const attention of needsAttention({ workItems: state.workItems, memberId, now })) {
    const item = state.workItems[attention.workItemId], step = attention.step;
    const action = step === "revise" ? "resolve" : step;
    const permitted = workActions(item, member, now).some(([candidate]) => candidate === action);
    const labels = { verify: "Ready for review", decide: "Ready for your decision", accept: "Invited to contribute", start: "Ready to start", claim: "Scope needed", revise: "Needs a new direction" };
    steps.push({ key: `work:${item.id}`, kind: "work", id: item.id, action: permitted ? action : null,
      title: item.title, label: labels[step] ?? nextWorkStep(item, now).label,
      button: step === "verify" ? "Review result" : step === "decide" ? "Review decision" : "Open work",
      priority: ["verify", "decide"].includes(step) ? 0 : 2, at: item.updatedAt });
  }
  // Drafts are content to inspect, not lifecycle transitions. Keep one work row,
  // and never skip a newer stale proposal to promote an older draft as current.
  const latestDrafts = new Map();
  const workSteps = new Map(steps.filter(step => step.kind === 'work').map(step => [step.id, step]));
  for (const message of state.messages) if (message.workItemId && message.proposal) latestDrafts.set(message.workItemId, message);
  for (const [workId, draft] of latestDrafts) {
    const item = state.workItems[workId];
    if (!item || draft.proposal.basisRevision !== item.revision
      || !workActions(item, member, now).some(([action]) => action === 'complete')) continue;
    const existing = workSteps.get(workId);
    const entry = { key: `work:${workId}`, kind: 'work', id: workId, action: null, draftMessageId: draft.id,
      title: item.title, label: 'Draft to inspect', button: 'View draft', priority: 2, at: item.updatedAt };
    if (existing) Object.assign(existing, entry); else steps.push(entry);
  }
  return steps.sort((a, b) => a.priority - b.priority || String(a.at ?? "").localeCompare(String(b.at ?? "")) || a.key.localeCompare(b.key));
}
