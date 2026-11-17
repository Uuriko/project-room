import { activationObligations } from "./activation-obligations.mjs";
import { conversationCursorCodec } from "./conversation-sync.mjs";
import { addressedWorkWindow } from "./current-work-list.mjs";
import {
  CurrentReadBudgetExceeded, currentVisibleHorizon, isCurrentRoom, readCurrentHead,
  readCurrentRecord, readCurrentWorkPrivacy, withCurrentReadContext
} from "./current-room-repository.mjs";
import { ServiceError } from "./service-error.mjs";
import { readWorkItems } from "./work-repository.mjs";
import { workRoleHolder } from "./work-context.mjs";

const PAGE_SIZE = 4;
const MAX_BYTES = 16 * 1024;
const LEGACY_PROJECTION_BYTES = 256 * 1024;
const CURSOR_ERRORS = new Set([
  "invalid_reply_cursor", "reply_cursor_identity_changed", "stale_reply_cursor"
]);

const read = (roomId, source, cursor) => ({
  tool: "room_next", arguments: { roomId, source, ...(cursor ? { cursor } : {}) }
});
const unavailable = (roomId, source, reason, nextRead = read(roomId, source)) => ({
  coverage: "unavailable", reason, items: [], nextRead
});

export function validRoomNextSelection({ source, cursor }) {
  return (source === undefined || source === "work" || source === "requests")
    && (cursor === undefined || source !== undefined && typeof cursor === "string"
      && /^[A-Za-z0-9_-]{1,4096}$/.test(cursor));
}

function cursorBinding(auth, roomId, source, head) {
  return {
    kind: "room_next_v1", roomId, source, viewerId: auth.member.id, head,
    credential: auth.credentialHash ?? null, session: auth.sessionBinding ?? null,
    authEpoch: auth.account?.authEpoch ?? null, sessionRevision: auth.sessionRevision ?? null,
    permissions: [...auth.member.permissions].sort()
  };
}

function pageCursor(store, binding, cursor) {
  const codec = conversationCursorCodec(store);
  const previous = cursor ? codec.decode(cursor) : null;
  if (cursor && (!previous || typeof previous.after !== "string" || !Number.isSafeInteger(previous.at)
    || Object.keys(binding).some(key => JSON.stringify(binding[key]) !== JSON.stringify(previous[key]))))
    return null;
  const at = previous?.at ?? store.now();
  return { after: previous?.after ?? "", at, encode: after => codec.encode({ ...binding, at, after }) };
}

function workRows(items, auth, room, roomId, now) {
  const byId = new Map(items.map(item => [item.id, item]));
  return activationObligations(items, auth.member, room.ownerId, now).map(row => ({
    id: row.id, title: row.title.slice(0, 160), revision: byId.get(row.id).revision,
    reason: row.reason,
    nextRead: { tool: row.nextRead.tool, arguments: {
      roomId, brief: true, ...row.nextRead.arguments, ...(row.reason === "revise" ? { includeDiscussion: false } : {})
    } }
  }));
}

function workPage(store, roomId, auth, room, cursor) {
  const { db } = store;
  return withCurrentReadContext(db, roomId, budget => {
    const head = readCurrentHead(db, roomId, budget);
    const position = pageCursor(store, cursorBinding(auth, roomId, "work", head.head_sha256), cursor);
    if (!position) return unavailable(roomId, "work", "cursor_changed");

    const window = addressedWorkWindow(store, roomId, auth.member.id, room.ownerId,
      position.after, PAGE_SIZE, budget);
    const visible = window.items.filter(item => {
      const privacy = readCurrentWorkPrivacy(db, roomId, item.id, budget);
      return !privacy.requests || Object.hasOwn(privacy.parties, auth.member.id) || workRoleHolder(item, auth.member.id);
    });
    return {
      coverage: window.hasMore ? "partial" : "complete",
      evaluatedThrough: currentVisibleHorizon(store, roomId, auth.member.id, head.sequence),
      items: workRows(visible, auth, room, roomId, position.at),
      nextRead: window.hasMore ? read(roomId, "work", position.encode(window.after)) : null
    };
  }, { maxRecords: 512 });
}

function legacyWorkPage(store, roomId, auth, room, cursor) {
  const position = pageCursor(store, cursorBinding(auth, roomId, "work", room.sequence), cursor);
  if (!position) return unavailable(roomId, "work", "cursor_changed");
  // Legacy work can be inline or referenced. Bound the containing projection
  // before opening it in SQLite and hydrate only the selected keys.
  const rows = store.db.prepare(`SELECT item.key FROM rooms, json_each(rooms.projection, '$.workItems') AS item
    WHERE rooms.id=? AND item.key COLLATE BINARY>? ORDER BY item.key COLLATE BINARY LIMIT ?`)
    .all(roomId, position.after, PAGE_SIZE + 1);
  const ids = rows.slice(0, PAGE_SIZE).map(row => row.key);
  const parties = store.privateWorkParties(roomId, { workIds: ids });
  const visible = [...readWorkItems(store.db, roomId, ids).values()].filter(item => {
    const allowed = parties.get(item.id);
    return !allowed || allowed.has(auth.member.id) || workRoleHolder(item, auth.member.id);
  });
  const more = rows.length > PAGE_SIZE;
  return {
    coverage: more ? "partial" : "complete",
    items: workRows(visible, auth, room, roomId, position.at),
    nextRead: more ? read(roomId, "work", position.encode(ids.at(-1))) : null
  };
}

