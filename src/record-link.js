// Exact-result and sign-in record selectors. This module must stay a leaf:
// the agent sign-in page imports it, and that page must not load workspace
// modules such as events.js or client.js.
const RECORD_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const RESERVED_IDS = new Set(["constructor", "prototype", "__proto__"]);
function validRecordId(value) {
  return typeof value === "string" && RECORD_ID.test(value) && !RESERVED_IDS.has(value);
}

// Exact result links are selectors. The reader still checks room access and the pinned receipt.
export function exactResultDestination({ search = "", hash = "" }) {
  const route = /^#pr-record\/result\/([^/]+)\/([^/]+)$/.exec(hash);
  const rooms = new URLSearchParams(search).getAll("room");
  if (!route || rooms.length !== 1 || ![rooms[0], route[1], route[2]].every(validRecordId)) return null;
  return { roomId: rooms[0], workItemId: route[1], completionEventId: route[2] };
}

export function exactResultHref({ roomId, workItemId, completionEventId }, locationLike = globalThis.location) {
  if (![roomId, workItemId, completionEventId].every(validRecordId)) return "";
  const url = new URL(locationLike.origin);
  url.pathname = locationLike.pathname;
  url.searchParams.set("room", roomId);
  url.hash = ["pr-record", "result", workItemId, completionEventId].join("/");
  return url.href;
}

// Carry record selectors through agent sign-in. The chosen room still owns
// the post-login destination and the record reader still authorizes access.
export function agentSigninRecord({ search = "", hash = "" }) {
  const rooms = new URLSearchParams(search).getAll("room");
  if (rooms.length !== 1 || !validRecordId(rooms[0])) return null;
  const exact = exactResultDestination({ search, hash });
  if (exact) return { ...exact, hash };
  const work = /^#pr-record\/work\/([^/]+)$/.exec(hash);
  if (!work) return null;
  try {
    const id = decodeURIComponent(work[1]);
    return validRecordId(id) ? { roomId: rooms[0], workItemId:id, hash: `#pr-record/work/${encodeURIComponent(id)}` } : null;
  } catch { return null; }
}

const AGENT_RECORD_BINDING_KEY = "project-room:agent-record-binding";

export function rememberAgentRecordBinding(target, session) {
  if (!target || target.roomId !== session?.roomId || !/^[a-f0-9]{64}$/.test(session.sessionBinding ?? "")) return;
  try {
    sessionStorage.setItem(AGENT_RECORD_BINDING_KEY, JSON.stringify({
      roomId: target.roomId, hash: target.hash, binding: session.sessionBinding
    }));
  } catch { /* Browser storage may be unavailable. */ }
}

export function agentRecordBinding(locationLike = globalThis.location) {
  const target = agentSigninRecord(locationLike);
  if (!target) return null;
  try {
    const saved = JSON.parse(sessionStorage.getItem(AGENT_RECORD_BINDING_KEY));
    if (saved?.roomId === target.roomId && saved.hash === target.hash && /^[a-f0-9]{64}$/.test(saved.binding ?? "")) return saved.binding;
  } catch { /* Ignore missing or invalid navigation state. */ }
  return null;
}

export function clearAgentRecordBinding(binding) {
  try {
    const saved = JSON.parse(sessionStorage.getItem(AGENT_RECORD_BINDING_KEY));
    if (saved?.binding === binding) sessionStorage.removeItem(AGENT_RECORD_BINDING_KEY);
  } catch { /* Browser storage may be unavailable. */ }
}
