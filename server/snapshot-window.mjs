// One room-read window for the browser, REST agents, and MCP.
// The default GET /api/rooms/{id} and ?messages=recent are this window.
// ?full=1 is the retired unbounded document, and only while
// ROOM_SNAPSHOT_FULL_COMPAT=1. Older history pages through /messages.
import { isCurrentRoom, withCurrentReadContext,withCurrentWorkSummaryReuse,readCurrentRecord,readCurrentHistoryFloor,chargeCurrentReadBudget } from './current-room-repository.mjs';
import {readCurrentEventWindow} from './current-room-events.mjs';
import { readConversation } from './conversation-sync.mjs';
import { messageSequences } from "./message-queries.mjs";
import { messageRepository } from "./message-repository.mjs";
import { messageInHistory, eventInHistory } from "./history-visibility.mjs";
import { dmConsentEventVisible, dmEventVisibility } from "./dm-event-visibility.mjs";
import { peerEventVisible, visibleBonds } from "./bonds.mjs";
import { redactMessageTree, redactSnapshotState } from "./redact-read.mjs";
import { ServiceError } from "./service-error.mjs";
import { readAgentOrientation } from "./agent-orientation.mjs";
import { workRoleHolder } from "./work-context.mjs";

export const SNAPSHOT_WINDOW_MESSAGES = 100;
export const SNAPSHOT_WINDOW_BYTES = 30 * 1024;
// Short messages keep the count window. The byte cap sheds the audit tail
// before it sheds messages, and only then drops older messages.
const MESSAGE_BUDGET = 22 * 1024;

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };

export function messageSeqs(db, roomId, ids) {
  return messageSequences(db, roomId, ids);
}

export function messagesPageOf(messages, seqs, hasMore) {
  const oldest = messages[0];
  const before = oldest && seqs.has(oldest.id) ? seqs.get(oldest.id) : null;
  return { before, beforeId: before === null ? null : oldest.id, hasMore: Boolean(hasMore) };
}

// Newest items whose JSON fits in budget. One oversized item is kept so a
// window is never empty when the room has messages.
export function takeNewestFitting(items, budget) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const sizes = items.map(item => Buffer.byteLength(JSON.stringify(item)) + 1);
  let total = 2;
  let start = items.length;
  for (let i = items.length - 1; i >= 0; i--) {
    const next = total + sizes[i];
    if (start !== items.length && next > budget) break;
    total = next;
    start = i;
    if (next > budget) break;
  }
  return items.slice(start);
}

function slimEventBodies(events) {
  return events.map(event => {
    const data = event?.data;
    if (!data || typeof data !== "object" || !("body" in data)) return event;
    if (event.type !== "message.posted" && event.type !== "dm.posted") return event;
    const { body, ...rest } = data;
    return { ...event, data: rest };
  });
}

export function fitWindowedSnapshot(snapshot, { maxBytes = SNAPSHOT_WINDOW_BYTES, messageBudget = MESSAGE_BUDGET } = {}) {
  const state = { ...snapshot.state };
  const original = Array.isArray(state.messages) ? state.messages : [];
  const messages = takeNewestFitting(original, messageBudget);
  let messagesWindow = snapshot.messagesWindow ? { ...snapshot.messagesWindow } : null;
  const dropped = original.length - messages.length;
  if (messagesWindow && dropped > 0) {
    messagesWindow = { ...messagesWindow, limit: messages.length, omitted: (messagesWindow.omitted ?? 0) + dropped };
  }
  // Size the audit tail once. Re-encoding the whole snapshot per dropped
  // event made the small window slower than the unbounded read. Message
  // bodies stay on the tail while the snapshot fits; they are shed only
  // when that is what keeps the window inside the cap.
  const baseState = { ...state, messages, eventLog: [] };
  const base = { ...snapshot, ...(messagesWindow ? { messagesWindow } : {}), state: baseState };
  const raw = Array.isArray(state.eventLog) ? state.eventLog : [];
  const withBodies = fitEvents(base, raw, maxBytes);
  if (Buffer.byteLength(JSON.stringify(withBodies)) <= maxBytes) return withBodies;
  return fitEvents(base, slimEventBodies(raw), maxBytes);
}

