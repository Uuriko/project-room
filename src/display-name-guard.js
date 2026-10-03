// #938: bounded visual-confusable guard for newly minted and linked agent names.
// Member admission (QA2 P1-4) also refuses reserved labels, control characters,
// and names whose skeleton matches an active member in the same room.
// This is a pure check. Callers must supply the active names visible at their
// scope and reject an unsafe result before writing a member record.
// The table handles common Greek/Cyrillic lookalikes, not all UTS #39 data.
// Never treat a successful check as proof of the named agent's identity.
// Existing member rows are left as stored; only a new or changed name is checked.

const latin = /\p{Script=Latin}/u;
const greek = /\p{Script=Greek}/u;
const cyrillic = /\p{Script=Cyrillic}/u;
const invisible = /\p{Default_Ignorable_Code_Point}/u;
const controls = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const spaces = /\p{White_Space}+/gu;

// Most frequent Latin-lookalike alphabetic characters. Deliberately explicit:
// unmapped characters retain their code point and do not masquerade as a
// complete Unicode security implementation. NFKC handles width/style forms.
const lookalikes = new Map(Object.entries({
  А:'a', В:'b', С:'c', Е:'e', Н:'h', І:'i', Ј:'j', К:'k', М:'m', О:'o', Р:'p', Ѕ:'s', Т:'t', Х:'x', У:'y',
  а:'a', в:'b', с:'c', е:'e', һ:'h', і:'i', ј:'j', к:'k', м:'m', о:'o', р:'p', ѕ:'s', т:'t', х:'x', у:'y',
  Α:'a', Β:'b', Ε:'e', Ζ:'z', Η:'h', Ι:'i', Κ:'k', Μ:'m', Ν:'n', Ο:'o', Ρ:'p', Τ:'t', Υ:'y', Χ:'x',
  α:'a', β:'b', ε:'e', ι:'i', κ:'k', ο:'o', ρ:'p', τ:'t', υ:'y', χ:'x',
}));

export function displayNameSkeleton(value) {
  if (typeof value !== 'string') return null;
  const canonical = value.normalize('NFKC').trim().replace(spaces, ' ').toLowerCase();
  return [...canonical].map(char => lookalikes.get(char) ?? char).join('');
}

function recordName(record) {
  if (typeof record === 'string') return { name: record, id: null };
  if (!record || typeof record !== 'object') return { name: null, id: null };
  return { name: record.displayName ?? record.display_name ?? null,
    id: record.identityId ?? record.identity_id ?? record.memberId ?? record.id ?? null };
}

// activeNames is a snapshot supplied by the caller (for mint: global active
// identity names; for link: room members plus active identities in scope).
// excludeId permits a same-identity retry/link, not another identity with the
// same name. It is compared to trusted record IDs, never to display text.
export function checkAgentDisplayName(name, { activeNames = [], excludeId = null } = {}) {
  if (typeof name !== 'string' || !name.trim() || name.length > 80 || controls.test(name))
    return { safe: false, reason: 'invalid_name' };
  const normalized = name.normalize('NFKC');
  if (invisible.test(normalized)) return { safe: false, reason: 'invisible_character' };
  const scripts = [latin, greek, cyrillic].filter(pattern => pattern.test(normalized)).length;
  if (scripts > 1) return { safe: false, reason: 'mixed_script' };
  const skeleton = displayNameSkeleton(name);
  if (!skeleton) return { safe: false, reason: 'invalid_name' };
  for (const record of activeNames) {
    const { name: other, id } = recordName(record);
    if (typeof other !== 'string' || (excludeId !== null && id === excludeId)) continue;
    if (displayNameSkeleton(other) === skeleton) return { safe: false, reason: 'name_collision' };
  }
  return { safe: true, reason: null };
}

// Labels a new member may not take. Compared on the skeleton, so case, width,
// and mapped lookalikes do not slip past. A leading "@" and a trailing
// "(owner)" / "[system]" decoration are part of the same label, not a
// different name. "all" matches the whole label only, so ordinary names that
// merely contain those letters stay available.
const reservedLabels = new Set([
  'system', 'project room', 'room owner', 'owner', 'admin', 'moderator',
  'everyone', 'here', 'channel', 'all',
]);

// Cf already covers these. The explicit class keeps bidi and direction
// marks rejected if the general format class is ever narrowed.
const bidiControls = /[\u202A-\u202E\u2066-\u2069\u200E\u200F]/u;

// SEC-2: the same classes guard Board titles and notes
// (server/work-claim-integrity.mjs). spaces carries the g flag; use it with
// replace, not test.
export const TEXT_CHARACTER_CLASSES = Object.freeze({ invisible, bidiControls, spaces });

function hasBlockedControls(value) {
  return controls.test(value) || bidiControls.test(value);
}

function stripControls(value) {
  return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u202A-\u202E\u2066-\u2069\u200E\u200F]/gu, '');
}

function normalizedName(value) {
  return value.normalize('NFKC').trim().replace(spaces, ' ').toLowerCase();
}

