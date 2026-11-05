// Addressed authority for local runtimes. Never reads conversation or task bodies.
import { isCurrentRoom, withCurrentReadContext, readCurrentHead, readCurrentRecord } from './current-room-repository.mjs';
import { validId, ownMember } from '../src/events.js';
import { ServiceError } from './service-error.mjs';

export const MAX_AUTHORITY_MEMBERS = 64;
const fields = ['id', 'kind', 'active', 'revision', 'identityId', 'accountId', 'accountableHumanId'];

export function readRoomAuthorityView(store, token, roomId, requestedMemberIds = [], expectedSessionBinding = null) {
  if (!Array.isArray(requestedMemberIds) || requestedMemberIds.length > MAX_AUTHORITY_MEMBERS
      || requestedMemberIds.some(id => !validId(id))) {
    throw new ServiceError(422, 'invalid_snapshot_view', 'Choose at most 64 exact member IDs for the authority view');
  }
  const requested = [...new Set(requestedMemberIds)].sort();
  return store.readTransaction(() => withCurrentReadContext(store.db, roomId, budget => {
    const auth = store.authenticate(token, roomId, expectedSessionBinding);
    const current = isCurrentRoom(store.db, roomId);
    const legacy = current ? null : store.roomAuthority(roomId);
    const head = current ? readCurrentHead(store.db, roomId, budget) : null;
    const room = current ? readCurrentRecord(store.db, roomId, 'metadata', 'room', budget) : { ownerId: legacy.ownerId };
    if (!room || !validId(room.ownerId)) throw Error('current_room_corrupt: missing selected owner authority');

    const selected = [...new Set([auth.member.id, room.ownerId, ...requested])].sort();
    const members = Object.create(null), unresolved = [];
    for (const id of selected) {
      const member = current ? readCurrentRecord(store.db, roomId, 'members', id, budget) : ownMember(legacy.members, id);
      if (member === undefined) { unresolved.push(id); continue; }
      if (member.id !== id) throw Error('current_room_corrupt: selected authority identity differs');
      // Field selection follows full record proof, never an unverified scalar read.
      Object.defineProperty(members, id, {
        value: Object.fromEntries(fields.filter(key => Object.hasOwn(member, key)).map(key => [key, member[key]])),
        enumerable: true,
      });
    }
    if (!ownMember(members, room.ownerId) || !ownMember(members, auth.member.id)) {
      throw Error('current_room_corrupt: selected principal authority is missing');
    }
    const result = {
      snapshotView: 'authority', snapshotVersion: 1, roomId, viewerId: auth.member.id,
      sequence: head?.sequence ?? legacy.sequence,
      authoritySelection: { complete: true, requestedMemberIds: requested, unresolvedMemberIds: unresolved },
      state: { room: { ownerId: room.ownerId }, members },
    };
    if (Buffer.byteLength(JSON.stringify(result)) > 128 * 1024) {
      throw new ServiceError(409, 'current_room_context_unavailable', 'Selected authority exceeds the response budget; choose fewer members');
    }
    return result;
  }, { maxRecords: 512 }));
}
