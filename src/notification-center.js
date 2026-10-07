// In-app notification center (IS-UX-1, #1601). A mountable client component
// that renders the per-member notification feed (the shape
// GET /api/rooms/{id}/notifications returns: {unread, notifications:[...]})
// grouped by kind, with an unread count and an empty state. Pure render
// helpers are DOM-free; mount() takes a container element.
//
// MOUNT POINT (wiring owned by jill-lane7 — index.html / src/app.js):
//   import { mountNotificationCenter } from "./notification-center.js";
//   const center = mountNotificationCenter(document.getElementById("notification-center"), {
//     fetchFeed: () => client.roomNotifications({ limit: 50 }),
//     onAck: item => client.ackMention(item)
//   });
//   await center.refresh();
const KIND_LABELS = {
  mention: "Mentions",
  reply: "Replies",
  assignment: "Assignments",
  work_update: "Work updates",
  access_request: "Access requests",
  access_decision: "Access decisions"
};
export const CENTER_KIND_ORDER = Object.freeze([
  "mention", "reply", "assignment", "work_update", "access_request", "access_decision"
]);

export function kindLabel(kind) {
  return KIND_LABELS[kind] ?? "Updates";
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
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const itemTitle = item => {
  const actor = escapeHtml(item?.actorId ?? "someone");
  switch (item?.kind) {
    case "mention": return `${actor} mentioned you`;
    case "reply": return `${actor} replied to you`;
    case "assignment": return `${actor} assigned you work`;
    case "work_update": return `${actor} updated your work`;
    case "access_request": return `${actor} requested access`;
    case "access_decision": return `${actor} decided an access request`;
    default: return `${actor} has an update for you`;
  }
};

const itemTarget = item =>
  item?.messageId ? `message ${escapeHtml(item.messageId)}`
  : item?.workItemId ? `work ${escapeHtml(item.workItemId)}`
  : "the room";

export function renderCenterHtml({ notifications = [], roomName = "Room", unread = null } = {}) {
  const groups = groupForCenter(notifications);
  // Prefer the feed's own unread count: the server may report more unread
  // items than the fetched page carries.
  const count = typeof unread === "number" ? unread : notifications.length;
  const head = `<div class="notification-center" data-unread="${count}" role="region" aria-label="Notifications">` +
    `<h2>Notifications${count > 0 ? ` <span class="count-chip">${count}</span>` : ""}</h2>`;
  if (groups.length === 0) {
    return `${head}<p class="notification-empty">You're caught up — nothing needs you in ${escapeHtml(roomName)} right now.</p></div>`;
  }
  const body = groups.map(group =>
    `<section class="notification-group" data-kind="${group.kind}">` +
    `<h3>${escapeHtml(group.label)}</h3><ul>` +
    group.items.map(item =>
      `<li class="notification-item" data-kind="${escapeHtml(item.kind)}">` +
      `<span class="notification-title">${itemTitle(item)}</span> ` +
      `<span class="notification-target">in ${itemTarget(item)}</span>` +
      (item.kind === "mention"
        ? ` <button type="button" class="button ghost" data-ack-mention="${escapeHtml(item.messageId ?? "")}">Acknowledge</button>`
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
