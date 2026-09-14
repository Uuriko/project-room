// BUILD-01 F2: human-readable room export.
//
// Renders the same event walk the JSONL export ships (store.exportEvents:
// dense {sequence, event} rows) as one self-contained HTML document a
// departing member can open in a browser or hand to someone else. It is a
// view over the event log, not over the projection: the walk below is a
// deliberately small replay that keeps only what a reader needs (members,
// messages, work items, evidence links), so a room the store can export is
// a room this module can render.
//
// Safety posture, in one place:
//   - every value that came out of an event goes through esc() before it is
//     placed in element content, and through attr() before it is placed in
//     an attribute; there is no other way text reaches the document;
//   - the only attribute that carries user-controlled data is the href of an
//     evidence link, and it is emitted only when the value parses as an
//     https: URL without credentials (the same rule src/events.js enforces on
//     the way in; re-checked here because a renderer must not trust its input);
//   - the document contains no script, no inline event handler and no style
//     attribute; its single <style> block is fixed text whose sha256 is pinned
//     by the Content-Security-Policy the route sends (EXPORT_HTML_CSP), so a
//     browser that opens the file inline runs nothing and loads nothing.
//   - tombstoned messages render as "deleted" with no body and no edit
//     history — the same visibility rule the projection applies. The JSONL
//     export still carries the history (docs/EXPORT-RETENTION-DELETION.md);
//     this format is the one meant for people, so it shows the room as the
//     room showed it.
import { createHash } from "node:crypto";
import { EVENT_TYPES as T } from "../src/events.js";

const STYLE = `
:root { color-scheme: light dark; }
body { margin: 0; padding: 1.5rem 1rem 3rem; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; max-width: 52rem; margin-inline: auto; }
h1, h2 { line-height: 1.2; }
h1 { font-size: 1.6rem; margin: 0 0 .25rem; }
h2 { font-size: 1.15rem; margin: 2rem 0 .75rem; border-bottom: 1px solid rgba(127,127,127,.35); padding-bottom: .25rem; }
p.lede { margin: 0 0 1rem; opacity: .85; }
dl.meta { display: grid; grid-template-columns: max-content 1fr; gap: .15rem 1rem; margin: 0 0 1rem; font-size: .9rem; }
dl.meta dt { opacity: .7; }
dl.meta dd { margin: 0; }
ul.members { padding-left: 1.2rem; margin: 0; }
ol.messages { list-style: none; padding: 0; margin: 0; }
ol.messages > li { padding: .6rem 0; border-top: 1px solid rgba(127,127,127,.2); }
ol.messages > li:first-child { border-top: 0; }
.head { font-size: .85rem; opacity: .75; display: flex; flex-wrap: wrap; gap: .25rem .75rem; }
.author { font-weight: 600; opacity: 1; }
.body { white-space: pre-wrap; overflow-wrap: anywhere; margin: .2rem 0 0; }
.deleted { font-style: italic; opacity: .65; }
.flag { font-size: .8rem; border: 1px solid rgba(127,127,127,.45); border-radius: 999px; padding: 0 .5rem; }
section.work { padding: .75rem 0; border-top: 1px solid rgba(127,127,127,.2); }
section.work h3 { margin: 0 0 .25rem; font-size: 1rem; }
section.work dl { display: grid; grid-template-columns: max-content 1fr; gap: .15rem 1rem; margin: .4rem 0 0; font-size: .9rem; }
section.work dd { margin: 0; overflow-wrap: anywhere; }
ul.evidence { padding-left: 1.2rem; margin: .25rem 0 0; }
code { font-size: .9em; }
footer { margin-top: 3rem; font-size: .85rem; opacity: .7; border-top: 1px solid rgba(127,127,127,.35); padding-top: .75rem; }
`.trim();

