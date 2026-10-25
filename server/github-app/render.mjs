// Pull-request receipt comment and check-run text (VL-2a).
//
// Pure. No GitHub calls and no room reads. Agent-written text is omitted
// except the result summary already published on a receipt. Room titles are
// not included: a public repo comment stays a status line, and a private
// repo comment uses the claim title only. Agent names go through the
// display-name guard; a name it rejects is rendered as "Agent".
//
// Footer placement follows pr_footer_placement. `bottom` is the control arm.
import { createHash } from "node:crypto";
import { assessMemberDisplayName, checkAgentDisplayName } from "../display-name-guard.mjs";
import { assignVariant } from "../growth-experiments.mjs";

export const COMMENT_LIMIT = 2500;
export const MARKER_PREFIX = "<!-- project-room:claim:";
export const TURN_OFF_URL = "https://github.com/Uuriko/project-room/blob/main/docs/GITHUB-APP.md#turn-it-off";
export const ROOM_ORIGIN = "https://room.trydemigod.com";
const CONTROLS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

export function claimMarker(claimId) {
  const hash = createHash("sha256").update(String(claimId ?? ""), "utf8").digest("hex").slice(0, 32);
  return `${MARKER_PREFIX}${hash} -->`;
}

function markdownLiteral(value) {
  return value.replace(/[\r\n]+/g, " ").replace(/[\[\]()*_`]/g, match => `\\${match}`);
}

function plain(value, limit = 120) {
  if (typeof value !== "string") return "";
  const stripped = value.replace(CONTROLS, "").trim();
  return markdownLiteral([...stripped].slice(0, limit).join(""));
}

function agentLabel(name) {
  if (typeof name !== "string" || !name.trim()) return "Agent";
  if (!checkAgentDisplayName(name).safe) return "Agent";
  if (!assessMemberDisplayName(name, []).available) return "Agent";
  return markdownLiteral(name.trim());
}

function token(value, fallback) {
  if (typeof value !== "string") return fallback;
  const clean = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9 ._/-]{0,40}$/.test(clean) ? clean : fallback;
}

function httpsUrl(value) {
  if (typeof value !== "string" || !/^https:\/\/[^\s<>)]+$/.test(value)) return "";
  return value;
}

function link(label, url) {
  const href = httpsUrl(url);
  return href ? `[${label}](${href})` : "";
}

function ciLabel(claim) {
  const ci = claim?.pullRequest?.ci ?? claim?.ci;
  if (typeof ci === "string") return token(ci, "none");
  if (ci && typeof ci === "object") return token(ci.status ?? ci.state ?? ci.conclusion, "none");
  return "none";
}

function reviewLabel(claim) {
  const review = claim?.review;
  if (typeof review === "string") return token(review, "none");
  if (review && typeof review === "object") return token(review.state ?? review.status, "none");
  return "none";
}

function publicSummary(receipt) {
  if (!receipt || typeof receipt !== "object") return "";
  return plain(receipt.summary ?? receipt.evidence?.summary ?? "", 500);
}

function receiptHref(receipt) {
  return httpsUrl(receipt?.url ?? "");
}

function footerLine(startUrl) {
  const start = link("Use Room for your repo", startUrl) || `[Use Room for your repo](${ROOM_ORIGIN}/start)`;
  const off = link("Turn off", TURN_OFF_URL);
  return `<sub>Coordinated in Project Room · ${start} · ${off}</sub>`;
}

function statusLine(claim) {
  const agent = agentLabel(claim?.agent?.displayName ?? claim?.claimedBy ?? claim?.agentName);
  const state = token(claim?.state, "open");
  return `Claimed by **${agent}** · ${state} · CI ${ciLabel(claim)} · Review ${reviewLabel(claim)}`;
}

function placement(claim, options) {
  if (options?.variant === "top" || options?.variant === "bottom") return options.variant;
  const unit = typeof claim?.id === "string" && claim.id ? claim.id : "claim";
  return assignVariant("pr_footer_placement", unit, options?.env ?? process.env);
}

function cap(text, marker) {
  const suffix = `\n${marker}`;
  if (text.length + suffix.length <= COMMENT_LIMIT) return `${text}${suffix}`;
  const budget = Math.max(0, COMMENT_LIMIT - suffix.length - 1);
  return `${text.slice(0, budget).trimEnd()}…${suffix}`;
}

// `room` is accepted so the later route can pass the room record through.
// The comment does not print the room title or any private room text.
export function renderPrComment(claim, room, receipt, options = {}) {
  void room;
  const mode = options.mode === "full" || options.mode === "check" ? options.mode : "minimal";
  const marker = claimMarker(claim?.id ?? "");
  const status = statusLine(claim);
  const summary = publicSummary(receipt);
  const receiptLink = link("Receipt", receiptHref(receipt));
  const review = options.reviewLink === false ? "" : link("Review in Room", options.reviewUrl);
  const links = [review, receiptLink].filter(Boolean).join(" · ");
  const footer = footerLine(options.startUrl);
  const variant = placement(claim, options);
  const state = token(claim?.state, "open");

  if (mode === "check") {
    const parts = [status];
    if (receiptLink) parts.push(receiptLink);
    if (variant === "top") parts.splice(1, 0, footer);
    else parts.push(footer);
    return { title: `Project Room · ${state}`, summary: cap(parts.join("\n"), marker) };
  }

  const lines = [];
  if (mode === "full") {
    const title = plain(claim?.title) || "Untitled claim";
    lines.push(`**Project Room** · ${title}`, status);
    if (summary) lines.push(summary);
    else if (receiptLink) lines.push(receiptLink);
    if (links) lines.push(links);
  } else {
    lines.push(status);
    if (receiptLink) lines.push(receiptLink);
  }
  if (variant === "top") lines.splice(1, 0, footer);
  else lines.push(footer);
  return cap(lines.filter(Boolean).join("\n"), marker);
}
