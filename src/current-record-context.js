import { uiText } from "./strings.js";
// Internal reducer dependency channel. Never persisted or carried in state,
// client commands, events, grants or a synthetic map member. The store binds
// counts independently qualified by its current-format head receipt. Recovery
// may additionally bind scoped point readers over its own prior reducer fold;
// no callback or context is serialized, supplied by a client or a grant.
const contexts = new WeakMap();
export function bindCurrentRecordContext(state, { replyRequestCount, replyOwner, replyRootChannel, claimOverlaps }) {
  if (!Number.isSafeInteger(replyRequestCount) || replyRequestCount < 0)
    throw Error('invalid_current_reply_request_count');
  if ([replyOwner, replyRootChannel, claimOverlaps].some(value => value !== undefined && typeof value !== 'function'))
    throw Error('invalid_current_replay_reader');
  contexts.set(state, Object.freeze({ replyRequestCount, replyOwner, replyRootChannel, claimOverlaps }));
}
export function inheritCurrentRecordContext(previous, next) {
  const context=contexts.get(previous);if(context)contexts.set(next,context);
}
export const currentRecordReplyCount = state => contexts.get(state)?.replyRequestCount;

export function currentRecordReplyOwner(state,messageId) {
 const value=contexts.get(state)?.replyOwner?.(messageId);
 if(value!==undefined&&value!==null&&(typeof value!=='string'||!value))throw Error(uiText("currentRoom.invalidReplyOwner"));
 return value;
}
export function currentRecordReplyRootChannel(state,messageId) {
 const value=contexts.get(state)?.replyRootChannel?.(messageId);
 if(value!==undefined&&(typeof value!=='string'||!value))throw Error(uiText("currentRoom.invalidReplyChannel"));
 return value;
}

export function currentRecordClaimOverlaps(state, workItemId, repository, paths, at) {
 const value=contexts.get(state)?.claimOverlaps?.(workItemId,repository,paths,at);
 if(value!==undefined&&(!Array.isArray(value)||value.length>10||value.some(item=>!item||typeof item.workItemId!=='string'||typeof item.holderId!=='string'||!Array.isArray(item.paths)||item.paths.length<1||item.paths.length>16||item.paths.some(path=>typeof path!=='string'))))throw Error(uiText("currentRoom.invalidClaimOverlaps"));
 return value;
}
