// Room tabs (Conversation, Work, Receipts). Off unless the page asks for
// them. This module only classifies records the room already has.
import { uiText } from "./strings.js";

const KEY = "project-room-tabs";
const MARK = "project-room-tabs-query";
export const STALE_CLAIM_MS = 30 * 60 * 1000;

function storageGet(storage, key) {
  try { return storage ? storage.getItem(key) : null; }
  catch { return null; }
}

function storageSet(storage, key, value) {
  try { storage?.setItem(key, value); }
  catch { /* private mode */ }
}

export function readRoomTabsFlag(search, storage) {
  const params = new URLSearchParams(typeof search === "string" ? search.replace(/^\?/, "") : "");
  const query = params.get("tabs");
  if (storage && (query === "0" || query === "1") && storageGet(storage, MARK) !== "1") {
    storageSet(storage, KEY, query);
    storageSet(storage, MARK, "1");
  }
  if (!storage) return query === "1";
  return storageGet(storage, KEY) === "1";
}

function memberOf(members, id) {
  if (!members || typeof id !== "string" || !Object.hasOwn(members, id)) return null;
  const member = members[id];
  return member && typeof member === "object" ? member : null;
}

export function conversationMessage(message, members) {
  const kind = memberOf(members, message?.authorId)?.kind;
  return kind === "human" || kind === "agent";
}

export function partitionConversation(messages, members) {
  const kept = [];
  const updates = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (conversationMessage(message, members)) kept.push(message);
    else updates.push(message);
  }
  return { messages: kept, updates };
}

export function updatesLabel(count) {
  const total = Number(count);
  if (!Number.isInteger(total) || total <= 0) return "";
  if (total === 1) return uiText("tabs.updates.one");
  return uiText("tabs.updates.many", { count: total });
}

export function updateLine(message, members) {
  const name = memberOf(members, message?.authorId)?.displayName;
  const who = typeof name === "string" ? name.trim() : "";
  const body = typeof message?.body === "string" ? message.body.replace(/\s+/g, " ").trim() : "";
  const text = [...body].slice(0, 80).join("");
  if (who && text) return uiText("tabs.update.line", { name: who, text });
  if (text) return text;
  return uiText("tabs.update.unnamed");
}

function expiryMs(item) {
  const raw = item?.expiresAt ?? item?.leaseExpiresAt;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? at : null;
}

// A lease expiry wins when the claim already carries one (C2's expiresAt,
// or the leaseExpiresAt the board stores today). Age is only the fallback.
export function staleClaim(item, now, staleMs = STALE_CLAIM_MS) {
  if (!item || item.state === "done" || item.state === "unclaimed" || item.state === "closed") return false;
  const expiry = expiryMs(item);
  if (expiry != null) return expiry <= now;
  const at = Date.parse(item.claimedAt || item.updatedAt || "");
  return Number.isFinite(at) && now - at >= staleMs;
}

// Needs you is blocked work, pinned first. Dependency-waiting cards stay
// in Ready. Done is the board's landed column.
export function fixedBoardColumns(columns) {
  const source = columns ?? {};
  const needs = [];
  const ready = [...(source.ready ?? [])];
  for (const item of source.blocked ?? []) {
    if (item?.state === "blocked") needs.push(item);
    else ready.push(item);
  }
  return [
    ["needs", needs],
    ["ready", ready],
    ["claimed", [...(source.claimed ?? [])]],
    ["review", [...(source.review ?? [])]],
    ["done", [...(source.landed ?? [])]],
  ];
}

export function receiptEntries(payload) {
  const rows = Array.isArray(payload?.receipts) ? payload.receipts : [];
  const entries = [];
  for (const row of rows) {
    const id = typeof row?.id === "string" ? row.id.trim() : "";
    const title = typeof row?.title === "string" ? row.title.trim() : "";
    if (!id || !title || /[\\/]/.test(id)) continue;
    entries.push({ id, title, href: `/receipts/${encodeURIComponent(id)}` });
  }
  return entries;
}
