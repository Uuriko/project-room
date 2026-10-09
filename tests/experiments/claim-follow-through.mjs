// QA-only prototype. Feed a selected Board snapshot; never writes or dispatches.
// Deliberately not connected to Needs-me until real-case usefulness is reviewed.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function claimFollowThrough(claim, { dependencies = [], now, candidateHead = null } = {}) {
  if (!claim || typeof claim.id !== 'string' || !claim.id
    || !['unclaimed', 'claimed', 'in_progress', 'blocked', 'done', 'closed'].includes(claim.state)) {
    throw new TypeError('A selected Board claim with a valid id and state is required');
  }
  if (!Number.isFinite(Date.parse(now))) throw new TypeError('An explicit observation timestamp is required');
  if (candidateHead !== null && !/^[a-f0-9]{40}$/i.test(candidateHead)) throw new TypeError('Invalid candidate head');
  if (!Array.isArray(dependencies)) throw new TypeError('Dependencies must be snapshots');
  const basis = {
    owner: claim.owner ?? null, claimedAt: claim.claimedAt ?? null,
    revision: claim.revision ?? null, headSha: claim.ci?.headSha ?? null,
  };
  const currentReviews = (claim.reviews ?? []).filter(review => review.basis?.version === 1
    && Object.entries(basis).every(([key, value]) => (review.basis[key] ?? null) === value)
    && (!candidateHead || candidateHead === basis.headSha));
  const unresolved = (claim.dependsOn ?? []).filter(id => {
    const dependency = dependencies.find(item => item.id === id);
    return !dependency || dependency.state !== 'done' || dependency.premiseFlag || dependency.supersededBy;
  });
  let action;
  if (claim.supersededBy) action = ['inspect_successor', 'Read the successor; do not dispatch this retired scope.'];
  else if (claim.state === 'closed') action = ['no_dispatch', 'Closed without delivery; preserve the retirement.'];
  else if (claim.premiseFlag) action = ['recheck_premise', 'Resolve the flagged premise with the existing owner before recommending work.'];
  else if (claim.state === 'done') action = ['inspect_delivery', 'Inspect accepted delivery evidence; delivery mode does not prove live user behavior.'];
  else if (unresolved.length) action = ['inspect_dependencies', 'Read unresolved dependency outcomes and coordinate with their existing owners.'];
  else if (claim.state === 'blocked') action = ['inspect_hold', 'Read the explicit hold and recovery path with the existing owner.'];
  else if (!claim.owner) action = ['dispatcher_acceptance', 'Use the existing dispatcher and obtain named acceptance before assigning work.'];
  else if (!Number.isFinite(Date.parse(claim.leaseExpiresAt)) || Date.parse(claim.leaseExpiresAt) <= Date.parse(now)) {
    action = ['refresh_lease', 'Refresh server ownership and lease; local expiry does not authorize takeover.'];
  } else if (!basis.headSha || (candidateHead && candidateHead !== basis.headSha)) {
    action = ['refresh_head_evidence', 'Read CI and review evidence for the exact candidate head.'];
  } else if (claim.ci.state === 'failure') action = ['inspect_failure', 'Inspect the exact failing execution and help the accepted owner.'];
  else if (claim.ci.state === 'pending') action = ['await_evidence', 'Wait for changed execution evidence; do not repeat a same-basis request.'];
  else if (currentReviews.some(review => review.verdict === 'changes_requested')) {
    action = ['inspect_review_findings', 'Assess concrete findings and explicit holds; review status alone is not a release prohibition.'];
  } else action = ['inspect_acceptance', 'Verify required checks actually executed and the user outcome; a CI rollup is not acceptance proof.'];
  return {
    claimId: claim.id, state: claim.state, observedAt: now, basis, candidateHead,
    ci: claim.ci ?? null,
    currentReviewCount: currentReviews.length,
    staleReviewCount: (claim.reviews ?? []).length - currentReviews.length,
    unresolvedDependencies: unresolved,
    deliveryMode: claim.deliveryMode ?? null,
    nextAction: { code: action[0], suggestion: action[1], inference: true },
    writes: false,
    limits: ['Snapshot only; refresh before acting.', 'No merge, deployment, live behavior or new authority inferred.'],
  };
}

// Reconstructable offline helper: node tests/experiments/claim-follow-through.mjs < input.json
// Input: {claim, options:{now, candidateHead?, dependencies?}}. No network access.
if (!process.env.NODE_TEST_CONTEXT && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) throw new TypeError('Use stdin JSON; no command arguments supported');
  const input = JSON.parse(readFileSync(0, 'utf8'));
  process.stdout.write(`${JSON.stringify(claimFollowThrough(input.claim, input.options), null, 2)}\n`);
}
