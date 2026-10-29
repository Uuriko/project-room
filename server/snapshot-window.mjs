// One room-read window for the browser, REST agents, and MCP.
// The default GET /api/rooms/{id} and ?messages=recent are this window.
// ?full=1 is the retired unbounded document, and only while
// ROOM_SNAPSHOT_FULL_COMPAT=1. Older history pages through /messages.
import { messageSequences } from "./message-queries.mjs";
import { messageRepository } from "./message-repository.mjs";
import { messageInHistory, eventInHistory } from "./history-visibility.mjs";
import { dmConsentEventVisible, dmEventVisibility } from "./dm-event-visibility.mjs";
import { peerEventVisible, visibleBonds } from "./bonds.mjs";
import { redactMessageTree, redactSnapshotState } from "./redact-read.mjs";
import { ServiceError } from "./service-error.mjs";
import { readAgentOrientation } from "./agent-orientation.mjs";

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
export function readRoomSnapshot(store, token, roomId, fence, { view = "full", helpContext = false, offerContext = false, auditView = "full", windowed = false, visibility = null } = {}) {
  if (view === "orientation") {
    if (helpContext || offerContext || auditView !== "full" || windowed) fail(422, "invalid_snapshot_view", "Orientation does not accept snapshot context options");
    return readAgentOrientation(store, token, roomId, fence);
  }
  const snapshot = store.snapshot(token, roomId, fence, view, helpContext, offerContext, auditView, windowed ? SNAPSHOT_WINDOW_MESSAGES : null);
  if (view === "work") {
    delete snapshot.state.agentHalts;
    return snapshot;
  }
  const { dmMessageVisible, roomEventVisible, peerContext } = visibility ?? viewerFilter(store, roomId, snapshot.viewerId);
  const visibleMessages = (snapshot.state.messages ?? []).filter(dmMessageVisible);
  const visibleIds = new Set(visibleMessages.map(message => message.id));
  const shown = windowed ? visibleMessages.slice(-SNAPSHOT_WINDOW_MESSAGES) : visibleMessages;
  const nextState = {
    ...snapshot.state,
    messages: shown,
    eventLog: (snapshot.state.eventLog ?? []).filter(roomEventVisible),
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
