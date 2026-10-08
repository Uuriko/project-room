// Projection claim commands (MCP and the work-item form) write the same
// work-claims board the REST routes use. A handoff or supersede leaves a
// successor card that depends on the source, so the chain is visible there.
import { createWork, claimWork, renewWork, updateWork, roomWorkClaimConfig, HELD_CLAIM_STATES } from "./work-claims.mjs";
import { emitWorkClaimEvent } from "./work-claim-events.mjs";

const BOARD_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function boardClaimId(workItemId) {
  if (typeof workItemId === "string" && BOARD_ID.test(workItemId)) return workItemId;
  const cleaned = String(workItemId ?? "").replace(/[^A-Za-z0-9_-]/g, "_").replace(/^_+/, "").slice(0, 120);
  return BOARD_ID.test(cleaned) ? cleaned : "workitem";
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
  const receipt = emitWorkClaimEvent(store, roomId, { actorId, item, action, atMs: nowMs });
  // createdSeq comes from the server-side journal sequence — stamp it on
  // creates with a silent second write (the event already went out).
  const seq = receipt?.sequence;
  if (action === "created" && Number.isSafeInteger(seq) && item.createdSeq !== seq) {
    const stamped = { ...item, createdSeq: seq };
    store.workClaims.set(roomId, stamped);
    return stamped;
  }
  return item;
}

function claimBoard(store, roomId, actorId, id, data, nowMs) {
  const registry = store.workClaims;
  // Atomic CAS end-to-end (collision-qa W5): the cap check, the
  // already-claimed check and the write share one transaction — no
  // check-then-set race against a concurrent claim on another transport.
  const tx = typeof registry.transaction === "function" ? registry.transaction : fn => fn();
  return tx(() => claimBoardInner(store, roomId, actorId, id, data, nowMs));
}

function claimBoardInner(store, roomId, actorId, id, data, nowMs) {
  const registry = store.workClaims;
  const files = filesFrom(data);
  const fields = {
    files: files.length ? files : undefined,
    pullRequests: Array.isArray(data.pullRequests) ? data.pullRequests : undefined,
    repo: typeof data.repository === "string" ? data.repository : undefined,
    branch: typeof data.ref === "string" ? data.ref : undefined
  };
  const configOf = () => typeof registry.configFor === "function"
    ? registry.configFor(roomId)
    : roomWorkClaimConfig(roomLike(registry, roomId));
  let item = registry.get(roomId, id);
  if (!item) {
    const config = configOf();
    const open = registry.list(roomId).filter(entry => entry.state !== "done").length;
    if (open >= config.maxOpenClaims) {
      const error = new Error(`This room already has ${config.maxOpenClaims} open claims. Close stale claims before opening another.`);
      error.status = 409;
      error.code = "work_board_full";
      throw error;
    }
    // Files are required at creation (collide-guild addendum) unless the
    // room opted out — then the claim is marked filesDeclared:false.
    if (config.requireClaimFiles && !fields.files) {
      const error = new Error(`Work "${id}" declares no files — claim creation requires a non-empty files array (the room may set workClaims.requireClaimFiles:false)`);
      error.status = 422;
      error.code = "files_required";
      throw error;
    }
    item = createWork({
      id, title: data.workItemId, workItemId: data.workItemId,
      files: fields.files, pullRequests: fields.pullRequests, repo: fields.repo, branch: fields.branch,
      filesDeclared: Boolean(fields.files)
    }, { now: nowMs, agentId: actorId });
    registry.set(roomId, item);
  }
  if (item.state !== "unclaimed") return item;
  const held = registry.list(roomId).filter(entry => entry.owner === actorId && HELD_CLAIM_STATES.includes(entry.state)).length;
  const config = configOf();
  if (held >= config.maxMemberOpenClaims) {
    const error = new Error(`You already hold ${config.maxMemberOpenClaims} open claims. Release or finish one before claiming another.`);
    error.status = 409;
    error.code = "too_many_open_claims";
    throw error;
  }
  const claimed = claimWork(item, actorId, { ...fields, room: roomLike(registry, roomId), now: nowMs });
  return commit(store, roomId, actorId, claimed, "claimed", nowMs);
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
    // Release-atomic like the REST route: pause + release share one
    // transaction so the member's held-count drops atomically.
    const tx = typeof registry.transaction === "function" ? registry.transaction : fn => fn();
    return tx(() => {
      let item = registry.get(roomId, id);
      if (!item || item.state === "unclaimed" || item.state === "done") return item;
      if (item.state === "in_progress" || item.state === "blocked") {
        item = updateWork(item, actorId, { state: "claimed", note: "paused for release", now: nowMs, authority: item.owner !== actorId });
        registry.set(roomId, item);
      }
      return commit(store, roomId, actorId, updateWork(item, actorId, {
        state: "unclaimed", note: "released", now: nowMs, authority: item.owner !== actorId
      }), "released", nowMs);
    });
  }
  if (incoming.type === "work.handoff_recorded") {
    claimBoard(store, roomId, actorId, id, data, nowMs);
    const nextId = boardClaimId(`${data.workItemId}-next`);
    const source = registry.get(roomId, id);
    const link = { kind: "handoff", targetId: nextId, at: incoming.at, actorId, note: data.nextAction ?? null };
    const chained = { ...source, chain: Object.freeze([...(source.chain ?? []), link].slice(-20)) };
    commit(store, roomId, actorId, chained, "state_changed", nowMs);
    return successor(store, roomId, actorId, id, nextId, data.nextAction, nowMs);
  }
  if (incoming.type === "work.superseded") {
    const nextId = boardClaimId(data.supersededByWorkItemId);
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
