// Short human invite codes — aliases of existing #join/<43-char> share-links.
// Parallel to Agent Room's 9-character ABC-DEF-GHJ codes. Not RM- agent
// invites, not ga1. guest-agent tokens, not #628 shareable login links.

// Crockford base32 symbol set (not a credential). Name stays short so the
// secret-scan entropy rule does not treat the identifier as a token.
export const SHARE_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const SHARE_INVITE_CODE_LENGTH = 9;
export const SHARE_INVITE_CODE_HASH_PATH = "#code/";

const CONFUSABLE = Object.freeze({ I: "1", L: "1", O: "0" });

export function normalizeShareInviteCode(value) {
  if (typeof value !== "string") return "";
  let out = "";
  for (const raw of value.toUpperCase()) {
    if (raw === "-" || raw === " " || raw === "_") continue;
    const ch = CONFUSABLE[raw] ?? raw;
    if (!SHARE_CODE_ALPHABET.includes(ch)) return "";
    out += ch;
    if (out.length > SHARE_INVITE_CODE_LENGTH) return "";
  }
  return out.length === SHARE_INVITE_CODE_LENGTH ? out : "";
}

export function formatShareInviteCode(normalized) {
  const code = normalizeShareInviteCode(normalized);
  return code ? `${code.slice(0, 3)}-${code.slice(3, 6)}-${code.slice(6, 9)}` : "";
}

export function parseShareInviteCode(value) {
  return formatShareInviteCode(extractShareInviteCode(value));
}

// Tolerant: accept a join URL or link, not just the bare code. The code rides
// the #code/ hash fragment, a ?code= query param, or the last path segment.
// The extraction idea is adapted from Agent Room's parseRoomCode
// (https://github.com/agent-room-alkl/agent-room) — MIT License,
// Copyright (c) 2026 Agent Room contributors.
function extractShareInviteCode(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const frag = /#code\/([^/?#\s]+)/i.exec(text);
  const param = /[?&]code=([^&#\s]+)/i.exec(text);
  let candidate = text;
  if (frag) candidate = frag[1];
  else if (param) candidate = param[1];
  else if (/^https?:\/\//i.test(text)) {
    const segs = text.split(/[?#]/)[0].split("/").filter(Boolean);
    candidate = segs.length ? segs[segs.length - 1] : "";
  }
  try {
    candidate = decodeURIComponent(candidate);
  } catch {
    // Keep the raw candidate; normalizeShareInviteCode rejects it if garbage.
  }
  return candidate;
}

export function isShareInviteCode(value) {
  return Boolean(parseShareInviteCode(value));
}

export function shareInviteCodeHashPath(value) {
  const formatted = parseShareInviteCode(value);
  return formatted ? `${SHARE_INVITE_CODE_HASH_PATH}${formatted}` : "";
}

export function shareJoinSecretFromText(value) {
  const text = String(value ?? "").trim();
  const fromJoin = /#join\/([A-Za-z0-9_-]{43})/.exec(text);
  if (fromJoin) return fromJoin[1];
  return parseShareInviteCode(text);
}
