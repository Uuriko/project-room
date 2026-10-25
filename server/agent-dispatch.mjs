// Agent dispatch: capacity, a ranked queue, and one coordinator.
//
// The coordinator is an agent who claimed the seat, or the built-in
// fallback while the seat is empty. The fallback runs on a claim change
// and on an explicit tick. It does not run while an agent holds the seat.
// Every assignment is logged with the reason it was chosen.
//
// Collision uses declared files and function names. A project map, when
// the room has one (room_map, the shape from the code-map work), replaces
// path-prefix areas and adds the symbols parsed for those files. Ubiquitous
// files are ignored so a shared manifest is not a collision or a strength.
//
// Pure planners take snapshots. AgentDispatch is the room's book.

import { randomBytes } from "node:crypto";
import { ServiceError } from "./service-error.mjs";

export const DISPATCH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;
const SAMPLE_GAP_MS = 60 * 1000;
const LOG_KEEP = 200;
const DUPLICATE_JACCARD = 0.7;
const BIG_FILE_COUNT = 4;
const STALL_MERGED_PER_DAY = 0.25;
const STALL_FAILURE_RATE = 0.5;

export const VALUE = Object.freeze({
  failingCheck: 90,
  finishPrs: 85,
  urgent: 80,
  collision: 75,
  duplicate: 68,
  high: 60,
  fixPlan: 50,
  board: 40,
  low: 20
});

// Same paths the code map treats as ubiquitous. A shared pin or manifest
// is not a person's strength and is not a reason to refuse an assignment.
export const UBIQUITOUS_FILES = new Set([
  "scripts/CANDIDATE-MANIFEST.json",
  "docs/openapi.yaml",
  "scripts/runtime-package.mjs",
  "server/store.mjs",
  "server/http.mjs",
  "plugins/project-room/skills/project-room/references/errors-catalog.md",
  "skills/project-room/references/errors-catalog.md"
]);

const ACTIVE = new Set(["claimed", "in_progress", "blocked", "delivered"]);
const TERMINAL = new Set(["done", "closed"]);

export const agentDispatchSchema = `
  CREATE TABLE IF NOT EXISTS agent_dispatch (
    room_id TEXT NOT NULL,
    key TEXT NOT NULL,
    payload TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, key)
  );
`;

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };

export function normalizePath(value) {
  if (typeof value !== "string") return null;
  let path = value.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, "");
  if (!path || path.length > 300 || path.includes("\0") || path.split("/").some(part => part === ".." || part === "")) return null;
  while (path.endsWith("/") && path.length > 1) path = path.slice(0, -1);
  return path;
}

export function normalizeProjectMap(raw) {
  if (!raw || typeof raw !== "object") return null;
  const files = {};
  const source = raw.files;
  const entries = Array.isArray(source) ? source : source && typeof source === "object" ? Object.entries(source).map(([path, row]) => ({ path, ...(row ?? {}) })) : [];
  for (const row of entries) {
    const path = normalizePath(row?.path);
    if (!path) continue;
    const symbols = Array.isArray(row.symbols) ? row.symbols.filter(name => typeof name === "string" && name.length > 0 && name.length <= 80) : [];
    const area = typeof row.area === "string" && row.area.trim() ? row.area.trim().slice(0, 120) : null;
    files[path] = { symbols: [...new Set(symbols)].sort(), area };
  }
  return Object.keys(files).length ? { files } : null;
}

export function areaForPath(path, projectMap) {
  const mapped = projectMap?.files?.[path]?.area;
  if (mapped) return mapped;
  const slash = path.indexOf("/");
  return slash === -1 ? "root" : path.slice(0, slash);
}

function symbolsFor(path, fileBlocks, projectMap) {
  const named = [];
  const block = fileBlocks?.[path];
  if (typeof block === "string" && block) named.push(block);
  const mapped = projectMap?.files?.[path]?.symbols ?? [];
  return [...new Set([...named, ...mapped])].sort();
}

function touchesOf(files, fileBlocks, projectMap) {
  const touches = [];
  for (const file of files ?? []) {
    const path = normalizePath(file);
    if (!path || UBIQUITOUS_FILES.has(path)) continue;
    touches.push({ path, symbols: symbolsFor(path, fileBlocks, projectMap) });
  }
  touches.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return touches;
}

function keysOf(touches) {
  const keys = new Set();
  for (const touch of touches) {
    keys.add(`file:${touch.path}`);
    for (const symbol of touch.symbols) keys.add(`sym:${touch.path}:${symbol}`);
  }
  return keys;
}

function overlapKey(left, right) {
  for (const key of left) if (right.has(key)) return key;
  return null;
}

function pullsOf(claim) {
  if (Array.isArray(claim.pullRequests) && claim.pullRequests.length) return claim.pullRequests.filter(Boolean);
  return claim.pullRequest ? [claim.pullRequest] : [];
}

