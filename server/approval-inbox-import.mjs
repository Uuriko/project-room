// server/approval-inbox-import.mjs
// WAVE-500 guild 10/10 (unified approval inbox), slice 8/50: tap-list importer.
//
// Parses the standing tap list (TAPS-2026-09-22.md) into approval-inbox card
// DRAFTS. Drafts are inert data - turning them into live cards is a separate,
// human-confirmed step owned by another slice. This module is pure: no I/O,
// no network, no side effects, and it never creates a live card.
//
// Tap-list conventions handled:
// - numbered items `N.` / `Nb.` (e.g. 5b, 11c) under ## sections
// - bullet taps under "## Added ..." sections (new taps arrive as bullets)
// - RETIRED / RESOLVED / CLOSED / DONE markers and ~~strikethrough~~ skipped
// - "Parked", "Closed out", "Standing", and "Batched for next device session"
//   sections never become drafts (not pending decisions, or duplicated indexes)

export const DRAFT_KINDS = ["money", "identity", "deploy", "permission", "publish", "other"];

const SKIP_SECTION = /closed out|parked|standing|batched for next device session/i;
const ADDED_SECTION = /^added\b/i;

const NUMBERED = /^\s*(\d+[a-z]?)\.\s+(.+?)\s*$/;
const BULLET = /^\s*[-*]\s+(.+?)\s*$/;
const HEADING = /^\s*#{1,3}\s+(.+?)\s*$/;
const CLOSED_MARKER = /(^|[^A-Za-z])(RETIRED|RESOLVED|CLOSED|DONE)([^A-Za-z]|$)/;
const STRUCK = /~~/;
// Title/body separator: the tap list uses an em dash, sometimes a hyphen or colon.
const SEPARATOR = /\s[—–-]\s|:\s/;

// Explicit owner-decision routing wins over topic keywords: when the tap says
// the OWNER must decide ("your call", "owner action", ...), the card is a
// permission card even when its subject is money-adjacent (e.g. a spend-path
// kill switch). Topic keywords below classify everything else.
const PERMISSION_FIRST = /your call|owner action|owner-only|owner click|owner decision/i;

// Keyword rules run before section fallbacks: an item's own words win.
const KIND_RULES = [
  ["money", /\$\s?\d|\bUSDC\b|\bETH\b|\bSOL\b|\bmoney\b|prize|funding|payment|\bpay\b|paid|payout|budget|bounty|bounties|\bfee\b|\bcost\b|\bpool\b|treasury|spend|pricing|\btier\b|\bcredit\b/i],
  ["identity", /sign-in|signin|login|gmail|OAuth|\bPAT\b|token|credential|password|wallet|invite|identity|custod|session|secret|\bkey\b|keys|signature|forensics|2FA|MFA|\bauth\b/i],
  ["deploy", /\bdeploy|redeploy|release|\bship\b|production|\bmerge\b|merged|branch|\bCI\b|rollout|rollback|mainnet/i],
  ["permission", /owner action|owner-only|owner click|your call|your word|\btap\b|approve|approval|authoriz|decision|yes or no|yes\/no|ratif|permission/i],
  ["publish", /\bpublish|submission|submit|listing|\bpost\b|\bHN\b|outreach|press|announce/i],
];
const SECTION_KIND = [
  [/money|grants/i, "money"],
  [/credential|device session/i, "identity"],
  [/rsvp|decisions/i, "permission"],
];

export function classifyTapKind(text, section = "") {
  const t = String(text || "");
  if (PERMISSION_FIRST.test(t)) return "permission";
  for (const [kind, re] of KIND_RULES) if (re.test(t)) return kind;
  for (const [re, kind] of SECTION_KIND) if (re.test(section)) return kind;
  return "other";
}

function slug(text) {
  const s = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.split("-").slice(0, 6).join("-") || "section";
}

function splitTitle(text) {
  const rest = String(text || "").trim();
  const bold = rest.match(/^\*\*(.+?)\*\*\s*(.*)$/s);
  if (bold) {
    return {
      title: bold[1].trim().replace(/[: –-]\s*$/, "").trim(),
      what: bold[2].trim(),
    };
  }
  const sep = rest.match(SEPARATOR);
  if (sep) {
    return {
      title: rest.slice(0, sep.index).trim(),
      what: rest.slice(sep.index + sep[0].length).trim(),
    };
  }
  const sentence = rest.match(/^(.{10,120}?[.?!])\s+(.*)$/s);
  if (sentence) return { title: sentence[1].trim(), what: sentence[2].trim() };
  return { title: rest.slice(0, 140), what: "" };
}

function extractOptions(body) {
  const m = String(body || "").match(/[Oo]ptions:\s*(.+)$/s);
  if (m) {
    const out = [];
    for (const part of m[1].split(/\([a-z]\)/)) {
      let o = part.trim().split(/[.?!]\s/)[0].trim().replace(/[.?!;,]+$/, "");
      if (o && !out.includes(o)) out.push(o);
    }
    return out;
  }
  if (/yes or no|yes\/no/i.test(body)) return ["yes", "no"];
  return [];
}

export function parseTapList(markdown) {
  if (typeof markdown !== "string" || !markdown.trim()) return [];
  const lines = markdown.split("\n");
  const drafts = [];
  let section = "";
  let skipSection = false;
  let addedSection = false;
  let bulletIndex = 0;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const h = line.match(HEADING);
    if (h) {
      section = h[1].trim();
      skipSection = SKIP_SECTION.test(section);
      addedSection = ADDED_SECTION.test(section);
      bulletIndex = 0;
      i += 1;
      continue;
    }
    if (skipSection || !line.trim()) {
      i += 1;
      continue;
    }
    const num = line.match(NUMBERED);
    const bul = !num && addedSection ? line.match(BULLET) : null;
    const match = num || bul;
    if (!match) {
      i += 1;
      continue;
    }
    const rawText = (num ? match[2] : match[1]).trim();
    // Lead-in bullets (ending in ":") absorb following sibling bullets as context.
    const leadIn = /:\s*$/.test(rawText.replace(/\*\*/g, ""));
    const extra = [];
    let j = i + 1;
    while (j < lines.length) {
      const nxt = lines[j];
      if (!nxt.trim() || HEADING.test(nxt) || NUMBERED.test(nxt)) break;
      const nb = nxt.match(BULLET);
      if (nb && leadIn) {
        extra.push(nb[1].trim());
        j += 1;
        continue;
      }
      break;
    }
    i = j;
    if (STRUCK.test(rawText) || CLOSED_MARKER.test(rawText)) continue; // retired/closed/struck
    if (bul) bulletIndex += 1;
    const sourceRef = num ? `tap-${num[1]}` : `${slug(section)}-${bulletIndex}`;
    const { title, what } = splitTitle(rawText);
    const body = [what, ...extra].filter(Boolean).join(" ");
    drafts.push({
      kind: classifyTapKind(`${title} ${body}`, section),
      title: title.slice(0, 140),
      what: body.slice(0, 280),
      context: [section, ...extra].filter(Boolean).join(" | ").slice(0, 280),
      options: extractOptions(body),
      sourceRef,
    });
  }
  return drafts;
}
