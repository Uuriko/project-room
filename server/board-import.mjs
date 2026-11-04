// Board import (Linear parity: Import). Off unless ROOM_BOARD_IMPORT=1.
//
// The room owner pastes an export from GitHub Issues, Jira or Asana (the
// JSON each tool's API or export returns) and gets unclaimed Board tasks.
// No outbound fetch and no third-party token: the caller supplies the JSON.
// Each task id is derived from (room, source, external key), so importing
// the same export twice skips what already exists. Closed or done items and
// GitHub pull requests are skipped. At most MAX_IMPORT items per call.
import { createHash } from "node:crypto";
import { createWork } from "./work-claims.mjs";
import { emitWorkClaimEvent } from "./work-claim-events.mjs";

export const boardImportEnabled = (env = process.env) => env?.ROOM_BOARD_IMPORT === "1";
export const IMPORT_SOURCES = Object.freeze(["github", "jira", "asana"]);
export const MAX_IMPORT = 100;

const clip = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");
const tag = v => (typeof v === "string" ? v.trim().replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) : "");
const names = list => (Array.isArray(list) ? list.map(x => (typeof x === "string" ? x : x?.name)).filter(x => typeof x === "string") : []);

// Normalize one exported item to { key, title, note, labels } or { skip }.
export function normalizeItem(source, raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { skip: "invalid_item" };
  if (source === "github") {
    if (raw.pull_request) return { skip: "pull_request" };
    if (raw.state && raw.state !== "open") return { skip: "closed" };
    const key = Number.isSafeInteger(raw.number) ? `#${raw.number}` : clip(raw.html_url, 300);
    return { key, title: clip(raw.title, 400), note: [clip(raw.body, 3000), clip(raw.html_url, 500)].filter(Boolean).join("\n"), labels: names(raw.labels) };
  }
  if (source === "jira") {
    const f = raw.fields && typeof raw.fields === "object" ? raw.fields : {};
    if (f.status?.statusCategory?.key === "done" || f.resolution) return { skip: "closed" };
    return { key: clip(raw.key, 100), title: clip(f.summary, 400), note: clip(typeof f.description === "string" ? f.description : "", 3500), labels: names(f.labels) };
  }
  if (source === "asana") {
    if (raw.completed === true) return { skip: "closed" };
    return { key: clip(raw.gid, 100), title: clip(raw.name, 400), note: [clip(raw.notes, 3000), clip(raw.permalink_url, 500)].filter(Boolean).join("\n"), labels: names(raw.tags) };
  }
  return { skip: "invalid_item" };
}

export const importClaimId = (roomId, source, key) =>
  `im-${createHash("sha256").update(`${roomId}\n${source}\n${key}`).digest("hex").slice(0, 20)}`;

// Plan (dryRun) or apply an import. Returns per-item results in input order.
export function importBoardTasks(store, roomId, actorId, { source, items, dryRun = false }, now = Date.now()) {
  const results = [];
  const seen = new Set();
  for (const raw of items) {
    const n = normalizeItem(source, raw);
    if (n.skip) { results.push({ result: "skipped", reason: n.skip }); continue; }
    if (!n.key || !n.title) { results.push({ result: "skipped", reason: "invalid_item" }); continue; }
    const claimId = importClaimId(roomId, source, n.key);
    if (seen.has(claimId) || store.workClaims.get(roomId, claimId)) { results.push({ result: "duplicate", key: n.key, claimId }); continue; }
    seen.add(claimId);
    if (dryRun) { results.push({ result: "would_create", key: n.key, claimId, title: n.title }); continue; }
    const tags = [...new Set(["imported", source, ...n.labels.map(tag).filter(Boolean)])].slice(0, 10);
    const item = createWork({ id: claimId, title: `[${n.key}] ${n.title}`.slice(0, 512), note: n.note || undefined, tags }, { now, agentId: actorId });
    store.workClaims.set(roomId, item);
    emitWorkClaimEvent(store, roomId, { actorId, item, action: "created", previousOwnerId: null, previousState: null, atMs: now });
    results.push({ result: "created", key: n.key, claimId });
  }
  const count = r => results.filter(x => x.result === r).length;
  return { source, dryRun, created: count("created"), wouldCreate: count("would_create"), duplicates: count("duplicate"), skipped: count("skipped"), results };
}
