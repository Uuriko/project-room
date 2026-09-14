// W4-43 H1: three starter automation recipes. Every recipe has an EXPLICIT
// trigger - a pure predicate over committed room state - and produces a
// BOUNDED useful outcome: a draft or single suggestion the member acts on
// themselves. Nothing here sends messages, launches work, or spends; that
// observe/draft/act separation is H2's lane.

import { contributionSteps } from "./work-selectors.js";
import { verificationSatisfied } from "./workflow.js";
import { WORK_STATES as S } from "./events.js";

export const REVIEW_REQUEST_AFTER_MS = 24 * 60 * 60 * 1000;

export const RECIPE_CATALOG = Object.freeze([
  Object.freeze({
    id: "draft-catch-up",
    title: "Draft catch-up",
    trigger: "Your caught-up marker is behind the room's latest committed event",
    outcome: "A catch-up draft you open yourself; it is never delivered to you or anyone else"
  }),
  Object.freeze({
    id: "suggest-next-work",
    title: "Suggest next work",
    trigger: "At least one committed work step or explicit request currently needs you",
    outcome: "Exactly one suggested next step, derived from committed facts only; never an assignment"
  }),
  Object.freeze({
    id: "request-review",
    title: "Request a review",
    trigger: "A result you are accountable for has waited unverified past 24 hours",
    outcome: "A draft request addressed to the named verifier; sending remains your explicit action"
  })
]);

const reviewDrafts = (state, memberId, now) => {
  const drafts = [];
  for (const item of Object.values(state.workItems ?? {})) {
    if (!item || typeof item !== "object") continue;
    if (item.accountableMemberId !== memberId) continue;
    if (item.state !== S.COMPLETED || !item.receipt?.eventId) continue;
    if (!item.independentVerificationRequired || verificationSatisfied(item)) continue;
    const verifier = state.members?.[item.verifierMemberId];
    if (!verifier || verifier.active === false) continue;
    const at = Date.parse(item.updatedAt ?? "");
    if (!Number.isFinite(at) || now - at <= REVIEW_REQUEST_AFTER_MS) continue;
    drafts.push(Object.freeze({
      workItemId: item.id, title: item.title ?? null, toMemberId: verifier.id, waitingMs: now - at
    }));
  }
  return drafts.sort((a, b) => a.workItemId < b.workItemId ? -1 : 1);
};

export function activeRecipes(state, memberId, { now = Date.now(), cursor = null, sequence = null } = {}) {
  if (!state || typeof state !== "object") throw new Error("Room state unavailable");
  const member = state.members?.[memberId];
  if (!member || member.active === false) return Object.freeze([]);
  const out = [];

  if (Number.isSafeInteger(cursor) && Number.isSafeInteger(sequence) && cursor < sequence) {
    out.push(Object.freeze({
      id: "draft-catch-up",
      trigger: Object.freeze({ cursor, sequence, unseen: sequence - cursor }),
      outcome: Object.freeze({ kind: "catch_up_draft" })
    }));
  }

  const steps = contributionSteps(state, memberId, now);
  if (steps.length > 0) {
    const top = [...steps].sort((a, b) => a.priority - b.priority || String(a.at).localeCompare(String(b.at)) || (a.key < b.key ? -1 : 1))[0];
    out.push(Object.freeze({
      id: "suggest-next-work",
      trigger: Object.freeze({ openSteps: steps.length }),
      outcome: Object.freeze({
        kind: "work_suggestion",
        workItemId: top.kind === "work" ? top.id : null,
        requestId: top.kind === "request" ? top.id : null,
        label: top.label, button: top.button
      })
    }));
  }

  for (const draft of reviewDrafts(state, memberId, now)) {
    out.push(Object.freeze({
      id: "request-review",
      trigger: Object.freeze({ workItemId: draft.workItemId, waitingMs: draft.waitingMs, afterMs: REVIEW_REQUEST_AFTER_MS }),
      outcome: Object.freeze({
        kind: "review_request_draft",
        workItemId: draft.workItemId, title: draft.title, toMemberId: draft.toMemberId
      })
    }));
  }

  return Object.freeze(out);
}
