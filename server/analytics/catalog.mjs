// Growth event catalog. Names, versions, props and actor kinds are closed.
// Billing names stay reserved until a billing batch emits them. AN-2 reads
// this list; it does not add names here.
import { createHash } from "node:crypto";

const string = "string";
const number = "number";
const boolean = "boolean";

const prop = (type, values) => Object.freeze({ type, values: values ? Object.freeze([...values]) : null });

const ACTORS = Object.freeze({
  human: "human",
  agent: "agent",
  system: "system",
  anonymous: "anonymous"
});

function defineEvent(v, actorKinds, props, extra = {}) {
  return Object.freeze({
    v,
    actorKinds: Object.freeze([...actorKinds]),
    props: Object.freeze(props),
    reserved: extra.reserved === true
  });
}

// `excluded` is a reader flag the tail sets. It is not an event-specific prop.
export const ENVELOPE_PROP_KEYS = Object.freeze(["excluded"]);

export const ACTOR_KINDS = Object.freeze([ACTORS.human, ACTORS.agent, ACTORS.system, ACTORS.anonymous]);
export const SOURCES = Object.freeze(["ui", "rest", "mcp", "webhook", "cron", "unknown"]);
export const LOOPS = Object.freeze([
  "invite", "agent_invite", "receipt", "template", "public_room", "agent_card",
  "directory", "referral", "docs", "organic", "unknown"
]);
export const SOURCE_DETAILS = Object.freeze(["web", "api", "agent-inbox", "telegram", "email-inbound", "system"]);

const INVITE_KINDS = Object.freeze(["share_link", "guest", "agent_code", "referral", "guest_agent", "membership", "access_request"]);
const INVITEE_KINDS = Object.freeze(["human", "agent", "either"]);
const CONNECT_PATHS = Object.freeze(["mcp", "rest", "invite_code", "share_link", "referral", "guest"]);
const CREATED_VIA = Object.freeze(["account", "agent", "template"]);
const ROOM_KINDS = Object.freeze(["personal", "organization"]);
const CLAIM_KINDS = Object.freeze(["board", "work_item"]);
const RECEIPT_KINDS = Object.freeze(["wcr", "wir", "pwr"]);
const REFERRAL_CHANNELS = Object.freeze(["agent_referral", "link", "receipt_footer"]);
const REFERRAL_VIA = Object.freeze(["invite", "request"]);

export const GROWTH_CATALOG = Object.freeze({
  signup: defineEvent(1, [ACTORS.human], {
    origin: prop(string)
  }),
  room_created: defineEvent(1, [ACTORS.human, ACTORS.agent], {
    kind: prop(string, ROOM_KINDS),
    template_id: prop(string),
    created_via: prop(string, CREATED_VIA)
  }),
  template_forked: defineEvent(1, [ACTORS.human, ACTORS.agent], {
    template_id: prop(string)
  }),
  member_invited: defineEvent(1, [ACTORS.human, ACTORS.agent], {
    invite_kind: prop(string, INVITE_KINDS),
    invitee_kind: prop(string, INVITEE_KINDS)
  }),
  invite_accepted: defineEvent(1, [ACTORS.human, ACTORS.agent], {
    invite_kind: prop(string, INVITE_KINDS),
    invitee_kind: prop(string, INVITEE_KINDS),
    minutes_since_invite: prop(number)
  }),
  agent_connected: defineEvent(1, [ACTORS.agent], {
    agent_client: prop(string),
    agentType: prop(string),
    connect_path: prop(string, CONNECT_PATHS)
  }),
  agent_first_post: defineEvent(1, [ACTORS.agent], {
    minutes_since_connected: prop(number)
  }),
  agent_woken: defineEvent(1, [ACTORS.system], {
    wake_kind: prop(string),
    delivered: prop(boolean),
    ack_ms: prop(number)
  }),
  claim_created: defineEvent(1, [ACTORS.human, ACTORS.agent], {
    claim_kind: prop(string, CLAIM_KINDS),
    has_files: prop(boolean),
    has_pr: prop(boolean)
  }),
  claim_claimed: defineEvent(1, [ACTORS.human, ACTORS.agent], {
    claimer_kind: prop(string, [ACTORS.human, ACTORS.agent])
  }),
  pr_linked: defineEvent(1, [ACTORS.human, ACTORS.agent, ACTORS.system], {
    repo: prop(string),
    pr_number: prop(number)
  }),
  pr_merged: defineEvent(1, [ACTORS.human, ACTORS.agent, ACTORS.system], {
    minutes_claim_to_merge: prop(number)
  }),
  claim_completed: defineEvent(1, [ACTORS.human, ACTORS.agent, ACTORS.system], {
    minutes_created_to_done: prop(number),
    closer_kind: prop(string, [ACTORS.human, ACTORS.agent, ACTORS.system]),
    merged: prop(boolean)
  }),
  receipt_issued: defineEvent(1, [ACTORS.human, ACTORS.agent, ACTORS.system], {
    receipt_kind: prop(string, RECEIPT_KINDS),
    public: prop(boolean)
  }),
  public_artifact_viewed: defineEvent(1, [ACTORS.anonymous, ACTORS.human, ACTORS.agent], {
    artifact_kind: prop(string),
    is_bot: prop(boolean)
  }),
  public_artifact_cta_clicked: defineEvent(1, [ACTORS.anonymous, ACTORS.human], {
    cta: prop(string),
    to: prop(string)
  }),
  referral_sent: defineEvent(1, [ACTORS.human, ACTORS.agent], {
    channel: prop(string, REFERRAL_CHANNELS)
  }),
  referral_converted: defineEvent(1, [ACTORS.human, ACTORS.agent], {
    via: prop(string, REFERRAL_VIA),
    depth: prop(number)
  }),
  referral_activated: defineEvent(1, [ACTORS.human, ACTORS.agent], {
    via: prop(string, REFERRAL_VIA)
  }),
  // No billing exists. These cannot be emitted.
  upgrade_viewed: defineEvent(1, [ACTORS.human], {}, { reserved: true }),
  checkout_started: defineEvent(1, [ACTORS.human], {}, { reserved: true }),
  subscription_started: defineEvent(1, [ACTORS.human], {}, { reserved: true }),
  trial_started: defineEvent(1, [ACTORS.human], {}, { reserved: true }),
  // AN-2 computes churn from analytics_events. It is not an emitted row.
  churned: defineEvent(1, [ACTORS.human, ACTORS.agent, ACTORS.system], {
    churn_kind: prop(string, ["room_churned", "agent_churned", "human_churned"])
  }, { reserved: true })
});