function timeOf(claim) {
  const stamp = claim.updatedAt ?? claim.completedAt ?? claim.history?.at?.(-1)?.at;
  if (typeof stamp === "number" && Number.isFinite(stamp)) return stamp;
  const parsed = Date.parse(stamp ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

function ciFailed(claim) {
  if (pullsOf(claim).some(pull => /fail|error/i.test(pull?.ciStatus?.state ?? ""))) return true;
  const ci = claim.ci;
  if (typeof ci === "string" && /fail|error/i.test(ci)) return true;
  if (ci && typeof ci === "object" && /fail|error/i.test(String(ci.state ?? ""))) return true;
  return Array.isArray(claim.checks) && claim.checks.some(check => check?.result === "fail" || check?.result === "error");
}

function failingLabel(claim) {
  for (const pull of pullsOf(claim)) {
    const state = pull?.ciStatus?.state;
    if (typeof state === "string" && /fail|error/i.test(state)) return state;
  }
  const failed = (claim.checks ?? []).find(check => check?.result === "fail" || check?.result === "error");
  return failed?.name || "failing check";
}

function boardValue(claim) {
  const tags = Array.isArray(claim.tags) ? claim.tags.map(tag => String(tag).toLowerCase()) : [];
  for (const tag of tags) {
    const valued = /^value:(\d{1,3})$/.exec(tag);
    if (valued) return Math.min(100, Number(valued[1]));
  }
  if (tags.includes("urgent")) return VALUE.urgent;
  if (tags.includes("high")) return VALUE.high;
  if (tags.includes("low")) return VALUE.low;
  return VALUE.board;
}

function jaccard(left, right) {
  const a = new Set(left);
  const b = new Set(right);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared += 1;
  return shared / (a.size + b.size - shared);
}

function isSubset(smaller, larger) {
  if (smaller.length < 2) return false;
  const set = new Set(larger);
  return smaller.every(file => set.has(file));
}

function filesOf(claim) {
  return (claim.files ?? []).map(normalizePath).filter(path => path && !UBIQUITOUS_FILES.has(path));
}

const taskBase = (partial) => Object.freeze({
  blocked: false,
  assignable: true,
  onlyMemberId: null,
  holders: Object.freeze([]),
  claimIds: Object.freeze([]),
  ...partial,
  touches: Object.freeze(partial.touches ?? [])
});

export function buildWorkQueue({ claims = [], fixPlans = [], projectMap = null } = {}) {
  const list = claims.filter(claim => claim && typeof claim.id === "string");
  const done = new Set(list.filter(claim => claim.state === "done" && !claim.premiseFlag && !claim.supersededBy).map(claim => claim.id));
  const tasks = [];
  const open = list.filter(claim => !TERMINAL.has(claim.state) && claim.state !== "unclaimed");
  const collisionClaims = open.map(claim => ({
    id: claim.id,
    status: claim.state,
    lane: claim.owner ?? null,
    files: filesOf(claim)
  }));
  const byFile = new Map();
  for (const claim of collisionClaims) {
    for (const file of claim.files) {
      if (!byFile.has(file)) byFile.set(file, []);
      byFile.get(file).push(claim);
    }
  }
  const collidingIds = new Set();
  const collisionFiles = [];
  for (const [file, holders] of byFile) {
    const ids = [...new Set(holders.map(holder => holder.id))];
    if (ids.length < 2) continue;
    collisionFiles.push(file);
    for (const id of ids) collidingIds.add(id);
  }
  if (collisionFiles.length) {
    const holders = [...new Set(open.filter(claim => collidingIds.has(claim.id)).map(claim => claim.owner).filter(Boolean))].sort();
    tasks.push(taskBase({
      key: `collision:${collisionFiles.slice().sort().join("|")}`,
      source: "collision",
      title: `Overlap on ${collisionFiles.slice().sort().slice(0, 3).join(", ")}`,
      value: VALUE.collision,
      assignable: false,
      holders,
      claimIds: [...collidingIds].sort(),
      touches: touchesOf(collisionFiles, {}, projectMap),
      reason: "These open claims name the same files. The queue keeps the finding and does not hand the files to another agent."
    }));
  }

  const comparable = list.filter(claim => !TERMINAL.has(claim.state));
  const duplicateIds = new Set();
  const pairs = [];
  for (let i = 0; i < comparable.length; i += 1) {
    for (let j = i + 1; j < comparable.length; j += 1) {
      const left = filesOf(comparable[i]);
      const right = filesOf(comparable[j]);
      if (left.length < 2 || right.length < 2) continue;
      if (jaccard(left, right) >= DUPLICATE_JACCARD || isSubset(left, right) || isSubset(right, left)) {
        pairs.push([comparable[i], comparable[j]]);
        duplicateIds.add(comparable[i].id);
        duplicateIds.add(comparable[j].id);
      }
    }
  }
  for (const [left, right] of pairs) {
    const unclaimed = [left, right].filter(claim => claim.state === "unclaimed");
    const kept = unclaimed[0] ?? left;
    tasks.push(taskBase({
      key: `duplicate:${[left.id, right.id].sort().join("|")}`,
      source: "duplicate",
      title: `Duplicate work: ${left.title ?? left.id} and ${right.title ?? right.id}`,
      value: VALUE.duplicate,
      assignable: unclaimed.length > 0,
      onlyMemberId: unclaimed.length ? null : (left.owner ?? null),
      holders: [left.owner, right.owner].filter(Boolean),
      claimIds: [left.id, right.id].sort(),
      touches: touchesOf(filesOf(kept), kept.fileBlocks, projectMap),
      reason: unclaimed.length
        ? "Two items name nearly the same files. Assign one and leave the other unassigned."
        : "Both copies are already held. Shown so the coordinator does not start a third."
    }));
  }

  for (const claim of open) {
    if (!ciFailed(claim) || !claim.owner) continue;
    tasks.push(taskBase({
      key: `check:${claim.id}:${failingLabel(claim)}`,
      source: "failing_check",
      title: `Fix ${failingLabel(claim)} on ${claim.title ?? claim.id}`,
      value: VALUE.failingCheck,
      onlyMemberId: claim.owner,
      holders: [claim.owner],
      claimIds: [claim.id],
      touches: touchesOf(filesOf(claim), claim.fileBlocks, projectMap),
      reason: "A failing check is routed to the claim's owner."
    }));
  }

  for (const plan of fixPlans) {
    if (!plan || typeof plan.id !== "string") continue;
    const files = (plan.files ?? []).map(normalizePath).filter(Boolean);
    const unmet = (plan.blockedBy ?? []).filter(id => !done.has(id));
    tasks.push(taskBase({
      key: `fix:${plan.id}`,
      source: "fix_plan",
      title: plan.title || plan.id,
      value: Number.isFinite(plan.value) ? Math.max(0, Math.min(100, plan.value)) : VALUE.fixPlan,
      blocked: unmet.length > 0,
      touches: touchesOf(files, {}, projectMap),
      claimIds: Object.freeze([]),
      reason: unmet.length ? `Waiting on ${unmet.join(", ")}.` : "Fix-plan item."
    }));
  }

  for (const claim of list) {
    if (claim.state !== "unclaimed" || claim.premiseFlag || claim.supersededBy) continue;
    if (duplicateIds.has(claim.id)) continue;
    const unmet = (claim.dependsOn ?? []).filter(id => !done.has(id));
    tasks.push(taskBase({
      key: `board:${claim.id}`,
      source: "board",
      title: claim.title ?? claim.id,
      value: boardValue(claim),
      blocked: unmet.length > 0,
      claimIds: [claim.id],
      touches: touchesOf(filesOf(claim), claim.fileBlocks, projectMap),
      reason: unmet.length ? `Waiting on ${unmet.join(", ")}.` : "Board item with its dependencies done."
    }));
  }

  tasks.sort(compareTasks);
  const openCount = Math.max(1, open.length);
  return Object.freeze({
    tasks: Object.freeze(tasks),
    collisionRate: collidingIds.size / openCount,
    duplicateRate: duplicateIds.size / Math.max(1, comparable.length),
    collidingClaims: collidingIds.size,
    duplicateClaims: duplicateIds.size
  });
}

function compareTasks(a, b) {
  if (a.blocked !== b.blocked) return a.blocked ? 1 : -1;
  if (a.value !== b.value) return b.value - a.value;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

export function agentCapacity({ agents = [], claims = [], assignments = [], now = Date.now(), windowMs = DISPATCH_WINDOW_MS, projectMap = null } = {}) {
  const since = now - windowMs;
  const days = windowMs / DAY_MS;
  const accepted = assignments.filter(row => row.status === "accepted");
  const offered = assignments.filter(row => row.status === "offered");
  return agents.filter(agent => agent && typeof agent.memberId === "string").map(agent => {
    const mine = claims.filter(claim => claim?.owner === agent.memberId);
    const activeClaims = mine.filter(claim => ACTIVE.has(claim.state));
    const openPrs = [];
    for (const claim of activeClaims) {
      for (const pull of pullsOf(claim)) {
        if (pull && pull.outcome !== "merged" && pull.outcome !== "closed") {
          openPrs.push({ claimId: claim.id, url: pull.url ?? null, number: pull.number ?? null });
        }
      }
    }
    const merged = mine.filter(claim => claim.state === "done" && pullsOf(claim).some(pull => pull?.outcome === "merged") && (timeOf(claim) ?? 0) >= since);
    const failedClosed = mine.filter(claim => TERMINAL.has(claim.state) && pullsOf(claim).some(pull => pull?.outcome === "closed") && (timeOf(claim) ?? 0) >= since);
    const failedOpen = activeClaims.filter(ciFailed);
    const failed = failedClosed.length + failedOpen.length;
    const attempts = merged.length + failed;
    const areas = new Map();
    for (const claim of merged) {
      for (const path of filesOf(claim)) {
        const area = areaForPath(path, projectMap);
        areas.set(area, (areas.get(area) ?? 0) + 1);
      }
    }
    const busy = activeClaims.length > 0 || accepted.some(row => row.memberId === agent.memberId);
    const mergedPerDay = merged.length / days;
    const failureRate = attempts === 0 ? 0 : failed / attempts;
    const stalled = openPrs.length > 0 && (mergedPerDay < STALL_MERGED_PER_DAY || failureRate >= STALL_FAILURE_RATE);
    return Object.freeze({
      memberId: agent.memberId,
      displayName: agent.displayName || agent.memberId,
      identityId: agent.identityId ?? null,
      status: busy ? "busy" : "idle",
      stalled,
      claims: Object.freeze(activeClaims.map(claim => ({ id: claim.id, title: claim.title ?? claim.id, state: claim.state }))),
      openPrs: Object.freeze(openPrs),
      mergedPerDay: Math.round(mergedPerDay * 1000) / 1000,
      merged: merged.length,
      failureRate: Math.round(failureRate * 1000) / 1000,
      strengths: Object.freeze([...areas.entries()].map(([area, count]) => Object.freeze({ area, merged: count })).sort((a, b) => b.merged - a.merged || (a.area < b.area ? -1 : 1))),
      offered: offered.some(row => row.memberId === agent.memberId)
    });
  });
}

function finishTask(agent, claims, projectMap) {
  const active = claims.filter(claim => claim.owner === agent.memberId && ACTIVE.has(claim.state));
  const files = [];
  const ids = [];
  for (const claim of active) {
    if (!pullsOf(claim).some(pull => pull && pull.outcome !== "merged" && pull.outcome !== "closed")) continue;
    ids.push(claim.id);
    files.push(...filesOf(claim));
  }
  if (!ids.length) return null;
  return taskBase({
    key: `finish:${agent.memberId}`,
    source: "finish_prs",
    title: "Finish or rebase your open pulls",
    value: VALUE.finishPrs,
    onlyMemberId: agent.memberId,
    holders: [agent.memberId],
    claimIds: ids,
    touches: touchesOf(files, {}, projectMap),
    reason: `${agent.displayName} has ${ids.length} open pull${ids.length === 1 ? "" : "s"} and ${agent.mergedPerDay} merged per day. Finish those before starting new work.`
  });
}

function suitability(agent, task, projectMap) {
  const areas = new Set((task.touches ?? []).map(touch => areaForPath(touch.path, projectMap)));
  let score = 0;
  for (const area of areas) score += agent.strengths.find(row => row.area === area)?.merged ?? 0;
  return score;
}

function reservedKeys(active, memberId, holders) {
  const keys = new Set();
  const allowed = new Set(holders ?? []);
  for (const row of active) {
    if (row.memberId === memberId && allowed.has(memberId)) continue;
    if (row.memberId === memberId && row.own) continue;
    for (const key of row.keys) keys.add(key);
  }
  return keys;
}

export function splitTask(task, projectMap) {
  if (!task?.assignable || task.blocked) return [task];
  if (task.source === "finish_prs" || task.source === "failing_check" || task.source === "collision" || task.source === "duplicate") return [task];
  const groups = new Map();
  for (const touch of task.touches ?? []) {
    const area = areaForPath(touch.path, projectMap);
    if (!groups.has(area)) groups.set(area, []);
    groups.get(area).push(touch);
  }
  const wide = (task.touches ?? []).length >= BIG_FILE_COUNT || groups.size >= 2;
  if (!wide || groups.size < 2) return [task];
  return [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([area, touches]) => taskBase({
    ...task,
    key: `${task.key}#${area}`,
    title: `${task.title} (${area})`,
    parentKey: task.key,
    touches,
    reason: `Split of ${task.key} on ${area}, with no files shared with the other pieces.`
  }));
}

function pairScore(agent, task, active, declines, projectMap) {
  if (!task.assignable || task.blocked) return null;
  if (task.onlyMemberId && task.onlyMemberId !== agent.memberId) return null;
  if (declines.has(`${agent.memberId}|${task.key}`)) return null;
  // A stall prefers finishing open pulls. Declining that offer is not a stop:
  // the agent can take other work, and the finish offer is not repeated.
  if (agent.stalled && task.source !== "finish_prs" && !declines.has(`${agent.memberId}|finish:${agent.memberId}`)) return null;
  const keys = keysOf(task.touches ?? []);
  keys.add(`task:${task.key}`);
  const hit = overlapKey(keys, reservedKeys(active, agent.memberId, task.holders));
  if (hit) return null;
  const fit = suitability(agent, task, projectMap);
  return task.value * 1000 + fit * 10 - agent.failureRate;
}

function reasonFor(agent, task, seatLabel, projectMap) {
  const areas = [...new Set((task.touches ?? []).map(touch => areaForPath(touch.path, projectMap)))];
  const fit = agent.strengths.filter(row => areas.includes(row.area)).map(row => `${row.merged} merged in ${row.area}`);
  const fitText = fit.length ? ` ${agent.displayName} has ${fit.join(", ")}.` : "";
  return `${seatLabel} ${agent.displayName} is ${agent.status}, ${task.title} is the highest unblocked task that does not overlap another agent's files, and it matches their record.${fitText} ${task.reason}`;
}

export function planAssignments({ agents, tasks, active = [], declines = new Set(), projectMap = null, seatMode = "fallback", paused = false, actor = { role: "hook" } } = {}) {
  if (paused) return { assignments: [], skipped: "paused" };
  const holder = actor.role === "holder" || actor.role === "owner";
  if (seatMode === "agent" && !holder) return { assignments: [], skipped: "seat_held" };
  const seatLabel = seatMode === "agent" ? "The coordinator assigned this." : "The fallback assigned this because the coordinator seat is empty.";
  const queue = [...tasks];
  for (const agent of agents) {
    if (!agent.stalled) continue;
    if (declines.has(`${agent.memberId}|finish:${agent.memberId}`)) continue;
    if (queue.some(task => task.key === `finish:${agent.memberId}`)) continue;
    const task = finishTask(agent, agent.openClaims ?? [], projectMap);
    if (task) queue.push(task);
  }
  queue.sort(compareTasks);
  const remaining = agents.filter(agent => !agent.offered && (agent.status === "idle" || agent.stalled));
  const taken = new Set();
  const assignments = [];
  const usedAgents = new Set();
  const working = [...queue];
  while (remaining.some(agent => !usedAgents.has(agent.memberId)) && working.length) {
    let best = null;
    for (const task of working) {
      if (taken.has(task.key) || taken.has(task.parentKey)) continue;
      for (const agent of remaining) {
        if (usedAgents.has(agent.memberId)) continue;
        const score = pairScore(agent, task, active, declines, projectMap);
        if (score === null) continue;
        if (!best || score > best.score || (score === best.score && (agent.memberId < best.agent.memberId || (agent.memberId === best.agent.memberId && task.key < best.task.key)))) {
          best = { score, agent, task };
        }
      }
    }
    if (!best) break;
    const pieces = splitTask(best.task, projectMap);
    const pieceAgents = [];
    if (pieces.length > 1) {
      const free = remaining.filter(agent => !usedAgents.has(agent.memberId));
      if (free.length >= 2) {
        const usedPieces = new Set();
        for (const piece of pieces) {
          let pick = null;
          for (const agent of free) {
            if (usedPieces.has(agent.memberId)) continue;
            const score = pairScore(agent, piece, active, declines, projectMap);
            if (score === null) continue;
            if (!pick || score > pick.score || (score === pick.score && agent.memberId < pick.agent.memberId)) pick = { score, agent };
          }
          if (!pick) continue;
          usedPieces.add(pick.agent.memberId);
          pieceAgents.push({ agent: pick.agent, task: piece });
        }
      }
    }
    const chosen = pieceAgents.length >= 2 ? pieceAgents : [{ agent: best.agent, task: best.task }];
    for (const row of chosen) {
      usedAgents.add(row.agent.memberId);
      taken.add(row.task.key);
      if (row.task.parentKey) taken.add(row.task.parentKey);
      const reason = row.task.source === "finish_prs" ? `${seatLabel} ${row.task.reason}` : reasonFor(row.agent, row.task, seatLabel, projectMap);
      assignments.push({ memberId: row.agent.memberId, displayName: row.agent.displayName, identityId: row.agent.identityId, task: row.task, reason });
      active.push({ memberId: row.agent.memberId, keys: keysOf(row.task.touches ?? []), own: false });
    }
    const index = working.findIndex(task => task.key === best.task.key);
    if (index >= 0) working.splice(index, 1);
  }
  return { assignments, skipped: null };
}

export function metricsOf({ capacity, queue, samples = [], now = Date.now(), windowMs = DISPATCH_WINDOW_MS } = {}) {
  const agents = capacity.length;
  const busy = capacity.filter(agent => agent.status === "busy").length;
  const recent = samples.filter(sample => now - sample.at <= windowMs && sample.agents > 0);
  const busyShare = recent.length
    ? recent.reduce((sum, sample) => sum + sample.busy / sample.agents, 0) / recent.length
    : (agents ? busy / agents : 0);
  const mergedPerDay = capacity.reduce((sum, agent) => sum + agent.mergedPerDay, 0);
  return Object.freeze({
    agents,
    busy,
    busyShare: Math.round(busyShare * 1000) / 1000,
    busyShareBasis: recent.length > 1 ? "window" : "now",
    mergedPerDay: Math.round(mergedPerDay * 1000) / 1000,
    perAgent: Object.freeze(capacity.map(agent => Object.freeze({
      displayName: agent.displayName,
      status: agent.status,
      mergedPerDay: agent.mergedPerDay
    }))),
    duplicateRate: Math.round((queue?.duplicateRate ?? 0) * 1000) / 1000,
    collisionRate: Math.round((queue?.collisionRate ?? 0) * 1000) / 1000,
    windowDays: windowMs / DAY_MS
  });
}

const VIEW_NAMES = new Set(["all", "capacity", "queue", "metrics"]);

export function sliceView(view, name = "all") {
  const which = name ?? "all";
  if (!VIEW_NAMES.has(which)) fail(422, "invalid_dispatch", "view must be all, capacity, queue, or metrics");
  if (which === "capacity") return { roomId: view.roomId, seat: view.seat, paused: view.paused, capacity: view.capacity };
  if (which === "queue") return { roomId: view.roomId, queue: view.queue, assignments: view.assignments };
  if (which === "metrics") return { roomId: view.roomId, seat: view.seat, paused: view.paused, metrics: view.metrics };
  return view;
}

export function actOnDispatch(store, roomId, actor, body = {}) {
  const action = body.action;
  if (action === "tick") return store.agentDispatch.tick(roomId, actor);
  if (action === "respond") return store.agentDispatch.respond(roomId, actor, body);
  if (action === "claim_seat") return store.agentDispatch.claimSeat(roomId, actor, "claim");
  if (action === "release_seat") return store.agentDispatch.claimSeat(roomId, actor, "release");
  if (action === "pause" || action === "resume" || action === "seat" || action === "assign") {
    return store.agentDispatch.override(roomId, actor, body);
  }
  if (action === "fix_plan") return store.agentDispatch.addFixPlan(roomId, actor, body);
  fail(422, "invalid_dispatch", "action must be tick, respond, claim_seat, release_seat, assign, pause, resume, seat, or fix_plan");
}

function parse(row) {
  try { return JSON.parse(row.payload); }
  catch { return null; }
}

export class AgentDispatch {
  constructor(store) {
    this.store = store;
  }

  now() {
    return typeof this.store.now === "function" ? this.store.now() : Date.now();
  }

  ensure() {
    this.store.db.exec(agentDispatchSchema);
  }

  onClaimsChanged(roomId) {
    try { this.tick(roomId, { role: "hook" }); }
    catch { /* a dispatch failure must not roll back the claim write */ }
  }

  rows(roomId) {
    this.ensure();
    return this.store.db.prepare("SELECT key, payload, updated_at AS updatedAt FROM agent_dispatch WHERE room_id=?").all(roomId);
  }

  write(roomId, key, payload, at) {
    this.store.db.prepare(`INSERT INTO agent_dispatch (room_id, key, payload, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(room_id, key) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at`)
      .run(roomId, key, JSON.stringify(payload), at);
  }

  remove(roomId, key) {
    this.store.db.prepare("DELETE FROM agent_dispatch WHERE room_id=? AND key=?").run(roomId, key);
  }

  book(roomId) {
    const rows = this.rows(roomId);
    const assignments = [];
    const declines = new Set();
    const fixPlans = [];
    const samples = [];
    const log = [];
    let seat = { mode: "fallback", memberId: null, claimedAt: null };
    let paused = false;
    let logSeq = 0;
    for (const row of rows) {
      const payload = parse(row);
      if (!payload) continue;
      if (row.key === "seat") seat = { mode: payload.mode === "agent" ? "agent" : "fallback", memberId: payload.memberId ?? null, claimedAt: payload.claimedAt ?? null };
      else if (row.key === "meta") { paused = payload.paused === true; logSeq = payload.logSeq ?? 0; }
      else if (row.key.startsWith("assignment:")) assignments.push(payload);
      else if (row.key.startsWith("decline:")) declines.add(row.key.slice("decline:".length));
      else if (row.key.startsWith("fix:")) fixPlans.push(payload);
      else if (row.key.startsWith("sample:")) samples.push(payload);
      else if (row.key.startsWith("log:")) log.push(payload);
    }
    log.sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1));
    return { assignments, declines, fixPlans, samples, log, seat, paused, logSeq };
  }

  snapshot(roomId) {
    const room = this.store.room(roomId);
    const state = room?.state ?? {};
    const members = Object.values(state.members ?? {}).filter(member => member && member.kind === "agent" && member.active !== false);
    const claims = this.store.workClaims?.list?.(roomId) ?? [];
    let projectMap = null;
    const api = this.store.projectMap;
    if (api && (typeof api.snapshot === "function" || typeof api.read === "function")) {
      try { projectMap = normalizeProjectMap(typeof api.snapshot === "function" ? api.snapshot(roomId) : api.read(roomId)); }
      catch { projectMap = null; }
    }
    const identities = new Map();
    try {
      for (const row of this.store.db.prepare("SELECT member_id AS memberId, identity_id AS identityId FROM identity_links WHERE room_id=?").all(roomId)) {
        identities.set(row.memberId, row.identityId);
      }
    } catch { /* a store without the link table has no wake target */ }
    return {
      ownerId: state.room?.ownerId ?? null,
      agents: members.map(member => ({
        memberId: member.id,
        displayName: member.displayName || member.id,
        identityId: member.identityId ?? identities.get(member.id) ?? null
      })),
      claims,
      projectMap
    };
  }

  view(roomId) {
    const at = this.now();
    const snap = this.snapshot(roomId);
    const book = this.book(roomId);
    this.settleAssignments(roomId, book, snap.claims, at);
    const capacity = agentCapacity({
      agents: snap.agents,
      claims: snap.claims,
      assignments: book.assignments,
      now: at,
      projectMap: snap.projectMap
    }).map(agent => ({ ...agent, openClaims: snap.claims.filter(claim => claim.owner === agent.memberId && ACTIVE.has(claim.state)) }));
    const queue = buildWorkQueue({ claims: snap.claims, fixPlans: book.fixPlans, projectMap: snap.projectMap });
    const metrics = metricsOf({ capacity, queue, samples: book.samples, now: at });
    return {
      roomId,
      seat: book.seat,
      paused: book.paused,
      capacity: capacity.map(agent => ({
        memberId: agent.memberId,
        displayName: agent.displayName,
        status: agent.status,
        stalled: agent.stalled,
        claims: agent.claims,
        openPrs: agent.openPrs,
        mergedPerDay: agent.mergedPerDay,
        failureRate: agent.failureRate,
        strengths: agent.strengths
      })),
      queue: queue.tasks.map(task => ({
        key: task.key,
        source: task.source,
        title: task.title,
        value: task.value,
        blocked: task.blocked,
        assignable: task.assignable,
        onlyMemberId: task.onlyMemberId,
        files: task.touches.map(touch => touch.path),
        reason: task.reason
      })),
      assignments: book.assignments.filter(row => row.status === "offered" || row.status === "accepted"),
      metrics,
      log: book.log.slice(0, 40)
    };
  }

  settleAssignments(roomId, book, claims, at) {
    const byId = new Map(claims.map(claim => [claim.id, claim]));
    for (const row of book.assignments) {
      if (row.status !== "offered" && row.status !== "accepted") continue;
      const finished = (row.claimIds ?? []).length > 0 && (row.claimIds ?? []).every(id => {
        const claim = byId.get(id);
        return claim && TERMINAL.has(claim.state);
      });
      if (!finished) continue;
      row.status = "done";
      row.updatedAt = at;
      this.write(roomId, `assignment:${row.id}`, row, at);
    }
  }

  activeRows(book, claims, projectMap) {
    const rows = [];
    for (const claim of claims) {
      if (!ACTIVE.has(claim.state) || !claim.owner) continue;
      rows.push({ memberId: claim.owner, keys: keysOf(touchesOf(filesOf(claim), claim.fileBlocks, projectMap)), own: true });
    }
    for (const row of book.assignments) {
      if (row.status !== "offered" && row.status !== "accepted") continue;
      const keys = keysOf((row.files ?? []).map(path => ({ path, symbols: row.symbols?.[path] ?? [] })));
      if (row.taskKey) keys.add(`task:${row.taskKey}`);
      rows.push({ memberId: row.memberId, keys, own: false });
    }
    return rows;
  }

  tick(roomId, actor = { role: "hook" }) {
    this.ensure();
    const at = this.now();
    const snap = this.snapshot(roomId);
    const book = this.book(roomId);
    this.settleAssignments(roomId, book, snap.claims, at);
    const queue = buildWorkQueue({ claims: snap.claims, fixPlans: book.fixPlans, projectMap: snap.projectMap });
    const capacity = agentCapacity({
      agents: snap.agents, claims: snap.claims, assignments: book.assignments, now: at, projectMap: snap.projectMap
    }).map(agent => ({
      ...agent,
      openClaims: snap.claims.filter(claim => claim.owner === agent.memberId && ACTIVE.has(claim.state))
    }));
    const seatMode = book.seat.mode;
    const role = actor.role === "owner" || actor.memberId === snap.ownerId ? "owner"
      : actor.memberId && book.seat.mode === "agent" && book.seat.memberId === actor.memberId ? "holder"
        : actor.role === "hook" || actor.role === "fallback" ? "hook" : "member";
    if (role === "member" && seatMode === "agent") fail(403, "dispatch_seat_held", "The coordinator seat is held. The holder or the owner runs assignment.");
    const plan = planAssignments({
      agents: capacity,
      tasks: queue.tasks,
      active: this.activeRows(book, snap.claims, snap.projectMap),
      declines: book.declines,
      projectMap: snap.projectMap,
      seatMode,
      paused: book.paused,
      actor: { role: role === "owner" ? "owner" : role === "holder" ? "holder" : "hook" }
    });
    const created = [];
    const run = fn => this.store.db.isTransaction || typeof this.store.transaction !== "function" ? fn() : this.store.transaction(fn);
    run(() => {
      let seq = book.logSeq;
      for (const row of plan.assignments) {
        const id = `as_${randomBytes(8).toString("base64url")}`;
        const assignment = {
          id, memberId: row.memberId, displayName: row.displayName, status: "offered",
          taskKey: row.task.key, source: row.task.source, title: row.task.title,
          files: row.task.touches.map(touch => touch.path),
          symbols: Object.fromEntries(row.task.touches.map(touch => [touch.path, touch.symbols])),
          parentKey: row.task.parentKey ?? null,
          claimIds: row.task.claimIds ?? [],
          reason: row.reason, by: seatMode === "agent" ? (book.seat.memberId ?? "coordinator") : "fallback",
          createdAt: at, updatedAt: at
        };
        this.write(roomId, `assignment:${id}`, assignment, at);
        seq += 1;
        this.write(roomId, `log:${String(seq).padStart(6, "0")}`, {
          id: seq, at, action: "assign", memberId: row.memberId, taskKey: row.task.key, reason: row.reason, by: assignment.by, assignmentId: id
        }, at);
        created.push(assignment);
        if (row.identityId && this.store.agentHeartbeats?.enqueueWake) {
          try {
            this.store.agentHeartbeats.enqueueWake({ agentId: row.identityId, kind: "assignment", roomId, messageId: id });
            assignment.wake = true;
          } catch { assignment.wake = false; }
        }
      }
      const last = book.samples.at(-1);
      if (!last || at - last.at >= SAMPLE_GAP_MS) {
        const busy = capacity.filter(agent => agent.status === "busy").length;
        this.write(roomId, `sample:${at}`, { at, busy, agents: capacity.length }, at);
      }
      this.write(roomId, "meta", { paused: book.paused, logSeq: seq }, at);
      this.trimLog(roomId, seq);
    });
    return { assigned: created, skipped: plan.skipped, seat: book.seat };
  }

  trimLog(roomId, seq) {
    if (seq <= LOG_KEEP) return;
    const drop = seq - LOG_KEEP;
    this.store.db.prepare("DELETE FROM agent_dispatch WHERE room_id=? AND key LIKE 'log:%' AND key < ?")
      .run(roomId, `log:${String(drop).padStart(6, "0")}`);
  }

  respond(roomId, actor, { assignmentId, decision } = {}) {
    if (decision !== "accept" && decision !== "decline") fail(422, "invalid_dispatch", "decision must be accept or decline");
    if (typeof assignmentId !== "string" || assignmentId.length < 3) fail(422, "invalid_dispatch", "assignmentId is required");
    const book = this.book(roomId);
    const row = book.assignments.find(item => item.id === assignmentId);
    if (!row || (row.status !== "offered" && row.status !== "accepted")) fail(404, "unknown_assignment", "That assignment is not open");
    const owner = actor.memberId === this.snapshot(roomId).ownerId || actor.role === "owner";
    if (row.memberId !== actor.memberId && !owner) fail(403, "dispatch_forbidden", "Only the assigned agent or the owner can answer this assignment");
    const at = this.now();
    row.status = decision === "accept" ? "accepted" : "declined";
    row.updatedAt = at;
    row.answeredBy = actor.memberId;
    this.write(roomId, `assignment:${row.id}`, row, at);
    const seq = book.logSeq + 1;
    this.write(roomId, `log:${String(seq).padStart(6, "0")}`, {
      id: seq, at, action: decision, memberId: row.memberId, taskKey: row.taskKey, reason: decision === "decline" ? "Declined. The task goes back to the queue for someone else." : "Accepted.",
      by: actor.memberId, assignmentId: row.id
    }, at);
    if (decision === "decline") this.write(roomId, `decline:${row.memberId}|${row.taskKey}`, { at }, at);
    this.write(roomId, "meta", { paused: book.paused, logSeq: seq }, at);
    const seatHeld = book.seat.mode === "agent" && book.seat.memberId;
    const follow = decision === "decline"
      ? this.tick(roomId, seatHeld ? { role: "holder", memberId: book.seat.memberId } : { role: "hook" })
      : { assigned: [] };
    return { assignment: row, reassigned: follow.assigned ?? [] };
  }

  claimSeat(roomId, actor, action) {
    const snap = this.snapshot(roomId);
    const book = this.book(roomId);
    const at = this.now();
    if (action === "release") {
      const owner = actor.memberId === snap.ownerId;
      if (book.seat.memberId !== actor.memberId && !owner) fail(403, "dispatch_forbidden", "Only the coordinator or the owner can release the seat");
      this.write(roomId, "seat", { mode: "fallback", memberId: null, claimedAt: null }, at);
      this.appendLog(roomId, { at, action: "release_seat", memberId: actor.memberId, taskKey: null, reason: "The seat is empty. The fallback assigns until an agent claims it.", by: actor.memberId });
      const follow = this.tick(roomId, { role: "hook" });
      return { seat: { mode: "fallback", memberId: null }, assigned: follow.assigned };
    }
    if (action !== "claim") fail(422, "invalid_dispatch", "action must be claim or release");
    if (actor.kind !== "agent") fail(403, "dispatch_agent_only", "An agent claims the coordinator seat. The owner can name one with an override.");
    if (book.seat.mode === "agent" && book.seat.memberId && book.seat.memberId !== actor.memberId) {
      fail(409, "dispatch_seat_held", "Another agent holds the coordinator seat.");
    }
    this.write(roomId, "seat", { mode: "agent", memberId: actor.memberId, claimedAt: at }, at);
    this.appendLog(roomId, { at, action: "claim_seat", memberId: actor.memberId, taskKey: null, reason: `${actor.displayName || actor.memberId} claimed the coordinator seat. The fallback stops assigning.`, by: actor.memberId });
    return { seat: { mode: "agent", memberId: actor.memberId, claimedAt: at } };
  }

  override(roomId, actor, body = {}) {
    const snap = this.snapshot(roomId);
    if (actor.memberId !== snap.ownerId && actor.role !== "owner") fail(403, "owner_required", "The room owner overrides dispatch.");
    const at = this.now();
    const book = this.book(roomId);
    if (body.action === "pause" || body.action === "resume") {
      const paused = body.action === "pause";
      this.write(roomId, "meta", { paused, logSeq: book.logSeq }, at);
      this.appendLog(roomId, { at, action: body.action, memberId: null, taskKey: null, reason: paused ? "The owner paused assignment." : "The owner resumed assignment.", by: "owner" });
      return { paused };
    }
    if (body.action === "seat") {
      const memberId = body.memberId ?? null;
      if (memberId !== null && !snap.agents.some(agent => agent.memberId === memberId)) fail(422, "invalid_dispatch", "memberId must be an agent in this room");
      const seat = memberId ? { mode: "agent", memberId, claimedAt: at } : { mode: "fallback", memberId: null, claimedAt: null };
      this.write(roomId, "seat", seat, at);
      this.appendLog(roomId, { at, action: "override_seat", memberId, taskKey: null, reason: memberId ? "The owner named the coordinator." : "The owner returned assignment to the fallback.", by: "owner" });
      return { seat };
    }
    if (body.action !== "assign") fail(422, "invalid_dispatch", "action must be assign, pause, resume, or seat");
    if (typeof body.memberId !== "string" || typeof body.taskKey !== "string") fail(422, "invalid_dispatch", "assign needs memberId and taskKey");
    const queue = buildWorkQueue({ claims: snap.claims, fixPlans: book.fixPlans, projectMap: snap.projectMap });
    const task = queue.tasks.find(item => item.key === body.taskKey) ?? null;
    if (!task) fail(404, "unknown_task", "That task is not on the queue");
    const agent = snap.agents.find(item => item.memberId === body.memberId);
    if (!agent) fail(422, "invalid_dispatch", "memberId must be an agent in this room");
    this.remove(roomId, `decline:${body.memberId}|${body.taskKey}`);
    const id = `as_${randomBytes(8).toString("base64url")}`;
    const reason = `The owner overrode assignment and gave this to ${agent.displayName}. ${body.note ? String(body.note).slice(0, 200) : ""}`.trim();
    const assignment = {
      id, memberId: agent.memberId, displayName: agent.displayName, status: "offered",
      taskKey: task.key, source: task.source, title: task.title,
      files: task.touches.map(touch => touch.path),
      symbols: Object.fromEntries(task.touches.map(touch => [touch.path, touch.symbols])),
      parentKey: task.parentKey ?? null,
      claimIds: task.claimIds ?? [], reason, by: "owner", createdAt: at, updatedAt: at
    };
    this.write(roomId, `assignment:${id}`, assignment, at);
    this.appendLog(roomId, { at, action: "override_assign", memberId: agent.memberId, taskKey: task.key, reason, by: "owner", assignmentId: id });
    if (agent.identityId && this.store.agentHeartbeats?.enqueueWake) {
      try { this.store.agentHeartbeats.enqueueWake({ agentId: agent.identityId, kind: "assignment", roomId, messageId: id }); }
      catch { /* the assignment is still on the queue */ }
    }
    return { assignment };
  }

  addFixPlan(roomId, actor, body = {}) {
    if (typeof body.id !== "string" || !/^[A-Za-z0-9._:-]{1,80}$/.test(body.id)) fail(422, "invalid_dispatch", "id must be a short token");
    if (typeof body.title !== "string" || body.title.trim().length === 0 || body.title.length > 200) fail(422, "invalid_dispatch", "title must be 1..200 characters");
    const files = Array.isArray(body.files) ? body.files.map(normalizePath).filter(Boolean) : [];
    if (!files.length || files.length > 64) fail(422, "invalid_dispatch", "files must name 1..64 paths");
    const blockedBy = Array.isArray(body.blockedBy) ? body.blockedBy.filter(id => typeof id === "string" && id.length > 0 && id.length <= 128).slice(0, 20) : [];
    const value = body.value === undefined ? VALUE.fixPlan : body.value;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) fail(422, "invalid_dispatch", "value must be a number from 0 to 100");
    const at = this.now();
    const plan = { id: body.id, title: body.title.trim(), files, blockedBy, value, createdBy: actor.memberId, at };
    this.write(roomId, `fix:${plan.id}`, plan, at);
    this.appendLog(roomId, { at, action: "fix_plan", memberId: actor.memberId, taskKey: `fix:${plan.id}`, reason: "Added a fix-plan item to the queue.", by: actor.memberId });
    return plan;
  }

  appendLog(roomId, entry) {
    const book = this.book(roomId);
    const seq = book.logSeq + 1;
    this.write(roomId, `log:${String(seq).padStart(6, "0")}`, { id: seq, ...entry }, entry.at);
    this.write(roomId, "meta", { paused: book.paused, logSeq: seq }, entry.at);
    this.trimLog(roomId, seq);
  }
}
