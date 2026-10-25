// Room-scoped code map storage. Tables are created on first use. The queue
// drains inline on push and again from the project-map job. Notices are one
// room post per overlap set. Nothing here wakes an agent.

import { isAbsolute, resolve } from "node:path";
import { ServiceError } from "./service-error.mjs";
import { appendRoomEvent, stableEventId } from "./receipt-cards.mjs";
import {
  applyFiles, assessOverlap, emptyGraph, graphFromGraphify, graphifyPreferred,
  mapExplain, mapHotspots, mapPath, mapQuery, normalizePath, normalizeRepo, projectMapEnabled
} from "./project-map.mjs";

export const PROJECT_MAP_TABLES = Object.freeze([
  "project_maps", "project_map_queue", "project_map_pulls", "project_map_notices"
]);

const LIVE = new Set(["claimed", "in_progress", "blocked", "delivered"]);
const HIDDEN = new Set(["done", "closed", "cancelled"]);
const MAX_GRAPH = 1_500_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS project_maps (
  room_id TEXT NOT NULL,
  repo TEXT NOT NULL,
  revision TEXT,
  built_at INTEGER NOT NULL,
  engine TEXT NOT NULL,
  graph_json TEXT NOT NULL,
  PRIMARY KEY (room_id, repo)
);
CREATE TABLE IF NOT EXISTS project_map_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL,
  repo TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  enqueued_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS project_map_pulls (
  room_id TEXT NOT NULL,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT,
  state TEXT NOT NULL,
  files_json TEXT NOT NULL,
  claim_id TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, repo, number)
);
CREATE TABLE IF NOT EXISTS project_map_notices (
  room_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  event_id TEXT NOT NULL,
  posted_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, dedupe_key)
);
`;

export function featureEnv(store) {
  if (store && Object.hasOwn(store, "featureEnv") && store.featureEnv && typeof store.featureEnv === "object") return store.featureEnv;
  return process.env;
}

function ensure(store) {
  if (!store?.db) return false;
  store.db.exec(SCHEMA);
  return true;
}

export function projectMapPending(store) {
  if (!store?.db) return false;
  try {
    return Boolean(store.db.prepare("SELECT 1 FROM project_map_queue LIMIT 1").get());
  } catch {
    return false;
  }
}

function safePath(value) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) return null;
  const path = resolve(value);
  return isAbsolute(path) ? path : null;
}

async function graphifyGraph(env, repo, revision) {
  if (!graphifyPreferred(env)) return null;
  const wanted = typeof env?.ROOM_PROJECT_MAP_REPO === "string" ? normalizeRepo(env.ROOM_PROJECT_MAP_REPO) : null;
  if (!wanted || wanted !== repo) return null;
  const out = safePath(env.ROOM_PROJECT_MAP_GRAPHIFY_OUT);
  const { readFile } = await import("node:fs/promises");
  if (out) return graphFromGraphify(JSON.parse(await readFile(out, "utf8")), { repo, revision });
  const checkout = safePath(env.ROOM_PROJECT_MAP_CHECKOUT);
  if (!checkout) return null;
  const { execFile } = await import("node:child_process");
  const { join } = await import("node:path");
  await new Promise((resolveRun, rejectRun) => {
    execFile("graphify", ["update", "."], { cwd: checkout, timeout: 4000 }, error => (error ? rejectRun(error) : resolveRun()));
  });
  for (const name of ["graphify-out/graph.json", "graph.json"]) {
    try {
      return graphFromGraphify(JSON.parse(await readFile(join(checkout, name), "utf8")), { repo, revision });
    } catch { /* the parser remains the fallback */ }
  }
  return null;
}

function loadGraph(store, roomId, repo) {
  const row = store.db.prepare("SELECT graph_json FROM project_maps WHERE room_id=? AND repo=?").get(roomId, repo);
  if (!row) return null;
  try { return JSON.parse(row.graph_json); } catch { return null; }
}

function saveGraph(store, roomId, graph) {
  const body = JSON.stringify(graph);
  if (body.length > MAX_GRAPH) throw new ServiceError(422, "invalid_input", "map is too large");
  store.db.prepare(`INSERT INTO project_maps (room_id, repo, revision, built_at, engine, graph_json)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(room_id, repo) DO UPDATE SET revision=excluded.revision, built_at=excluded.built_at, engine=excluded.engine, graph_json=excluded.graph_json`)
    .run(roomId, graph.repo, graph.revision ?? null, graph.builtAt ?? Date.now(), graph.engine ?? "parser", body);
}

function selectGraph(store, roomId, repo) {
  const wanted = repo ? normalizeRepo(repo) : null;
  if (wanted) return loadGraph(store, roomId, wanted);
  const row = store.db.prepare("SELECT graph_json FROM project_maps WHERE room_id=? ORDER BY built_at DESC LIMIT 1").get(roomId);
  if (!row) return null;
  try { return JSON.parse(row.graph_json); } catch { return null; }
}

export async function drainProjectMapQueue(store, env = featureEnv(store), { limit = 5, roomId = null } = {}) {
  if (!store?.db || !projectMapEnabled(env)) return { drained: 0 };
  if (!projectMapPending(store)) return { drained: 0 };
  ensure(store);
  const rows = roomId
    ? store.db.prepare("SELECT id, room_id, repo, payload_json FROM project_map_queue WHERE room_id=? ORDER BY id LIMIT ?").all(roomId, limit)
    : store.db.prepare("SELECT id, room_id, repo, payload_json FROM project_map_queue ORDER BY id LIMIT ?").all(limit);
  let drained = 0;
  for (const row of rows) {
    let payload = {};
    try { payload = JSON.parse(row.payload_json); } catch { payload = {}; }
    const current = loadGraph(store, row.room_id, row.repo) ?? emptyGraph(row.repo, payload.revision ?? null);
    let next = null;
    if (payload.graphify && typeof payload.graphify === "object") {
      next = graphFromGraphify(payload.graphify, { repo: row.repo, revision: payload.revision ?? current.revision });
    } else {
      try { next = await graphifyGraph(env, row.repo, payload.revision ?? current.revision); } catch { next = null; }
      if (!next) next = applyFiles(current, { ...payload, repo: row.repo });
    }
    next.repo = row.repo;
    saveGraph(store, row.room_id, next);
    store.db.prepare("DELETE FROM project_map_queue WHERE id=?").run(row.id);
    drained += 1;
  }
  return { drained };
}

export async function pushProjectMap(store, roomId, body) {
  const env = featureEnv(store);
  if (!projectMapEnabled(env)) return { enabled: false, reason: "ROOM_PROJECT_MAP is off" };
  const repo = normalizeRepo(body?.repo);
  if (!repo) throw new ServiceError(422, "invalid_input", "repo must be owner/name");
  const files = Array.isArray(body?.files) ? body.files : null;
  const graphify = body?.graphify && typeof body.graphify === "object" ? body.graphify : null;
  if (!files && !graphify) throw new ServiceError(422, "invalid_input", "files or graphify is required");
  ensure(store);
  const payload = {
    repo,
    revision: typeof body?.revision === "string" ? body.revision.slice(0, 120) : null,
    files: (files ?? []).slice(0, 200).map(file => ({
      path: normalizePath(file?.path),
      source: typeof file?.source === "string" ? file.source.slice(0, 64 * 1024) : ""
    })).filter(file => file.path),
    removed: (Array.isArray(body?.removed) ? body.removed : []).map(normalizePath).filter(Boolean),
    ...(graphify ? { graphify } : {})
  };
  store.db.prepare("INSERT INTO project_map_queue (room_id, repo, payload_json, enqueued_at) VALUES (?, ?, ?, ?)")
    .run(roomId, repo, JSON.stringify(payload), Date.now());
  await drainProjectMapQueue(store, env, { roomId, limit: 1 });
  const graph = loadGraph(store, roomId, repo);
  return {
    enabled: true, repo, revision: graph?.revision ?? payload.revision, engine: graph?.engine ?? "parser",
    files: Object.keys(graph?.files ?? {}).length, truncated: graph?.truncated === true
  };
}

export function readProjectMap(store, roomId, { op = "query", q, from, to, repo } = {}) {
  const env = featureEnv(store);
  if (!projectMapEnabled(env)) return { enabled: false, reason: "ROOM_PROJECT_MAP is off" };
  if (!ensure(store)) return { enabled: true, found: false, repo: null };
  const graph = selectGraph(store, roomId, repo);
  if (!graph) return { enabled: true, found: false, repo: repo ? normalizeRepo(repo) : null };
  if (op === "hotspots") return { enabled: true, repo: graph.repo, engine: graph.engine, revision: graph.revision, hotspots: mapHotspots(graph) };
  if (op === "path") return { enabled: true, repo: graph.repo, ...mapPath(graph, from, to) };
  if (op === "explain") return { enabled: true, repo: graph.repo, ...mapExplain(graph, q) };
  return { enabled: true, repo: graph.repo, ...mapQuery(graph, q) };
}

export function runRoomMap(store, secret, args) {
  store.authenticate(secret, args.roomId);
  return readProjectMap(store, args.roomId, args);
}

function loadContext(store, roomId) {
  ensure(store);
  let claims = [];
  try { claims = store.workClaims?.list?.(roomId) ?? []; } catch { claims = []; }
  let pulls = [];
  try {
    pulls = store.db.prepare("SELECT repo, number, title, state, files_json FROM project_map_pulls WHERE room_id=? AND state='open'").all(roomId)
      .map(row => ({
        id: `pr:${row.repo}#${row.number}`,
        kind: "pull",
        number: row.number,
        title: row.title ?? "",
        repo: row.repo,
        files: JSON.parse(row.files_json),
        state: "open"
      }));
  } catch { pulls = []; }
  const graphs = new Map();
  try {
    for (const row of store.db.prepare("SELECT repo, graph_json FROM project_maps WHERE room_id=?").all(roomId)) {
      try { graphs.set(row.repo, JSON.parse(row.graph_json)); } catch { /* skip */ }
    }
  } catch { /* no map yet */ }
  return { claims, pulls, graphs };
}