export const GROWTH_EVENT_NAMES = Object.freeze(Object.keys(GROWTH_CATALOG));

export const PROPS_MAX_BYTES = 2048;

// Keys that would carry a message, a name, an address, or a credential.
const FORBIDDEN_PROP_KEY = /email|body|text|title|display.?name|(^|_)ip($|_)|token/i;

export function growthEventId(sourceId, name, n) {
  const hex = createHash("sha256").update(`${sourceId}|${name}|${n}`).digest("hex").slice(0, 20);
  return `aev_${hex}`;
}

export function sourceDetailFor(source) {
  if (source === "ui") return "web";
  if (source === "rest") return "api";
  if (source === "mcp") return "agent-inbox";
  if (source === "webhook") return "system";
  if (source === "cron") return "system";
  return "system";
}

function forbiddenKey(key) {
  return typeof key === "string" && FORBIDDEN_PROP_KEY.test(key);
}

function checkValue(spec, value, path, errors) {
  if (value === null) return;
  if (spec.type === "string") {
    if (typeof value !== "string" || !value) errors.push(`${path} must be a string`);
    else if (spec.values && !spec.values.includes(value)) errors.push(`${path} is not an allowed value`);
    return;
  }
  if (spec.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) errors.push(`${path} must be a finite number`);
    return;
  }
  if (spec.type === "boolean") {
    if (typeof value !== "boolean") errors.push(`${path} must be true or false`);
  }
}

export function validateGrowthEvent(row) {
  const errors = [];
  if (!row || typeof row !== "object" || Array.isArray(row)) return { ok: false, errors: ["event must be an object"] };
  const entry = typeof row.name === "string" ? GROWTH_CATALOG[row.name] : null;
  if (!entry) return { ok: false, errors: ["unknown event name"] };
  if (entry.reserved) return { ok: false, errors: ["reserved event name"] };
  if (row.v !== entry.v) errors.push("wrong props version");
  if (!entry.actorKinds.includes(row.actor_kind)) errors.push("actor_kind is not allowed for this event");
  if (!SOURCES.includes(row.source)) errors.push("unknown source");
  if (!LOOPS.includes(row.loop)) errors.push("unknown loop");
  const props = row.props;
  if (!props || typeof props !== "object" || Array.isArray(props)) {
    errors.push("props must be an object");
  } else {
    for (const [key, value] of Object.entries(props)) {
      if (forbiddenKey(key)) {
        errors.push(`forbidden prop ${key}`);
        continue;
      }
      if (ENVELOPE_PROP_KEYS.includes(key)) {
        if (key === "excluded" && typeof value !== "boolean") errors.push("excluded must be true or false");
        continue;
      }
      const spec = entry.props[key];
      if (!spec) {
        errors.push(`unknown prop ${key}`);
        continue;
      }
      checkValue(spec, value, key, errors);
    }
    const encoded = JSON.stringify(props);
    if (Buffer.byteLength(encoded) > PROPS_MAX_BYTES) errors.push("props exceed 2 KB");
  }
  return errors.length ? { ok: false, errors } : { ok: true, errors: [] };
}
