// Project state: one bounded, derived read of "where is the project" for a
// Room, for people and for agents. Nothing here is hand-written: it composes
//   - the serving build (SOURCE_REVISION / BUILD_ID, the /api/version door),
//   - the room's work items (state, owner, handoff, blocker, age, next step),
//   - receipts that automation already posts to the room (PROD DEPLOY,
//     PROD ROLLBACK, MERGED #n, CI #n), parsed by format, and
//   - the viewer's own attention items (the same slice the digest uses).
// Agents read this instead of posting or re-reading status recaps. Every list
// is capped; `truncated` names what was shed and `complete` says whether the
// work scan reached every item.
import { nextWorkStep, terminalWork } from "../src/workflow.js";
import { ownMember, validId } from "../src/events.js";
import { checkReceiverRoute } from "../src/reply-requests.js";
import { ServiceError } from "./service-error.mjs";
import { withheldWorkItem, outsidePrivateWork } from "./work-context.mjs";
import { isCurrentRoom } from "./current-room-repository.mjs";
import { readWorkItem } from "./work-repository.mjs";
import { SOURCE_REVISION, BUILD_ID } from "./version.mjs";
import { parseReceipt } from "./receipts.mjs";
import { readReceiptSignals } from "./receipt-signals.mjs";
import { readResponseLatency, latencyLine } from "./response-latency.mjs";
import { PREREQUISITE_GATED_STEPS, prerequisiteHold } from "../client/begin-work.mjs";
import { nativePrerequisiteState, boardPrerequisiteState, observePrerequisites } from "./work-item-state.mjs";
import { readMacCapabilities } from "./mac-capabilities.mjs";
import { boardClaimId } from "./work-item-board.mjs";

export const PROJECT_STATE_VERSION = 1;
export const PROJECT_STATE_MAX_BYTES = 6144;
// Receipt scan: the latest message events only, never the whole journal.
export const RECEIPT_SCAN_EVENTS = 1500;
export const WORK_PAGE = 8;
export const WORK_MAX_PAGES = 16; // 128 items; beyond that `complete` is false
// Prerequisite lookups per read: not-yet-started items examined, and work
// records read for them. Past either bound a row reports unknown, never ready.
export const PREREQUISITE_ITEMS = 24;
export const PREREQUISITE_READS = 96;
const PRE_START_STEPS = Object.freeze(["accept", ...PREREQUISITE_GATED_STEPS]);
export function validProjectReceiverSelection({ receiverMemberId, receiverWorkItemId }) {
  return (receiverMemberId === undefined || validId(receiverMemberId))
    && (receiverWorkItemId === undefined || receiverMemberId !== undefined && validId(receiverWorkItemId));
}

export function observeReceiverRoute(streams, roomId, recipientId, request) {
  let status = "unknown";
  for (const entry of streams) {
    if (entry.roomId !== roomId || entry.memberId !== recipientId || !entry.receiverScope
      || entry.res.destroyed || entry.res.writableEnded || !entry.stillAuthorized()) continue;
    if (checkReceiverRoute(entry.receiverScope, request) === "matches_scope") {
      status = "matches_scope";
      const since = entry.receiverWaitingSince;
      if (since) return { status, receiver: { state: "waiting_for_work", since } };
    } else if (status === "unknown") status = "outside_scope";
  }
  return { status };
}

function selectedReceiver(store, token, roomId, auth, ownerId, receiverMemberId, workItemId, streams) {
  if (workItemId !== null) {
    store.workContext(token, roomId, workItemId, { expectedSessionBinding: auth.sessionBinding });
  }
  const base = { memberId: receiverMemberId, workItemId, execution: "unverified" };
  const { status, receiver } = observeReceiverRoute(streams, roomId, receiverMemberId, {
    requesterId: auth.member.id, workItemId, id: null
  });
  if (status === "matches_scope" || auth.member.id === receiverMemberId || auth.member.id === ownerId) {
    if (store.wakeQueue.pauseStatus(roomId, receiverMemberId)) {
      return { ...base, state: "paused", dispatch: "hold" };
    }
  }
  if (receiver) return { ...base, state: receiver.state, since: receiver.since, dispatch: "check_existing_work" };
  return { ...base, state: "readiness_unconfirmed", dispatch: "hold" };
}