function graphFor(ctx, subject) {
  const repo = subject?.repo ? normalizeRepo(subject.repo) : null;
  if (repo && ctx.graphs.has(repo)) return ctx.graphs.get(repo);
  if (ctx.graphs.size === 1) return [...ctx.graphs.values()][0];
  return null;
}

function overlapAgainst(ctx, subject) {
  const claims = ctx.claims.filter(item => item && item.id !== subject.id && LIVE.has(item.state));
  const pulls = ctx.pulls.filter(item => item.id !== subject.id);
  return assessOverlap({ subject, others: [...claims, ...pulls], graph: graphFor(ctx, subject) });
}

function postNotice(store, roomId, subject, overlap) {
  const ids = [String(subject.id), ...overlap.with.map(item => String(item.id))].sort();
  const material = [roomId, ...ids, ...overlap.files, ...overlap.symbols].join("\0");
  const eventId = stableEventId("pm", material);
  const existing = store.db.prepare("SELECT 1 FROM project_map_notices WHERE room_id=? AND dedupe_key=?").get(roomId, material);
  if (existing) return;
  const room = store.room?.(roomId);
  const ownerId = room?.state?.room?.ownerId;
  const author = room?.state?.members?.[ownerId];
  if (!author || author.active === false) return;
  appendRoomEvent(store, roomId, {
    id: eventId,
    type: "message.posted",
    actorId: author.id,
    data: { messageId: eventId, body: overlap.summary }
  });
  store.db.prepare("INSERT OR IGNORE INTO project_map_notices (room_id, dedupe_key, event_id, posted_at) VALUES (?, ?, ?, ?)")
    .run(roomId, material, eventId, Date.now());
}

