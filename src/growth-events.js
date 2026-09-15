// Track C slice C1 — Analytics event contract (growth events).
//
// Pure validation/registry module for room analytics. Contract-first: the
// vocabulary, actor classification, sources, timestamps, privacy classes and
// schema versions are defined here in code, mirroring docs/GROWTH-EVENT-CONTRACT.md.
// No network, no storage, no imports. Outputs are frozen.

// Current schema version stamped on every event envelope produced by defineEvent.
export const GROWTH_SCHEMA_VERSION = "1.0";

export const ACTOR_KINDS = Object.freeze(["human", "agent", "system"]);
export const EVENT_SOURCES = Object.freeze(["web", "api", "agent-inbox", "telegram", "email-inbound", "system"]);
export const PRIVACY_CLASSES = Object.freeze(["public-in-room", "account-private", "never-collect"]);

// Default-deny layer 1: secret-bearing field names are never collected.
const SECRET_NAME_PATTERN = /password|passwd|secret|token|credential|apikey|api[_-]?key|private[_-]?key|auth|session|cookie/i;
// Default-deny layer 2: content-body field names are never collected.
// Note: identifier-style names (messageId, threadId) are allowed; bare
// content names (body, text, content, message, email) are not.
const BODY_NAME_PATTERN = /^(body|text|content|message|email|html|payload|file|attachment|data)$/i;

const isSensitiveFieldName = name => SECRET_NAME_PATTERN.test(name) || BODY_NAME_PATTERN.test(name);

const scalar = value => value === null || ["string", "number", "boolean"].includes(typeof value);

const nonEmptyString = (value, label) => {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  return value.trim();
};

const checkTimestamp = (value, label) => {
  const raw = nonEmptyString(value, label);
  if (Number.isNaN(Date.parse(raw))) throw new TypeError(`${label} must be an ISO-8601 timestamp`);
  return new Date(raw).toISOString();
};

// Registry entry shape:
// { version, roomEvents, privacyClass, description, required: [...], optional: [...], enums: { field: [...] } }
const defineRegistry = entries => {
  const frozen = {};
  for (const [type, entry] of Object.entries(entries)) {
    nonEmptyString(type, "Event type");
    if (entry.privacyClass === "never-collect") {
      throw new TypeError(`Event ${type} is registered as never-collect and must not exist in the growth vocabulary`);
    }
    if (!PRIVACY_CLASSES.includes(entry.privacyClass)) throw new TypeError(`Event ${type} has an unknown privacy class`);
    for (const field of [...entry.required, ...entry.optional]) {
      if (isSensitiveFieldName(field)) throw new TypeError(`Event ${type} registers sensitive field "${field}"`);
    }
    frozen[type] = Object.freeze({
      version: nonEmptyString(entry.version, `Version for ${type}`),
      roomEvents: Object.freeze([...entry.roomEvents]),
      privacyClass: entry.privacyClass,
      description: nonEmptyString(entry.description, `Description for ${type}`),
      required: Object.freeze([...entry.required]),
      optional: Object.freeze([...entry.optional]),
      enums: Object.freeze(Object.fromEntries(Object.entries(entry.enums ?? {}).map(([k, v]) => [k, Object.freeze([...v])])))
    });
  }
  return Object.freeze(frozen);
};

// C1 growth vocabulary. Every event is derived from room activity the room
// actually has (roomEvents lists the originating room event names); only
// named, aggregate or identifier fields are collected — never content bodies.
export const GROWTH_EVENTS = defineRegistry({
  "room.created": {
    version: "1.0",
    roomEvents: ["room.created"],
    privacyClass: "public-in-room",
    description: "A room was created.",
    required: ["roomId", "roomKind"],
    optional: [],
    enums: { roomKind: ["personal", "organization"] }
  },
  "member.joined": {
    version: "1.0",
    roomEvents: ["member.added", "member.joined_via_invitation"],
    privacyClass: "public-in-room",
    description: "A human or agent became a room member.",
    required: ["roomId", "memberId", "memberKind"],
    optional: ["via"],
    enums: { memberKind: ["human", "agent"], via: ["invitation", "direct"] }
  },
  "invite.accepted": {
    version: "1.0",
    roomEvents: ["member.joined_via_invitation"],
    privacyClass: "public-in-room",
    description: "An invitation was accepted and the invitee joined the room.",
    required: ["roomId", "invitationId"],
    optional: ["via"],
    enums: { via: ["email", "link", "agent"] }
  },
  "message.sent": {
    version: "1.0",
    roomEvents: ["message.posted"],
    privacyClass: "public-in-room",
    description: "A message was posted. Only identifiers and aggregates — never the body.",
    required: ["roomId", "messageId"],
    optional: ["threadId", "replyToMessageId", "hasAttachment", "lengthBucket"],
    enums: { lengthBucket: ["short", "medium", "long"] }
  },
  "agent.mentioned": {
    version: "1.0",
    roomEvents: ["message.posted"],
    privacyClass: "public-in-room",
    description: "A posted message @-mentioned an agent member.",
    required: ["roomId", "messageId", "mentionedAgentId"],
    optional: ["mentionCount"]
  },
  "reaction.added": {
    version: "1.0",
    roomEvents: ["message.reaction_set"],
    privacyClass: "public-in-room",
    description: "A reaction was set on a message.",
    required: ["roomId", "messageId", "reaction"],
    optional: []
  },
  "message.pinned": {
    version: "1.0",
    roomEvents: ["message.pinned"],
    privacyClass: "public-in-room",
    description: "A message was pinned.",
    required: ["roomId", "messageId"],
    optional: []
  },
  "work.proposed": {
    version: "1.0",
    roomEvents: ["work.proposed"],
    privacyClass: "public-in-room",
    description: "A work item was proposed.",
    required: ["roomId", "workItemId"],
    optional: []
  },
  "work.completed": {
    version: "1.0",
    roomEvents: ["work.completed"],
    privacyClass: "public-in-room",
    description: "A work item was completed.",
    required: ["roomId", "workItemId"],
    optional: ["verificationKind"],
    enums: { verificationKind: ["independent_review", "owner_decision", "none"] }
  },
  "help.offer_opened": {
    version: "1.0",
    roomEvents: ["help.offer_opened"],
    privacyClass: "public-in-room",
    description: "A help offer was opened.",
    required: ["roomId", "offerId"],
    optional: []
  },
  "notification.preference_set": {
    version: "1.0",
    roomEvents: ["notifications.preferences_set"],
    privacyClass: "account-private",
    description: "A member changed notification preferences. Per-account data.",
    required: ["roomId"],
    optional: ["channel", "level"],
    enums: { channel: ["mentions", "replies", "work_updates", "announcements"], level: ["all", "mentions_only", "none"] }
  },
  "inbound.received": {
    version: "1.0",
    roomEvents: ["email.inbound_received", "telegram.inbound_received"],
    privacyClass: "account-private",
    description: "An inbound email or Telegram message arrived for a room. Arrival fact only.",
    required: ["channel"],
    optional: ["roomId", "hasAttachment"],
    enums: { channel: ["email", "telegram"] }
  }
});