const STYLE_HASH = createHash("sha256").update(STYLE, "utf8").digest("base64");
// The document-level policy (also embedded as a <meta> so an opened file
// keeps it) plus the header-only directives a static download should carry.
export const EXPORT_HTML_DOCUMENT_CSP = `default-src 'none'; style-src 'sha256-${STYLE_HASH}'; base-uri 'none'; form-action 'none'`;
export const EXPORT_HTML_CSP = `${EXPORT_HTML_DOCUMENT_CSP}; frame-ancestors 'none'; sandbox`;

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;", "`": "&#96;" };
export const esc = value => String(value ?? "").replace(/[&<>"'`]/g, c => ESCAPES[c]);
const attr = esc;

// A link is only a link when it is an https: URL without credentials;
// anything else (javascript:, data:, a relative path, junk) is shown as text.
export function safeEvidenceHref(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

const when = at => {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? esc(at) : esc(date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC"));
};

// Walk the exported rows once and keep what the document shows. Unknown or
// unrelated event types are counted and otherwise ignored: the document is
// a reading, not a replay, and must never fail on an event it does not
// know how to draw.
export function walkExport(rows) {
  const room = { id: null, title: null, purpose: null, createdAt: null };
  const members = new Map();
  const messages = new Map();
  const work = new Map();
  let count = 0, first = null, last = null, lastAt = null;
  const name = id => members.get(id)?.displayName ?? id ?? "unknown";
  const blankWork = id => ({ id, title: null, definitionOfDone: null, accountableMemberId: null, state: "unknown", proposedById: null, createdAt: null, evidence: [], notes: [] });
  // A work event without a usable id (only a malformed log has one) updates
  // a throwaway record rather than inventing an "undefined" item.
  const workItem = id => {
    if (typeof id !== "string" || !id) return blankWork(id);
    if (!work.has(id)) work.set(id, blankWork(id));
    return work.get(id);
  };
  for (const row of rows) {
    const { sequence, event } = row;
    count += 1;
    if (first === null) first = sequence;
    last = sequence;
    lastAt = event.at ?? lastAt;
    const data = event.data ?? {};
    switch (event.type) {
      case T.ROOM_CREATED:
        Object.assign(room, { id: data.roomId ?? event.roomId, title: data.title, purpose: data.purpose, createdAt: event.at });
        break;
      case T.MEMBER_ADDED:
      case T.MEMBER_JOINED_VIA_INVITATION:
        members.set(data.memberId, { id: data.memberId, displayName: data.displayName ?? data.memberId, kind: data.kind ?? "human", active: true, joinedAt: event.at });
        break;
      case T.MEMBER_ACCESS_CHANGED:
        if (members.has(data.memberId)) members.get(data.memberId).active = data.active !== false;
        break;
      case T.MESSAGE_POSTED: {
        const id = data.messageId || event.id;
        // D6: a rewritten post carries a redaction record instead of text; the redaction event below names when.
        messages.set(id, { id, authorId: event.actorId, at: event.at, body: data.redacted ? null : data.body, edited: false, deleted: false, deletedAt: null, redacted: Boolean(data.redacted), redactedAt: null, workItemId: data.workItemId || null, replyToId: data.replyToId || null });
        break;
      }
      case T.MESSAGE_EDITED: {
        const message = messages.get(data.messageId);
        if (message && !message.deleted && !message.redacted) { message.body = data.body; message.edited = true; }
        break;
      }
      case T.MESSAGE_REDACTED: {
        const message = messages.get(data.messageId);
        if (message) { message.body = null; message.redacted = true; message.redactedAt = event.at; message.edited = false; }
        break;
      }
      case T.MESSAGE_DELETED: {
        const message = messages.get(data.messageId);
        if (message) { message.body = null; message.deleted = true; message.deletedAt = event.at; message.edited = false; }
        break;
      }
      case T.WORK_PROPOSED: {
        const item = workItem(data.workItemId);
        Object.assign(item, { title: data.title, definitionOfDone: data.definitionOfDone, accountableMemberId: data.accountableMemberId, state: "proposed", proposedById: event.actorId, createdAt: event.at });
        break;
      }
      case T.WORK_ACCEPTED: workItem(data.workItemId).state = "accepted"; break;
      case T.WORK_STARTED: workItem(data.workItemId).state = "working"; break;
      case T.WORK_BLOCKED: {
        const item = workItem(data.workItemId);
        item.state = "blocked";
        item.notes.push({ at: event.at, actorId: event.actorId, label: "Blocked", text: data.reason });
        break;
      }
      case T.WORK_BLOCKER_RESOLVED: {
        const item = workItem(data.workItemId);
        item.notes.push({ at: event.at, actorId: event.actorId, label: "Blocker resolved", text: data.resolution });
        break;
      }
      case T.WORK_COMPLETED: {
        const item = workItem(data.workItemId);
        item.state = "completed";
        item.evidence.push({ at: event.at, actorId: event.actorId, label: "Completion", summary: data.summary, url: data.evidenceUrl ?? null, version: data.evidenceVersion });
        break;
      }
      case T.WORK_HANDOFF_RECORDED: {
        const item = workItem(data.workItemId);
        item.evidence.push({ at: event.at, actorId: event.actorId, label: "Handoff", summary: data.doneSummary, url: data.evidenceUrl ?? null, version: data.evidenceVersion ?? null });
        break;
      }
      case T.VERIFICATION_RECORDED: {
        const item = workItem(data.workItemId);
        item.notes.push({ at: event.at, actorId: event.actorId, label: `Verification: ${data.result}`, text: data.summary });
        break;
      }
      case T.OWNER_DECISION_RECORDED: {
        const item = workItem(data.workItemId);
        item.notes.push({ at: event.at, actorId: event.actorId, label: `Decision: ${data.decision}`, text: data.reason });
        break;
      }
      case T.WORK_SUPERSEDED: {
        const item = workItem(data.workItemId);
        item.state = "superseded";
        item.notes.push({ at: event.at, actorId: event.actorId, label: "Superseded", text: data.reason });
        break;
      }
      default: break;
    }
  }
  return { room, members, messages, work, count, first, last, lastAt, name };
}

function renderEvidence(entry, name) {
  const href = safeEvidenceHref(entry.url);
  const link = href ? `<a href="${attr(href)}" rel="noopener noreferrer nofollow">${esc(href)}</a>`
    : entry.url != null ? `<code>${esc(entry.url)}</code>` : "<em>evidence recorded in the room</em>";
  const version = entry.version != null ? ` <span class="flag">version ${esc(entry.version)}</span>` : "";
  return `<li><span class="head"><span class="author">${esc(entry.label)}</span> <span>${esc(name(entry.actorId))}</span> <time datetime="${attr(entry.at)}">${when(entry.at)}</time></span>`
    + `<div class="body">${esc(entry.summary)}</div><div>${link}${version}</div></li>`;
}

export function renderRoomExportHtml(rows, { roomId, generatedAt = new Date().toISOString() } = {}) {
  const walk = walkExport(rows);
  const { room, members, messages, work, count, first, last, lastAt, name } = walk;
  const title = room.title ?? roomId ?? "Project Room";
  const out = [];
  out.push("<!doctype html>", "<html lang=\"en\">", "<head>", "<meta charset=\"utf-8\">",
    `<meta http-equiv="Content-Security-Policy" content="${attr(EXPORT_HTML_DOCUMENT_CSP)}">`,
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    "<meta name=\"referrer\" content=\"no-referrer\">",
    `<title>${esc(title)} — room export</title>`,
    `<style>${STYLE}</style>`, "</head>", "<body>");
  out.push("<header>", `<h1>${esc(title)}</h1>`);
  if (room.purpose) out.push(`<p class="lede">${esc(room.purpose)}</p>`);
  out.push("<dl class=\"meta\">",
    `<dt>Room</dt><dd><code>${esc(room.id ?? roomId ?? "")}</code></dd>`,
    `<dt>Exported</dt><dd><time datetime="${attr(generatedAt)}">${when(generatedAt)}</time></dd>`,
    `<dt>History</dt><dd>${count} event${count === 1 ? "" : "s"}${count ? `, sequence ${first} to ${last}` : ""}${lastAt ? `, last at <time datetime="${attr(lastAt)}">${when(lastAt)}</time>` : ""}</dd>`,
    "</dl>",
    "<p class=\"lede\">A point-in-time, read-only copy of this room's conversation and work, as members saw it. Deleted messages are shown as deleted without their text. The complete machine-readable history is the JSONL export.</p>",
    "</header>");

  out.push("<section aria-labelledby=\"members\">", `<h2 id="members">Members (${members.size})</h2>`, "<ul class=\"members\">");
  for (const member of members.values()) {
    out.push(`<li>${esc(member.displayName)} <span class="flag">${esc(member.kind)}</span>${member.active ? "" : " <span class=\"flag\">access ended</span>"}</li>`);
  }
  if (!members.size) out.push("<li><em>No members recorded.</em></li>");
  out.push("</ul>", "</section>");

  out.push("<section aria-labelledby=\"messages\">", `<h2 id="messages">Messages (${messages.size})</h2>`);
  if (!messages.size) out.push("<p><em>No messages.</em></p>");
  else {
    out.push("<ol class=\"messages\">");
    for (const message of messages.values()) {
      const flags = [];
      if (message.replyToId) flags.push(`<span class="flag">reply</span>`);
      if (message.workItemId) flags.push(`<span class="flag">work: ${esc(work.get(message.workItemId)?.title ?? message.workItemId)}</span>`);
      if (message.edited) flags.push(`<span class="flag">edited</span>`);
      out.push("<li>", `<div class="head"><span class="author">${esc(name(message.authorId))}</span> <time datetime="${attr(message.at)}">${when(message.at)}</time> ${flags.join(" ")}</div>`);
      if (message.redacted) out.push(`<p class="body deleted">Message redacted${message.redactedAt ? ` <time datetime="${attr(message.redactedAt)}">${when(message.redactedAt)}</time>` : ""}</p>`);
      else if (message.deleted) out.push(`<p class="body deleted">Message deleted${message.deletedAt ? ` <time datetime="${attr(message.deletedAt)}">${when(message.deletedAt)}</time>` : ""}</p>`);
      else out.push(`<p class="body">${esc(message.body)}</p>`);
      out.push("</li>");
    }
    out.push("</ol>");
  }
  out.push("</section>");

  out.push("<section aria-labelledby=\"work\">", `<h2 id="work">Work items (${work.size})</h2>`);
  if (!work.size) out.push("<p><em>No work items.</em></p>");
  for (const item of work.values()) {
    out.push("<section class=\"work\">", `<h3>${esc(item.title ?? item.id)} <span class="flag">${esc(item.state)}</span></h3>`, "<dl>",
      `<dt>Definition of done</dt><dd>${esc(item.definitionOfDone ?? "")}</dd>`,
      `<dt>Accountable</dt><dd>${esc(name(item.accountableMemberId))}</dd>`,
      `<dt>Proposed by</dt><dd>${esc(item.proposedById ? name(item.proposedById) : "unknown")}${item.createdAt ? ` <time datetime="${attr(item.createdAt)}">${when(item.createdAt)}</time>` : ""}</dd>`,
      "</dl>");
    if (item.evidence.length) out.push("<ul class=\"evidence\">", ...item.evidence.map(entry => renderEvidence(entry, name)), "</ul>");
    if (item.notes.length) {
      out.push("<ul class=\"evidence\">");
      for (const note of item.notes) out.push(`<li><span class="head"><span class="author">${esc(note.label)}</span> <span>${esc(name(note.actorId))}</span> <time datetime="${attr(note.at)}">${when(note.at)}</time></span><div class="body">${esc(note.text)}</div></li>`);
      out.push("</ul>");
    }
    out.push("</section>");
  }
  out.push("</section>");

  // The closing marker lets a reader tell a whole file from a cut one: the
  // route sends Content-Length too, but a saved file has no headers.
  out.push("<footer>", `End of export: ${count} event${count === 1 ? "" : "s"} rendered${last ? `, through sequence ${last}` : ""}.`, "</footer>", "</body>", "</html>", "");
  return out.join("\n");
}