const CAPS = Object.freeze({ inProgress: 10, blocked: 6, needsYou: 6, needsHuman: 6, mergedNotDeployed: 8, receipts: 4, attention: 5 });

const clip = (text, n) => {
  if (typeof text !== "string") return null;
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n - 1) + "…" : flat;
};
const strip = ({ _t, ...row }) => row;
const iso = ms => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const minutes = (now, at) => { const t = Date.parse(at); return Number.isFinite(t) ? Math.max(0, Math.round((now - t) / 60000)) : null; };

// parseReceipt lives in receipts.mjs (pure, no imports) so the post path can use it without this module's graph.
export { parseReceipt };

// Pure builder. `members` maps id → {displayName, kind}; `items` are work
// items as the reducers hold them (privacy already applied by the reader).
// `prerequisites` maps work id → observations ({id,state,satisfied}[]) for
// not-yet-started work. Omitted entirely (pure callers), rows are unchanged.
// When supplied, an item without an entry is unknown, not ready.
export function buildProjectState({ roomId, viewerId, ownerId, sequence, now, live, items, itemsComplete, members, receipts, receiptWindow, attention, latency = null, prerequisites = undefined, macCapabilities = undefined, receiverAvailability = undefined }) {
  const member = id => (id == null || !members ? null : ownMember(members, id));
  const name = id => (id == null ? null : clip(member(id)?.displayName, 24) ?? String(id).slice(0, 12));
  const nowMs = typeof now === "number" ? now : Date.parse(now);
  const counts = {};
  const inProgress = [], blocked = [], needsYou = [], needsHuman = [];
  for (const item of items) {
    if (item.state === "superseded" || item.supersededBy) continue;
    const board = item.state === "completed" ? (terminalWork(item) ? "done" : "delivered") : item.state;
    counts[board] = (counts[board] ?? 0) + 1;
    // Submitted evidence is not terminal while its exact review or decision
    // is outstanding. Keep it in the same role-derived attention read.
    if (board === "done") continue;
    const step = nextWorkStep(item, nowMs, ownerId);
    const owner = name(item.claim?.status === "active" ? item.claim.holderId : item.accountableMemberId);
    const nextFor = step.memberId == null ? null : name(step.memberId);
    // Null and redundant fields are omitted: this document is read on every wake.
    // A claim/start step is advice only while every prerequisite is known to be
    // satisfied. Otherwise the row says what it waits on (ids only where the
    // viewer may see the task) or that readiness is unknown. Accept stays open.
    const hold = prerequisites && PRE_START_STEPS.includes(step.action)
      ? (prerequisites.has(item.id) ? prerequisiteHold(prerequisites.get(item.id)) : prerequisiteHold(null)) : null;
    const gated = Boolean(hold) && PREREQUISITE_GATED_STEPS.includes(step.action);
    const waiting = !hold ? {} : !hold.known ? { waitingOn: "unknown" }
      : item.title == null ? { waitingOn: hold.waitingOn.length + hold.more }
      : { waitingOn: hold.waitingOn, ...(hold.more ? { waitingOnMore: hold.more } : {}) };
    const row = {
      id: item.id, title: clip(item.title, 48) ?? "(private)", state: board, owner,
      next: !gated ? step.action : hold.known ? "wait_prerequisites" : "check_prerequisites", ...waiting,
      ...(nextFor && nextFor !== owner ? { nextFor } : {}), ...(item.handoff?.open ? { handoff: "open" } : {}),
      quietMin: minutes(nowMs, item.updatedAt ?? item.createdAt)
    };
    row._t = Date.parse(item.updatedAt ?? item.createdAt) || 0; // sort key, removed before serialization
    if (board === "accepted" || board === "working") inProgress.push(row);
    if (board === "blocked") blocked.push({ ...row, blockedBy: clip(item.blocker?.reason, 60), ...(item.blocker?.nextAction ? { unblock: clip(item.blocker.nextAction, 40) } : {}) });
    // Known waiting needs nobody yet; unknown readiness still needs a selected read.
    const attention = step.needsAttention && !(gated && hold.known);
    if (attention && step.memberId === viewerId) needsYou.push(row);
    if (attention && step.memberId != null && member(step.memberId)?.kind === "human") needsHuman.push(row);
  }
  // Longest-quiet first (oldest update, then id: stable across reads) inside each list: stale work is what a reader acts on.
  const byQuiet = (a, b) => a._t - b._t || (a.id < b.id ? -1 : 1);
  for (const list of [inProgress, blocked, needsYou, needsHuman]) list.sort(byQuiet);

  // Receipts → what is live and what merged since.
  const rows = (receipts ?? []).map(r => ({ ...r, parsed: r.parsed ?? parseReceipt(r.body) })).filter(r => r.parsed);
  const deploys = rows.filter(r => r.parsed.kind === "deploy" || r.parsed.kind === "rollback").sort((a, b) => b.seq - a.seq);
  const lastOkDeploy = deploys.find(r => r.parsed.smoke === "ok" && r.parsed.kind === "deploy") ?? null;
  const merges = rows.filter(r => r.parsed.kind === "merged").sort((a, b) => a.seq - b.seq);
  // Main is linear and merges are posted in order, so a deploy of sha X covers
  // every merge up to the MERGED receipt for X; with no matching receipt the
  // deploy receipt's own position is the watermark.
  const tip = lastOkDeploy ? merges.find(r => r.parsed.sha === lastOkDeploy.parsed.sha) : null;
  const watermark = tip?.seq ?? lastOkDeploy?.seq ?? 0;
  const pending = merges.filter(r => r.seq > watermark);
  const liveSha = /^[0-9a-f]{40}$/.test(live?.sourceRevision ?? "") ? live.sourceRevision.slice(0, 8) : null;
  const deployMatchesLive = lastOkDeploy && liveSha && lastOkDeploy.parsed.sha === liveSha;
  const state = {
    contractVersion: PROJECT_STATE_VERSION, roomId, viewerId, through: sequence, evaluatedAt: iso(nowMs), untrusted: true,
    live: {
      sha: liveSha, build: Number.isFinite(Date.parse(live?.buildId)) ? live.buildId : null,
      deployedAt: deployMatchesLive ? iso(Date.parse(lastOkDeploy.at)) : (Number.isFinite(Date.parse(live?.buildId)) ? iso(Date.parse(live.buildId)) : null),
      smoke: deployMatchesLive ? "ok" : lastOkDeploy ? "receipt-sha-differs" : "no-receipt",
      lastDeploy: deploys[0] ? { kind: deploys[0].parsed.kind, sha: deploys[0].parsed.sha ?? null, smoke: deploys[0].parsed.smoke, at: iso(Date.parse(deploys[0].at)), seq: deploys[0].seq } : null
    },
    mergedNotDeployed: lastOkDeploy
      ? { count: pending.length, items: pending.slice(-CAPS.mergedNotDeployed).reverse().map(r => ({ pr: r.parsed.pr, sha: r.parsed.sha, title: r.parsed.title, at: iso(Date.parse(r.at)) })) }
      : { count: null, note: "no good PROD DEPLOY receipt in the scan window, so what is undeployed is unknown, not zero", mergesSeen: merges.length },
    work: { counts, scanned: items.length, complete: Boolean(itemsComplete) },
    inProgress: inProgress.slice(0, CAPS.inProgress).map(strip),
    blocked: blocked.slice(0, CAPS.blocked).map(strip),
    needsYou: needsYou.slice(0, CAPS.needsYou).map(strip),
    needsHuman: needsHuman.slice(0, CAPS.needsHuman).map(strip),
    attention: (attention ?? []).slice(0, CAPS.attention).map(a => ({ kind: a.kind, seq: a.seq, id: a.id, summary: clip(a.summary, 80) })),
    receipts: rows.sort((a, b) => b.seq - a.seq).slice(0, CAPS.receipts).map(r => ({ seq: r.seq, at: iso(Date.parse(r.at)), by: name(r.actorId), ...r.parsed })),
    receiptWindow: receiptWindow ?? null,
    ...(latency ? { latency } : {}),
    ...(macCapabilities ? { macCapabilities } : {}),
    ...(receiverAvailability ? { receiverAvailability } : {}),
    truncated: {}
  };
  const listed = new Set([...state.inProgress, ...state.blocked].map(row => row.id));
  const pointer = ({ id, next, nextFor, waitingOn }) => ({ id, next, ...(waitingOn !== undefined ? { waitingOn } : {}), ...(nextFor ? { nextFor } : {}) });
  state.needsYou = state.needsYou.map(row => (listed.has(row.id) ? pointer(row) : row));
  state.needsHuman = state.needsHuman.map(row => (listed.has(row.id) ? pointer(row) : row));
  const shed = { inProgress: inProgress.length - state.inProgress.length, blocked: blocked.length - state.blocked.length,
    needsYou: needsYou.length - state.needsYou.length, needsHuman: needsHuman.length - state.needsHuman.length,
    mergedNotDeployed: pending.length - (state.mergedNotDeployed.items?.length ?? 0) };
  for (const [k, v] of Object.entries(shed)) if (v > 0) state.truncated[k] = v;
  // Hard byte budget: shed the lowest-value rows first; counts are never shed.
  const size = () => Buffer.byteLength(JSON.stringify(state));
  for (const key of ["receipts", "attention", "inProgress", "needsHuman", "blocked", "needsYou"]) {
    while (size() > PROJECT_STATE_MAX_BYTES && state[key].length > 1) {
      state[key].pop(); state.truncated[key] = (state.truncated[key] ?? 0) + 1;
    }
  }
  return state;
}

