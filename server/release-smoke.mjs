import { createHash } from "node:crypto";
import { validId } from "../src/events.js";
import { nextWorkStep, workThreadHref } from "../src/workflow.js";
import { nativePrerequisiteState } from "./work-item-state.mjs";

export function releaseSmokePlan(value) {
  if (!value || !validId(value.accountableMemberId) || !validId(value.verifierMemberId)
      || value.accountableMemberId === value.verifierMemberId
      || typeof value.criteria !== "string" || !value.criteria.trim() || value.criteria.length > 2000) return null;
  return { accountableMemberId: value.accountableMemberId, verifierMemberId: value.verifierMemberId, criteria: value.criteria };
}

export function releaseSmokeWorkId(workItemId, completionEventId, candidateRevision) {
  const key = createHash("sha256").update(JSON.stringify([workItemId, completionEventId, candidateRevision])).digest("hex");
  return `release-smoke-${key}`;
}

export function releaseOutcome({ releaseChecks, work, readWork, visibleSmokeEvidence, now, ownerId }) {
  const plan = releaseChecks?.smokeTest;
  if (!plan) return null;
  const { candidateRevision, completionEventId, checks } = releaseChecks;
  const deploy = checks.find(check => check.stage === "deploy");
  const id = releaseSmokeWorkId(work.id, completionEventId, candidateRevision);
  const base = { candidateRevision, criterion: plan.criteria };
  if (deploy?.status !== "passed") {
    return { ...base, status: "open", remaining: deploy?.status === "failed" ? "fix_deployment" : "verify_deployment" };
  }

  const smoke = readWork(id);
  if (smoke?.sourceMessageId !== deploy.evidenceMessageId || smoke.proposedById !== deploy.reportedById
      || smoke.accountableMemberId !== plan.accountableMemberId || smoke.verifierMemberId !== plan.verifierMemberId
      || smoke.independentVerificationRequired !== true) {
    return { ...base, status: "open", remaining: "confirm_smoke_handoff" };
  }
  const next = nextWorkStep(smoke, now, ownerId);
  const smokePassed = nativePrerequisiteState(smoke, now).satisfied;
  const smokeAccepted = smokePassed && visibleSmokeEvidence(smoke);
  const accepted = smokeAccepted && nativePrerequisiteState(work, now).satisfied;
  return { ...base, status: accepted ? "accepted" : "open",
    ...(accepted ? {} : { remaining: smokeAccepted ? "accept_release" : smokePassed ? "restore_smoke_evidence" : "accept_smoke_test" }),
    smokeTest: { workItemId: id, href: workThreadHref(id), state: smoke.state,
      next, nextRead: { tool: "room_read_work", arguments: { workItemId: id, brief: true } },
      ...(smokeAccepted ? { completionEventId: smoke.receipt.eventId } : {}) } };
}
