// Historical reaction/poll compatibility. No emoji UI or text conversion.
import { REACTION_IDENTITIES, MODIFIER_BASE_RANGES } from "./legacy-reaction-aliases.js";

export const LEGACY_REACTIONS = Object.freeze({
  like: "👍",
  heart: "❤️",
  celebrate: "🎉",
  thinking: "🤔"
});

// Distinct emoji on one message. Removing one and adding to an existing
// emoji still works at the cap. One member can hold each emoji only once.
export const MAX_REACTIONS_PER_MESSAGE = 50;
export const REACTION_KEY_MAX = 64;

const SKIN_TONES = Object.freeze({
  2: "\u{1F3FB}",
  3: "\u{1F3FC}",
  4: "\u{1F3FD}",
  5: "\u{1F3FE}",
  6: "\u{1F3FF}"
});
const SKIN_TONE = /[\u{1F3FB}-\u{1F3FF}]/u;
const SHORTCODE = /^[a-z0-9_+-]+$/;
const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

const modifierBases = new Set();
for (const part of MODIFIER_BASE_RANGES.split(",")) {
  if (!part) continue;
  if (part.includes("-")) {
    const [start, end] = part.split("-").map(hex => Number.parseInt(hex, 16));
    for (let code = start; code <= end; code++) modifierBases.add(code);
  } else modifierBases.add(Number.parseInt(part, 16));
}

const byShortcode = new Map();
const byEmoji = new Map();
for (const [emoji, aliases] of REACTION_IDENTITIES) {
  byEmoji.set(emoji, true);
  for (const alias of aliases.split(" ")) byShortcode.set(alias, emoji);
}

function graphemes(text) {
  return [...segmenter.segment(text)].map(part => part.segment);
}

export function isSingleEmoji(text) {
  const parts = graphemes(text);
  if (parts.length !== 1) return false;
  const grapheme = parts[0];
  if ([...grapheme].length === 1 && grapheme.codePointAt(0) < 0x80) return false;
  if (/\p{Extended_Pictographic}/u.test(grapheme)) return true;
  if (/\p{Regional_Indicator}/u.test(grapheme)) return true;
  return grapheme.includes("\u20E3");
}

function qualify(grapheme) {
  if (byEmoji.has(grapheme)) return grapheme;
  if (!grapheme.includes("\uFE0F") && byEmoji.has(`${grapheme}\uFE0F`)) return `${grapheme}\uFE0F`;
  const stripped = grapheme.replace(/\uFE0F/g, "");
  if (byEmoji.has(stripped)) return stripped;
  if (byEmoji.has(`${stripped}\uFE0F`)) return `${stripped}\uFE0F`;
  return grapheme;
}

function applySkinTone(emoji, tone) {
  const toneChar = SKIN_TONES[tone];
  if (!toneChar || SKIN_TONE.test(emoji)) return null;
  const chars = [...emoji];
  if (!modifierBases.has(chars[0].codePointAt(0))) return null;
  const rest = chars[1] === "\uFE0F" ? chars.slice(2) : chars.slice(1);
  const toned = chars[0] + toneChar + rest.join("");
  return isSingleEmoji(toned) ? toned : null;
}

// Slack names that gemoji spells differently. Identity is still the glyph.
const EXTRA_ALIASES = Object.freeze({ thinking_face: "🤔" });

function lookupShortcode(token) {
  return LEGACY_REACTIONS[token] || EXTRA_ALIASES[token] || byShortcode.get(token) || null;
}

// Fold a reaction argument into one Unicode key, or return null when it is
// not a single standard emoji. Accepts the glyph, :shortcode:, shortcode,
// shortcode::skin-tone-N, and the legacy like/heart/celebrate/thinking names.
export function canonicalReaction(input) {
  if (typeof input !== "string" || !input.isWellFormed()) return null;
  let raw = input.trim().normalize("NFC");
  if (!raw || raw.length > REACTION_KEY_MAX) return null;
  let tone = null;
  const wrappedTone = /^:([a-z0-9_+-]+)::skin-tone-([2-6]):$/i.exec(raw);
  const bareTone = /^([a-z0-9_+-]+)::skin-tone-([2-6])$/i.exec(raw);
  const wrapped = /^:([a-z0-9_+-]+):$/i.exec(raw);
  if (wrappedTone) { raw = wrappedTone[1].toLowerCase(); tone = wrappedTone[2]; }
  else if (bareTone) { raw = bareTone[1].toLowerCase(); tone = bareTone[2]; }
  else if (wrapped) raw = wrapped[1].toLowerCase();

  if (tone) {
    const base = lookupShortcode(raw.toLowerCase());
    if (!base) return null;
    const toned = applySkinTone(base, tone);
    return toned && toned.length <= REACTION_KEY_MAX ? toned : null;
  }

  const token = raw.toLowerCase();
  if (SHORTCODE.test(token)) {
    const found = lookupShortcode(token);
    if (found) return found;
    if (SHORTCODE.test(raw)) return null;
  }

  if (!isSingleEmoji(raw)) return null;
  const qualified = qualify(raw);
  return qualified.length <= REACTION_KEY_MAX ? qualified : null;
}

// Merge legacy names and duplicate glyphs into one map keyed by Unicode.
export function foldedReactionMap(reactions = {}) {
  const groups = new Map();
  for (const [raw, members] of Object.entries(reactions || {})) {
    if (!Array.isArray(members)) continue;
    const key = canonicalReaction(raw);
    if (!key) continue;
    const set = groups.get(key) || new Set();
    for (const id of members) if (id != null && id !== "") set.add(id);
    groups.set(key, set);
  }
  const folded = {};
  for (const [key, set] of groups) if (set.size) folded[key] = [...set].sort();
  return folded;
}

export function clipGraphemes(text, maxUnits) {
  const value = String(text ?? "");
  const limit = Number.isInteger(maxUnits) ? maxUnits : value.length;
  if (value.length <= limit) return value;
  let taken = 0;
  for (const { segment } of segmenter.segment(value)) {
    if (taken + segment.length > limit) break;
    taken += segment.length;
  }
  return value.slice(0, taken);
}
