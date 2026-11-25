import { createHash } from "node:crypto";
import { getTier } from "./autonomy-tiers.mjs";
import { isGuestAgentMemberId } from "./guest-agent-links.mjs";
import { nextReviewerProject } from "./project-discoveries.mjs";
import { activationObligations } from "./activation-obligations.mjs";
import { conversationCursorCodec } from "./conversation-sync.mjs";
import { addressedRequestWindow, addressedWorkWindow } from "./current-work-list.mjs";
import { messageInHistory } from "./history-visibility.mjs";
import {
  chargeCurrentReadBudget, CurrentReadBudgetExceeded, currentVisibleHorizon, isCurrentRoom, readCurrentHead,
  readCurrentHistoryFloor, readCurrentRecord, readCurrentWorkItem, withCurrentReadContext
} from "./current-room-repository.mjs";
import { ServiceError } from "./service-error.mjs";
import { currentResult } from "../src/work-selectors.js";
import { readWorkItem, readWorkItems } from "./work-repository.mjs";
import { workRoleHolder } from "./work-context.mjs";

const PAGE_SIZE = 4;
const WORK_SEARCH_WINDOWS = 4;
const LEGACY_WORK_SEARCH_LIMIT = 64;
const CORRECTION_CHARS = 400;
const CORRECTION_FIELD_BYTES = 650;
const MAX_BYTES = 16 * 1024;
const LEGACY_WORK_BYTES = 256 * 1024;
const CURSOR_ERRORS = new Set([
  "invalid_reply_cursor", "reply_cursor_identity_changed", "stale_reply_cursor"
]);

const read = (roomId, source, cursor) => ({
  tool: "room_next", arguments: { roomId, source, ...(cursor ? { cursor } : {}) }
});
const unavailable = (roomId, source, reason, nextRead = read(roomId, source)) => ({
  coverage: "unavailable", reason, items: [], nextRead
});

