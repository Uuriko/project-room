// F004: audit log UI (who did what, when).
//
// Pure renderer over the room's audit trail. The audit trail is the room's
// event log read through the store's #110 filtered read: every mutation
// records actorId + at, so "who did what when" is a filtered read, not a
// new table. Rows are { sequence, event } where event is
// { id, type, roomId, actorId, at, data } — the same shape store.exportEvents
// and the #110 events() read return.
//
// This module only presents. It performs no reads, no writes, and no schema
// changes; name resolution is supplied by the caller as a function or map so
// the renderer never touches the store.
//
// Safety posture, in one place:
//   - every value that came out of an event goes through esc() before it is
//     placed in element content, and through attr() before it is placed in
//     an attribute; there is no other way text reaches the document;
//   - no links, no hrefs, no scripts, no inline event handlers and no style
//     attributes: ids render as <code> text, so there is nothing to smuggle
//     a javascript: URL or markup through;
//   - malformed rows or unknown event types never throw: a row always
//     renders with a best-effort label and target, so one corrupt event
//     cannot break the whole log view.

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;", "`": "&#96;" };
export const esc = value => String(value ?? "").replace(/[&<>"'`]/g, c => ESCAPES[c]);
const attr = esc;

// Past-tense "what" for each known event type, keyed on the dotted contract
// strings from src/events.js (kept literal so this renderer stays
// dependency-free and usable in the browser bundle). Unknown types fall
// back to a humanized form of the dotted type — never a throw.
const ACTION_LABELS = {
  "room.created": "Created the room",
  "room.charter_updated": "Updated the room charter",
  "room.policy_set": "Set the room policy",
  "room.spend_allowance_set": "Set the spend allowance",
  "room.archived": "Archived the room",
  "member.added": "Added a member",
  "member.joined_via_invitation": "Joined via invitation",
  "member.access_changed": "Changed member access",
  "member.status_updated": "Updated member status",
  "notifications.preferences_set": "Set notification preferences",
  "member.mute_set": "Set member mute",
  "message.posted": "Posted a message",
  "message.edited": "Edited a message",
  "message.deleted": "Deleted a message",
  "reply_request.cancelled": "Cancelled a reply request",
  "message.reaction_set": "Set a message reaction",
  "message.pinned": "Pinned a message",
  "message.unpinned": "Unpinned a message",
  "work.proposed": "Proposed work",
  "work.help_updated": "Updated help wanted",
  "work.help_offer_opened": "Opened a help offer",
  "work.help_offer_updated": "Updated a help offer",
  "work.accepted": "Accepted work",
  "work.started": "Started work",
  "work.blocked": "Marked work blocked",
  "work.blocker_resolved": "Resolved a work blocker",
  "work.completed": "Completed work",
  "work.superseded": "Superseded work",
  "work.handoff_recorded": "Recorded a work handoff",
  "work.halt_cleared": "Cleared the work halt",
  "claim.acquired": "Acquired a claim",
  "claim.released": "Released a claim",
  "verification.recorded": "Recorded verification",
  "owner.decision_recorded": "Recorded an owner decision",
  "decision.recorded": "Recorded a decision",
  "session.started": "Started a session",
  "session.status_changed": "Changed a session status",
  "session.stop_requested": "Requested a session stop",
  "session.stopped": "Stopped a session",
  "capabilities.advertised": "Advertised capabilities"
};

export function auditActionLabel(type) {
  if (typeof type === "string" && Object.hasOwn(ACTION_LABELS, type)) return ACTION_LABELS[type];
  if (typeof type !== "string" || !type.trim()) return "Unknown event";
  const words = type.replace(/[._-]+/g, " ").trim();
  return words[0].toUpperCase() + words.slice(1);
}

