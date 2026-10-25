// Agent join profile: declared wake, attention, claim cap, roles, and tags.
// Pure. No store, no network. Coordinator auto-pick reads roles and
// capabilities through readDeclaredAgentProfile.

export const JOIN_PROFILE_WAKES = Object.freeze(["push", "webhook", "pull"]);
export const JOIN_PROFILE_EVENTS = Object.freeze(["mentions-and-own-claims", "all"]);
export const JOIN_PROFILE_ROLES = Object.freeze(["coordinator", "reviewer", "builder"]);
export const JOIN_PROFILE_DETAILS = Object.freeze(["brief", "full"]);
export const JOIN_PROFILE_FIELDS = Object.freeze(["wake", "events", "maxClaims", "roles", "detail", "capabilities"]);
export const JOIN_PROFILE_MAX_CLAIMS = Object.freeze({ min: 1, max: 10 });
export const JOIN_PROFILE_CAPABILITY_LIMITS = Object.freeze({ count: 20, length: 40 });

export const DEFAULT_JOIN_PROFILE = Object.freeze({
  wake: "pull",
  events: "mentions-and-own-claims",
  maxClaims: 2,
  roles: Object.freeze([]),
  detail: "brief",
  capabilities: Object.freeze([]),
});

const ROLE_LABELS = Object.freeze({ coordinator: "Coordinator", reviewer: "Reviewer", builder: "Builder" });
const WAKE_LABELS = Object.freeze({ push: "Push", webhook: "Webhook", pull: "Pull" });
const CONTROL = /[\u0000-\u001F\u007F]/;

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function failure(code, extra = {}) {
  return { ok: false, code, ...extra };
}

function copyProfile(profile) {
  return {
    wake: profile.wake,
    events: profile.events,
    maxClaims: profile.maxClaims,
    roles: [...profile.roles],
    detail: profile.detail,
    capabilities: [...profile.capabilities],
  };
}

export function defaultJoinProfile() {
  return copyProfile(DEFAULT_JOIN_PROFILE);
}

function validateWake(value) {
  if (typeof value !== "string" || !JOIN_PROFILE_WAKES.includes(value)) return failure("join_profile_wake");
  return { ok: true, value };
}

function validateEvents(value) {
  if (typeof value !== "string" || !JOIN_PROFILE_EVENTS.includes(value)) return failure("join_profile_events");
  return { ok: true, value };
}

function validateMaxClaims(value) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < JOIN_PROFILE_MAX_CLAIMS.min || value > JOIN_PROFILE_MAX_CLAIMS.max) {
    return failure("join_profile_max_claims");
  }
  return { ok: true, value };
}

function validateRoles(value) {
  if (!Array.isArray(value)) return failure("join_profile_roles");
  const seen = new Set();
  for (const role of value) {
    if (typeof role !== "string" || !JOIN_PROFILE_ROLES.includes(role) || seen.has(role)) return failure("join_profile_roles");
    seen.add(role);
  }
  return { ok: true, value: JOIN_PROFILE_ROLES.filter(role => seen.has(role)) };
}

function validateDetail(value) {
  if (typeof value !== "string" || !JOIN_PROFILE_DETAILS.includes(value)) return failure("join_profile_detail");
  return { ok: true, value };
}

function validateCapabilities(value) {
  const limit = JOIN_PROFILE_CAPABILITY_LIMITS;
  if (!Array.isArray(value) || value.length > limit.count) return failure("join_profile_capabilities");
  const clean = [];
  for (const tag of value) {
    if (typeof tag !== "string" || CONTROL.test(tag)) return failure("join_profile_capabilities");
    const trimmed = tag.trim();
    if (trimmed.length < 1 || trimmed.length > limit.length || clean.includes(trimmed)) return failure("join_profile_capabilities");
    clean.push(trimmed);
  }
  return { ok: true, value: clean };
}

const FIELD_VALIDATORS = Object.freeze({
  wake: validateWake,
  events: validateEvents,
  maxClaims: validateMaxClaims,
  roles: validateRoles,
  detail: validateDetail,
  capabilities: validateCapabilities,
});

