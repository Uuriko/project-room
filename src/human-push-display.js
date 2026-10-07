// Lock-screen text for a human push. The default is a count. A message body
// on the payload is ignored. A short server-set title (the declarative
// notification title, or payload.title) may replace the count title. It is
// a label such as "Codex needs your approval", not the message.

const ACTION_TITLES = { approve: "Approve", reject: "Reject", reply: "Reply" };

function countTitle(mention, dm, waiting) {
  if (dm > 0 && mention === 0) return waiting === 1 ? "Direct message" : "Direct messages";
  if (mention > 0 && dm === 0) return waiting === 1 ? "Mention" : "Mentions";
  return "Mentions and DMs";
}

function countBody(waiting) {
  if (waiting === 0) return "Something is waiting in the room";
  if (waiting === 1) return "1 waiting in the room";
  return `${waiting} waiting in the room`;
}

function shortLabel(value) {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\r\n\u0000-\u001f\u007f]/g, " ").trim();
  if (!text || text.length > 80) return null;
  return text;
}

function roomPath(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.length > 2048) return null;
  return value;
}

export function notificationActions(payload) {
  const list = Array.isArray(payload?.actions) ? payload.actions : [];
  const seen = new Set();
  const actions = [];
  for (const item of list) {
    const action = item?.action;
    if (!Object.hasOwn(ACTION_TITLES, action) || seen.has(action)) continue;
    seen.add(action);
    actions.push({ action, title: ACTION_TITLES[action] });
    if (actions.length === 2) break;
  }
  return actions;
}

export function needsMeCountFromPush(payload) {
  const value = payload?.needsMeCount ?? payload?.notification?.app_badge;
  return Number.isInteger(value) && value >= 0 && value <= 99 ? value : null;
}

// Rich (v2) rendering: a payload that carries the member's preview
// preference shows who wrote and the start of what they wrote. Anything
// else — v1 payloads, or v2 payloads where the member turned preview off —
// renders the counts, exactly as before. Content only reaches the lock
// screen when the server put it on the payload, which only happens with
// preview enabled for that member in that room.
function richTitle(payload, mention, dm, waiting) {
  if (payload?.v !== 2) return null;
  const name = shortLabel(payload?.sender?.name);
  if (!name || typeof payload?.preview !== "string" || !payload.preview) return null;
  return name;
}

function richBody(payload, mention, dm, waiting) {
  if (payload?.v !== 2) return null;
  const name = shortLabel(payload?.sender?.name);
  if (!name || typeof payload?.preview !== "string" || !payload.preview) return null;
  const text = payload.preview.replace(/[\r\n\x00-\u001f\x7f]/g, " ").trim();
  if (!text) return null;
  return text.length > 140 ? text.slice(0, 140) : text;
}

export function notificationFromPush(payload) {
  const counts = payload && typeof payload === "object" ? payload.counts : null;
  const mention = Number.isInteger(counts?.mention) && counts.mention > 0 ? counts.mention : 0;
  const dm = Number.isInteger(counts?.dm) && counts.dm > 0 ? counts.dm : 0;
  const waiting = mention + dm;
  const roomId = typeof payload?.roomId === "string" && payload.roomId ? payload.roomId : null;
  const url = roomPath(payload?.data?.url) || roomPath(payload?.notification?.navigate_url) || roomPath(payload?.url)
    || (roomId ? `/?room=${encodeURIComponent(roomId)}` : "/");
  const title = shortLabel(payload?.notification?.title) || shortLabel(payload?.title)
    || richTitle(payload, mention, dm, waiting) || countTitle(mention, dm, waiting);
  const body = richBody(payload, mention, dm, waiting) ?? countBody(waiting);
  return {
    title,
    body,
    tag: roomId ? `room:${roomId}` : "room",
    data: { roomId, url },
    actions: notificationActions(payload),
    needsMeCount: needsMeCountFromPush(payload)
  };
}
