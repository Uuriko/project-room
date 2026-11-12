// Adapted from Codex 2's reviewed public proposal:
// project-room-lobby message codex2-formal-delivery-prototype-1103.
// Credentials stay in RoomClient; only its service-issued command is persisted.
import {RoomError} from './room.mjs';

// Match src/reply-requests.js; room-acp is independently distributable.
export const MAX_FORMAL_RESPONSE_CHARS = 8192;
export const MAX_FORMAL_COMMAND_BYTES = 65536;
const MAX_DRAFT_BYTES = 16384;
function pendingOverflow(context, value, code, actual, maximum) {
  const binding = {version:1, roomId:context.roomId, requestMessageId:context.request.id,
    viewerId:context.viewerId, requestRevision:context.request.revision,
    contextEventId:context.current.contextEventId, contextSequence:context.current.contextSequence,
    outcome:value.outcome, body:value.body};
  const retained = Buffer.byteLength(value.body) <= MAX_DRAFT_BYTES
    && Buffer.byteLength(JSON.stringify(binding)) <= MAX_DRAFT_BYTES;
  return {kind:'pending', body:`The response exceeds the ${code === 'formal_body_too_long' ? 'character' : 'serialized command byte'} limit (${actual} / ${maximum}). This request remains open. ${retained ? 'The exact draft is retained locally' : 'The draft exceeds the local retention budget and was not retained'}; shorten it and inspect the current request before responding.`,
    pendingReason:{code, actual, maximum, draftRetained:retained}, ...(retained ? {draft:binding} : {})};
}
const MAX_CONTEXT_BYTES = 4 * 65536;
const invalid = reason => {throw new RoomError(409, 'formal_context_invalid', reason);};

export async function readCompleteRequest(room, requestId) {
  let cursor = null, binding, last, bytes = 0;
  const items = [], seen = new Set();
  for (let page = 0; page < 20; page++) {
    last = await room.requestContext(requestId, cursor);
    if (last.roomId !== room.roomId || last.viewerId !== room.memberId || last.request?.id !== requestId
      || last.request.recipientId !== room.memberId) invalid('Request does not belong to this listener');
    const preparation = {...last.preparation}; delete preparation.evaluatedThrough;
    const identity = JSON.stringify([last.roomCreatedEventId, last.request.revision,
      last.current?.contextEventId, last.current?.contextSequence, preparation]);
    if (binding && binding !== identity) invalid('Request changed while reading; inspect again before execution');
    binding = identity;
    bytes += Buffer.byteLength(JSON.stringify(last));
    if (bytes > MAX_CONTEXT_BYTES) throw new RoomError(413, 'formal_context_too_large', 'Request exceeds the listener context budget');
    if (!Array.isArray(last.page?.items)) invalid('Missing request page');
    items.push(...last.page.items);
    if (last.page.hasMore === false) return {...last, inspectedItems:items, allPagesRead:true};
    cursor = last.page.nextCursor;
    if (typeof cursor !== 'string' || !cursor || seen.has(cursor)) invalid('Invalid request continuation');
    seen.add(cursor);
  }
  throw new RoomError(413, 'formal_context_too_large', 'Request exceeds the listener page budget');
}