export function validRoomNextSelection({ source, cursor, view, consideredDiscovery }) {
  return (view === undefined || view === "pickup")
    && (consideredDiscovery === undefined || (view === "pickup" && source === undefined
      && typeof consideredDiscovery === "string" && /^[A-Za-z0-9_-]{1,4096}$/.test(consideredDiscovery)))
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
    try {
      const window = loadWindow(after);
      items = rowsFor(window.items);
      after = window.after;
      hasMore = window.hasMore;
    } catch (error) {
      // Keep the last completed window as the continuation boundary. An
      // incomplete window is retried under the next request's read budget.
      if (!(error instanceof CurrentReadBudgetExceeded) || after === position.after) throw error;
      break;
    }
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

    const evaluatedThrough = currentVisibleHorizon(store, roomId, auth.member.id, head.sequence);
    const page = scanWorkPage(roomId, position,
      after => addressedWorkWindow(store, roomId, auth.member.id, room.ownerId, after, PAGE_SIZE, budget, { actionableAt: position.at }),
      // The canonical viewer summary already masks unauthorized work rows.
      items => workRows(items.filter(item => item.title !== null),
        auth, room, roomId, position.at, item => readCurrentWorkItem(db, roomId, item.id, budget).blocker));
    return { ...page, evaluatedThrough };
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
    ...(row.progress || row.progressState ? { latestRecipientProgress: {
      state: row.progress?.state ?? row.progressState, at: row.progress?.at ?? row.lastActivityAt
    } } : {}),
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

function requestPage(store, roomId, auth, cursor) {
  // A pickup cursor walks the current open inbox, not the historical request journal.
  const position = pageCursor(store, cursorBinding(auth, roomId, "incoming-open", null), cursor);
  if (!position) return unavailable(roomId, "requests", "cursor_changed");
  return withCurrentReadContext(store.db, roomId, budget => {
    const floor = readCurrentHistoryFloor(store.db, roomId, auth.member.id, budget);
    const page = addressedRequestWindow(store, roomId, auth.member.id, position.after, PAGE_SIZE, budget);
    const visible = page.requests.filter(request => messageInHistory({ id: request.id, createdAt: request.createdAt }, floor));
    const event = store.db.prepare('SELECT sequence FROM events WHERE room_id=? AND id=?');
    let evaluatedThrough = 0;
    for (const request of visible) {
      for (const eventId of new Set([request.openingEventId, request.contextEventId].filter(Boolean))) {
        const row = event.get(roomId, eventId);
        chargeCurrentReadBudget(budget, 128);
        if (!row) throw new ServiceError(409, 'reply_history_changed', 'Request history changed; reconcile before resuming');
        evaluatedThrough = Math.max(evaluatedThrough, row.sequence);
      }
    }
    return {
      coverage: page.hasMore ? "partial" : "complete",
      evaluatedThrough,
      evaluationScope: "visible-encountered-anchors",
      items: requestRows(visible, roomId),
      nextRead: page.hasMore ? read(roomId, "requests", position.encode(page.examinedAfter)) : null
    };
  }, { maxRecords: 512 });
}

function boundedPage(roomId, source, getPage) {
  try { return getPage(); }
  catch (error) {
    if (error instanceof CurrentReadBudgetExceeded || error?.code === "reply_list_too_large")
      return unavailable(roomId, source, "read_budget_exceeded");
    if (error instanceof ServiceError && CURSOR_ERRORS.has(error.code))
      return unavailable(roomId, source, "cursor_changed");
    throw error;
  }
}

// Check the four newest completion events by the existing room/type index.
// Only a still-current Room-wide result can become a shared investigation.
function recentRoomResult(store, roomId) {
  const rows = store.db.prepare(`SELECT id, json_extract(body, '$.data.workItemId') AS workItemId
    FROM events WHERE room_id=? AND json_extract(body, '$.type')='work.completed'
    ORDER BY rowid DESC LIMIT 4`).all(roomId);
  const restricted = store.privateWorkParties(roomId, { workIds: rows.map(row => row.workItemId) });
  for (const row of rows) {
    if (restricted.has(row.workItemId)) continue;
    const item = readWorkItem(store.db, roomId, row.workItemId);
    const result = currentResult(item);
    if (result?.completionEventId === row.id) return { workItemId: item.id, ...result };
  }
  return null;
}

// A bounded read suggests one check. Only a contributor's subsequent Room
// message records a finding. Its key follows source evidence, never Room head.
function investigationLead(store, roomId, charter, goal) {
  const project = store.projectOffers.publishedProject(roomId);
  if (project) {
    const receipt = store.publicWorkClaims.latestPublicReceiptLead(roomId, project.repositoryUrl);
    const publicLead = unrecordedInvestigation(store, roomId, charter, goal, { project, receipt });
    if (publicLead) return publicLead;
  }
  return unrecordedInvestigation(store, roomId, charter, goal, { result: recentRoomResult(store, roomId) });
}

function unrecordedInvestigation(store, roomId, charter, goal, { project, receipt, result }) {
  const criterion = project?.acceptanceCriteria[0] ?? charter?.outputs ?? goal;
  if (!criterion) return null;
  const basis = project
    ? { projectId: project.id, version: project.version, revision: project.revision,
      ...(receipt && { taskId: receipt.taskId, receiptId: receipt.receiptId }) }
    : { charterRevision: charter?.revision ?? null, criterion, ...(result && { workItemId: result.workItemId, completionEventId: result.completionEventId }) };
  const digest = createHash("sha256").update(JSON.stringify([roomId, basis])).digest("hex").slice(0, 32);
  const checkpoint = "investigation-" + digest;
  const bodyPrefix = "Room investigation " + checkpoint + "\n";
  // Inspect only an exact, general-channel checkpoint. Other messages, DMs
  // and work-linked results cannot attest to this particular check.
  const saved = store.db.prepare(`SELECT seq, substr(body,1,?) AS prefix, length(body)>? AS hasResult
    FROM messages WHERE room_id=? AND message_id=? AND channel_id='general'
    AND coalesce(to_member_id,'')='' AND coalesce(work_item_id,'')='' AND coalesce(reply_to_id,'')=''
    AND deleted_at IS NULL`);
  let id = checkpoint;
  for (let n = 0; n < 3; n++) {
    const previous = saved.get(bodyPrefix.length, bodyPrefix.length, roomId, id);
    if (!previous) break;
    if (previous.prefix === bodyPrefix && previous.hasResult) return null;
    id = checkpoint + "-" + previous.seq;
    if (n === 2) return null;
  }
  const nextRead = receipt
    ? { tool: "public_work_read_task", arguments: { taskId: receipt.taskId } }
    : result ? (result.kind === "room_text"
      ? { tool: "room_read_result", arguments: { roomId, workItemId: result.workItemId, completionEventId: result.completionEventId } }
      : { tool: "room_read_work", arguments: { roomId, workItemId: result.workItemId, brief: true, includeResult: true } })
      : { tool: "room_list_work", arguments: { roomId, focus: "results", limit: 1 } };
  return { basis, criterion, nextRead,
    question: receipt
      ? "Does the cited artifact reproduce one acceptance criterion of the selected public task?"
      : "Which observed result supports this criterion, or which specific bottleneck prevents it?",
    ...(project && { projectPath: project.path, ...(project.repositoryUrl && { repositoryUrl: project.repositoryUrl }) }),
    ...(receipt && { taskPath: receipt.taskPath, receiptPath: receipt.receiptPath, artifactPath: receipt.artifactPath }),
    guidance: "Follow the selected evidence. A better evidenced bottleneck or optimization within this scope is also useful. Check existing work first. An empty partial page is inconclusive. Record the source, check, observation and smallest next step, or a scoped clean result. Keep restricted evidence with its original audience. For a Room-safe note, start body with record.bodyPrefix and append your result. This checkpoint deduplicates delivery; it does not reserve the check.",
    record: { tool: "room_post_message", arguments: { roomId, id, messageId: id, compact: true },
      inputRequired: ["body"], bodyPrefix,
      onMessageExists: {
        readPath: "/api/rooms/" + encodeURIComponent(roomId) + "/messages/" + encodeURIComponent(id) + "/thread",
        guidance: "After a confirmed message-ID collision, read the recorded finding. If your Room-safe observation adds evidence, reply with your own stable id and body. Retry that reply unchanged.",
        reply: { tool: "room_post_message", arguments: { roomId, replyToId: id, compact: true }, inputRequired: ["id", "body"] }
      } }
  };
}

export function readRoomNext(store, secret, roomId, { source, cursor, view, consideredDiscovery } = {}, readInvitation, { allowPublicReview = false, allowInvestigation = false, discoveryOrigin } = {}) {
  if (!validRoomNextSelection({ source, cursor, view, consideredDiscovery }))
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
          json_extract(projection,'$.room.ownerId') AS ownerId, json_extract(projection,'$.room.purpose') AS purpose,
          json_extract(projection,'$.room.archivedAt') AS archivedAt,
          json_extract(projection,'$.room.charter') AS charter FROM rooms WHERE id=?`).get(roomId);
    const charter = current ? room.charter : JSON.parse(room.charter ?? "null");
    packet.goal = String(charter?.purpose ?? room.purpose ?? "").slice(0, 800);
    packet.charterRevision = charter?.revision ?? null;

    // Archived discussion and unrelated projections never enter these readers.
    // Private request membership is resolved only for the selected work IDs.
    if (includeWork) packet.work = !current && room.workBytes > LEGACY_WORK_BYTES
      ? unavailable(roomId, "work", "legacy_projection_budget",
        { tool: "room_activation_pack", arguments: { roomId, view: "brief" } })
      : boundedPage(roomId, "work", () => current
        ? workPage(store, roomId, auth, room, cursor) : legacyWorkPage(store, roomId, auth, room, cursor));
    let recoveryRead;
    if (includeRequests) {
      const { recoveryRead: recovery, ...requests } = boundedPage(roomId, "requests", () => current
        ? requestPage(store, roomId, auth, cursor)
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

      // A source cursor has already passed its room, viewer and permission checks.
      // Only a cursor issued while walking a combined pickup can certify the other source.
      const resume = source && cursor && packet[source]?.coverage !== "unavailable"
        ? conversationCursorCodec(store).decode(cursor)?.discoveryWalk : null;
      const roomSequence = () => store.db.prepare("SELECT sequence FROM rooms WHERE id=?").get(roomId).sequence;
      const currentResume = resume && resume.sequence === roomSequence();
      if (resume && !currentResume && !addressed) {
        packet.nextRead = { tool: "room_next", arguments: { roomId, view: "pickup",
          ...(resume.consideredDiscovery && { consideredDiscovery: resume.consideredDiscovery }) } };
      }
      const combined = !source || currentResume;
      const workCoverage = packet.work?.coverage ?? (resume?.pendingWork ? "partial" : "complete");
      const requestCoverage = packet.requests?.coverage ?? "complete";
      const addressedComplete = combined && workCoverage === "complete" && requestCoverage === "complete";
      if (combined && resume?.pendingWork && !packet.nextRead)
        packet.nextRead = read(roomId, "work", resume.pendingWork);

      // Preserve discovery priority until all addressed work is known. An
      // empty partial page can still offer a separate exact public review.
      if (allowPublicReview && combined && !room.archivedAt && !addressed
        && workCoverage !== "unavailable" && requestCoverage === "complete"
        && auth.member.permissions.includes("verify") && !store.wakeQueue.pauseStatus(roomId, auth.member.id)) {
        const receiptId = store.publicWorkReviews.nextPending(roomId, auth.member.id);
        if (receiptId) {
          const nextRead = { tool: "room_read_public_review", arguments: { roomId, receiptId } };
          packet.ifIdle = { status: "public_review", nextRead };
          if (addressedComplete) packet.nextRead = nextRead;
        }
      }

      if (combined && !room.archivedAt && auth.member.kind === "agent"
        && auth.member.permissions.includes("accept_work") && !addressed && !packet.ifIdle) {
        const paused = store.wakeQueue.pauseStatus(roomId, auth.member.id);
        if (paused) packet.ifIdle = { status: "paused" };
        else if (addressedComplete && readInvitation) {
          const listing = readInvitation();
          const invite = listing.work?.[0];
          if (invite) {
            packet.nextRead = { ...invite.nextRead, arguments: { roomId, ...invite.nextRead.arguments } };
            packet.ifIdle = { status: "invitation", workItemId: invite.id, title: invite.title.slice(0, 160),
              revision: invite.revision, helpEventId: invite.help.eventId, nextRead: packet.nextRead };
          } else {
            packet.ifIdle = listing.selection?.available === false
              ? { status: "unavailable", reason: listing.selection.reason }
              : { status: "no_invitation" };
          }
        }
      }

      const canInvestigate = allowInvestigation && auth.member.kind === "agent"
        && auth.member.permissions.includes("accept_work") && !isGuestAgentMemberId(auth.member.id)
        && (auth.member.id === room.ownerId || getTier(store.db, roomId, auth.member.id)?.autonomyTier !== "t1_readonly");
      if (discoveryOrigin && combined && !room.archivedAt && !addressed
          && workCoverage !== "unavailable" && requestCoverage !== "unavailable"
          && !store.wakeQueue.pauseStatus(roomId, auth.member.id)) {
        const binding = cursorBinding(auth, roomId, "discovery", null);
        const checkpoint = consideredDiscovery ?? resume?.consideredDiscovery;
        const position = pageCursor(store, binding, checkpoint);
        if (!position) throw new ServiceError(422, "invalid_discovery_checkpoint", "Omit the stale checkpoint to restart finding review");
        const project = nextReviewerProject(store, roomId, auth.member.id, discoveryOrigin, position.after);
        if ((project || canInvestigate) && !addressedComplete && packet.nextRead?.tool === "room_next") {
          // The selected source continuation remembers any other unfinished
          // source so the last empty page can finish the combined pickup.
          const args = packet.nextRead.arguments;
          const codec = conversationCursorCodec(store);
          const original = codec.decode(args.cursor);
          if (original) {
            const pendingWork = args.source === "requests" ? resume?.pendingWork ?? packet.work?.nextRead?.arguments.cursor : null;
            const discoveryWalk = { sequence: roomSequence(), pendingWork, consideredDiscovery: checkpoint };
            packet.nextRead = { tool: "room_next", arguments: { ...args, view: "pickup",
              cursor: codec.encode({ ...original, discoveryWalk }) } };
            if (packet[args.source]?.nextRead) packet[args.source].nextRead = packet.nextRead;
          }
        } else if (project && addressedComplete) {
          const nextRead = { tool: "room_read_project_discoveries", arguments: { roomId, offerId: project.offerId, limit: 5 } };
          packet.ifIdle ??= { status: "unavailable", reason: "invitation_not_selected" };
          packet.ifIdle.discoveryReview = { nextRead, consideredDiscovery: position.encode(project.after),
            path: '/api/rooms/' + encodeURIComponent(roomId) + '/project-offers/' + encodeURIComponent(project.offerId) + '/discoveries' };
        }
        if (canInvestigate && addressedComplete && !packet.nextRead && !packet.ifIdle?.discoveryReview &&
          (packet.ifIdle?.status === "no_invitation" || packet.ifIdle?.reason === "current_help_index_unavailable")) {
          const lead = investigationLead(store, roomId, charter, packet.goal);
          if (lead) {
            // Older clients validate top-level read names against a closed enum.
            // Its ifIdle extension is open and carries the exact action in full.
            packet.ifIdle.investigation = lead;
            if (["room_read_work", "room_read_result"].includes(lead.nextRead.tool)) packet.nextRead = lead.nextRead;
          }
        }
      }
    }
    // The recommended continuation must keep returning a recommended action.
    // Leave the original per-source paging contract intact for other callers.
    if (view === "pickup" && packet.nextRead?.tool === "room_next")
      packet.nextRead = { ...packet.nextRead, arguments: { ...packet.nextRead.arguments, view: "pickup" } };
    if (Buffer.byteLength(JSON.stringify(packet)) > MAX_BYTES)
      throw new ServiceError(409, "current_room_context_unavailable", "Read one source at a time");
    return packet;
  });
}
