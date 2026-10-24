import { join } from 'node:path';
import { RoomAgentClient } from '../room-agent.mjs';
import { openRequestJournal, runRequestOnce } from '../request-runner.mjs';
import { buildReplyCommand } from '../reply-actions.mjs';
import { queueJobArtifacts } from './artifacts.mjs';
import { canonical, digest, requireThat } from './store.mjs';
import { policy, submit, runJob, getJob, admission, observe } from './executor.mjs';

export const prefix = 'Project Room capability v1\n';
export function parseCapabilityTask(body) {
  requireThat(typeof body === 'string' && body.startsWith(prefix) && Buffer.byteLength(body) <= 8192, 'invalid_capability_task');
  const task = JSON.parse(body.slice(prefix.length));
  requireThat(task && canonical(Object.keys(task).sort()) === canonical(['capability', 'input', 'version']) && task.version === 1
    && typeof task.capability === 'string', 'invalid_capability_task');
  return task;
}
export async function runRoomCapability(store, { connection, requestMessageId, signal, observeResources = () => observe(store.directory) }) {
  const client = new RoomAgentClient(connection);
  const context = await client.replyContext(requestMessageId, { limit: 50, signal });
  requireThat(context.viewerId === connection.memberId && context.request.recipientId === connection.memberId, 'request_identity_mismatch');
  const opening = context.page.items.find(r => r.message?.id === requestMessageId)?.message;
  requireThat(opening?.authorId === context.request.requesterId, 'opening_unavailable');
  const task = parseCapabilityTask(opening.body);
  const operation = digest(canonical([connection.origin, connection.memberId, context.roomCreatedEventId, context.request.openingEventId, requestMessageId]));
  const authorize = () => {
    const p = policy(store);
    requireThat(!p.paused && p.roomGrants?.some(g => g.origin === connection.origin && g.room === connection.roomId
      && g.member === connection.memberId && g.requesters.includes(context.request.requesterId) && g.capabilities.includes(task.capability)), 'room_grant_required');
  };
  const journal = openRequestJournal(join(store.directory, 'room-requests.sqlite'));
  const queueEvidence = (result, response) => {
    if (policy(store).publishArtifacts === true && result.result?.artifacts?.length) {
      const command = buildReplyCommand(connection, 'room_respond_to_request', { ...response, body: 'Evidence pending' });
      queueJobArtifacts(store, { connection, jobId: result.id, requestMessageId, roomCreatedEventId: context.roomCreatedEventId, messageId: command.data.messageId });
    }
  };
  const resultBody = result => JSON.stringify({ version: 1, jobId: result.id, state: result.state, packageHash: result.pin,
    artifactDigest: result.result?.artifactDigest ?? null, elapsedMs: result.result?.elapsedMs ?? null,
    evidenceLocation: 'executing_laptop', acceptance: result.result?.acceptance ?? 'not_verified',
    next: result.state === 'completed' ? 'Inspect artifacts when needed; script success is not release approval.' : 'Inspect the durable job before repair or retry.' });
  try {
    // If the process died after committing the local result but before the
    // request runner saved its answer, rebuild only the original bound answer.
    const pending = store.db.prepare('SELECT * FROM room_results WHERE request=?').get(operation);
    if (pending) {
      const saved = JSON.parse(pending.response), binding = JSON.parse(pending.binding);
      const row = journal.prepare('SELECT * FROM request_runs WHERE id=?').get(binding.requestId);
      if (row && !row.response) {
        const local = getJob(store, pending.job);
        requireThat(context.current.answerBasis && saved.expectedRequestRevision === context.current.answerBasis.expectedRequestRevision
          && saved.contextEventId === context.current.answerBasis.contextEventId && saved.contextSequence === context.current.answerBasis.contextSequence
          && saved.toMemberId === context.request.requesterId && row.attempt_id === binding.attemptId, 'saved_result_basis_changed');
        requireThat(['completed', 'needs_attention', 'cancelled'].includes(local.state), 'job_requires_reconciliation');
        queueEvidence(local, saved);
        journal.prepare('UPDATE request_runs SET response=? WHERE id=? AND response IS NULL').run(JSON.stringify({ ...saved, body: resultBody(local) }), binding.requestId);
      }
    }
    let job;
    const preflight = () => {
      authorize();
      job = submit(store, { room: connection.roomId, operation, capability: task.capability, input: task.input });
      if (job.state === 'queued') requireThat(admission(store, job, observeResources()).allowed, 'device_not_available');
      else requireThat(['completed', 'needs_attention', 'cancelled'].includes(job.state), 'job_requires_reconciliation');
    };
    return await runRequestOnce({ connection, requestMessageId, db: journal, signal, preflight,
      execute: async (prepared, { binding }) => {
        authorize();
        const current = prepared.messages.find(r => r.message?.id === requestMessageId)?.message;
        requireThat(canonical(parseCapabilityTask(current?.body)) === canonical(task), 'request_changed');
        requireThat(binding.expectedRequestRevision === context.current.answerBasis?.expectedRequestRevision
          && binding.contextEventId === context.current.answerBasis?.contextEventId, 'request_changed');
        const response = { requestId: binding.requestId, responseToRequestId: requestMessageId,
          ...context.current.answerBasis, responseOutcome: 'answered', toMemberId: prepared.request.requesterId,
          workItemId: prepared.request.workItemId };
        store.db.prepare('INSERT OR IGNORE INTO room_results VALUES(?,?,?,?)').run(operation, job.id, canonical(binding), canonical(response));
        if (job.state === 'queued') await runJob(store, job.id, { signal: prepared.signal, observation: observeResources() });
        const result = getJob(store, job.id);
        requireThat(['completed', 'needs_attention', 'cancelled'].includes(result.state), 'job_requires_reconciliation');
        queueEvidence(result, response);
        return { body: resultBody(result) };
      } });
  } finally { journal.close(); }
}
