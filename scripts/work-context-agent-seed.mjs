// Deterministic synthetic prehistory only. Fresh agents provide the correction and real review.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { EVENT_TYPES as T } from '../src/events.js';

export function seedWorkContextExercise({ store, keys, artifactOrigin, artifactDirectory }) {
  const workItemId = 'cancellation-checklist';
  const send = (actor, type, data) => store.command(keys[actor], 'commons', { id: randomUUID(), type, data });
  const mutate = (actor, type, fields = {}) => send(actor, type, { workItemId,
    expectedRevision: store.room('commons').state.workItems[workItemId].revision, ...fields });
  send('owner', T.MESSAGE_POSTED, { messageId: 'cancellation-request', body: 'Prepare an original proposed acceptance checklist for a future agent-run cancellation flow. Cover three cases: a cancellation request times out; the worker confirms stopped; a result arrives after cancellation was requested. For each, state the Room display, human operator next action and observable evidence. Distinguish request acknowledgement from confirmed stop, stopped execution from known final usage/cost, and late output from approval. Label all behavior as proposed, not implemented. Under 650 words, exact retrievable Markdown bytes, independent review, then designated human decision. Local drafting only: no provider, compute, publishing, money or Dasha access. The fictional coordination scope is repository project-room-context-exercise, ref main, paths [docs/cancellation-checklist.md]; it represents the separately authorized temporary draft, not a real repository or external grant.' });
  send('owner', T.WORK_PROPOSED, { workItemId, title: 'Clarify cancellation handoffs',
    definitionOfDone: 'Three concrete acceptance cases from the linked source; each has display, human next action and evidence. Correct the prior failed review, remain under 650 words, and mark proposals honestly. Record an actual immutable artifact hash. Independent review is required; only the designated human can approve.',
    accountableMemberId: 'producer', verifierMemberId: 'reviewer', independentVerificationRequired: true,
    ownerDecisionRequired: true, humanDecisionMakerId: 'owner', sourceMessageId: 'cancellation-request', mode: 'write' });
  const prior = Buffer.from('# Synthetic seed: deliberately incomplete cancellation note\n\nThis is fixture prehistory, not an agent-authored answer.\nA cancellation request immediately stops the worker and proves there is no cost. Late results can be marked approved.\n');
  const hash = createHash('sha256').update(prior).digest('hex');
  writeFileSync(join(artifactDirectory, `${hash}.md`), prior, { flag: 'wx', mode: 0o600 });
  mutate('producer', T.WORK_ACCEPTED);
  mutate('producer', T.CLAIM_ACQUIRED, { repository: 'project-room-context-exercise', ref: 'main', paths: ['docs/cancellation-checklist.md'], expiresAt: new Date(Date.now() + 3600000).toISOString() });
  mutate('producer', T.WORK_STARTED);
  const completed = mutate('producer', T.WORK_COMPLETED, { summary: 'Synthetic prehistory only: deliberately incomplete note.',
    evidenceUrl: `${artifactOrigin}/${hash}.md`, evidenceVersion: `sha256:${hash}`, producerId: 'producer',
    checksClaimed: ['Deterministic fixture seed; no actual producer evaluation'], nextAction: 'Seeded failed review precedes fresh agent correction.' });
  mutate('reviewer', T.VERIFICATION_RECORDED, { result: 'fail', completionEventId: completed.event.id, evidenceVersion: `sha256:${hash}`,
    summary: 'Synthetic seeded review: request, confirmed stop, usage and human approval are conflated; no three-case checklist.',
    nextAction: 'Write the linked source’s three cases and separate those outcomes. This finding is seeded history, not the fresh reviewer’s verdict.' });
  mutate('producer', T.CLAIM_RELEASED);
  send('owner', T.MESSAGE_POSTED, { messageId: 'cancellation-request-old', body: 'UNRELATED-CONTEXT-SENTINEL. A different discussion about meeting cancellations. Do not use as the selected source.' });
  send('owner', T.WORK_PROPOSED, { workItemId: 'meeting-cancellation', title: 'UNRELATED-WORK-SENTINEL: meeting note', definitionOfDone: 'Separate unrelated fixture task', accountableMemberId: 'owner', mode: 'read' });
  return workItemId;
}
