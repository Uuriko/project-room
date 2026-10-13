// Projection claim commands (MCP and the work-item form) write the same
// work-claims board the REST routes use. A handoff or supersede leaves a
// successor card that depends on the source, so the chain is visible there.
import { createHash } from "node:crypto";
import { createWork, claimWork, renewWork, updateWork, roomWorkClaimConfig, openClaimCount } from "./work-claims.mjs";
import { emitWorkClaimEvent } from "./work-claim-events.mjs";

const BOARD_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ACTIVE = new Set(["claimed", "in_progress", "blocked"]);

// Map a work item id to its board claim id. Ids that are already board-safe
// pass through unchanged, so existing cards keep their ids. Any other id is
// encoded reversibly instead of squashed: "_" is the escape character
// ("__" is "_", "_p" is ".", "_c" is ":", "_x<hex>_" is any other character
// by code point) and the result takes an "_e" prefix. Valid work item ids
// start with a letter or digit (src/events.js validId), so a pass-through
// id can never start with "_" and the encoded space is disjoint from it:
// "task.1", "task:1" and "task_1" land on three different cards. An
// encoding that would overflow the 128-char board limit falls back to
// "_h" plus a SHA-256 prefix of the original id — deterministic, and two
// distinct ids collide only if their digests do. (The previous mapping
// replaced every non-board character with "_" and truncated to 120 chars,
// merging distinct ids onto one card; #2854.)
export function boardClaimId(workItemId) {
  if (typeof workItemId === "string" && BOARD_ID.test(workItemId)) return workItemId;
  const raw = String(workItemId ?? "");
  if (!raw) return "workitem";
  let encoded = "";
  for (const char of raw) {
    if (/^[A-Za-z0-9-]$/.test(char)) encoded += char;
    else if (char === "_") encoded += "__";
    else if (char === ".") encoded += "_p";
    else if (char === ":") encoded += "_c";
    else encoded += `_x${char.codePointAt(0).toString(16)}_`;
  }
  const candidate = `_e${encoded}`;
  if (BOARD_ID.test(candidate)) return candidate;
  return `_h${createHash("sha256").update(raw).digest("hex").slice(0, 40)}`;
}

function filesFrom(data) {
  const paths = Array.isArray(data.paths) ? data.paths.filter(path => typeof path === "string") : [];
  const blocks = Array.isArray(data.blocks) ? data.blocks : [];
  const label = new Map();
  for (const entry of blocks) {
    if (!entry || typeof entry.path !== "string") continue;
    const name = entry.block ?? entry.region ?? null;
    if (typeof name === "string" && name.length > 0) label.set(entry.path, name);
  }
  const names = new Set([...paths, ...label.keys()]);
  return [...names].map(path => label.has(path) ? { path, block: label.get(path) } : path);
}

function roomLike(registry, roomId) {
  return { workClaims: typeof registry.rawConfig === "function" ? registry.rawConfig(roomId) : {} };
}

function commit(store, roomId, actorId, item, action, nowMs) {
  store.workClaims.set(roomId, item);
  emitWorkClaimEvent(store, roomId, { actorId, item, action, atMs: nowMs });
  return item;
}

function claimBoard(store, roomId, actorId, id, data, nowMs) {
  const registry = store.workClaims;
  const files = filesFrom(data);
  const fields = {
    files: files.length ? files : undefined,
    pullRequests: Array.isArray(data.pullRequests) ? data.pullRequests : undefined,
    repo: typeof data.repository === "string" ? data.repository : undefined,
    branch: typeof data.ref === "string" ? data.ref : undefined
  };
  let item = registry.get(roomId, id);
  if (!item) {
    const config = typeof registry.configFor === "function"
      ? registry.configFor(roomId)
      : roomWorkClaimConfig(roomLike(registry, roomId));
    const open = openClaimCount(registry.list(roomId), nowMs);
    if (open >= config.maxOpenClaims) {
      const error = new Error(`This room already has ${config.maxOpenClaims} open claims. Close stale claims (close or cancel) before opening another.`);
      error.status = 409;
      error.code = "work_board_full";
      throw error;
    }
    item = createWork({
      id, title: data.workItemId, workItemId: data.workItemId,
      files: fields.files, pullRequests: fields.pullRequests, repo: fields.repo, branch: fields.branch
    }, { now: nowMs, agentId: actorId });
    // PRODUCT-200 D4 (2026-10-09): the board write must emit its room
    // event at the mutation site. A bare registry.set here left the create
    // invisible to the event stream (event-replay could not rebuild the
    // board: a "claimed" event for an item that was never "created").
    // The mirror's commit() writes the row and emits, like the routes'.
    commit(store, roomId, actorId, item, "created", nowMs);
  }
  if (item.state !== "unclaimed") return item;
  const held = registry.list(roomId).filter(entry => entry.owner === actorId && ACTIVE.has(entry.state)).length;
  const config = typeof registry.configFor === "function"
    ? registry.configFor(roomId)
    : roomWorkClaimConfig(roomLike(registry, roomId));
  if (held >= config.maxMemberOpenClaims) {
    const error = new Error(`You already hold ${config.maxMemberOpenClaims} open claims. Release or finish one before claiming another.`);
    error.status = 409;
    error.code = "too_many_open_claims";
    throw error;
  }
  const claimed = claimWork(item, actorId, { ...fields, room: roomLike(registry, roomId), now: nowMs });
  return commit(store, roomId, actorId, claimed, "claimed", nowMs);
}

