// One room-read window for the browser, REST agents, and MCP.
// The default GET /api/rooms/{id} and ?messages=recent are this window.
// ?full=1 is the retired unbounded document, and only while
// ROOM_SNAPSHOT_FULL_COMPAT=1. Older history pages through /messages.
import { messageRepository } from "./message-repository.mjs";
import { messageInHistory, eventInHistory } from "./history-visibility.mjs";
import { dmConsentEventVisible, dmEventVisibility } from "./dm-event-visibility.mjs";
import { peerEventVisible, visibleBonds } from "./bonds.mjs";
import { redactMessageTree, redactSnapshotState } from "./redact-read.mjs";
import { ServiceError } from "./service-error.mjs";

export const SNAPSHOT_WINDOW_MESSAGES = 100;
export const SNAPSHOT_WINDOW_BYTES = 30 * 1024;
// Short messages keep the count window. The byte cap sheds the audit tail
// before it sheds messages, and only then drops older messages.
const MESSAGE_BUDGET = 22 * 1024;

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };

export function messageSeqs(db, roomId, ids) {
  const seqs = new Map();
  for (let start = 0; start < ids.length; start += 256) {
    const slice = ids.slice(start, start + 256);
    if (!slice.length) continue;
    for (const row of db.prepare(`SELECT message_id AS messageId, seq FROM messages
      WHERE room_id=? AND message_id IN (SELECT value FROM json_each(?))`).all(roomId, JSON.stringify(slice))) {
      seqs.set(row.messageId, row.seq);
    }
  }
  return seqs;
}

export function messagesPageOf(messages, seqs, hasMore) {
  const oldest = messages[0];
  const before = oldest && seqs.has(oldest.id) ? seqs.get(oldest.id) : null;
  return { before, hasMore: Boolean(hasMore) };
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
  // event made the small window slower than the unbounded read.
  const events = slimEventBodies(state.eventLog ?? []);
  const baseState = { ...state, messages, eventLog: [] };
  const base = { ...snapshot, ...(messagesWindow ? { messagesWindow } : {}), state: baseState };
  const baseBytes = Buffer.byteLength(JSON.stringify(base));
  if (baseBytes >= maxBytes || events.length === 0) return base;
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
  let fitted = { ...base, state: { ...baseState, eventLog: chosen } };
  while (chosen.length > 0 && Buffer.byteLength(JSON.stringify(fitted)) > maxBytes) {
    chosen = chosen.slice(1);
    fitted = { ...base, state: { ...baseState, eventLog: chosen } };
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

export function readMessagePage(store, token, roomId, { before = null, limit = SNAPSHOT_WINDOW_MESSAGES, expectedSessionBinding = null } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SNAPSHOT_WINDOW_MESSAGES) fail(422, "invalid_snapshot_view", "Choose a page of at most 100 messages");
  if (before !== null && (!Number.isSafeInteger(before) || before < 0)) fail(422, "invalid_snapshot_view", "Choose a message cursor");
  return store.readTransaction(() => {
    const auth = store.authenticate(token, roomId, expectedSessionBinding);
    const room = store.room(roomId);
    const repository = messageRepository(store, roomId, room.state);
    const { dmMessageVisible } = viewerFilter(store, roomId, auth.member.id);
    const visible = [];
    for (const message of repository.records()) if (dmMessageVisible(message)) visible.push(message);
    const seqs = messageSeqs(store.db, roomId, visible.map(message => message.id));
    let end = visible.length;
    if (before !== null) {
      end = visible.findIndex(message => seqs.get(message.id) === before);
      if (end < 0) end = visible.filter(message => (seqs.get(message.id) ?? Infinity) < before).length;
    }
    const start = Math.max(0, end - limit);
    let messages = visible.slice(start, end).map(message => redactMessageTree(message));
    messages = takeNewestFitting(messages, MESSAGE_BUDGET);
    const oldest = messages[0];
    const pageBefore = oldest && seqs.has(oldest.id) ? seqs.get(oldest.id) : null;
    const hasMore = start > 0 || messages.length < (end - start);
    return {
      messagesVersion: 1,
      roomId,
      sequence: room.sequence,
      messages,
      messagesPage: { before: pageBefore, hasMore },
      viewerId: auth.member.id,
      viewerAccountId: auth.account?.id ?? null,
      viewerAuthEpoch: auth.account?.authEpoch ?? null,
      viewerSessionBinding: auth.sessionBinding,
      viewerSessionRevision: auth.sessionRevision ?? null
    };
  });
}
