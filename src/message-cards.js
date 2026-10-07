// Rich message cards (missing-features #7): a Discord-embed-style card that
// can ride on a message.posted event next to (or instead of) the text body,
// for dashboards, alerts, and game UIs. Plain-text messages are untouched:
// a card is purely additive — messages without one render exactly as before.
//
// SSRF posture: card image/thumbnail/url fields are validated as https URLs
// here, but the server NEVER fetches them. They render client-side as
// ordinary links/images, so there is no server-side fetch for an attacker
// to aim at internal infrastructure. Private/reserved IP literals are
// refused outright so a card cannot smuggle an internal target into a
// client either.

export class InboundWebhookError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "InboundWebhookError";
    this.code = code;
  }
}
const fail = (code, message) => { throw new InboundWebhookError(code, message); };

export const MESSAGE_CARD_LIMITS = Object.freeze({
  title: 256,
  description: 4096,
  url: 2000,
  fields: 25,
  fieldName: 256,
  fieldValue: 1024,
  footer: 2048,
});

const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

// Hosts that are internal by construction. Card URLs are render-only (never
// fetched server-side), but refusing them keeps a card from laundering an
// internal target into a client's browser.
function isPrivateHost(hostname) {
  const name = String(hostname ?? "").toLowerCase().replace(/\.$/, "");
  if (!name) return true;
  if (name === "localhost" || name.endsWith(".localhost")) return true;
  // IPv4 literals in private/reserved ranges.
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name);
  if (v4) {
    const [, a, b] = v4.map(Number);
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 0 || a >= 224) return true;
  }
  if (name === "::1" || name === "[::1]") return true;
  return false;
}

function checkCardUrl(value, field) {
  if (typeof value !== "string" || value.length === 0 || value.length > MESSAGE_CARD_LIMITS.url) {
    throw new InboundWebhookError("invalid_card", `${field} must be an https URL`);
  }
  let parsed;
  try { parsed = new URL(value); } catch {
    throw new InboundWebhookError("invalid_card", `${field} must be an https URL`);
  }
  if (parsed.protocol !== "https:") {
    throw new InboundWebhookError("invalid_card", `${field} must be an https URL`);
  }
  if (isPrivateHost(parsed.hostname)) {
    throw new InboundWebhookError("invalid_card", `${field} must not target a private or reserved host`);
  }
  return value;
}

const checkText = (value, field, max, { required = false } = {}) => {
  if (value === undefined || value === null) {
    if (required) throw new InboundWebhookError("invalid_card", `${field} is required`);
    return undefined;
  }
  if (typeof value !== "string") throw new InboundWebhookError("invalid_card", `${field} must be text`);
  const text = value;
  if (required && text.length === 0) throw new InboundWebhookError("invalid_card", `${field} is required`);
  if (text.length > max) throw new InboundWebhookError("invalid_card", `${field} must be at most ${max} characters`);
  return text;
};

// Validate a card object. Returns a frozen copy. Throws InboundWebhookError
// (code invalid_card) on any violation — unknown fields included, so a
// sender cannot smuggle unvalidated content past the gate.
export function validateMessageCard(card) {
  if (!card || typeof card !== "object" || Array.isArray(card)) {
    throw new InboundWebhookError("invalid_card", "card must be an object");
  }
  const allowed = new Set(["title", "description", "url", "color", "image", "thumbnail", "fields", "footer", "timestamp"]);
  for (const key of Object.keys(card)) {
    if (!allowed.has(key)) throw new InboundWebhookError("invalid_card", `unexpected field: ${key}`);
  }
  const title = checkText(card.title, "title", MESSAGE_CARD_LIMITS.title, { required: true });
  const out = { title };
  const description = checkText(card.description, "description", MESSAGE_CARD_LIMITS.description);
  if (description !== undefined) out.description = description;
  if (card.url !== undefined) out.url = checkCardUrl(card.url, "url");
  if (card.color !== undefined) {
    if (typeof card.color !== "string" || !COLOR_PATTERN.test(card.color)) {
      throw new InboundWebhookError("invalid_card", "color must be a #rrggbb hex string");
    }
    out.color = card.color.toLowerCase();
  }
  if (card.image !== undefined) out.image = checkCardUrl(card.image, "image");
  if (card.thumbnail !== undefined) out.thumbnail = checkCardUrl(card.thumbnail, "thumbnail");
  if (card.fields !== undefined) {
    if (!Array.isArray(card.fields)) throw new InboundWebhookError("invalid_card", "fields must be an array");
    if (card.fields.length > MESSAGE_CARD_LIMITS.fields) {
      throw new InboundWebhookError("invalid_card", `fields must have at most ${MESSAGE_CARD_LIMITS.fields} entries`);
    }
    out.fields = Object.freeze(card.fields.map((field, i) => {
      if (!field || typeof field !== "object" || Array.isArray(field)) {
        throw new InboundWebhookError("invalid_card", `fields[${i}] must be an object`);
      }
      for (const key of Object.keys(field)) {
        if (!["name", "value", "inline"].includes(key)) {
          throw new InboundWebhookError("invalid_card", `unexpected field: fields[${i}].${key}`);
        }
      }
      const name = checkText(field.name, `fields[${i}].name`, MESSAGE_CARD_LIMITS.fieldName, { required: true });
      const value = checkText(field.value, `fields[${i}].value`, MESSAGE_CARD_LIMITS.fieldValue, { required: true });
      const entry = { name, value };
      if (field.inline !== undefined) {
        if (typeof field.inline !== "boolean") throw new InboundWebhookError("invalid_card", `fields[${i}].inline must be a boolean`);
        entry.inline = field.inline;
      }
      return Object.freeze(entry);
    }));
  }
  const footer = checkText(card.footer, "footer", MESSAGE_CARD_LIMITS.footer);
  if (footer !== undefined) out.footer = footer;
  if (card.timestamp !== undefined) {
    if (typeof card.timestamp !== "string" || Number.isNaN(Date.parse(card.timestamp))) {
      throw new InboundWebhookError("invalid_card", "timestamp must be an ISO 8601 date string");
    }
    out.timestamp = card.timestamp;
  }
  return Object.freeze(out);
}
