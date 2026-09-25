// Outbound webhooks (B020). A webhook manager: register webhooks
// (URL + event filter), match room events against filters, build delivery
// payloads, and track delivery state (pending → delivered/failed). Actual
// HTTP delivery is a later slice. All state is caller-owned (a Map); the
// module is pure except for node:dns, which only the opt-in async DNS
// check (assertWebhookHostDnsPublic) touches. Malformed inputs throw
// WebhookError.
import { promises as dns } from "node:dns";
import { parseIpv4, parseIpv6, isBlockedIp, isBlockedIpv6Value } from "./ip-blocklist.mjs";

class WebhookError extends Error { constructor(code, message) { super(message); this.name = "WebhookError"; this.code = code; } }
const fail = (code, message) => { throw new WebhookError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_webhook", message); };
const URL_PATTERN = /^https:\/\/[^\s/$.?#].[^\s]*$/i;

// --- SSRF guard (RC-2026-09-19-087; H-1 fix RC-2026-09-25) -------------------
// Webhook deliveries are server-side fetches, so a hostile subscriber can
// aim them at internal infrastructure: the cloud metadata endpoint
// (169.254.169.254), loopback, RFC1918/ULA space, link-local addresses.
// Subscribe-time checks reject anything that can only be internal, before
// the URL is stored. Host parsing runs on the WHATWG-normalized hostname,
// so decimal/octal/hex IPv4 disguises (2130706433, 0x7f.0.0.1, 0177.0.0.1)
// and userinfo tricks (example.com@127.0.0.1) collapse to the real address
// before the range checks. DNS rebinding (a name that resolves internal at
// fetch time) is covered by resolveWebhookTarget below, which also returns
// the checked addresses so the dispatch path can pin the connection to
// exactly those (M-1 fix) instead of re-resolving.
//
// The range verdicts themselves live in ./ip-blocklist.mjs, shared with the
// web-fetch path — including IPv4 embedded in IPv6 (mapped, NAT64, 6to4,
// v4-compatible) and Teredo, which the old local isPrivateIpv6 missed.

const stripBrackets = host => (host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host);

// Reject hostnames that can only be internal. hostname comes from the
// WHATWG parser (already lowercased); a trailing dot is stripped so
// "localhost." cannot dodge the name check.
function assertPublicHost(hostname) {
  const name = hostname.toLowerCase().replace(/\.$/, "");
  if (!name) fail("invalid_webhook", "webhook url must include a hostname");
  if (name === "localhost" || name.endsWith(".localhost")) {
    fail("invalid_webhook", "webhook url must not target localhost");
  }
  if (isBlockedIp(name)) {
    fail("invalid_webhook", "webhook url must not target a private or reserved IP address");
  }
  if (name.startsWith("[")) {
    // A bracketed host that is not a blocked IP literal is either public
    // or unparseable. Fail closed on the unparseable (IPv6 zone IDs, junk):
    // it cannot be a DNS name, so there is nothing else it could be.
    const v6 = parseIpv6(name);
    if (v6 === null || isBlockedIpv6Value(v6)) {
      fail("invalid_webhook", "webhook url must not target a private or reserved IP address");
    }
  }
  // Anything else is a DNS name: subscribe-time resolution is
  // resolveWebhookTarget below (DNS rebinding).
}

// Validate a webhook URL: https only, public host only (SSRF guard —
// RC-2026-09-19-087). Returns the url unchanged when it passes.
export function validateWebhookUrl(url) {
  check(typeof url === "string" && url.length > 0 && url.length <= 2000, "url must be 1-2000 chars");
  check(URL_PATTERN.test(url), "url must be a valid https URL");
  let parsed;
  try { parsed = new URL(url); } catch { fail("invalid_webhook", "url must be a valid https URL"); }
  check(parsed.protocol === "https:", "url must be a valid https URL");
  assertPublicHost(parsed.hostname);
  return url;
}

// Same checks, also returning the DNS addresses that passed, so the
// dispatch path can pin the connection to exactly those (no second,
// unchecked resolution — the M-1 DNS-rebinding fix). IP literals are
// already screened by validateWebhookUrl; their own address is the pinned
// set. A name with no usable records is rejected (fail closed). The
// resolver is injectable so tests never touch the network.
export async function resolveWebhookTarget(url, { resolve4 = dns.resolve4, resolve6 = dns.resolve6 } = {}) {
  let host;
  try { host = new URL(validateWebhookUrl(url)).hostname.toLowerCase().replace(/\.$/, ""); }
  catch (error) { throw error; }
  if (host.startsWith("[") || parseIpv4(host) !== null) {
    return { url, addresses: [stripBrackets(host)] };
  }
  const settled = await Promise.allSettled([resolve4(host), resolve6(host)]);
  const answers = settled.flatMap(result => (result.status === "fulfilled" ? result.value : []));
  if (answers.length === 0) fail("invalid_webhook", "webhook hostname does not resolve to a public address");
  for (const answer of answers) {
    const v4 = parseIpv4(answer);
    if (v4 !== null) {
      if (isBlockedIp(answer)) fail("invalid_webhook", "webhook hostname resolves to a private or reserved IP address");
      continue;
    }
    // Fail closed on anything unparseable — a DNS answer that is not an IP
    // literal is not something we can vet.
    const v6 = parseIpv6(answer);
    if (v6 === null || isBlockedIpv6Value(v6)) {
      fail("invalid_webhook", "webhook hostname resolves to a private or reserved IP address");
    }
  }
  return { url, addresses: answers };
}

// DNS-rebinding companion for callers that can await: run the synchronous
// checks, then resolve the hostname's A/AAAA records and re-run the
// private-range checks against every answer. See resolveWebhookTarget for
// the address-returning form used by the dispatch path.
export async function assertWebhookHostDnsPublic(url, opts = {}) {
  return (await resolveWebhookTarget(url, opts)).url;
}
// The canonical wake-ping event name. An agent.wake delivery is journaled
// pending when an offline wakeable agent is @-mentioned or DM'd; the same
// payload shape is returned on the agent's next heartbeat and is the shape
// a future HTTP dispatch would POST to the host's registered wake URL.
export const WAKE_PING_EVENT = "agent.wake";
// Tag acknowledgment (2026-09-23): one-tap ack copy carried on every
// agent.wake payload (and on the journaled pending-wake signal), so a woken
// agent knows a bare 👍 react on the mentioning message counts as a
// response. Additive — the signal shape is untouched.
export const WAKE_ACK_HINT = "react \u{1F44D} to acknowledge";
export function buildWakePing({ agentId, signal }) {
  check(typeof agentId === "string" && agentId.length > 0, "agentId must be a non-empty string");
  check(signal !== null && typeof signal === "object", "signal must be an object");
  check(typeof signal.signalId === "string" && signal.signalId.length > 0, "signal.signalId must be a non-empty string");
  return Object.freeze({ event: WAKE_PING_EVENT, agentId, signal: Object.freeze({ ...signal }), ackHint: WAKE_ACK_HINT });
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
