import { buildReplyCommand } from '../reply-actions.mjs';
import { RoomAgentClient } from '../room-agent.mjs';
import { validateInteraction, sameInteractionScope, sameInteractionAttempt } from './interaction-contract.mjs';
import { canonical, digest, requireThat } from './store.mjs';

export const interactionPrefix = 'Project Room interaction v1\n';
// This is a durable conversation adapter, NOT an execution approval grant.
// The execution boundary must check current human authority and local policy.
const interactionKey = interaction => 'interaction-' + digest(canonical([interaction.scope, interaction.id]));
export function prepareRoomInteraction(connection, value) {
  const interaction = structuredClone(value), key = interactionKey(interaction);
  const command = buildReplyCommand(connection, 'room_request_reply', { requestId: key, toMemberId: interaction.payload.recipientId, body: 'Preparing question' });
  interaction.payload.requestMessageId = command.data.messageId;
  interaction.source = { id: command.data.messageId, revision: 0 };
  return validateInteraction(interaction);
}
export async function openRoomInteraction(store, { connection, interaction, sourceRequestMessageId, signal }) {
  validateInteraction(interaction);
  requireThat(['question', 'approval'].includes(interaction.kind) && interaction.state === 'open', 'interaction_request_required');
  requireThat(interaction.scope.origin === connection.origin && interaction.scope.roomId === connection.roomId
    && interaction.scope.viewerId === connection.memberId, 'interaction_connection_mismatch');
  requireThat(interaction.payload.expiresAt > Date.now(), 'interaction_expired');
  requireThat(canonical(prepareRoomInteraction(connection, interaction)) === canonical(interaction), 'interaction_request_binding_invalid');
  const client = new RoomAgentClient(connection);
  const source = await client.replyContext(sourceRequestMessageId, { limit: 1, signal });
  requireThat(source.roomCreatedEventId === interaction.scope.roomCreatedEventId && source.viewerId === connection.memberId, 'interaction_remote_binding_changed');
  const body = interactionPrefix + canonical(interaction);
  requireThat(body.length <= 4096, 'interaction_body_too_large');
  const key = interactionKey(interaction);
  const saved = store.db.prepare('SELECT value FROM settings WHERE id=?').get(key);
  if (saved) requireThat(JSON.parse(saved.value).body === body, 'interaction_id_reused');
  else store.db.prepare('INSERT INTO settings VALUES(?,?)').run(key, canonical({ body, interaction, requestMessageId: null }));
  const receipt = await client.replyAction('room_request_reply', {
    requestId: key, toMemberId: interaction.payload.recipientId, body }, { signal });
  requireThat(receipt.status === 'recorded', 'interaction_delivery_unconfirmed');
  store.db.prepare('UPDATE settings SET value=? WHERE id=?').run(canonical({ body, interaction, requestMessageId: receipt.requestMessageId }), key);
  return { key, requestMessageId: receipt.requestMessageId, executionAuthorized: false };
}
export async function readRoomInteraction(store, { connection, key, scope, attempt, now = Date.now(), signal }) {
  const saved = store.db.prepare('SELECT value FROM settings WHERE id=?').get(key);
  requireThat(saved, 'interaction_not_found');
  const record = JSON.parse(saved.value), original = record.interaction;
  requireThat(record.requestMessageId, 'interaction_delivery_unconfirmed');
  requireThat(sameInteractionScope(original.scope, scope) && sameInteractionAttempt(original.attempt, attempt)
    && scope.origin === connection.origin && scope.roomId === connection.roomId && scope.viewerId === connection.memberId, 'interaction_binding_changed');
  requireThat(Number.isSafeInteger(now) && now < original.payload.expiresAt, 'interaction_expired');
  const client = new RoomAgentClient(connection), messages = []; let cursor, first, context;
  for (let page = 0; page < 20; page++) {
    context = await client.replyContext(record.requestMessageId, { limit: 50, ...(cursor ? { cursor } : {}), signal });
    requireThat(context.roomCreatedEventId === scope.roomCreatedEventId && context.viewerId === scope.viewerId
      && context.request.requesterId === connection.memberId && context.request.recipientId === original.payload.recipientId, 'interaction_remote_binding_changed');
    if (!first) first = context.request;
    requireThat(context.request.revision === first.revision, 'interaction_changed_during_read');
    messages.push(...context.page.items.map(row => row.message).filter(Boolean));
    if (!context.page.hasMore) break;
    cursor = context.page.nextCursor; requireThat(cursor && page < 19, 'interaction_context_incomplete');
  }
  const opening = messages.find(m => m.id === record.requestMessageId);
  requireThat(opening?.body === record.body && opening.authorId === connection.memberId, 'interaction_opening_changed');
  const response = messages.find(m => m.id === context.request.responseMessageId);
  const result = { key, status: context.request.status, executionAuthorized: false, answer: null };
  if (context.request.status === 'answered') {
    requireThat(response?.authorId === original.payload.recipientId, 'interaction_responder_changed');
    if (original.kind === 'question') result.answer = response.body;
    else {
      let answer; try { answer = JSON.parse(response.body); } catch { throw new Error('interaction_decision_invalid'); }
      requireThat(canonical(Object.keys(answer).sort()) === canonical(['attemptId', 'decision', 'operationDigest'])
        && ['approve', 'decline'].includes(answer.decision) && answer.attemptId === attempt.attemptId
        && answer.operationDigest === original.payload.operationDigest, 'interaction_decision_invalid');
      result.answer = answer;
    }
  }
  return result;
}