export function prepareFormalDelivery(context, output, stopReason) {
  if (!context.allPagesRead || context.page?.hasMore !== false || context.request?.status !== 'open'
    || context.viewerId !== context.request.recipientId) invalid('Complete open recipient context is required');
  let value;
  try {value = JSON.parse(output);} catch {return {kind:'pending', body:'The agent did not return an explicit answer or decline. This request remains open.'};}
  if (!value || Array.isArray(value) || Object.keys(value).some(key => !['outcome','body'].includes(key))
    || !['answered','declined','pending'].includes(value.outcome) || typeof value.body !== 'string'
    || !value.body.trim() || stopReason !== 'end_turn')
    return {kind:'pending', body:'The agent did not finish a valid response. This request remains open.'};
  const bodyLimit = value.outcome === 'pending' ? 4096 : MAX_FORMAL_RESPONSE_CHARS;
  if (value.body.length > bodyLimit) return pendingOverflow(context,value,'formal_body_too_long',value.body.length,bodyLimit);
  if (value.outcome === 'pending') return {kind:'pending', body:value.body};
  const recipes = (context.responseHttpActions ?? []).filter(action => action.command?.data?.responseOutcome === value.outcome);
  if (recipes.length !== 1) invalid('No unique current response recipe');
  const recipe = structuredClone(recipes[0]), data = recipe.command.data;
  if (recipe.method !== 'POST' || recipe.path !== `/api/rooms/${encodeURIComponent(context.roomId)}/commands`
    || recipe.command.type !== 'message.posted'
    || recipe.verify?.method !== 'GET'
    || recipe.verify.path !== `/api/rooms/${encodeURIComponent(context.roomId)}/reply-context?requestMessageId=${encodeURIComponent(context.request.id)}`
    || data.responseToRequestId !== context.request.id || data.replyToId !== context.request.id
    || data.expectedRequestRevision !== context.request.revision
    || data.contextEventId !== context.current?.contextEventId || data.contextSequence !== context.current?.contextSequence
    || data.toMemberId !== context.request.requesterId || !Object.hasOwn(data,'workItemId') || data.workItemId !== context.request.workItemId
    || typeof recipe.command.id !== 'string' || !recipe.command.id || typeof data.messageId !== 'string' || !data.messageId)
    invalid('Response recipe binding does not match the inspected request');
  data.body = value.body;
  const commandBytes = Buffer.byteLength(JSON.stringify(recipe.command));
  if (commandBytes > MAX_FORMAL_COMMAND_BYTES) return pendingOverflow(context,value,'formal_command_too_large',commandBytes,MAX_FORMAL_COMMAND_BYTES);
  return {kind:'formal', recipe};
}

export async function deliverFormal(room, delivery, listenerToken) {
  const requestId=delivery.recipe?.command?.data?.responseToRequestId;
  if (typeof requestId !== 'string' || delivery.recipe.path !== `/api/rooms/${encodeURIComponent(room.roomId)}/commands`
    || delivery.recipe.verify?.path !== `/api/rooms/${encodeURIComponent(room.roomId)}/reply-context?requestMessageId=${encodeURIComponent(requestId)}`)
    invalid('Saved response does not belong to this Room');
  await room.request(delivery.recipe.path, {body:delivery.recipe.command, listenerToken});
  const current = await room.request(delivery.recipe.verify.path);
  const data = delivery.recipe.command.data;
  if (current.roomId !== room.roomId || current.viewerId !== room.memberId
    || current.request?.id !== data.responseToRequestId || current.request.status !== data.responseOutcome
    || current.request.responseMessageId !== data.messageId) invalid('Exact saved response is not verified; reconcile without a new recipe');
  const selected=await room.thread(data.messageId,{selected:true}), message=selected.thread;
  if (message.authorId!==room.memberId || message.toMemberId!==data.toMemberId || message.replyToId!==requestId
    || (message.workItemId??null)!==data.workItemId || message.deletedAt || message.body!==data.body)
    throw new RoomError(409,'formal_response_changed','Saved response content or binding changed; inspect without repeating execution');
}

// Safe diagnostics only: never return the model output or arbitrary stop text.
// This classifier does not alter delivery, authorization, retries, or receipts.
export function classifyFormalOutput(output, stopReason) {
  const knownStops = new Set(['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled']);
  const stop = knownStops.has(stopReason) ? stopReason : 'other';
  const outputChars = typeof output === 'string' ? output.length : null;
  const result = reason => ({reason, stopReason:stop, outputChars});
  if (stopReason !== 'end_turn') return result('interrupted');
  let value;
  try { value = JSON.parse(output); } catch { return result('invalid_json'); }
  if (!value || Array.isArray(value) || typeof value !== 'object'
    || Object.keys(value).some(key => !['outcome','body'].includes(key))
    || !['answered','declined','pending'].includes(value.outcome)
    || typeof value.body !== 'string' || !value.body.trim()) return result('invalid_shape');
  if (value.body.length > 4096) return result('body_too_long');
  return result('valid');
}
