// In-app notification center (IS-UX-1, #1601). A mountable client component
// that renders the per-member notification feed (the shape
// GET /api/rooms/{id}/notifications returns: {unread, notifications:[...]})
// grouped by kind, with an unread count and an empty state. Pure render
// helpers are DOM-free; mount() takes a container element. User-facing copy
// lives in the strings catalog (strings/en.json, nc.*) via uiText(); HTML
// parameters are escaped by callers before insertion, per src/strings.js.
//
// MOUNT POINT (wiring owned by jill-lane7 — index.html / src/app.js):
//   import { mountNotificationCenter } from "./notification-center.js";
//   const center = mountNotificationCenter(document.getElementById("notification-center"), {
//     fetchFeed: () => client.roomNotifications({ limit: 50 }),
//     onAck: item => client.ackMention(item)
//   });
//   await center.refresh();
import { uiText } from "./strings.js";

const KIND_KEYS = {
  mention: "nc.kind.mention",
  reply: "nc.kind.reply",
  assignment: "nc.kind.assignment",
  work_update: "nc.kind.work_update",
  access_request: "nc.kind.access_request",
  access_decision: "nc.kind.access_decision"
};
export const CENTER_KIND_ORDER = Object.freeze([
  "mention", "reply", "assignment", "work_update", "access_request", "access_decision"
]);

export function kindLabel(kind) {
  return uiText(KIND_KEYS[kind] ?? "nc.kind.other");
}

export function unreadCount(feed) {
  if (typeof feed?.unread === "number") return feed.unread;
  return Array.isArray(feed?.notifications) ? feed.notifications.length : 0;
}

export function groupForCenter(notifications) {
  const items = Array.isArray(notifications) ? notifications : [];
  return CENTER_KIND_ORDER
    .map(kind => ({ kind, label: kindLabel(kind), items: items.filter(n => n?.kind === kind) }))
    .filter(group => group.items.length > 0);
}

const escapeHtml = value => String(value ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .split("'").join("&#39;").split('"').join("&quot;");

const ITEM_KEYS = {
  mention: "nc.item.mention",
  reply: "nc.item.reply",
  assignment: "nc.item.assignment",
  work_update: "nc.item.work_update",
  access_request: "nc.item.access_request",
  access_decision: "nc.item.access_decision"
};

const itemTitle = item => uiText(ITEM_KEYS[item?.kind] ?? "nc.item.other", {
  actor: escapeHtml(item?.actorId ?? "someone")
});

const itemTarget = item => {
  if (item?.messageId) return uiText("nc.target.message", { id: escapeHtml(item.messageId) });
  if (item?.workItemId) return uiText("nc.target.work", { id: escapeHtml(item.workItemId) });
  return uiText("nc.target.room");
};

export function renderCenterHtml({ notifications = [], roomName = "Room", unread = null } = {}) {
  const groups = groupForCenter(notifications);
  // Prefer the feed's own unread count: the server may report more unread
  // items than the fetched page carries.
  const count = typeof unread === "number" ? unread : notifications.length;
  const title = uiText("nc.title");
  const head = `<div class="notification-center" data-unread="${count}" role="region" aria-label="${title}">` +
    `<h2>${title}${count > 0 ? ` <span class="count-chip">${count}</span>` : ""}</h2>`;
  if (groups.length === 0) {
    return `${head}<p class="notification-empty">${uiText("nc.empty", { room: escapeHtml(roomName) })}</p></div>`;
  }
  const body = groups.map(group =>
    `<section class="notification-group" data-kind="${group.kind}">` +
    `<h3>${escapeHtml(group.label)}</h3><ul>` +
    group.items.map(item =>
      `<li class="notification-item" data-kind="${escapeHtml(item.kind)}">` +
      `<span class="notification-title">${itemTitle(item)}</span> ` +
      `<span class="notification-target">${uiText("nc.inTarget", { target: itemTarget(item) })}</span>` +
      (item.kind === "mention"
        ? ` <button type="button" class="button ghost" data-ack-mention="${escapeHtml(item.messageId ?? "")}">${uiText("nc.ack")}</button>`
        : "") +
      `</li>`).join("") +
    `</ul></section>`).join("");
  return `${head}${body}</div>`;
}

// Mount into a container. `fetchFeed` resolves the feed shape; `onAck(item)`
// fires when an acknowledge button is pressed. Returns {refresh, ack}.
export function mountNotificationCenter(root, { fetchFeed, onAck } = {}) {
  if (!root || typeof fetchFeed !== "function") throw new Error("notification-center needs a root and fetchFeed");
  const center = {
    async refresh() {
      const feed = await fetchFeed();
      root.innerHTML = renderCenterHtml({ notifications: feed?.notifications ?? [], roomName: feed?.roomName, unread: feed?.unread });
    },
    async ack(item) {
      if (typeof onAck === "function") await onAck(item);
    }
  };
  if (typeof root.addEventListener === "function") {
    root.addEventListener("click", event => {
      const button = event?.target?.closest?.("[data-ack-mention]");
      if (!button) return;
      const messageId = button.getAttribute("data-ack-mention");
      center.ack({ kind: "mention", messageId });
    });
  }
  return center;
}