export const GROWTH_EVENT_TYPES = Object.freeze(Object.keys(GROWTH_EVENTS));

export const isKnownEvent = type => typeof type === "string" && Object.hasOwn(GROWTH_EVENTS, type);

export const eventVersion = type => {
  if (!isKnownEvent(type)) throw new TypeError(`Unknown growth event type "${type}"`);
  return GROWTH_EVENTS[type].version;
};

const checkActor = actor => {
  if (!actor || typeof actor !== "object") throw new TypeError("Event actor must be an object");
  const id = nonEmptyString(actor.id, "Actor id");
  if (!ACTOR_KINDS.includes(actor.kind)) throw new TypeError("Actor kind must be human, agent or system");
  return Object.freeze({ id, kind: actor.kind });
};

const checkSource = source => {
  const value = nonEmptyString(source, "Event source");
  if (!EVENT_SOURCES.includes(value)) throw new TypeError(`Unknown event source "${value}"`);
  return value;
};

const checkFields = (type, fields) => {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new TypeError("Event fields must be an object");
  const entry = GROWTH_EVENTS[type];
  const allowed = new Set([...entry.required, ...entry.optional]);
  for (const key of Object.keys(fields)) {
    if (!allowed.has(key)) throw new TypeError(`Event ${type} does not collect field "${key}"`);
    if (isSensitiveFieldName(key)) throw new TypeError(`Event ${type} must not collect sensitive field "${key}"`);
    if (!scalar(fields[key])) throw new TypeError(`Event ${type} field "${key}" must be a scalar (string, number, boolean or null)`);
    const values = entry.enums[key];
    if (values && !values.includes(fields[key])) throw new TypeError(`Event ${type} field "${key}" must be one of ${values.join(", ")}`);
  }
  for (const key of entry.required) {
    if (!Object.hasOwn(fields, key)) throw new TypeError(`Event ${type} is missing required field "${key}"`);
  }
  return Object.freeze({ ...fields });
};

// Build a validated growth-event envelope. Stamps the registry's current
// schema version and privacy class; callers cannot override either.
export function defineEvent(type, { actor, source, fields = {}, occurredAt = new Date().toISOString() } = {}) {
  if (!isKnownEvent(type)) throw new TypeError(`Unknown growth event type "${type}"`);
  const entry = GROWTH_EVENTS[type];
  return Object.freeze({
    type,
    schemaVersion: entry.version,
    occurredAt: checkTimestamp(occurredAt, "Event timestamp"),
    actor: checkActor(actor),
    source: checkSource(source),
    privacyClass: entry.privacyClass,
    fields: checkFields(type, fields)
  });
}

// Validate an externally supplied envelope (e.g. read back from a sink).
// Fails closed on unknown types, version drift, privacy-class mismatch,
// unknown or sensitive fields, missing required fields, and bad envelope shape.
export function validateEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) throw new TypeError("Event must be an object");
  const { type, schemaVersion, occurredAt, actor, source, privacyClass, fields } = event;
  if (!isKnownEvent(type)) throw new TypeError(`Unknown growth event type "${type}"`);
  const entry = GROWTH_EVENTS[type];
  if (schemaVersion !== entry.version) {
    throw new TypeError(`Event ${type} schema version "${schemaVersion}" does not match registered version "${entry.version}"`);
  }
  if (privacyClass !== entry.privacyClass) {
    throw new TypeError(`Event ${type} privacy class "${privacyClass}" does not match registered class "${entry.privacyClass}"`);
  }
  for (const key of Object.keys(event)) {
    if (!["type", "schemaVersion", "occurredAt", "actor", "source", "privacyClass", "fields"].includes(key)) {
      throw new TypeError(`Event ${type} has unknown envelope field "${key}"`);
    }
  }
  return Object.freeze({
    type,
    schemaVersion,
    occurredAt: checkTimestamp(occurredAt, "Event timestamp"),
    actor: checkActor(actor),
    source: checkSource(source),
    privacyClass,
    fields: checkFields(type, fields)
  });
}
