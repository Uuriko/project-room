import { activationObligations } from "./activation-obligations.mjs";
import { PICKUP_LEASE_HOURS, rankReadyWorkInRoom } from "./available-work.mjs";
import { readWantsWork } from "./work-wants.mjs";
import { conversationCursorCodec } from "./conversation-sync.mjs";
import { addressedWorkWindow } from "./current-work-list.mjs";
import {
  CurrentReadBudgetExceeded, currentVisibleHorizon, isCurrentRoom, readCurrentHead,
  readCurrentRecord, readCurrentWorkItem, readCurrentWorkPrivacy, withCurrentReadContext
} from "./current-room-repository.mjs";
import { ServiceError } from "./service-error.mjs";
import { readWorkItems } from "./work-repository.mjs";
import { workRoleHolder } from "./work-context.mjs";

const PAGE_SIZE = 4;
const WORK_SEARCH_WINDOWS = 4;
const LEGACY_WORK_SEARCH_LIMIT = 48;
const CORRECTION_CHARS = 400;
const CORRECTION_FIELD_BYTES = 650;
const MAX_BYTES = 16 * 1024;
const LEGACY_WORK_BYTES = 256 * 1024;
const LEGACY_REQUEST_BYTES = 1024 * 1024;
const CURSOR_ERRORS = new Set([
  "invalid_reply_cursor", "reply_cursor_identity_changed", "stale_reply_cursor"
]);

const read = (roomId, source, cursor) => ({
  tool: "room_next", arguments: { roomId, source, ...(cursor ? { cursor } : {}) }
});
const unavailable = (roomId, source, reason, nextRead = read(roomId, source)) => ({
  coverage: "unavailable", reason, items: [], nextRead
});