function fitEvents(base, events, maxBytes) {
  const baseBytes = Buffer.byteLength(JSON.stringify(base));
  if (events.length === 0) return base;
  // The newest event always rides along: readers anchor on the audit tail's
  // last event, so an over-budget window still carries that one event.
  if (baseBytes >= maxBytes) return { ...base, state: { ...base.state, eventLog: events.slice(-1) } };
  const sizes = events.map(event => Buffer.byteLength(JSON.stringify(event)) + 1);
  let total = baseBytes;
  let start = events.length;
  for (let i = events.length - 1; i >= 0; i--) {
    const next = total + sizes[i];
    if (start !== events.length && next > maxBytes) break;
    total = next;
    start = i;
    if (next > maxBytes) break;
  }
  let chosen = events.slice(start);
  let fitted = { ...base, state: { ...base.state, eventLog: chosen } };
  while (chosen.length > 1 && Buffer.byteLength(JSON.stringify(fitted)) > maxBytes) {
    chosen = chosen.slice(1);
    fitted = { ...base, state: { ...base.state, eventLog: chosen } };
  }
  return fitted;
}

function viewerFilter(store, roomId, viewerId) {
  const historyFloor = store.historyFloor(roomId, viewerId);
  const historyMessages = historyFloor ? messageRepository(store, roomId) : null;
  const dmMessageVisible = message => messageInHistory(message, historyFloor)
    && (!message.toMemberId || message.authorId === viewerId || message.toMemberId === viewerId);
  const dmPartyVisible = dmEventVisibility(viewerId, store.room(roomId).state.messages, [], store.archivedDmPartiesReader(roomId));
  const dmEventVisible = event => eventInHistory(event, historyFloor, historyMessages) && dmPartyVisible(event);
  const peerContext = {
    memberId: viewerId,
    identityId: store.bonds.identityForMember(roomId, viewerId),
    isOwner: viewerId === store.room(roomId).state.room.ownerId
  };
  const roomEventVisible = event => dmEventVisible(event) && dmConsentEventVisible(event, viewerId, peerContext.isOwner)
    && peerEventVisible(event, peerContext);
  return { dmMessageVisible, roomEventVisible, peerContext };
}

