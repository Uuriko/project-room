// Room-scoped code map storage. Tables are created on first authorized write.
// Uploads commit inline; the job discards only legacy rebuild hints. Notices
// are one room post per overlap set. Nothing here wakes an agent.

import { createHash } from "node:crypto";
import { ownMember } from "../src/events.js";
import { ServiceError } from "./service-error.mjs";
import { appendRoomEvent, stableEventId } from "./receipt-cards.mjs";
import { refuseArchivedWriteDb, isArchivedRoomDb } from "./archived-guard.mjs";
import {
  applyFiles, assessOverlap, createOverlapContext, emptyGraph, graphFromGraphify, graphifyPreferred,
  mapExplain, mapHotspots, mapPath, mapQuery, normalizePath, normalizeRepo, projectMapEnabled
} from "./project-map.mjs";

export const PROJECT_MAP_TABLES = Object.freeze([
  "project_maps", "project_map_queue", "project_map_pulls", "project_map_notices"
]);

const LIVE = new Set(["claimed", "in_progress", "blocked", "delivered"]);
const HIDDEN = new Set(["done", "closed", "cancelled"]);
const MAX_GRAPH = 1_500_000;

export const PROJECT_MAP_SCHEMA = `
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
  store.db.exec(PROJECT_MAP_SCHEMA);
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

function loadGraph(store, roomId, repo) {
  const row = store.db.prepare("SELECT graph_json FROM project_maps WHERE room_id=? AND repo=?").get(roomId, repo);
  if (!row) return null;
  try { return JSON.parse(row.graph_json); } catch { return null; }
}

function saveGraph(store, roomId, graph) {
  const body = JSON.stringify(graph);
  if (Buffer.byteLength(body) > MAX_GRAPH) throw new ServiceError(422, "invalid_input", "map is too large");
  store.db.prepare(`INSERT INTO project_maps (room_id, repo, revision, built_at, engine, graph_json)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(room_id, repo) DO UPDATE SET revision=excluded.revision, built_at=excluded.built_at, engine=excluded.engine, graph_json=excluded.graph_json`)
    .run(roomId, graph.repo, graph.revision ?? null, graph.builtAt ?? Date.now(), graph.engine ?? "parser", body);
}

function selectGraph(store, roomId, repo) {
  const wanted = repo ? normalizeRepo(repo) : null;
  if (repo && !wanted) throw new ServiceError(422, "invalid_input", "repo must be owner/name");
  if (wanted) return loadGraph(store, roomId, wanted);
  const row = store.db.prepare("SELECT graph_json FROM project_maps WHERE room_id=? ORDER BY built_at DESC LIMIT 1").get(roomId);
  if (!row) return null;
  try { return JSON.parse(row.graph_json); } catch { return null; }
}

function prepareGraph(store, roomId, body) {
  const env = featureEnv(store);
  const repo = normalizeRepo(body?.repo);
  if (!repo) throw new ServiceError(422, "invalid_input", "repo must be owner/name");
  if (typeof body.revision !== "string" || !body.revision.trim() || body.revision.length > 120) {
    throw new ServiceError(422, "invalid_input", "revision is required");
  }
  const current = loadGraph(store, roomId, repo);
  if (Object.hasOwn(body, "expectedRevision") && body.expectedRevision !== (current?.revision ?? null)) {
    throw new ServiceError(409, "stale_project_map", "Map changed; read its revision before publishing");
  }
  if (Object.hasOwn(body, "expectedGraphSha256") && body.expectedGraphSha256 !== (current?.provenance?.graphSha256 ?? null)) {
    throw new ServiceError(409, "stale_project_map", "Map content changed; read its graph digest before publishing");
  }
  let next;
  if (body.graphify) {
    // Extraction belongs on the operator's machine, never in a request/DO.
    // The server verifies the envelope binding, not the uploader's checkout.
    if (!graphifyPreferred(env) || normalizeRepo(env.ROOM_PROJECT_MAP_REPO) !== repo) {
      throw new ServiceError(403, "access_denied", "Graphify intake is not configured for this repository");
    }
    const envelope = body.graphify;
    if (normalizeRepo(envelope.repo) !== repo || envelope.revision !== body.revision || !envelope.graph) {
      throw new ServiceError(422, "invalid_input", "Graphify requires a matching repo/revision envelope");
    }
    const root = !Array.isArray(envelope.graph.nodes) && envelope.graph.graph && typeof envelope.graph.graph === "object"
      ? envelope.graph.graph : envelope.graph;
    const rows = value => Array.isArray(value) && value.every(row => row && typeof row === "object" && !Array.isArray(row));
    if (!root || typeof root !== "object" || Array.isArray(root) || !rows(root.nodes)
      || !(rows(root.edges) || (root.edges === undefined && rows(root.links)))) {
      throw new ServiceError(422, "invalid_input", "Graphify requires nodes and edges or links arrays");
    }
    next = graphFromGraphify(envelope.graph, { repo, revision: body.revision });
    next.provenance = { source: "authorized-upload", revisionVerified: false,
      graphSha256: createHash("sha256").update(JSON.stringify(envelope.graph)).digest("hex") };
  } else {
    if (!Array.isArray(body.files) || body.files.length > 200 || (body.removed?.length ?? 0) > 4000) {
      throw new ServiceError(422, "invalid_input", "Provide at most 200 files and 4000 removals per update");
    }
    for (const file of body.files) {
      if (!normalizePath(file?.path) || typeof file.source !== "string" || Buffer.byteLength(file.source) > 64 * 1024) {
        throw new ServiceError(422, "invalid_input", "Each file needs a relative path and at most 64 KiB of source");
      }
    }
    if (body.removed !== undefined && (!Array.isArray(body.removed) || body.removed.some(path => !normalizePath(path)))) {
      throw new ServiceError(422, "invalid_input", "Invalid removed paths");
    }
    next = applyFiles(body.replace === true ? emptyGraph(repo) : (current ?? emptyGraph(repo)), { ...body, repo });
    next.provenance = { source: "authorized-upload", revisionVerified: false };
  }
  if (Buffer.byteLength(JSON.stringify(next)) > MAX_GRAPH) throw new ServiceError(422, "invalid_input", "map is too large");
  return next;
}

export async function drainProjectMapQueue(store, env = featureEnv(store), { limit = 5, roomId = null } = {}) {
  if (!store?.db || !projectMapEnabled(env) || !projectMapPending(store)) return { drained: 0 };
  const bounded = Math.max(1, Math.min(5, Number.isInteger(limit) ? limit : 5));
  const rows = roomId
    ? store.db.prepare("SELECT id, room_id, payload_json FROM project_map_queue WHERE room_id=? ORDER BY id LIMIT ?").all(roomId, bounded)
    : store.db.prepare("SELECT id, room_id, payload_json FROM project_map_queue ORDER BY id LIMIT ?").all(bounded);
  let drained = 0;
  // Legacy queued writes are not silently published: they predate authorized,
  // revision-bound intake. Discard rebuild hints, preserve the last valid map.
  for (const row of rows) {
    store.db.prepare("DELETE FROM project_map_queue WHERE id=?").run(row.id);
    drained += 1;
  }
  return { drained, discarded: drained, reason: "Rebuild legacy map updates with authorized revision-bound intake" };
}

export async function pushProjectMap(store, roomId, body) {
  if (!projectMapEnabled(featureEnv(store))) return { enabled: false, reason: "ROOM_PROJECT_MAP is off" };
  // G8 (T2-L05d-C1): the map store is a side-table writer that never
  // passes through store.command; the freeze is checked here, at the
  // store layer, before anything is prepared or persisted.
  refuseArchivedWriteDb(store.db, roomId);
  ensure(store);
  // No await between observing the previous map and committing its replacement.
  // Invalid input cannot poison a durable queue or overwrite the valid graph.
  const graph = prepareGraph(store, roomId, body);
  saveGraph(store, roomId, graph);
  return { enabled: true, repo: graph.repo, revision: graph.revision, engine: graph.engine,
    builtAt: graph.builtAt, sourceScope: graph.sourceScope ?? null, provenance: graph.provenance,
    files: Object.keys(graph.files).length, truncated: graph.truncated === true };
}

export function readProjectMap(store, roomId, { op = "query", q, from, to, repo } = {}) {
  const env = featureEnv(store);
  if (!projectMapEnabled(env)) return { enabled: false, reason: "ROOM_PROJECT_MAP is off" };
  if (!store?.db) return { enabled: true, found: false, repo: null };
  try { store.db.prepare("SELECT 1 FROM project_maps LIMIT 1").get(); } catch { return { enabled: true, found: false, repo: repo ?? null }; }
  const graph = selectGraph(store, roomId, repo);
  if (!graph) return { enabled: true, found: false, repo: repo ? normalizeRepo(repo) : null };
  const metadata = { enabled: true, repo: graph.repo, engine: graph.engine, revision: graph.revision, builtAt: graph.builtAt, sourceScope: graph.sourceScope ?? null, truncated: graph.truncated === true, provenance: graph.provenance ?? { source: "legacy", revisionVerified: false } };
  if (op === "hotspots") return { ...metadata, hotspots: mapHotspots(graph) };
  if (op === "path") return { ...metadata, ...mapPath(graph, from, to) };
  if (op === "explain") return { ...metadata, ...mapExplain(graph, q) };
  return { ...metadata, ...mapQuery(graph, q) };
}

export function runRoomMap(store, secret, args) {
  store.authenticate(secret, args.roomId);
  return readProjectMap(store, args.roomId, args);
}

function loadContext(store, roomId) {
  try { store.db.prepare("SELECT 1 FROM project_maps LIMIT 1").get(); }
  catch { return { claims: [], pulls: [], graphs: new Map() }; }
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
  return { claims, pulls, graphs, overlapContexts: new Map() };
}

function graphFor(ctx, subject) {
  const repo = subject?.repo ? normalizeRepo(subject.repo) : null;
  if (repo && ctx.graphs.has(repo)) return ctx.graphs.get(repo);
  return null;
}

function overlapAgainst(ctx, subject) {
  const claims = ctx.claims.filter(item => item && item.id !== subject.id && LIVE.has(item.state));
  const pulls = ctx.pulls.filter(item => item.id !== subject.id);
  const graph = graphFor(ctx, subject);
  let overlapContext = graph ? ctx.overlapContexts?.get(graph) : null;
  if (graph && !overlapContext) {
    overlapContext = createOverlapContext(graph);
    ctx.overlapContexts.set(graph, overlapContext);
  }
  return assessOverlap({ subject, others: [...claims, ...pulls], graph, overlapContext });
}

function postNotice(store, roomId, subject, overlap) {
  const ids = [String(subject.id), ...overlap.with.map(item => String(item.id))].sort();
  const material = [roomId, ...ids, ...overlap.files, ...overlap.symbols].join("\0");
  const eventId = stableEventId("pm", material);
  const existing = store.db.prepare("SELECT 1 FROM project_map_notices WHERE room_id=? AND dedupe_key=?").get(roomId, material);
  if (existing) return;
  const room = store.room?.(roomId);
  const ownerId = room?.state?.room?.ownerId;
  const author = ownMember(room?.state?.members, ownerId);
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
  // Overlap notices are posted from read/decoration paths too, where a
  // thrown refusal would break the read. In an archived room the notice
  // simply does not post — the same null appendRoomEvent returns there —
  // and no project_map_notices row is recorded.
  if (isArchivedRoomDb(store.db, roomId)) return null;
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
  refuseArchivedWriteDb(store.db, roomId); // G8 (T2-L05d-C1), as in pushProjectMap.
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
