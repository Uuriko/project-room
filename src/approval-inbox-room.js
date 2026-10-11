// src/approval-inbox-room.js
//
// Client-side renderer for unified approval-inbox card events in the room
// message stream (WAVE-500 guild 10, unified approval inbox).
//
// EVENT -> RENDER CONTRACT. Sibling slice 6's card projection is not landed
// yet, so this module DEFINES the contract the projection must feed:
//
//   inbox.card_opened  -> headline + kind badge + "Decide" link
//     data: { cardId, kind, headline, decideUrl, summary?, requesterName?,
//             expiresAt?, openedAt? }
//   inbox.card_decided -> outcome + decided-by + receipt link
//     data: { cardId, kind, headline, outcome, decidedBy, decidedAt?,
//             receiptUrl?, receiptId? }
//   inbox.card_expired -> quiet, honest note; no action affordance
//     data: { cardId, kind?, headline?, expiredAt? }
//
// Kinds mirror server/approval-inbox-policy.mjs: money, identity, deploy,
// permission, publish, other. Outcomes mirror the policy decisions
// (approve | approve-session | deny-stop) plus the card statuses the skill
// doc names (approved | rejected).
//
// Pure: no I/O, no DOM, no clock reads. Returns HTML strings; the caller
// inserts them into the message stream. All text is escaped — card content
// is agent- or human-supplied and may arrive hostile.
//
// HOOKUP (for the merge lane, one line in the message-stream renderer):
//   import { renderInboxCardEvent } from "./approval-inbox-room.js";
//   const inboxHtml = renderInboxCardEvent(event); // "" when not an inbox card
//
// This module never touches src/events.js — event-type registration and
// stream wiring belong to the merge lane.

export const INBOX_CARD_OPENED = "inbox.card_opened";
export const INBOX_CARD_DECIDED = "inbox.card_decided";
export const INBOX_CARD_EXPIRED = "inbox.card_expired";

export const INBOX_KINDS = Object.freeze(["money", "identity", "deploy", "permission", "publish", "other"]);

const KIND_LABELS = {
  money: "Money",
  identity: "Identity",
  deploy: "Deploy",
  permission: "Permission",
  publish: "Publish",
  other: "Decision",
};

const OUTCOME_LABELS = {
  approve: "Approved",
  approved: "Approved",
  "approve-session": "Approved for session",
  "approved-session": "Approved for session",
  "deny-stop": "Rejected",
  deny: "Rejected",
  denied: "Rejected",
  reject: "Rejected",
  rejected: "Rejected",
};

const MAX_TEXT = 500;

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Hard length cap: a pathological headline must not bloat the stream row.
function clip(value) {
  const s = String(value ?? "").trim();
  return escapeHtml(s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + "…" : s);
}

function safeKind(kind) {
  return INBOX_KINDS.includes(kind) ? kind : "unknown";
}

/** Kind badge. Unknown kinds get an honest badge, never a fabricated one. */
export function kindBadge(kind) {
  const k = safeKind(kind);
  const label = k === "unknown" ? "Unknown kind" : KIND_LABELS[k];
  return `<span class="inbox-kind inbox-kind-${k}">${escapeHtml(label)}</span>`;
}

function cardAttrs(cardId) {
  return cardId ? ` data-inbox-card="${escapeHtml(cardId)}" data-focus-key="inbox-card:${escapeHtml(cardId)}"` : "";
}

function metaLine(parts) {
  const items = parts.filter(Boolean);
  return items.length ? `<span class="inbox-meta">${items.join(" · ")}</span>` : "";
}

/**
 * Card opened: headline + kind badge + "Decide" link.
 * Degrades honestly on missing fields; never throws on malformed data.
 */
export function renderInboxCardOpened(card = {}) {
  const headline = clip(card.headline) || "Untitled decision";
  const meta = metaLine([
    card.requesterName ? `Asked by ${clip(card.requesterName)}` : "",
    card.expiresAt ? `Expires ${clip(card.expiresAt)}` : "",
  ]);
  const summary = card.summary ? `<p class="inbox-summary">${clip(card.summary)}</p>` : "";
  const decide = card.decideUrl
    ? `<a class="inbox-decide button secondary" href="${escapeHtml(card.decideUrl)}">Decide</a>`
    : "";
  return `<article class="inbox-card inbox-card-opened"${cardAttrs(card.cardId)}>` +
    `<div class="inbox-card-top">${kindBadge(card.kind)}${meta}</div>` +
    `<h3 class="inbox-headline">${headline}</h3>${summary}` +
    (decide ? `<div class="inbox-actions">${decide}</div>` : "") +
    `</article>`;
}

/**
 * Card decided: outcome + decided-by + receipt link.
 * No receipt link when none is attached — never an empty anchor.
 */
export function renderInboxCardDecided(card = {}) {
  const raw = String(card.outcome ?? "").trim().toLowerCase();
  const label = OUTCOME_LABELS[raw] || (raw ? escapeHtml(raw[0].toUpperCase() + raw.slice(1)) : "Decided");
  const headline = clip(card.headline) || "Untitled decision";
  const by = card.decidedBy
    ? `<p class="inbox-decided-by">Decided by ${clip(card.decidedBy)}${card.decidedAt ? ` · ${clip(card.decidedAt)}` : ""}</p>`
    : "";
  const receipt = card.receiptUrl
    ? `<a class="inbox-receipt" href="${escapeHtml(card.receiptUrl)}">Receipt${card.receiptId ? ` ${clip(card.receiptId)}` : ""}</a>`
    : "";
  const tone = /approve/i.test(label) ? "approved" : /reject/i.test(label) ? "rejected" : "other";
  return `<article class="inbox-card inbox-card-decided inbox-outcome-${tone}"${cardAttrs(card.cardId)}>` +
    `<div class="inbox-card-top">${kindBadge(card.kind)}<span class="inbox-outcome">${label}</span></div>` +
    `<h3 class="inbox-headline">${headline}</h3>${by}` +
    (receipt ? `<div class="inbox-actions">${receipt}</div>` : "") +
    `</article>`;
}

/**
 * Card expired: quiet, honest. A dead decision is still named so it does
 * not silently vanish from the record — but it offers no actions.
 */
export function renderInboxCardExpired(card = {}) {
  const headline = clip(card.headline) || "Untitled decision";
  const when = card.expiredAt ? ` · ${clip(card.expiredAt)}` : "";
  return `<article class="inbox-card inbox-card-expired"${cardAttrs(card.cardId)}>` +
    `<p class="inbox-expired-note"><span class="inbox-headline">${headline}</span> expired undecided${when}.</p>` +
    `</article>`;
}

/**
 * Dispatcher for the message stream. Takes an event envelope { type, data }
 * and returns the card HTML for inbox card events, "" for anything else —
 * so the renderer is backward compatible with the full event stream.
 */
export function renderInboxCardEvent(event) {
  if (!event || typeof event !== "object") return "";
  const { type, data } = event;
  if (type === INBOX_CARD_OPENED) return renderInboxCardOpened(data);
  if (type === INBOX_CARD_DECIDED) return renderInboxCardDecided(data);
  if (type === INBOX_CARD_EXPIRED) return renderInboxCardExpired(data);
  return "";
}
