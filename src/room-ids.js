export const ROOM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

// Prototype names are denied as ids even when they satisfy the charset, so
// a plain object keyed by id can never resolve (or be assigned) through
// Object.prototype. Callers that validate user-supplied ids check
// isReservedId first so the rejection can name the real cause instead of
// collapsing into a charset error (#3013).
export const RESERVED_IDS = Object.freeze(["constructor", "prototype", "__proto__"]);
export const isReservedId = value => typeof value === "string" && RESERVED_IDS.includes(value);

export function validId(value) {
  return typeof value === "string" && ROOM_ID_PATTERN.test(value) && !isReservedId(value);
}