export function publishProjectMapOverlap(store, roomId, subject) {
  if (!subject || !projectMapEnabled(featureEnv(store))) return null;
  try {
    const overlap = overlapAgainst(loadContext(store, roomId), subject);
    if (!overlap) return null;
    if (LIVE.has(subject.state) || subject.kind === "pull") {
      try { postNotice(store, roomId, subject, overlap); }
      catch (error) { console.error("project map notice failed:", error?.message ?? error); }
    }
    return overlap;
  } catch (error) {
    console.error("project map overlap failed:", error?.message ?? error);
    return null;
  }
}

export function noteProjectMapOverlap(store, roomId, item) {
  if (!item || !LIVE.has(item.state)) return null;
  return publishProjectMapOverlap(store, roomId, item);
}

export function withProjectMapOverlap(store, roomId, value) {
  if (!value || !projectMapEnabled(featureEnv(store))) return value;
  try {
    const ctx = loadContext(store, roomId);
    const decorate = item => {
      if (!item || HIDDEN.has(item.state)) return item;
      const overlap = overlapAgainst(ctx, item);
      return overlap ? { ...item, overlap } : item;
    };
    if (Array.isArray(value.claims)) return { ...value, claims: value.claims.map(decorate) };
    if (typeof value.id === "string") return decorate(value);
    return value;
  } catch (error) {
    console.error("project map overlap failed:", error?.message ?? error);
    return value;
  }
}

export function recordProjectMapPull(store, roomId, body) {
  if (!projectMapEnabled(featureEnv(store))) return { enabled: false, reason: "ROOM_PROJECT_MAP is off" };
  const repo = normalizeRepo(body?.repo);
  const number = body?.number;
  if (!repo || !Number.isInteger(number) || number < 1 || number > 100_000_000) {
    throw new ServiceError(422, "invalid_input", "repo and number are required");
  }
  const files = [...new Set((Array.isArray(body?.files) ? body.files : []).map(normalizePath).filter(Boolean))].slice(0, 500);
  const state = body?.state === "closed" || body?.state === "merged" ? body.state : "open";
  const title = typeof body?.title === "string" ? body.title.slice(0, 200) : "";
  const claimId = typeof body?.claimId === "string" ? body.claimId.slice(0, 128) : null;
  ensure(store);
  const now = Date.now();
  store.db.prepare(`INSERT INTO project_map_pulls (room_id, repo, number, title, state, files_json, claim_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(room_id, repo, number) DO UPDATE SET title=excluded.title, state=excluded.state, files_json=excluded.files_json, claim_id=excluded.claim_id, updated_at=excluded.updated_at`)
    .run(roomId, repo, number, title, state, JSON.stringify(files), claimId, now);
  const subject = { id: `pr:${repo}#${number}`, kind: "pull", number, title, repo, files, state: state === "open" ? "claimed" : state };
  const overlap = state === "open" ? publishProjectMapOverlap(store, roomId, subject) : null;
  return overlap
    ? { enabled: true, repo, number, state, overlap }
    : { enabled: true, repo, number, state };
}
