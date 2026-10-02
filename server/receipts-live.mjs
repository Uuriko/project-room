// Live public receipts. Public-work receipts are already public. Work-claim
// records and completed work items are public only after the room owner turns
// on room.public_receipts_set. Default is off: a room that never records the
// event publishes nothing from its private ledger.
import { createHash } from "node:crypto";
import { publicReceipts } from "../src/events.js";
import { START_ROOM_URL } from "../deploy/room-entry.mjs";
import { isUnpublished } from "./legal-store.mjs";

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const HEX64 = /^[a-f0-9]{64}$/;
export const PUBLIC_RECEIPT_ID = /^(?:pwr_[a-f0-9]{16,128}|wcr_[a-f0-9]{32}|wir_[a-f0-9]{32})$/;

const hashId = (prefix, roomId, localId) =>
  `${prefix}_${createHash("sha256").update(`${roomId}\0${localId}`).digest("hex").slice(0, 32)}`;

const httpsUrl = value => {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
};

const pullRequestUrl = value => {
  const url = httpsUrl(value);
  return url && /\/pull\/\d+(?:$|[/?#])/.test(url) ? url : null;
};

const hashList = values => [...new Set(values.filter(value => SHA256.test(value)))];

const iso = value => {
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  return null;
};

const cleanName = value => {
  if (typeof value !== "string") return null;
  const name = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return name ? name.slice(0, 80) : null;
};

function credit(state, memberId) {
  if (typeof memberId !== "string" || !state?.members || !Object.hasOwn(state.members, memberId)) return null;
  const member = state.members[memberId];
  if (!member || member.active === false) return null;
  const name = cleanName(member.displayName) ?? memberId;
  return { name, kind: member.kind === "human" ? "human" : "agent" };
}

function creditsFrom(people) {
  const agents = [], humans = [];
  for (const person of people) {
    if (!person) continue;
    const list = person.kind === "human" ? humans : agents;
    if (!list.includes(person.name)) list.push(person.name);
  }
  return { agents, humans };
}

function listedRoomIds(store) {
  const ids = new Set();
  const has = name => store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  if (has("room_directory_settings")) {
    for (const row of store.db.prepare("SELECT room_id FROM room_directory_settings WHERE discoverable=1").all()) ids.add(row.room_id);
  }
  if (has("room_public_settings")) {
    for (const row of store.db.prepare("SELECT room_id FROM room_public_settings WHERE enabled=1").all()) ids.add(row.room_id);
  }
  return ids;
}

function roomField(state, listed) {
  if (!listed || !state?.room?.id) return null;
  const title = cleanName(state.room.title);
  return { id: state.room.id, title };
}

function startHref(ownerName) {
  const url = new URL(START_ROOM_URL);
  const ref = cleanName(ownerName);
  if (ref) url.searchParams.set("ref", ref);
  return url.href;
}

function envelope(fields) {
  return {
    schema: "project-room-public-receipt/1",
    id: fields.id,
    title: cleanName(fields.title) ?? "Receipt",
    source: fields.source,
    room: fields.room ?? null,
    agents: fields.agents ?? [],
    humans: fields.humans ?? [],
    pullRequest: fields.pullRequest ?? null,
    mergedAt: fields.mergedAt ?? null,
    hashes: fields.hashes ?? [],
    at: fields.at,
    startHref: fields.startHref,
  };
}

function publicWorkReceipts(store, rooms, listed) {
  if (!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='public_work_receipts'").get()) return [];
  const out = [];
  for (const row of store.db.prepare("SELECT receipt_json, artifact_sha256 FROM public_work_receipts").all()) {
    let body;
    try { body = JSON.parse(row.receipt_json); } catch { continue; }
    if (!body || typeof body.receiptId !== "string" || !body.receiptId.startsWith("pwr_")) continue;
    const roomId = typeof body.namespaceId === "string" ? body.namespaceId : null;
    if ((roomId && isUnpublished(store.db, "room", roomId)) || isUnpublished(store.db, "receipt", body.receiptId)) continue;
    const state = roomId ? rooms.get(roomId) : null;
    const showRoom = roomId && listed.has(roomId);
    const owner = state ? credit(state, state.room?.ownerId) : null;
    const hashes = hashList([
      HEX64.test(row.artifact_sha256 ?? "") ? `sha256:${row.artifact_sha256}` : null,
      HEX64.test(body.artifact?.sha256 ?? "") ? `sha256:${body.artifact.sha256}` : null,
    ].filter(Boolean));
    out.push(envelope({
      id: body.receiptId,
      title: cleanName(body.title) ?? "Public work",
      source: "public-work",
      room: showRoom && state ? roomField(state, true) : (roomId ? { id: roomId, title: null } : null),
      agents: typeof body.identityId === "string" && body.identityId ? [body.identityId] : [],
      humans: [],
      at: iso(body.createdAt) ?? new Date(0).toISOString(),
      hashes,
      // The namespace id is already on the public receipt. The owner's name
      // is a referral only when the room itself is publicly listed.
      startHref: startHref(showRoom ? owner?.name : null),
    }));
  }
  return out;
}

function optedInReceipts(store, rooms, listed) {
  const out = [];
  for (const [roomId, state] of rooms) {
    if (publicReceipts(state).enabled !== true || isUnpublished(store.db, "room", roomId)) continue;
    const room = roomField(state, listed.has(roomId));
    const owner = credit(state, state.room?.ownerId);
    const href = startHref(owner?.name);
    let claims = [];
    try { claims = store.workClaims?.list?.(roomId) ?? []; } catch { claims = []; }
    for (const item of claims) {
      if (!item || item.state !== "done" || item.pullRequest?.outcome !== "merged") continue;
      const people = [credit(state, item.owner)];
      for (const step of Array.isArray(item.history) ? item.history : []) people.push(credit(state, step?.actor));
      const { agents, humans } = creditsFrom(people);
      out.push(envelope({
        id: hashId("wcr", roomId, item.id),
        title: item.title,
        source: "work-claim",
        room,
        agents,
        humans,
        pullRequest: pullRequestUrl(item.pullRequest?.url),
        mergedAt: iso(item.pullRequest?.syncedAt),
        hashes: hashList(Array.isArray(item.blobs) ? item.blobs : []),
        at: iso(item.pullRequest?.syncedAt) ?? iso(item.updatedAt) ?? new Date(0).toISOString(),
        startHref: href,
      }));
    }
    const items = state.workItems && typeof state.workItems === "object" ? Object.values(state.workItems) : [];
    for (const item of items) {
      if (!item || item.state !== "completed" || !item.receipt || typeof item.receipt !== "object") continue;
      const people = [credit(state, item.receipt.reportedById), credit(state, item.receipt.producerId), credit(state, item.accountableMemberId)];
      const { agents, humans } = creditsFrom(people);
      const version = typeof item.receipt.evidenceVersion === "string" && SHA256.test(item.receipt.evidenceVersion)
        ? item.receipt.evidenceVersion : null;
      out.push(envelope({
        id: hashId("wir", roomId, item.id),
        title: item.title,
        source: "work-item",
        room,
        agents,
        humans,
        pullRequest: pullRequestUrl(item.receipt.evidenceUrl),
        mergedAt: null,
        hashes: hashList(version ? [version] : []),
        at: iso(item.updatedAt) ?? new Date(0).toISOString(),
        startHref: href,
      }));
    }
  }
  return out;
}

function loadRooms(store) {
  const rooms = new Map();
  for (const row of store.db.prepare("SELECT id, projection FROM rooms").all()) {
    try {
      const state = JSON.parse(row.projection);
      if (state?.room?.id) rooms.set(state.room.id, state);
    } catch { /* a corrupt projection is not a public receipt */ }
  }
  return rooms;
}

function receiptVisible(store, item) {
  if (isUnpublished(store.db, "receipt", item.id)) return false;
  if (item.room?.id && isUnpublished(store.db, "room", item.room.id)) return false;
  return true;
}

export function collectPublicReceipts(store) {
  const rooms = loadRooms(store);
  const listed = listedRoomIds(store);
  const all = [...publicWorkReceipts(store, rooms, listed), ...optedInReceipts(store, rooms, listed)].filter(item => receiptVisible(store, item));
  all.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return all;
}

export function queryPublicReceipts(store, { room = null, agent = null, cursor = null, limit = 20 } = {}) {
  if (room != null && (typeof room !== "string" || !room || room.length > 128)) {
    return { error: { status: 422, code: "invalid_receipt_query", message: "room filter must be a room id" } };
  }
  if (agent != null && (typeof agent !== "string" || !agent.trim() || agent.length > 80)) {
    return { error: { status: 422, code: "invalid_receipt_query", message: "agent filter must be a name" } };
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    return { error: { status: 422, code: "invalid_receipt_query", message: "limit must be an integer from 1 to 50" } };
  }
  let rows = collectPublicReceipts(store);
  if (room) rows = rows.filter(item => item.room?.id === room);
  if (agent) {
    const needle = agent.trim().toLowerCase();
    rows = rows.filter(item => item.agents.some(name => name.toLowerCase().includes(needle)));
  }
  let start = 0;
  if (cursor != null) {
    if (typeof cursor !== "string" || !cursor) {
      return { error: { status: 422, code: "invalid_receipt_query", message: "cursor is not a receipt from this list" } };
    }
    const index = rows.findIndex(item => item.id === cursor);
    if (index < 0) return { error: { status: 422, code: "invalid_receipt_query", message: "cursor is not a receipt from this list" } };
    start = index + 1;
  }
  const page = rows.slice(start, start + limit);
  const nextCursor = start + limit < rows.length ? page.at(-1)?.id ?? null : null;
  return { receipts: page, nextCursor };
}

export function publicReceiptById(store, id) {
  if (typeof id !== "string" || !PUBLIC_RECEIPT_ID.test(id)) return null;
  return collectPublicReceipts(store).find(item => item.id === id) ?? null;
}
