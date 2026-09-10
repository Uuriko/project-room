import { ADDITIVE_FIELDS, CAPABILITY_BITS, DEFAULT_GRANTS, GATED_BITS } from "./kinds.js";

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function isMemberRecord(member) {
  return member != null && typeof member === "object" && !Array.isArray(member);
}

/** Owner: explicit flag, role, or Room ownerId match. Labels are not this. */
export function isRoomOwner(member = {}, context = {}) {
  if (!isMemberRecord(member)) return false;
  if (member.role === "owner" || member.isOwner === true) return true;
  const ownerId = context.ownerId ?? member.ownerId ?? null;
  return Boolean(ownerId && member.id && member.id === ownerId);
}

function overlayLists(member, context) {
  return [
    ...asList(member.capabilities),
    ...asList(context.capabilities),
    ...asList(member.capabilityBits),
    ...asList(context.capabilityBits)
  ];
}

function additiveObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}

function grantedBit(member, context, bit) {
  if (member[bit] === true) return true;
  const nested = additiveObject(member.capabilityBits);
  if (nested && nested[bit] === true) return true;
  const contextBits = additiveObject(context.capabilityBits);
  if (contextBits && contextBits[bit] === true) return true;
  return overlayLists(member, context).includes(bit);
}

/**
 * Project Discord-style bits from a Member record.
 * Does not write Events, widen PERMISSIONS, or persist a capabilities array.
 */
export function memberCapabilities(member = {}, context = {}) {
  if (!isMemberRecord(member)) return { bits: [], owner: false };
  const owner = isRoomOwner(member, context);
  if (owner) return { bits: [...CAPABILITY_BITS], owner: true };

  const granted = new Set(DEFAULT_GRANTS);
  if (member.active !== false) {
    for (const bit of GATED_BITS) {
      if (grantedBit(member, context, bit) && ADDITIVE_FIELDS.includes(bit)) {
        granted.add(bit);
      }
    }
  }
  return { bits: CAPABILITY_BITS.filter((bit) => granted.has(bit)), owner: false };
}

export function hasCapability(member, bit, context = {}) {
  if (!CAPABILITY_BITS.includes(bit)) return false;
  return memberCapabilities(member, context).bits.includes(bit);
}

export function canAct(member, context = {}) {
  return hasCapability(member, "act", context);
}

export function canEmitReceipt(member, context = {}) {
  return hasCapability(member, "emit_receipt", context);
}

export function canInviteMember(member, context = {}) {
  return hasCapability(member, "invite_member", context);
}