// partial: only the fields present are checked and returned.
// complete: every field is required (the stored event shape).
export function validateJoinProfile(value, options = {}) {
  const complete = options.complete === true;
  if (!plainObject(value)) return failure("join_profile_invalid", { reason: "type" });
  const keys = Object.keys(value);
  const unknown = keys.find(key => !JOIN_PROFILE_FIELDS.includes(key));
  if (unknown) return failure("join_profile_invalid", { reason: "unknown", field: unknown });
  if (keys.length === 0) return failure("join_profile_invalid", { reason: "empty" });
  if (complete) {
    const missing = JOIN_PROFILE_FIELDS.find(field => !Object.hasOwn(value, field));
    if (missing) return failure("join_profile_invalid", { reason: "missing", field: missing });
  }
  const profile = {};
  for (const field of JOIN_PROFILE_FIELDS) {
    if (!Object.hasOwn(value, field)) continue;
    const checked = FIELD_VALIDATORS[field](value[field]);
    if (!checked.ok) return checked;
    profile[field] = checked.value;
  }
  return { ok: true, profile };
}

export function assertStoredJoinProfile(value) {
  const checked = validateJoinProfile(value, { complete: true });
  if (!checked.ok) throw new Error("join_profile_invalid");
  return checked.profile;
}

export function resolveJoinProfile(current, partial) {
  const base = current && typeof current === "object" ? current : defaultJoinProfile();
  return {
    wake: Object.hasOwn(partial, "wake") ? partial.wake : base.wake,
    events: Object.hasOwn(partial, "events") ? partial.events : base.events,
    maxClaims: Object.hasOwn(partial, "maxClaims") ? partial.maxClaims : base.maxClaims,
    roles: Object.hasOwn(partial, "roles") ? [...partial.roles] : [...(base.roles ?? [])],
    detail: Object.hasOwn(partial, "detail") ? partial.detail : base.detail,
    capabilities: Object.hasOwn(partial, "capabilities") ? [...partial.capabilities] : [...(base.capabilities ?? [])],
  };
}

export function joinProfilesEqual(left, right) {
  if (!left || !right) return false;
  return left.wake === right.wake
    && left.events === right.events
    && left.maxClaims === right.maxClaims
    && left.detail === right.detail
    && JSON.stringify(left.roles) === JSON.stringify(right.roles)
    && JSON.stringify(left.capabilities) === JSON.stringify(right.capabilities);
}

// Declared roles and capabilities for coordinator auto-pick. A member with
// no stored join profile reads as the defaults and declared:false.
export function readDeclaredAgentProfile(member) {
  const stored = member?.joinProfile;
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    return { ...defaultJoinProfile(), declared: false };
  }
  const checked = validateJoinProfile(stored, { complete: true });
  if (!checked.ok) return { ...defaultJoinProfile(), declared: false };
  return { ...checked.profile, declared: true };
}

export function joinProfileLine(member) {
  if (!member || member.kind !== "agent") return "";
  const profile = readDeclaredAgentProfile(member);
  const labels = profile.roles.map(role => ROLE_LABELS[role]).filter(Boolean);
  const roles = labels.map((label, index) => index === 0 ? label : label.toLowerCase()).join(", ");
  const wake = WAKE_LABELS[profile.wake] || "Pull";
  return roles.length ? [roles, wake].join(" · ") : wake;
}

// Open-claim cap. Not wired into claim, wake, or needs-me while those
// files sit in open pull requests. openCount is the member's current
// open claims; a new claim is allowed while openCount is below maxClaims.
export function claimAllowedByProfile(profile, openCount) {
  const maxClaims = Number.isInteger(profile?.maxClaims) ? profile.maxClaims : DEFAULT_JOIN_PROFILE.maxClaims;
  return Number.isInteger(openCount) && openCount >= 0 && openCount < maxClaims;
}

// Attention filter. kind is "mention", "own-claim", or "other".
// mentions-and-own-claims admits the first two. all admits every kind.
export function profileWantsEvent(profile, kind) {
  if (profile?.events === "all") return true;
  return kind === "mention" || kind === "own-claim";
}
