// A bounded discovery projection, not a queue, assignment or execution grant.
import {addressedWorkWindow} from './current-work-list.mjs';
import {readCurrentRecord, withCurrentReadContext} from './current-room-repository.mjs';
import {nextWorkStep, workActions} from '../src/workflow.js';

const REQUIRED_ACTION = {accept: 'accept', start: 'start', claim: 'claim', revise: 'resolve', verify: 'verify', decide: 'decide'};
export function activationObligations(items, member, ownerId, now) {
  if (!member || member.active === false) return [];
  return items.flatMap(item => {
    const next = nextWorkStep(item, now, ownerId);
    if (next.memberId !== member.id || (!next.needsAttention && next.action !== 'in_progress')) return [];
    const required = REQUIRED_ACTION[next.action];
    const permitted = !required || workActions(item, member, now).some(([action]) => action === required);
    return [{id: item.id, title: item.title, reason: permitted ? next.action : 'permission_required',
      nextRead: {tool: 'room_read_work', arguments: {workItemId: item.id, ...(next.action === 'verify' && permitted ? {brief: true, includeResult: true} : {})}}}];
  }).sort((a,b) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)));
}

export function currentActivationObligations(store, roomId, viewerId) {
  return store.readTransaction(() => withCurrentReadContext(store.db, roomId, b => {
    const room = readCurrentRecord(store.db, roomId, 'metadata', 'room', b);
    const member = readCurrentRecord(store.db, roomId, 'members', viewerId, b);
    const source = addressedWorkWindow(store, roomId, viewerId, room.ownerId, '', 4, b);
    return {items: activationObligations(source.items, member, room.ownerId, store.now()), complete: !source.hasMore};
  }, {maxRecords: 512}));
}