// The "what it acted on" for an entry, as plain (unescaped) { kind, id }.
// The audit log answers who did what when: the what is the action plus its
// target id — message bodies are deliberately not surfaced, matching the
// projection's tombstone rule (a deleted message renders as deleted, with
// no body).
export function auditTarget(event) {
  const data = event?.data ?? {};
  const type = event?.type;
  const id = event?.id;
  if (typeof type === "string") {
    if (type.startsWith("message.")) return { kind: "message", id: data.messageId ?? id };
    if (type === "reply_request.cancelled") return { kind: "reply request", id: data.requestMessageId ?? data.messageId ?? id };
    if (type.startsWith("work.") || type.startsWith("claim.") || type.startsWith("verification.")
      || type.startsWith("owner.") || type === "decision.recorded") {
      return { kind: "work item", id: data.workItemId ?? data.offerId ?? id };
    }
    if (type.startsWith("member.") || type.startsWith("notifications.")) return { kind: "member", id: data.memberId ?? event?.actorId };
    if (type.startsWith("session.")) return { kind: "session", id: data.sessionId ?? data.workItemId ?? id };
    if (type === "capabilities.advertised") return { kind: "member", id: event?.actorId };
    if (type.startsWith("room.")) return { kind: "room", id: event?.roomId ?? data.roomId };
  }
  return { kind: "event", id };
}

export function formatAuditTime(at) {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? String(at ?? "") : date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

// Normalize the caller's name source: a function (actorId) => name, a Map,
// or a plain object. Unresolved ids fall back to the raw actor id at render.
function nameResolver(source) {
  if (typeof source === "function") return source;
  if (source instanceof Map) return id => source.get(id);
  if (source && typeof source === "object") return id => source[id];
  return () => null;
}

// Tolerate bare events (no { sequence, event } wrapper) and missing fields:
// a renderer must never fail on a row it does not fully understand.
function rowParts(row) {
  const entry = row && typeof row === "object" && "event" in row ? row : { event: row };
  const event = entry.event && typeof entry.event === "object" ? entry.event : {};
  return { sequence: entry.sequence, event };
}

export function renderAuditRow(row, { resolveName } = {}) {
  const { sequence, event } = rowParts(row);
  const resolve = nameResolver(resolveName);
  const actorId = event.actorId;
  const name = resolve(actorId) ?? actorId ?? "unknown";
  const target = auditTarget(event);
  const when = formatAuditTime(event.at);
  const date = new Date(event.at);
  const valid = !Number.isNaN(date.getTime());
  const targetHtml = target.id != null && target.id !== ""
    ? ` <span class="audit-target">${esc(target.kind)} <code>${esc(target.id)}</code></span>` : "";
  const seq = Number.isSafeInteger(sequence) ? `<code>${esc(sequence)}</code>` : "<code>—</code>";
  return `<tr><td class="audit-seq">${seq}</td>`
    + `<td class="audit-actor">${esc(name)}</td>`
    + `<td class="audit-action">${esc(auditActionLabel(event.type))}${targetHtml}</td>`
    + `<td class="audit-when">${valid ? `<time datetime="${attr(date.toISOString())}">${esc(when)}</time>` : esc(when)}</td></tr>`;
}

export function renderAuditLog(rows, { title = "Audit log", resolveName, emptyText = "No audit entries yet." } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const out = [];
  out.push(`<section class="audit-log" aria-label="${attr(title)}">`, `<h2 class="audit-heading">${esc(title)}</h2>`);
  if (!list.length) {
    out.push(`<p class="audit-empty">${esc(emptyText)}</p>`, "</section>");
    return out.join("\n");
  }
  out.push(`<p class="audit-summary">${list.length} ${list.length === 1 ? "entry" : "entries"} — who did what, when.</p>`);
  out.push(`<table class="audit-table"><thead><tr><th scope="col">Seq</th><th scope="col">Who</th><th scope="col">What</th><th scope="col">When</th></tr></thead><tbody>`);
  const options = { resolveName };
  for (const row of list) out.push(renderAuditRow(row, options));
  out.push("</tbody></table>", "</section>");
  return out.join("\n");
}