function activeNameList(activeNames) {
  const records = Array.isArray(activeNames) ? activeNames
    : activeNames && typeof activeNames === 'object' ? Object.values(activeNames)
    : [];
  const names = [];
  for (const record of records) {
    if (record && typeof record === 'object' && !Array.isArray(record) && record.active === false) continue;
    const { name } = recordName(record);
    if (typeof name === 'string' && name.trim()) names.push(name);
  }
  return names;
}

// Peel a leading "@" and trailing parenthetical decorations. Returns the
// core skeleton plus each decoration skeleton, so "(owner)" is reserved
// even when the words in front of it are not.
function labelParts(skeleton) {
  let value = skeleton.replace(/^@+\s*/, '').trim();
  const decorations = [];
  while (value) {
    const match = /^(.*?)\s*[(\[]([^)\]]+)[)\]]$/.exec(value);
    if (!match) break;
    const core = match[1].trim();
    const decoration = match[2].trim();
    if (!core) return { core: decoration, decorations };
    decorations.push(decoration);
    value = core;
  }
  return { core: value, decorations };
}

function isReservedLabel(skeleton) {
  if (!skeleton) return false;
  const { core, decorations } = labelParts(skeleton);
  if (reservedLabels.has(core)) return true;
  return decorations.some(decoration => reservedLabels.has(decoration));
}

function classifyMemberDisplayName(name, activeNames) {
  if (typeof name !== 'string' || !name.trim() || name.length > 80) return { available: false, reason: 'invalid' };
  if (hasBlockedControls(name)) return { available: false, reason: 'control_characters' };
  const skeleton = displayNameSkeleton(name);
  const normalized = normalizedName(name);
  if (!skeleton) return { available: false, reason: 'invalid' };
  const names = activeNameList(activeNames);
  if (names.some(other => normalizedName(other) === normalized)) return { available: false, reason: 'duplicate' };
  if (isReservedLabel(skeleton)) return { available: false, reason: 'reserved' };
  if (names.some(other => displayNameSkeleton(other) === skeleton)) return { available: false, reason: 'confusable' };
  return { available: true, reason: null };
}

function visibleBase(name) {
  const stripped = stripControls(name).normalize('NFKC').replace(spaces, ' ').trim().replace(/^@+\s*/, '').trim();
  let current = stripped;
  while (current) {
    const match = /^(.*?)\s*[(\[]([^)\]]+)[)\]]$/.exec(current);
    if (!match) break;
    const decoration = displayNameSkeleton(match[2].trim());
    if (!decoration || !reservedLabels.has(decoration)) break;
    const core = match[1].trim();
    if (!core) return 'Member';
    current = core;
  }
  const base = current.trim();
  if (!base) return 'Member';
  return base.length > 70 ? base.slice(0, 70).trim() || 'Member' : base;
}

function suggestionFor(name, activeNames) {
  const base = visibleBase(name);
  const candidate = value => classifyMemberDisplayName(value, activeNames).available;
  if (candidate(base)) return base;
  for (let suffix = 2; suffix <= 20; suffix += 1) {
    const next = `${base} ${suffix}`;
    if (next.length <= 80 && candidate(next)) return next;
  }
  for (let suffix = 2; suffix <= 20; suffix += 1) {
    const next = `Member ${suffix}`;
    if (candidate(next)) return next;
  }
  return 'Member';
}

function unavailableMessage(reason, suggestion) {
  const lead = {
    reserved: 'That display name is reserved.',
    duplicate: 'That display name is already used in this room.',
    confusable: 'That display name is too easy to confuse with a member already in this room.',
    control_characters: 'That display name contains hidden or control characters.',
  }[reason];
  return `${lead} Suggested name: ${suggestion}.`;
}

// Admission check for a name about to be stored on a member. `activeNames`
// is the room's current members (or a list of display names). Inactive
// members do not block the name. `invalid` means the caller still owns the
// empty/length error; the four admission reasons throw from
// assertMemberDisplayNameAvailable.
export function assessMemberDisplayName(name, activeNames = []) {
  const verdict = classifyMemberDisplayName(name, activeNames);
  if (verdict.available || verdict.reason === 'invalid') return { ...verdict, suggestion: null, message: null };
  const suggestion = suggestionFor(name, activeNames);
  return { ...verdict, suggestion, message: unavailableMessage(verdict.reason, suggestion) };
}

export function assertMemberDisplayNameAvailable(name, activeNames = []) {
  const verdict = assessMemberDisplayName(name, activeNames);
  if (verdict.available || verdict.reason === 'invalid') return;
  const error = new Error(verdict.message);
  error.status = 422;
  error.code = 'display_name_unavailable';
  error.reason = verdict.reason;
  error.suggestion = verdict.suggestion;
  // http copies detail fields other than the agent-error envelope keys.
  error.detail = { displayNameReason: verdict.reason, suggestion: verdict.suggestion };
  throw error;
}