// The member snapshot. windowed uses the shared message window and byte budget.
export function readRoomSnapshot(store, token, roomId, fence, { view = "full", helpContext = false, offerContext = false, auditView = "full", windowed = false, visibility = null, workCursor = null } = {}) {
  if (view === "orientation") {
    if (helpContext || offerContext || auditView !== "full" || windowed) fail(422, "invalid_snapshot_view", "Orientation does not accept snapshot context options");
    return readAgentOrientation(store, token, roomId, fence, {cursor:workCursor});
  }
  if (view === "full" && isCurrentRoom(store.db, roomId)) {
    if (!windowed || helpContext || !["full","activity"].includes(auditView))
      fail(409, "current_snapshot_selection_unavailable", "Use the bounded current room window and addressed detail reads");
    return store.readTransaction(() => withCurrentReadContext(store.db, roomId, b => {
      const auth = store.authenticate(token, roomId, fence);
      return withCurrentWorkSummaryReuse(store,roomId,auth.member.id,()=>{
      const overview = store.currentOverview(roomId, auth.member.id);
      const conversation = readConversation(store, token, roomId, { limit: 8, expectedSessionBinding: fence });
      const channelKeys=store.db.prepare("SELECT record_key FROM current_room_record_proofs WHERE room_id=? AND domain='channels' AND present=1 ORDER BY record_key LIMIT 51").all(roomId);
      if(channelKeys.length>50)fail(409,'current_channel_catalog_unavailable','Channel catalog exceeds the supported room limit');
      chargeCurrentReadBudget(b,channelKeys.reduce((n,row)=>n+Buffer.byteLength(row.record_key)+32,0),channelKeys.length);
      const channels=Object.create(null);for(const {record_key:id}of channelKeys){const channel=readCurrentRecord(store.db,roomId,'channels',id,b);if(!channel||channel.id!==id)throw Error('Current channel membership differs');Object.defineProperty(channels,id,{value:channel,enumerable:true});}
      const sourceAfter=Math.max(0,overview.sequence-16),eventPage=readCurrentEventWindow(store,roomId,auth.member.id,{after:sourceAfter,limit:16});
      const events=eventPage.events.map(row=>row.event),eventLog=auditView==='activity'?events.filter(e=>e.type==='decision.recorded'||/^(work\.|work_claim\.|verification\.|owner_decision\.)/.test(e.type)||e.data?.workItemId!==undefined):events;
      const cursor=store.db.prepare('SELECT sequence FROM cursors WHERE room_id=? AND member_id=?').get(roomId,auth.member.id)?.sequence??0;
      const floor=readCurrentHistoryFloor(store.db,roomId,auth.member.id,b),catchUpCursor=Math.max(cursor,floor?floor.sequence-1:0);
      const replyRequests=Object.create(null),requestIds=new Set(conversation.messages.flatMap(m=>[m.id,m.responseToRequestId]).filter(Boolean));
      for(const id of requestIds){const request=readCurrentRecord(store.db,roomId,'replyRequests',id,b);if(request&&[request.requesterId,request.recipientId].includes(auth.member.id))Object.defineProperty(replyRequests,id,{value:request,enumerable:true});}


      // This is explicitly a partial current view. Neither omitted counts nor
      // absent request/work records mean that the room contains no more work.
      return {
        snapshotVersion: 2, representation: "normalized-current-v1", roomId,
        sequence: overview.sequence, viewerId: auth.member.id,cursor,catchUpCursor,
        ...(auditView==='activity'?{auditView,auditVersion:1}:{}),
        viewerAccountId: auth.account?.id ?? null, viewerAuthEpoch: auth.account?.authEpoch ?? null,
        viewerSessionBinding: auth.sessionBinding, viewerSessionRevision: auth.sessionRevision ?? null,
        state: { ...overview.state,channels,eventLog,replyRequests, messages: conversation.messages,
          pins:(overview.state.pins??[]).filter(pin=>conversation.messages.some(message=>message.id===pin.messageId&&!message.deletedAt&&message.body!=null)) },
        pinsWindow:{complete:false,coverage:'visible-conversation-records',nextRead:{method:'GET',path:`/api/rooms/${encodeURIComponent(roomId)}/pins`}},
        channelsWindow:{complete:true,shown:channelKeys.length},
        eventsWindow:{complete:sourceAfter===0,after:sourceAfter,examinedThrough:eventPage.next,hasOlder:sourceAfter>0,olderAfter:sourceAfter>0?Math.max(0,sourceAfter-16):null,sourceLimit:16},
        messagesWindow: { mode: "recent", omitted: null, complete: conversation.nextCursor === null },
        messagesPage: { cursor: conversation.nextCursor, hasMore: conversation.nextCursor !== null, contractVersion: 2, limit: 8 },
        workWindow: overview.workWindow,
        sections: { assistant:{available:true,coverage:'selected-run-window',maxRuns:100},requestRuns:{available:false,code:'current_request_runs_unavailable'},notifications:{available:false,code:'current_notification_aggregate_unavailable'},updates:{available:false,replacement:'needs-me',nextRead:{method:'GET',path:`/api/rooms/${encodeURIComponent(roomId)}/needs-me`}},returnBrief:{available:true,coverage:'visible-history-window',sourceLimit:16},files:{available:true,coverage:'selected-messages',complete:false},fileUploads:{available:true}, helpOffers: { available: false, code: "current_help_offers_unavailable" }, replyRequests: { available: true,complete:false,coverage:"visible-conversation-records", nextRead: { tool: "room_list_requests", arguments: { direction: "incoming", status: "open" } } } }
      };
      });
    }, { maxRecords: 1024 }));
  }
  // #4265: the non-windowed form is the explicit full-history contract (the
  // compat ?full=1 read; the work view returns before the messages branch),
  // so it opts in to full history at the store. The windowed default passes
  // no opt-in and stays bounded.
  const snapshot = store.snapshot(token, roomId, fence, view, helpContext, offerContext, auditView, windowed ? SNAPSHOT_WINDOW_MESSAGES : null, !windowed, workCursor);
  if (view === "work") {
    delete snapshot.state.agentHalts;
    return snapshot;
  }
  const { dmMessageVisible, roomEventVisible, peerContext } = visibility ?? viewerFilter(store, roomId, snapshot.viewerId);
  const visibleMessages = (snapshot.state.messages ?? []).filter(dmMessageVisible);
  const visibleIds = new Set(visibleMessages.map(message => message.id));
  const shown = windowed ? visibleMessages.slice(-SNAPSHOT_WINDOW_MESSAGES) : visibleMessages;
  // Request metadata is private conversation state too, independent of whether
  // its opening message still fits in the recent window. Match selected/list
  // request visibility without changing canonical state or historical events.
  const historyFloor = store.historyFloor(roomId, snapshot.viewerId);
  // F-S8a-5: work items carrying a reply request are private to that
  // request's parties on this full read too (bootstrap and the HTTP
  // room read serialise from here). Compute parties from the
  // unfiltered request set before it is narrowed to the viewer below;
  // a member party to any request on an item keeps its full record.
  // The store snapshot already applies this; repeating it here keeps
  // the boundary at this serialiser even if a snapshot source changes.
  // The exception matches every other read site: a member the item
  // itself names in a work role (proposer, accountable, verifier,
  // human decision maker, or claim holder) keeps its full record —
  // a private request on the item must not lock them out of it.
  const privatePartiesByWork = new Map();
  for (const request of Object.values(snapshot.state.replyRequests ?? {})) {
    if (!request?.workItemId) continue;
    if (!privatePartiesByWork.has(request.workItemId)) privatePartiesByWork.set(request.workItemId, new Set());
    privatePartiesByWork.get(request.workItemId).add(request.requesterId).add(request.recipientId);
  }
  const workItemsForViewer = (itemId, item) => {
    const parties = privatePartiesByWork.get(itemId);
    return parties && !parties.has(snapshot.viewerId) && !workRoleHolder(item, snapshot.viewerId);
  };
  const workItems = snapshot.state.workItems ? Object.fromEntries(Object.entries(snapshot.state.workItems).map(([id, item]) =>
    workItemsForViewer(id, item) ? [id, { ...item, title: null, definitionOfDone: null }] : [id, item])) : snapshot.state.workItems;
  const replyRequests = Object.fromEntries(Object.entries(snapshot.state.replyRequests ?? {}).filter(([, request]) =>
    [request.requesterId, request.recipientId].includes(snapshot.viewerId)
    && messageInHistory({ id: request.id, createdAt: request.createdAt }, historyFloor)));
  const nextState = {
    ...snapshot.state,
    ...(snapshot.state.workItems === undefined ? {} : { workItems }),
    messages: shown,
    ...(snapshot.state.replyRequests === undefined ? {} : { replyRequests }),
    eventLog: (snapshot.state.eventLog ?? []).filter(roomEventVisible).map(event => {
      const workItemId = event?.data?.workItemId;
      if (typeof workItemId !== "string" || !workItemsForViewer(workItemId, snapshot.state.workItems?.[workItemId])) return event;
      if (!Object.hasOwn(event.data, "title") && !Object.hasOwn(event.data, "definitionOfDone")) return event;
      return { ...event, data: { ...event.data,
        ...(Object.hasOwn(event.data, "title") ? { title: null } : {}),
        ...(Object.hasOwn(event.data, "definitionOfDone") ? { definitionOfDone: null } : {}) } };
    }),
    pins: windowed ? snapshot.state.pins ?? [] : (snapshot.state.pins ?? []).filter(pin => visibleIds.has(pin.messageId))
  };
  if (snapshot.state.bonds) nextState.bonds = visibleBonds(snapshot.state.bonds, peerContext);
  snapshot.state = redactSnapshotState(nextState);
  if (!windowed) return snapshot;
  const fitted = fitWindowedSnapshot(snapshot);
  const messages = fitted.state.messages ?? [];
  const seqs = messageSeqs(store.db, roomId, messages.map(message => message.id));
  return {
    ...fitted,
    messagesPage: messagesPageOf(messages, seqs, (fitted.messagesWindow?.omitted ?? 0) > 0)
  };
}

