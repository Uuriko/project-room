// #938: bounded visual-confusable guard for newly minted and linked agent names.
// This is a pure check. Callers must supply the active names visible at their
// scope and reject an unsafe result before writing an identity/member record.
// The table handles common Greek/Cyrillic lookalikes, not all UTS #39 data.
// Never treat a successful check as proof of the named agent's identity.

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