export function validRoomNextSelection({ source, cursor, view }) {
  return (view === undefined || view === "pickup")
    && (source === undefined || source === "work" || source === "requests")
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

function correctionText(text) {
  let bounded = text.slice(0, CORRECTION_CHARS);
  while (Buffer.byteLength(JSON.stringify(bounded)) > CORRECTION_FIELD_BYTES)
    bounded = bounded.slice(0, Math.floor(bounded.length / 2));
  return bounded;
}

function correctionPreview(blocker) {
  if (typeof blocker?.reason !== "string" || typeof blocker.nextAction !== "string") return {};
  const reason = correctionText(blocker.reason), nextAction = correctionText(blocker.nextAction);
  return { correction: { reason, nextAction,
    truncated: reason !== blocker.reason || nextAction !== blocker.nextAction } };
}

function workRows(items, auth, room, roomId, now, blockerFor) {
  const byId = new Map(items.map(item => [item.id, item]));
  return activationObligations(items, auth.member, room.ownerId, now).map(row => {
    const item = byId.get(row.id);
    return {
      id: row.id, title: row.title.slice(0, 160), revision: item.revision, reason: row.reason,
      ...(row.reason === "revise" ? correctionPreview(blockerFor(item)) : {}),
      nextRead: row.reason === "verify" && item.receipt?.eventId
        ? { tool: "room_read_result", arguments: { roomId, workItemId: item.id, completionEventId: item.receipt.eventId } }
        : { tool: row.nextRead.tool, arguments: {
          roomId, brief: true, ...row.nextRead.arguments, ...(row.reason === "revise" ? { includeDiscussion: false } : {})
        } }
    };
  });
}

// Scan past empty source windows within the same observed head and budget.
// Advance only across examined keys. A capped search still exposes its cursor.
function scanWorkPage(roomId, position, loadWindow, rowsFor) {
  let after = position.after, hasMore = false, items = [];
  for (let n = 0; n < WORK_SEARCH_WINDOWS; n++) {
    const window = loadWindow(after);
    after = window.after;
    hasMore = window.hasMore;
    items = rowsFor(window.items);
    if (items.length || !hasMore) break;
  }
  return { coverage: hasMore ? "partial" : "complete", items,
    nextRead: hasMore ? read(roomId, "work", position.encode(after)) : null };
}

function workPage(store, roomId, auth, room, cursor) {
  const { db } = store;
  return withCurrentReadContext(db, roomId, budget => {
    const head = readCurrentHead(db, roomId, budget);
    const position = pageCursor(store, cursorBinding(auth, roomId, "work", head.head_sha256), cursor);
    if (!position) return unavailable(roomId, "work", "cursor_changed");

    const page = scanWorkPage(roomId, position,
      after => addressedWorkWindow(store, roomId, auth.member.id, room.ownerId, after, PAGE_SIZE, budget),
      items => workRows(items.filter(item => {
        const privacy = readCurrentWorkPrivacy(db, roomId, item.id, budget);
        return !privacy.requests || Object.hasOwn(privacy.parties, auth.member.id) || workRoleHolder(item, auth.member.id);
      }), auth, room, roomId, position.at, item => readCurrentWorkItem(db, roomId, item.id, budget).blocker));
    return { ...page, evaluatedThrough: currentVisibleHorizon(store, roomId, auth.member.id, head.sequence) };
  }, { maxRecords: 512 });
}

function legacyWorkPage(store, roomId, auth, room, cursor) {
  const position = pageCursor(store, cursorBinding(auth, roomId, "work", room.sequence), cursor);
  if (!position) return unavailable(roomId, "work", "cursor_changed");
  // Preserve the original search depth even for large referenced work items.
  // Search farther only when the additional hydrated records fit the budget.
  const originalLimit = PAGE_SIZE * WORK_SEARCH_WINDOWS;
  const keys = store.db.prepare(`SELECT item.key, length(CAST(item.value AS BLOB)) AS bytes FROM work_projection_items AS item
    WHERE item.room_id=? AND item.key COLLATE BINARY>?
      AND (json_extract(item.value,'$.accountableMemberId')=? OR json_extract(item.value,'$.verifierMemberId')=?
        OR json_extract(item.value,'$.humanDecisionMakerId')=? OR json_extract(item.value,'$.handoff.triageMemberId')=?
        OR (? AND json_extract(item.value,'$.handoff.open')=1 AND json_extract(item.value,'$.handoff.triageMemberId') IS NULL))
    ORDER BY item.key COLLATE BINARY LIMIT ?`);
  const memberId = auth.member.id;
  const rows = keys.all(roomId, position.after, memberId, memberId, memberId, memberId,
    Number(memberId === room.ownerId), LEGACY_WORK_SEARCH_LIMIT + 1);
  let bytes = 0;
  const ids = [];
  for (const row of rows.slice(0, LEGACY_WORK_SEARCH_LIMIT)) {
    if (ids.length >= originalLimit && bytes + row.bytes > LEGACY_WORK_BYTES) break;
    ids.push(row.key);
    bytes += row.bytes;
  }
  const parties = store.privateWorkParties(roomId, { workIds: ids });
  const visible = [...readWorkItems(store.db, roomId, ids).values()].filter(item => {
    const allowed = parties.get(item.id);
    return !allowed || allowed.has(auth.member.id) || workRoleHolder(item, auth.member.id);
  });
  const matches = workRows(visible, auth, room, roomId, position.at, item => item.blocker);
  const items = matches.slice(0, PAGE_SIZE);
  const hasMore = matches.length > items.length || rows.length > ids.length;
  const after = matches.length > items.length ? items.at(-1).id : ids.at(-1);
  return { coverage: hasMore ? "partial" : "complete", items,
    nextRead: hasMore ? read(roomId, "work", position.encode(after)) : null };
}

const requestRead = (roomId, id) => ({
  tool: "room_read_request", arguments: { roomId, requestMessageId: id, view: "compact" }
});

function requestRows(requests, roomId) {
  return requests.map(row => ({
    id: row.id, revision: row.revision, savedAt: row.createdAt,
    ...(row.progress ? { latestRecipientProgress: { state: row.progress.state, at: row.progress.at } } : {}),
    nextRead: requestRead(roomId, row.id)
  }));
}

function legacyRequestPage(store, secret, roomId, auth, room, cursor, preferRecovery) {
  const position = pageCursor(store, cursorBinding(auth, roomId, "requests", room.sequence), cursor);
  if (!position) return unavailable(roomId, "requests", "cursor_changed");
  const page = store.replyRequests.list(secret, roomId, {
    direction: "incoming", status: "open", states: true, expectedSessionBinding: auth.sessionBinding
  });
  const rows = page.requests.filter(row => row.id > position.after).sort((a, b) => a.id < b.id ? -1 : 1);
  const selected = rows.slice(0, PAGE_SIZE);
  const more = rows.length > selected.length;
  // The legacy reader already loads the bounded, authorized open requests.
  // Pick a recovery without moving rows or invalidating a list continuation.
  const recovery = preferRecovery && !cursor && rows.find(row => row.progress?.state === "error");
  return {
    ...(recovery ? { recoveryRead: requestRead(roomId, recovery.id) } : {}),
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
    direction: "incoming", status: "open", states: true, limit: PAGE_SIZE,
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

export function readRoomNext(store, secret, roomId, { source, cursor, view } = {}, readInvitation, { allowPublicReview = false } = {}) {
  if (!validRoomNextSelection({ source, cursor, view }))
    throw new ServiceError(422, "invalid_arguments", "Choose a source and its returned cursor");
  return store.readTransaction(() => {
    const auth = store.authenticate(secret, roomId);
    const packet = { contractVersion: 1, roomId, viewerId: auth.member.id };
    const includeWork = source !== "requests", includeRequests = source !== "work";
    const current = isCurrentRoom(store.db, roomId);
    const room = current
      ? withCurrentReadContext(store.db, roomId, budget => readCurrentRecord(store.db, roomId, "metadata", "room", budget))
      : store.db.prepare(`SELECT sequence,
          length(CAST(json_extract(projection,'$.workItems') AS BLOB)) AS workBytes,
          length(CAST(json_extract(projection,'$.replyRequests') AS BLOB)) AS requestBytes,
          json_extract(projection,'$.room.ownerId') AS ownerId, json_extract(projection,'$.room.purpose') AS purpose,
          json_extract(projection,'$.room.archivedAt') AS archivedAt,
          json_extract(projection,'$.room.charter') AS charter FROM rooms WHERE id=?`).get(roomId);
    const charter = current ? room.charter : JSON.parse(room.charter ?? "null");
    packet.goal = String(charter?.purpose ?? room.purpose ?? "").slice(0, 800);
    packet.charterRevision = charter?.revision ?? null;

    // Archived discussion and unrelated projections never enter these readers.
    // Work visibility still depends on the private-request slice.
    const requestsOverBudget = !current && room.requestBytes > LEGACY_REQUEST_BYTES;
    if (includeWork) packet.work = !current && (room.workBytes > LEGACY_WORK_BYTES || requestsOverBudget)
      ? unavailable(roomId, "work", "legacy_projection_budget",
        { tool: "room_activation_pack", arguments: { roomId, view: "brief" } })
      : boundedPage(roomId, "work", () => current
        ? workPage(store, roomId, auth, room, cursor) : legacyWorkPage(store, roomId, auth, room, cursor));
    let recoveryRead;
    if (includeRequests) {
      const { recoveryRead: recovery, ...requests } = requestsOverBudget
        ? unavailable(roomId, "requests", "legacy_projection_budget",
          { tool: "room_list_requests", arguments: { roomId, direction: "incoming", status: "open" } })
        : boundedPage(roomId, "requests", () => current
          ? requestPage(store, secret, roomId, auth, cursor)
          : legacyRequestPage(store, secret, roomId, auth, room, cursor, view === "pickup"));
      packet.requests = requests;
      recoveryRead = recovery;
    }
    // The default stays readable by clients with the original closed output schema.
    if (view === "pickup") {
      const correction = packet.work?.items.find(item => item.reason === "revise");
      const addressed = correction?.nextRead ?? recoveryRead
        ?? packet.requests?.items[0]?.nextRead ?? packet.work?.items[0]?.nextRead;
      packet.nextRead = addressed ?? packet.requests?.nextRead ?? packet.work?.nextRead ?? null;

      // Preserve discovery priority until all addressed work is known. An
      // empty partial page can still offer a separate exact public review.
      if (allowPublicReview && !source && !room.archivedAt && !addressed
        && packet.work.coverage !== "unavailable" && packet.requests.coverage === "complete"
        && auth.member.permissions.includes("verify") && !store.wakeQueue.pauseStatus(roomId, auth.member.id)) {
        const receiptId = store.publicWorkReviews.nextPending(roomId, auth.member.id);
        if (receiptId) {
          const nextRead = { tool: "room_read_public_review", arguments: { roomId, receiptId } };
          packet.ifIdle = { status: "public_review", nextRead };
          if (packet.work.coverage === "complete") packet.nextRead = nextRead;
        }
      }

      if (!source && !room.archivedAt && auth.member.kind === "agent"
        && auth.member.permissions.includes("accept_work") && !addressed && !packet.ifIdle) {
        const paused = store.wakeQueue.pauseStatus(roomId, auth.member.id);
        const addressedComplete = packet.work.coverage === "complete" && packet.requests.coverage === "complete";
        if (paused) packet.ifIdle = { status: "paused" };
        else if (addressedComplete) {
          let wantsWork = null;
          try { wantsWork = readWantsWork(store.db, roomId, auth.member.id)?.wantsWork ?? null; }
          catch { wantsWork = null; }
          const ranked = rankReadyWorkInRoom(store, roomId, {
            goal: packet.goal, wantsWork, now: store.now?.() ?? Date.now()
          });
          const top = ranked[0];
          if (top) {
            const nextRead = { tool: "room_read_board", arguments: { roomId } };
            packet.nextRead = nextRead;
            packet.ifIdle = {
              status: "ready_work",
              claimId: top.item.id,
              title: String(top.item.title ?? top.item.id).slice(0, 160),
              reason: top.reason,
              leaseHours: PICKUP_LEASE_HOURS,
              readyCount: ranked.length,
              nextRead,
              claimAction: {
                method: "POST",
                endpoint: `/api/rooms/${roomId}/work-claims/${top.item.id}/claim`,
                params: { requestId: "<uuid>", leaseHours: PICKUP_LEASE_HOURS }
              }
            };
          } else if (readInvitation) {
            const listing = readInvitation();
            const invite = listing.work?.[0];
            if (invite) {
              packet.nextRead = { ...invite.nextRead, arguments: { roomId, ...invite.nextRead.arguments } };
              packet.ifIdle = { status: "invitation", workItemId: invite.id, title: invite.title.slice(0, 160),
                revision: invite.revision, helpEventId: invite.help.eventId, nextRead: packet.nextRead };
            } else {
              packet.ifIdle = listing.selection?.available === false
                ? { status: "unavailable", reason: listing.selection.reason }
                : { status: "dry", reason: "no_ready_work", readyCount: 0, goal: packet.goal };
            }
          } else {
            packet.ifIdle = { status: "dry", reason: "no_ready_work", readyCount: 0, goal: packet.goal };
          }
        }
      }
    }
    if (Buffer.byteLength(JSON.stringify(packet)) > MAX_BYTES)
      throw new ServiceError(409, "current_room_context_unavailable", "Read one source at a time");
    return packet;
  });
}