function occupiedSuccessor(registry, roomId, sourceId, nextId) {
  const existing = registry.get(roomId, nextId);
  if (!existing || !ACTIVE.has(existing.state)) return false;
  return !(Array.isArray(existing.dependsOn) && existing.dependsOn.includes(sourceId));
}

function refuseOccupiedSuccessor(nextId, sourceId) {
  const error = new Error(`Board card ${nextId} is already claimed. It is not a successor of ${sourceId}.`);
  error.status = 409;
  error.code = "work_claim_conflict";
  throw error;
}

function successor(store, roomId, actorId, sourceId, nextId, title, nowMs) {
  const registry = store.workClaims;
  if (registry.get(roomId, nextId)) return registry.get(roomId, nextId);
  const created = createWork({
    id: nextId, title: title || nextId, dependsOn: [sourceId], workItemId: nextId
  }, { now: nowMs, agentId: actorId });
  return commit(store, roomId, actorId, created, "created", nowMs);
}

export function mirrorProjectionClaim(store, roomId, actorId, incoming) {
  const registry = store?.workClaims;
  if (!registry || typeof registry.get !== "function" || typeof registry.set !== "function") return null;
  const data = incoming?.data ?? {};
  if (typeof data.workItemId !== "string" || !data.workItemId) return null;
  const nowMs = Date.parse(incoming.at);
  if (!Number.isFinite(nowMs)) return null;
  const id = boardClaimId(data.workItemId);
  if (incoming.type === "claim.acquired") return claimBoard(store, roomId, actorId, id, data, nowMs);
  if (incoming.type === "claim.renewed") {
    const item = registry.get(roomId, id);
    if (!item || item.state === "unclaimed" || item.owner !== actorId) return claimBoard(store, roomId, actorId, id, data, nowMs);
    return commit(store, roomId, actorId, renewWork(item, actorId, { room: roomLike(registry, roomId), now: nowMs }), "renewed", nowMs);
  }
  if (incoming.type === "claim.released") {
    let item = registry.get(roomId, id);
    if (!item || item.state === "unclaimed" || item.state === "done" || item.state === "closed") return item;
    if (item.state === "in_progress" || item.state === "blocked") {
      item = updateWork(item, actorId, { state: "claimed", note: "paused for release", now: nowMs, authority: item.owner !== actorId });
      registry.set(roomId, item);
    }
    return commit(store, roomId, actorId, updateWork(item, actorId, {
      state: "unclaimed", note: "released", now: nowMs, authority: item.owner !== actorId
    }), "released", nowMs);
  }
  if (incoming.type === "work.handoff_recorded") {
    const nextId = boardClaimId(`${data.workItemId}-next`);
    if (occupiedSuccessor(registry, roomId, id, nextId)) refuseOccupiedSuccessor(nextId, id);
    claimBoard(store, roomId, actorId, id, data, nowMs);
    const source = registry.get(roomId, id);
    const link = { kind: "handoff", targetId: nextId, at: incoming.at, actorId, note: data.nextAction ?? null };
    const chained = { ...source, chain: Object.freeze([...(source.chain ?? []), link].slice(-20)) };
    commit(store, roomId, actorId, chained, "state_changed", nowMs);
    return successor(store, roomId, actorId, id, nextId, data.nextAction, nowMs);
  }
  if (incoming.type === "work.superseded") {
    const nextId = boardClaimId(data.supersededByWorkItemId);
    if (occupiedSuccessor(registry, roomId, id, nextId)) refuseOccupiedSuccessor(nextId, id);
    let source = registry.get(roomId, id);
    if (!source) source = commit(store, roomId, actorId, createWork({ id, title: data.workItemId, workItemId: data.workItemId }, { now: nowMs, agentId: actorId }), "created", nowMs);
    const link = { kind: "supersede", targetId: nextId, at: incoming.at, actorId, note: data.reason ?? null };
    commit(store, roomId, actorId, {
      ...source,
      supersededBy: nextId,
      chain: Object.freeze([...(source.chain ?? []), link].slice(-20))
    }, "state_changed", nowMs);
    return successor(store, roomId, actorId, id, nextId, data.supersededByWorkItemId, nowMs);
  }
  return null;
}