export function readMessagePage(store, token, roomId, { before = null, beforeId = null, limit = SNAPSHOT_WINDOW_MESSAGES, expectedSessionBinding = null } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SNAPSHOT_WINDOW_MESSAGES) fail(422, "invalid_snapshot_view", "Choose a page of at most 100 messages");
  if (before !== null && (!Number.isSafeInteger(before) || before < 0)) fail(422, "invalid_snapshot_view", "Choose a message cursor");
  if (beforeId !== null && (before === null || typeof beforeId !== "string" || !beforeId || beforeId.length > 256)) fail(422, "invalid_snapshot_view", "Choose a valid message cursor");
  return store.readTransaction(() => {
    const auth = store.authenticate(token, roomId, expectedSessionBinding);
    const room = store.room(roomId);
    const repository = messageRepository(store, roomId, room.state);
    // Seek from the sequence cursor and stop after one page plus a lookahead.
    // Filter archive visibility in SQL so private history does not require
    // decoding unrelated message bodies. The working set keeps authority.
    const selected = [];
    for (const message of repository.records({ descending: true, beforeSequence: before, beforeId,
      visibility: { viewerId: auth.member.id, floor: store.historyFloor(roomId, auth.member.id) } })) {
      selected.push(message);
      if (selected.length > limit) break;
    }
    const candidates = selected.slice(0, limit).reverse().map(message => redactMessageTree(message));
    const messages = takeNewestFitting(candidates, MESSAGE_BUDGET);
    const seqs = messageSeqs(store.db, roomId, messages.map(message => message.id));
    const oldest = messages[0];
    const pageBefore = oldest && seqs.has(oldest.id) ? seqs.get(oldest.id) : null;
    const hasMore = selected.length > limit || messages.length < candidates.length;
    return {
      messagesVersion: 1,
      roomId,
      sequence: room.sequence,
      messages,
      messagesPage: { before: pageBefore, beforeId: pageBefore === null ? null : oldest.id, hasMore },
      viewerId: auth.member.id,
      viewerAccountId: auth.account?.id ?? null,
      viewerAuthEpoch: auth.account?.authEpoch ?? null,
      viewerSessionBinding: auth.sessionBinding,
      viewerSessionRevision: auth.sessionRevision ?? null
    };
  });
}