function requestRows(requests, roomId) {
  return requests.map(row => ({
    id: row.id, revision: row.revision,
    nextRead: { tool: "room_read_request", arguments: { roomId, requestMessageId: row.id } }
  }));
}

function legacyRequestPage(store, secret, roomId, auth, room, cursor) {
  const position = pageCursor(store, cursorBinding(auth, roomId, "requests", room.sequence), cursor);
  if (!position) return unavailable(roomId, "requests", "cursor_changed");
  const page = store.replyRequests.list(secret, roomId, {
    direction: "incoming", status: "open", expectedSessionBinding: auth.sessionBinding
  });
  const rows = page.requests.filter(row => row.id > position.after).sort((a, b) => a.id < b.id ? -1 : 1);
  const selected = rows.slice(0, PAGE_SIZE);
  const more = rows.length > selected.length;
  return {
    coverage: more ? "partial" : "complete", evaluatedThrough: page.evaluatedThrough,
    items: requestRows(selected, roomId),
    nextRead: more ? read(roomId, "requests", position.encode(selected.at(-1).id)) : null
  };
}

function requestPage(store, secret, roomId, auth, cursor) {
  // Keep the canonical request reader's current-per-page semantics while
  // fencing permission changes the native request cursor does not bind.
  const position = pageCursor(store, cursorBinding(auth, roomId, "requests", null), cursor);
  if (!position) return unavailable(roomId, "requests", "cursor_changed");
  const page = store.replyRequests.list(secret, roomId, {
    direction: "incoming", status: "open", limit: PAGE_SIZE,
    expectedSessionBinding: auth.sessionBinding, ...(position.after ? { cursor: position.after } : {})
  });
  if (page.viewerId !== auth.member.id || page.roomId !== roomId)
    throw new ServiceError(403, "no_access", "Room request viewer changed");
  return {
    coverage: page.sourceWindow.complete ? "complete" : "partial",
    evaluatedThrough: page.evaluatedThrough,
    evaluationScope: page.evaluationScope,
    items: requestRows(page.requests, roomId),
    nextRead: page.page.nextCursor ? read(roomId, "requests", position.encode(page.page.nextCursor)) : null
  };
}

function boundedPage(roomId, source, getPage) {
  try { return getPage(); }
  catch (error) {
    if (error instanceof CurrentReadBudgetExceeded) return unavailable(roomId, source, "read_budget_exceeded");
    if (error instanceof ServiceError && CURSOR_ERRORS.has(error.code))
      return unavailable(roomId, source, "cursor_changed");
    throw error;
  }
}

export function readRoomNext(store, secret, roomId, { source, cursor } = {}) {
  if (!validRoomNextSelection({ source, cursor }))
    throw new ServiceError(422, "invalid_arguments", "Choose a source and its returned cursor");
  return store.readTransaction(() => {
    const auth = store.authenticate(secret, roomId);
    const packet = { contractVersion: 1, roomId, viewerId: auth.member.id };
    const includeWork = source !== "requests", includeRequests = source !== "work";
    const current = isCurrentRoom(store.db, roomId);
    const room = current
      ? withCurrentReadContext(store.db, roomId, budget => readCurrentRecord(store.db, roomId, "metadata", "room", budget))
      : store.db.prepare(`SELECT sequence, length(CAST(projection AS BLOB)) AS bytes,
          json_extract(projection,'$.room.ownerId') AS ownerId, json_extract(projection,'$.room.purpose') AS purpose,
          json_extract(projection,'$.room.charter') AS charter FROM rooms WHERE id=?`).get(roomId);
    const charter = current ? room.charter : JSON.parse(room.charter ?? "null");
    packet.goal = String(charter?.purpose ?? room.purpose ?? "").slice(0, 800);
    packet.charterRevision = charter?.revision ?? null;

    if (!current && room.bytes > LEGACY_PROJECTION_BYTES) {
      if (includeWork) packet.work = unavailable(roomId, "work", "legacy_projection_budget",
        { tool: "room_activation_pack", arguments: { roomId, view: "brief" } });
      if (includeRequests) packet.requests = unavailable(roomId, "requests", "legacy_projection_budget",
        { tool: "room_list_requests", arguments: { roomId, direction: "incoming", status: "open" } });
    } else {
      if (includeWork) packet.work = boundedPage(roomId, "work", () => current
        ? workPage(store, roomId, auth, room, cursor) : legacyWorkPage(store, roomId, auth, room, cursor));
      if (includeRequests) packet.requests = boundedPage(roomId, "requests", () => current
        ? requestPage(store, secret, roomId, auth, cursor) : legacyRequestPage(store, secret, roomId, auth, room, cursor));
    }
    if (Buffer.byteLength(JSON.stringify(packet)) > MAX_BYTES)
      throw new ServiceError(409, "current_room_context_unavailable", "Read one source at a time");
    return packet;
  });
}
