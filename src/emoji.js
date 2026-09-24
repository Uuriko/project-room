// Unicode emoji for message text and reactions.
// Identity for a standard emoji is the Unicode grapheme (Discord). Slack-style
// shortcodes and the original like/heart/celebrate/thinking names are input
// aliases that fold into that grapheme. Custom room packs are not here: an
// unknown :shortcode: stays literal text until a pack exists.

import { EMOJI_ROWS, MODIFIER_BASE_RANGES } from "./emoji-catalog.js";

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
const rows = [];
for (const [emoji, primary, extras, category, description, search] of EMOJI_ROWS) {
  const aliases = [primary, ...extras.split(" ").filter(Boolean)];
  const row = { emoji, primary, aliases, category, description, search };
  rows.push(row);
  if (!byEmoji.has(emoji)) byEmoji.set(emoji, row);
  for (const alias of aliases) if (!byShortcode.has(alias)) byShortcode.set(alias, emoji);
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

export function emojiName(emoji) {
  const row = byEmoji.get(emoji);
  if (row) return row.description;
  const stripped = String(emoji).replace(/[\u{1F3FB}-\u{1F3FF}]/gu, "");
  const base = byEmoji.get(stripped) || byEmoji.get(`${stripped}\uFE0F`);
  if (base && stripped !== emoji) return `${base.description}, skin tone`;
  return String(emoji);
}

const QUICK_EMOJI = Object.freeze(["👍", "❤️", "🎉", "🤔", "😂", "🔥", "👀", "✅"]);

export function frequentEmoji(recent = []) {
  const out = [];
  const seen = new Set();
  for (const candidate of [...recent, ...QUICK_EMOJI]) {
    const key = canonicalReaction(candidate);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= 8) break;
  }
  return out;
}

export function emojiMatches(query, limit = 8) {
  const q = String(query ?? "").trim().toLowerCase().replace(/^:/, "").replace(/:$/, "");
  const cap = Math.max(0, limit);
  if (!q) return frequentEmoji().slice(0, cap).map(emoji => ({ emoji, name: emojiName(emoji) }));
  const scored = [];
  for (const row of rows) {
    let score = 0;
    if (row.primary === q || row.aliases.includes(q)) score = 100;
    else if (row.primary.startsWith(q) || row.aliases.some(alias => alias.startsWith(q))) score = 80;
    else if (row.search.includes(q)) score = 40;
    if (!score) continue;
    scored.push({ score, row });
  }
  scored.sort((a, b) => b.score - a.score || a.row.primary.localeCompare(b.row.primary) || a.row.emoji.localeCompare(b.row.emoji));
  const seen = new Set();
  const out = [];
  for (const { row } of scored) {
    if (seen.has(row.emoji)) continue;
    seen.add(row.emoji);
    out.push({ emoji: row.emoji, name: row.description });
    if (out.length >= cap) break;
  }
  return out;
}

const CATEGORY_ORDER = Object.freeze([
  "Smileys & Emotion", "People & Body", "Animals & Nature", "Food & Drink",
  "Activities", "Travel & Places", "Objects", "Symbols", "Flags"
]);

export function emojiCatalog() {
  const groups = new Map(CATEGORY_ORDER.map(category => [category, []]));
  for (const row of rows) {
    const bucket = groups.get(row.category) || groups.get("Smileys & Emotion");
    bucket.push({ emoji: row.emoji, name: row.description });
  }
  return [...groups.entries()].filter(([, items]) => items.length).map(([category, items]) => ({ category, items }));
}

// Composer token: a ":" started after whitespace, with a shortcode prefix
// before the caret. A bare colon does not open the list, so "Note:" still sends.
export function emojiQuery(text, caret) {
  const value = String(text ?? "");
  const pos = Number.isInteger(caret) ? Math.min(Math.max(caret, 0), value.length) : value.length;
  const before = value.slice(0, pos);
  const match = /(^|[\s]):([a-z0-9_+-]{1,40})$/i.exec(before);
  if (!match) return null;
  return { start: before.length - match[2].length - 1, query: match[2].toLowerCase() };
}

export function insertEmoji(text, caret, start, emoji) {
  const value = String(text ?? "");
  const pos = Number.isInteger(caret) ? caret : value.length;
  const at = Number.isInteger(start) ? Math.max(0, start) : 0;
  const after = value.slice(pos);
  const pad = after.startsWith(" ") ? "" : " ";
  const body = `${value.slice(0, at)}${emoji}${pad}${after}`;
  return { body, caret: at + emoji.length + (pad ? 1 : 0) };
}

// Display-only. Stored text stays as the member typed it. Known shortcodes
// become the glyph; unknown names (future custom emoji) stay visible.
export function renderEmojiShortcodes(text) {
  return String(text ?? "").replace(/(^|[^a-z0-9_+-]):([a-z0-9_+-]+)(?:::skin-tone-([2-6]))?:(?![a-z0-9_+-])/gi, (full, lead, name, tone) => {
    const emoji = canonicalReaction(tone ? `${name}::skin-tone-${tone}` : `:${name}:`);
    return emoji ? `${lead}${emoji}` : full;
  });
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
