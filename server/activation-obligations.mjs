// A bounded discovery projection, not a queue, assignment or execution grant.
import {addressedWorkWindow, addressedRequestWindow} from './current-work-list.mjs';
import {readCurrentRecord, readCurrentHead, withCurrentReadContext} from './current-room-repository.mjs';
import {nextWorkStep, workActions} from '../src/workflow.js';

import {messageInHistory} from './history-visibility.mjs';

export const obligationOrder = (a,b) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)) || String(a.kind ?? 'work').localeCompare(String(b.kind ?? 'work'));
export function activationRequests(requests, viewerId, floor) {
  return requests.filter(r => r.status === 'open' && r.recipientId === viewerId && messageInHistory({id:r.id,createdAt:r.createdAt},floor))
    .map(r => ({id:r.id, kind:'request', title:'Reply requested', reason:'reply_requested', nextRead:{tool:'room_read_request',arguments:{requestMessageId:r.id}}}));
}

const REQUIRED_ACTION = {accept: 'accept', start: 'start', claim: 'claim', revise: 'resolve', verify: 'verify', decide: 'decide'};
export function activationObligations(items, member, ownerId, now) {
  if (!member || member.active === false) return [];
  return items.flatMap(item => {
    const next = nextWorkStep(item, now, ownerId);
    if (next.memberId !== member.id || (!next.needsAttention && next.action !== 'in_progress')) return [];
    // Thin native summaries omit dependencies. Selected reads resolve waiting vs ready;
    // never infer executable start/claim readiness from this bounded projection.
    const required = REQUIRED_ACTION[next.action];
    const permitted = !required || workActions(item, member, now).some(([action]) => action === required);
    return [{id: item.id, title: item.title, reason: !permitted ? 'permission_required' : ['claim','start'].includes(next.action) ? 'check_prerequisites' : next.action,
      nextRead: {tool: 'room_read_work', arguments: {workItemId: item.id, ...(['verify','decide'].includes(next.action) && permitted ? {brief: true, includeResult: true} : {})}}}];
  }).sort(obligationOrder);
}

export function currentActivationObligations(store, roomId, viewerId) {
  return store.readTransaction(() => withCurrentReadContext(store.db, roomId, b => {
    const room = readCurrentRecord(store.db, roomId, 'metadata', 'room', b);
    const member = readCurrentRecord(store.db, roomId, 'members', viewerId, b);
    const source = addressedWorkWindow(store, roomId, viewerId, room.ownerId, '', 4, b);
    const requests = addressedRequestWindow(store, roomId, viewerId, '', 4, b);
    const floor = store.historyFloor(roomId, viewerId, readCurrentHead(store.db,roomId).sequence);
    const items = [...activationObligations(source.items, member, room.ownerId, store.now()),
      ...(member?.active === false ? [] : activationRequests(requests.requests, viewerId, floor))].sort(obligationOrder);
    return {items, complete: !source.hasMore && !requests.hasMore};
  }, {maxRecords: 512}));
}
