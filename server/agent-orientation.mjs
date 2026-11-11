import {isCurrentRoom} from './current-room-repository.mjs';
import {readCurrentWorkSnapshot} from './current-work-snapshot.mjs';
import { charterContext } from "../src/room-charter.js";
import { currentWorkRecord, workRoleHolder } from "./work-context.mjs";

// Default SDK orientation includes full current evidence records and bounded
// handoff history. Keep that contract separate from the current-only work view.
function orientationRecord(item) {
  const record = currentWorkRecord(item);
  for (const key of ["claim", "receipt", "verification", "decision", "blocker", "handoff", "handoffHistory"]) {
    if (Object.hasOwn(item, key)) record[key] = structuredClone(item[key]);
    else delete record[key];
  }
  return record;
}

export function readAgentOrientation(store, token, roomId, fence, {cursor=null}={}) {
  if(isCurrentRoom(store.db,roomId))return readCurrentWorkSnapshot(store,token,roomId,{expectedSessionBinding:fence,view:'orientation',cursor});
  return store.readTransaction(() => {
    const auth = store.authenticate(token, roomId, fence);
    const room = store.withIdentityRevoked(roomId, store.workProjection(roomId));
    const privatePartiesByWork = store.privateWorkParties(roomId);
    const recordForViewer = (id, item) => {
      const parties = privatePartiesByWork.get(id);
      return orientationRecord(!parties || parties.has(auth.member.id) || workRoleHolder(item, auth.member.id)
        ? item : { ...item, title: null, definitionOfDone: null });
    };
    return {
      snapshotView: "orientation", snapshotVersion: 1, roomId, sequence: room.sequence,
      state: { room: room.state.room, members: room.state.members,
        workItems: Object.fromEntries(Object.entries(room.state.workItems).map(([id, item]) => [id, recordForViewer(id, item)])) },
      charter: charterContext(room.state.room), viewerId: auth.member.id,
      viewerAccountId: auth.account?.id ?? null, viewerAuthEpoch: auth.account?.authEpoch ?? null,
      viewerSessionBinding: auth.sessionBinding, viewerSessionRevision: auth.sessionRevision ?? null
    };
  });
}
