// Evaluator only: this file is never served to a browser or included in agent packets.
const truth = {
  writing: { current: 'launch-2', accepted: 'launch-1', owner: 'Mina', blocker: 'Confirm the release date', required: [/November 21/i, /Mina/], forbidden: [/November (?:4|12)\b/i] },
  analysis: { current: 'analysis-2', accepted: 'analysis-1', owner: 'Ravi', blocker: 'Confirm the eligible cohort', required: [/75\s*%/, /\b60\b/, /\b80\b/, /Ravi/], forbidden: [/80\s*%/, /\b100\b/] },
  coding: { current: 'retry-2', accepted: 'retry-1', owner: 'Nora', blocker: 'Confirm which failures may retry', required: [/GET/, /(?:twice|\b2\b)/, /503/, /(?:never retry POST|do not retry POST)/i, /Nora/], forbidden: [/three times|any failure/i] }
};
export function score(id, task, answer) {
  const t = truth[id];
  if (!t || !['resume', 'review', 'handoff'].includes(task)) throw new Error('Unknown task');
  const a = answer ?? {};
  const checks = task === 'resume'
    ? { currentVersion: a.current === t.current, acceptedVersion: a.accepted === t.accepted,
      owner: a.owner?.trim() === t.owner, blocker: a.blocker?.trim().toLowerCase() === t.blocker.toLowerCase() }
    : { exactVersion: a.basedOn === t.current,
      requiredPhrases: typeof a.body === 'string' && t.required.every(pattern => pattern.test(a.body)) && !t.forbidden.some(pattern => pattern.test(a.body)) };
  const checksPassed = Object.values(checks).every(Boolean);
  return { checksPassed, outcome: !checksPassed ? "rejected" : task === "resume" ? "passed" : "requires_content_review", checks,
    limitation: 'Review/handoff outputs are never semantically approved by this phrase checker. Exact facts and required phrases are mechanical screening only.' };
}