// The read. Lives here, not on RoomStore, so it composes the store's existing
// bounded readers without growing the store: work comes from currentOverview
// (the Board/context reader, paged and privacy-filtered), receipts from a capped
// scan of the latest message events, attention from the viewer's own digest.
export function readProjectState(store, token, roomId, {
  expectedSessionBinding = null, receiverMemberId, receiverWorkItemId, streams = []
} = {}) {
  if (!validProjectReceiverSelection({ receiverMemberId, receiverWorkItemId })) {
    throw new ServiceError(422, "invalid_query", "Choose a receiver member and optional work item");
  }
  return store.readTransaction(() => {
    const auth = store.authenticate(token, roomId, expectedSessionBinding);
    const viewerId = auth.member.id, now = store.now();
    let items = [], members = {}, ownerId = null, sequence = 0, complete = true;
    if (isCurrentRoom(store.db, roomId)) {
      let workAfter = "", pages = 0;
      for (;;) {
        const page = store.currentOverview(roomId, viewerId, { workAfter, limit: WORK_PAGE, ...(pages ? { viewerAuthority: true } : {}) });
        if (!page) break;
        if (!pages) { members = page.state.members; ownerId = page.state.room.ownerId; sequence = page.sequence; }
        items.push(...Object.values(page.state.workItems));
        pages += 1;
        workAfter = page.workWindow.nextAfter;
        if (workAfter === null) break;
        if (pages >= WORK_MAX_PAGES) { complete = false; break; }
      }
    } else {
      const room = store.room(roomId);
      members = room.state.members; ownerId = room.state.room.ownerId; sequence = room.sequence;
      // Same privacy rule as the orientation read: a private request's work keeps
      // its title only for the parties and role holders.
      const parties = store.privateWorkParties(roomId);
      items = Object.entries(room.state.workItems ?? {}).map(([id, item]) => {
        const held = parties.get(id);
        return outsidePrivateWork(held, item, viewerId) ? withheldWorkItem(item) : item;
      });
    }
    // Prerequisite observations for not-yet-started work, by the same rule the
    // selected read and claim/start admission use. Bounded: unexamined or
    // unreadable items get no entry, which the builder reports as unknown.
    const prerequisites = new Map(), native = isCurrentRoom(store.db, roomId);
    let examined = 0, reads = 0;
    // The viewer's own assignments are examined first so the bound cannot hide them.
    for (const item of [...items].sort((a, b) => (b.accountableMemberId === viewerId) - (a.accountableMemberId === viewerId))) {
      if (item.supersededBy || !["proposed", "accepted"].includes(item.state)) continue;
      if (examined >= PREREQUISITE_ITEMS || reads >= PREREQUISITE_READS) break;
      examined += 1;
      try {
        // Every lookup is charged before it runs, on both representations: the
        // canonical record (thin native summaries omit dependsOn) or the Board
        // card that owns a legacy list, then one read per prerequisite.
        reads += 1;
        const source = native ? readWorkItem(store.db, roomId, item.id) : store.workClaims.get(roomId, boardClaimId(item.id));
        if (native && !source) continue;
        const ids = source?.dependsOn ?? (native ? [] : item.dependsOn ?? []);
        if (ids.length > 16 || reads + ids.length > PREREQUISITE_READS) continue;
        reads += ids.length;
        prerequisites.set(item.id, native
          ? observePrerequisites(ids, id => readWorkItem(store.db, roomId, id), dep => nativePrerequisiteState(dep, now))
          : observePrerequisites(ids, id => store.workClaims.get(roomId, id), boardPrerequisiteState));
      } catch { /* unknown */ }
    }
    const head = sequence || store.headSequence(roomId);
    // The viewer's history floor clamps the scan like every other read.
    const historyFloor = store.historyFloor(roomId, viewerId, head);
    const floor = Math.max(0, head - RECEIPT_SCAN_EVENTS, historyFloor ? historyFloor.sequence - 1 : 0);
    // Typed receipts first: when room_signal_log holds a good deploy anchor, the
    // log answers (a few indexed rows, no journal scan). Anything else falls back
    // to the text parse over the journal tail, so history before the log still reads.
    let receipts = null, receiptSource = "journal";
    const typed = readReceiptSignals(store.db, roomId, { floorSeq: floor });
    if (typed?.some(r => r.parsed.kind === "deploy" && r.parsed.smoke === "ok")) { receipts = typed; receiptSource = "log"; }
    if (!receipts) receipts = store.db.prepare(
      `SELECT sequence AS seq, json_extract(body,'$.at') AS at, json_extract(body,'$.actorId') AS actorId, json_extract(body,'$.data.body') AS body
       FROM events WHERE room_id=? AND sequence>? AND json_extract(body,'$.type')='message.posted' AND json_extract(body,'$.data.toMemberId') IS NULL
         AND (json_extract(body,'$.data.body') LIKE 'PROD DEPLOY %' OR json_extract(body,'$.data.body') LIKE 'PROD ROLLBACK %'
           OR json_extract(body,'$.data.body') LIKE 'MERGED #%' OR json_extract(body,'$.data.body') LIKE 'CI #%')
       ORDER BY sequence DESC LIMIT 200`).all(roomId, floor);
    let attention = [];
    try { attention = store.roomDigest(token, roomId, { since: 0, expectedSessionBinding })?.attention ?? []; } catch { attention = []; }
    let latency = null;
    try { latency = latencyLine(readResponseLatency(store, token, roomId, { expectedSessionBinding })); } catch { latency = null; }
    return buildProjectState({
      roomId, viewerId, ownerId, sequence: head, now, latency,
      ...(receiverMemberId && { receiverAvailability: selectedReceiver(
        store, token, roomId, auth, ownerId, receiverMemberId, receiverWorkItemId ?? null, streams
      ) }),
      macCapabilities: readMacCapabilities(store, { roomId, viewerId, members, items, now }),
      live: { sourceRevision: SOURCE_REVISION, buildId: BUILD_ID },
      items, itemsComplete: complete, members, receipts, prerequisites, receiptWindow: { fromSeq: floor + 1, throughSeq: head, source: receiptSource }, attention
    });
  });
}
