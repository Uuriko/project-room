// Human digest content (IS-UX-1, #1601). Pure, dependency-free, deterministic.
// Turns notification-feed items (server/notifications.mjs shape) into the
// rows renderNotificationEmail expects: sections ({heading, text, url}) for
// the "brief" kind and line items ({reason, title}) for the "batch" kind.
// Feed items carry no titles, so headlines derive from kind + actorId + ids;
// actor ids are clipped of control characters before display. Unknown kinds
// are dropped so a future kind can never poison a digest.
export const DIGEST_KIND_ORDER = Object.freeze([
  "mention",
  "reply",
  "assignment",
  "work_update",
  "access_request",
  "access_decision"
]);

const KNOWN = new Set(DIGEST_KIND_ORDER);

const clean = value => String(value ?? "").replace(/[\r\n\u0000-\u001f\u007f]/g, " ").trim();
const actorOf = item => clean(item?.actorId) || "someone";

const plural = (word, n) => (n === 1 ? word : `${word}s`);

// Human headline for one feed item. Never includes raw message text: the
// digest is a pointer back to the room, not a content mirror.
export function itemHeadline(item) {
  const actor = actorOf(item);
  switch (item?.kind) {
    case "mention": return `${actor} mentioned you`;
    case "reply": return `${actor} replied to you`;
    case "assignment": return `${actor} assigned you work (${clean(item.workItemId) || "untitled"})`;
    case "work_update": {
      const n = Number(item?.changes) || 1;
      return `${actor} updated work ${clean(item.workItemId) || "untitled"} (${n} ${plural("change", n)})`;
    }
    case "access_request": return `${actor} requested access`;
    case "access_decision": return `${actor} decided an access request`;
    default: return `${actor} has an update for you`;
  }
}

const HEADINGS = {
  mention: "Mention",
  reply: "Reply",
  assignment: "Assignment",
  work_update: "Work update",
  access_request: "Access request",
  access_decision: "Access decision"
};

// "Mentions (2)". Singular when exactly one.
export function sectionHeading(kind, count) {
  const base = HEADINGS[kind] ?? "Update";
  const n = Number(count) || 0;
  return `${plural(base, n)} (${n})`;
}

const groupItems = items =>
  DIGEST_KIND_ORDER.map(kind => ({
    kind,
    items: (Array.isArray(items) ? items : []).filter(item => item?.kind === kind)
  })).filter(group => group.items.length > 0);

// Brief sections: one per kind with headlines, oldest first. `roomName` is
// context only — the room itself is where the content lives.
export function buildDigestSections({ items = [], roomName = "Room" } = {}) {
  const room = clean(roomName) || "Room";
  return groupItems(items).map(group => ({
    kind: group.kind,
    heading: sectionHeading(group.kind, group.items.length),
    text: `${group.items.map(itemHeadline).join("; ")} — in ${room}.`,
    url: ""
  }));
}

// Batch lines: one per item, newest first (matches feed order).
export function buildDigestLines({ items = [] } = {}) {
  return (Array.isArray(items) ? items : [])
    .filter(item => KNOWN.has(item?.kind))
    .map(item => ({ reason: itemHeadline(item), title: itemHeadline(item) }));
}
