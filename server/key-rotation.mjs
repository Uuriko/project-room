// Key rotation (H007). A pure rotation policy for named keys: each key has a
// version, a created-at timestamp, and a status. rotationPlan() decides per
// key whether to keep, rotate (age exceeds maxAgeDays), or revoke (age
// exceeds maxAgeDays + graceDays, or explicitly compromised). Rotated keys
// stay readable during the grace period so in-flight operations complete.
// This module never touches key material — it only tracks metadata the
// caller supplies. Pure, dependency-free, deterministic; frozen outputs.
// Scheduler/secret-store wiring is a later slice.
const DEFAULTS = Object.freeze({ maxAgeDays: 90, graceDays: 7 });
class KeyRotationError extends Error { constructor(code, message) { super(message); this.name = "KeyRotationError"; this.code = code; } }
const fail = (code, message) => { throw new KeyRotationError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_key_rotation", message); };

const keyOf = (value, index) => {
  check(value !== null && typeof value === "object", `key ${index} must be an object`);
  check(typeof value.name === "string" && value.name.length > 0, `key ${index} needs a name`);
  check(typeof value.version === "number" && Number.isInteger(value.version) && value.version >= 1,
    `key ${index} needs a positive integer version`);
  check(typeof value.createdAt === "string" && !Number.isNaN(new Date(value.createdAt).getTime()),
    `key ${index} needs a parseable createdAt`);
  const status = value.status ?? "active";
  check(["active", "rotating", "revoked"].includes(status), `key ${index} has unknown status "${status}"`);
  return { name: value.name, version: value.version, createdAt: value.createdAt,
    status, compromised: value.compromised === true };
};
// Decide rotation actions. now is injectable for tests.
export function rotationPlan(keys, { now, maxAgeDays, graceDays } = {}) {
  check(Array.isArray(keys) && keys.length <= 10000, "keys must be a list of at most 10000");
  const at = now === undefined || now === null ? Date.now() : new Date(now).getTime();
  check(!Number.isNaN(at), "now must be a parseable timestamp");
  const maxAge = maxAgeDays ?? DEFAULTS.maxAgeDays, grace = graceDays ?? DEFAULTS.graceDays;
  check(Number.isFinite(maxAge) && maxAge > 0, "maxAgeDays must be positive");
  check(Number.isFinite(grace) && grace >= 0, "graceDays must be non-negative");
  const maxAgeMs = maxAge * 86400000, graceMs = grace * 86400000;
  const plans = [], totals = { keep: 0, rotate: 0, revoke: 0 };
  for (let index = 0; index < keys.length; index++) {
    const { name, version, createdAt, status, compromised } = keyOf(keys[index], index);
    const ageMs = Math.max(0, at - new Date(createdAt).getTime());
    let action = "keep";
    if (status === "revoked") action = "revoke";
    else if (compromised || ageMs > maxAgeMs + graceMs) action = "revoke";
    else if (ageMs > maxAgeMs || status === "rotating") action = "rotate";
    totals[action] += 1;
    plans.push(Object.freeze({ name, version, status, ageDays: Math.round(ageMs / 8640000) / 10,
      action, nextVersion: action === "rotate" ? version + 1 : version }));
  }
  return Object.freeze({ totals: Object.freeze({ ...totals }), plans: Object.freeze(plans) });
}
export { KeyRotationError, DEFAULTS };
