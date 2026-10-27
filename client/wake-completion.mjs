import { AgentWakeClient } from './agent-wake.mjs';
import { RoomAgentClient } from './room-agent.mjs';

const id = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
const fail = () => { throw new Error('reply_evidence_not_confirmed'); };

// Room stores the recovery evidence. Repeating this operation never posts a
// second reply; it only rechecks evidence and retries the fenced notification ACK.
// A handled notification is not evidence that a work item is complete.
export async function completeReplyWake({ connection, hostId, signalId, replyMessageId,
  client = new RoomAgentClient(connection), wake = new AgentWakeClient({ connection }) }) {
  if (!id(signalId) || !id(replyMessageId) || !id(connection.memberId) || !id(connection.roomId)
    || !/^[A-Za-z0-9._-]{1,128}$/.test(hostId ?? '')) throw new Error('invalid_completion');
  const read = () => wake.wait({ hostId, cadenceSeconds: 60, waitMs: 0 });
  const page = await read();
  if (page.status === 'listener_contended') return { status: 'listener_contended', signalId };
  const signal = page.pendingWakes.find(row => row.signalId === signalId);
  if (!signal) return { status: 'not_observed_pending', signalId };
  // Formal requests and work require their own completion semantics.
  if (!['mention', 'dm'].includes(signal.kind) || signal.roomId !== connection.roomId
    || !id(signal.messageId) || signal.requestId) throw new Error('unsupported_wake_completion');
  const source = await client.messageThread(signal.messageId);
  const reply = await client.messageThread(replyMessageId);
  const original = source?.thread, answer = reply?.thread;
  if (source?.roomId !== connection.roomId || reply?.roomId !== connection.roomId
    || original?.id !== signal.messageId || original.deletedAt || original.requestKind === 'reply'
    || answer?.id !== replyMessageId || answer.authorId !== connection.memberId
    || answer.replyToId !== signal.messageId || answer.deletedAt
    || typeof answer.body !== 'string' || !answer.body.trim()
    || !Number.isFinite(signal.createdAt) || !Number.isFinite(Date.parse(answer.createdAt))
    || Date.parse(answer.createdAt) < signal.createdAt) fail();
  // A private notification must stay in its original conversation; a public
  // reply cannot establish private handling, or vice versa.
  if (original.toMemberId
    ? original.toMemberId !== connection.memberId || answer.toMemberId !== original.authorId
    : Boolean(answer.toMemberId)) fail();
  const current = await read();
  if (current.status === 'listener_contended') return { status: 'listener_contended', signalId };
  const same = current.pendingWakes.find(row => row.signalId === signalId);
  if (!same) return { status: 'not_observed_pending', signalId };
  if (['kind', 'roomId', 'messageId', 'requestId'].some(key => same[key] !== signal[key])) fail();
  const receipt = await wake.ack({ signalIds: [signalId] });
  return { status: receipt.acknowledged.includes(signalId) ? 'reply_observed_and_acknowledged' : 'ack_not_confirmed',
    signalId, replyMessageId, workCompletion: 'not_inferred' };
}
