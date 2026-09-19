// Outbound webhooks (B020). A pure webhook manager: register webhooks
// (URL + event filter), match room events against filters, build delivery
// payloads, and track delivery state (pending → delivered/failed). Actual
// HTTP delivery is a later slice. All state is caller-owned (a Map); the
// module is pure and dependency-free. Frozen outputs; malformed inputs
// throw WebhookError.
class WebhookError extends Error { constructor(code, message) { super(message); this.name = "WebhookError"; this.code = code; } }
const fail = (code, message) => { throw new WebhookError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_webhook", message); };
const URL_PATTERN = /^https:\/\/[^\s/$.?#].[^\s]*$/i;
// Validate a webhook URL (https only, no secrets in repo).
export function validateWebhookUrl(url) {
  check(typeof url === "string" && url.length > 0 && url.length <= 2000, "url must be 1-2000 chars");
  check(URL_PATTERN.test(url), "url must be a valid https URL");
  return url;
}
// The canonical wake-ping event name. An agent.wake delivery is journaled
// pending when an offline wakeable agent is @-mentioned or DM'd; the same
// payload shape is returned on the agent's next heartbeat and is the shape
// a future HTTP dispatch would POST to the host's registered wake URL.
export const WAKE_PING_EVENT = "agent.wake";
export function buildWakePing({ agentId, signal }) {
  check(typeof agentId === "string" && agentId.length > 0, "agentId must be a non-empty string");
  check(signal !== null && typeof signal === "object", "signal must be an object");
  check(typeof signal.signalId === "string" && signal.signalId.length > 0, "signal.signalId must be a non-empty string");
  return Object.freeze({ event: WAKE_PING_EVENT, agentId, signal: Object.freeze({ ...signal }) });
}
// Create a webhook manager. store is a caller-owned Map (webhookId -> webhook).
export function createWebhooks({ store } = {}) {
  check(store === undefined || store instanceof Map, "store must be a Map if given");
  const webhooks = store ?? new Map();
  let deliveryCounter = 0;
  // Register a webhook.
  const register = ({ webhookId, url, events, secret }) => {
    check(typeof webhookId === "string" && webhookId.length > 0, "webhookId must be a non-empty string");
    validateWebhookUrl(url);
    check(Array.isArray(events) && events.length > 0 &&
      events.every(e => typeof e === "string" && e.length > 0),
      "events must be a non-empty string array");
    check(secret === undefined || (typeof secret === "string" && secret.length >= 16),
      "secret must be ≥16 chars if given");
    check(!webhooks.has(webhookId), `webhook "${webhookId}" already exists`);
    const webhook = Object.freeze({ webhookId, url, secret: secret ?? null,
      events: Object.freeze([...new Set(events)]), enabled: true });
    webhooks.set(webhookId, webhook);
    return webhook;
  };
  // Match an event type against registered webhooks. Supports "*" wildcard.
  const match = eventType => {
    check(typeof eventType === "string" && eventType.length > 0, "eventType must be a non-empty string");
    return Object.freeze([...webhooks.values()]
      .filter(w => w.enabled && (w.events.includes(eventType) || w.events.includes("*")))
      .map(w => Object.freeze({ ...w })));
  };
  // Build a delivery payload for an event.
  const buildPayload = (webhookId, { eventType, data }) => {
    check(typeof webhookId === "string" && webhookId.length > 0, "webhookId must be a non-empty string");
    check(webhooks.has(webhookId), `unknown webhook "${webhookId}"`);
    check(typeof eventType === "string" && eventType.length > 0, "eventType must be a non-empty string");
    check(data !== null && typeof data === "object", "data must be an object");
    const deliveryId = `delivery-${++deliveryCounter}`;
    return Object.freeze({ deliveryId, webhookId, eventType,
      url: webhooks.get(webhookId).url, data: Object.freeze({ ...data }),
      state: "pending", attempts: 0, error: null });
  };
  const setEnabled = (webhookId, enabled) => {
    check(typeof webhookId === "string" && webhookId.length > 0, "webhookId must be a non-empty string");
    check(webhooks.has(webhookId), `unknown webhook "${webhookId}"`);
    check(typeof enabled === "boolean", "enabled must be a boolean");
    const updated = Object.freeze({ ...webhooks.get(webhookId), enabled });
    webhooks.set(webhookId, updated);
    return updated;
  };
  const unregister = webhookId => {
    check(typeof webhookId === "string" && webhookId.length > 0, "webhookId must be a non-empty string");
    check(webhooks.delete(webhookId), `unknown webhook "${webhookId}"`);
  };
  return Object.freeze({ register, match, buildPayload, setEnabled, unregister,
    size: () => webhooks.size });
}
export { WebhookError };
