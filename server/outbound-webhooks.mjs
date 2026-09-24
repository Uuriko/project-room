// Outbound webhooks (B020). A webhook manager: register webhooks
// (URL + event filter), match room events against filters, build delivery
// payloads, and track delivery state (pending → delivered/failed). Actual
// HTTP delivery is a later slice. All state is caller-owned (a Map); the
// module is pure except for node:dns, which only the opt-in async DNS
// check (assertWebhookHostDnsPublic) touches. Malformed inputs throw
// WebhookError.
import { promises as dns } from "node:dns";

class WebhookError extends Error { constructor(code, message) { super(message); this.name = "WebhookError"; this.code = code; } }
const fail = (code, message) => { throw new WebhookError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_webhook", message); };
const URL_PATTERN = /^https:\/\/[^\s/$.?#].[^\s]*$/i;

// --- SSRF guard (RC-2026-09-19-087) -----------------------------------------
// Webhook deliveries are server-side fetches, so a hostile subscriber can
// aim them at internal infrastructure: the cloud metadata endpoint
// (169.254.169.254), loopback, RFC1918/ULA space, link-local addresses.
// Subscribe-time checks reject anything that can only be internal, before
// the URL is stored. Host parsing runs on the WHATWG-normalized hostname,
// so decimal/octal/hex IPv4 disguises (2130706433, 0x7f.0.0.1, 0177.0.0.1)
// and userinfo tricks (example.com@127.0.0.1) collapse to the real address
// before the range checks. DNS rebinding (a name that resolves internal at
// fetch time) is covered by the opt-in assertWebhookHostDnsPublic for
// callers that can await.

// Strict dotted-quad → uint32, or null. The URL parser has already
// normalized exotic IPv4 spellings, so only the canonical form is needed.
const ipv4ToInt = host => {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const byte = Number(part);
    if (byte > 255) return null;
    n = (n << 8) | byte;
  }
  return n >>> 0;
};

// Every IPv4 range a public webhook target must never fall in.
const PRIVATE_V4 = [
  ["0.0.0.0", 8],        // "this host" software scope
  ["10.0.0.0", 8],       // RFC1918
  ["100.64.0.0", 10],    // shared CGNAT space
  ["127.0.0.0", 8],      // loopback
  ["169.254.0.0", 16],   // link-local — the cloud metadata endpoint lives here
  ["172.16.0.0", 12],    // RFC1918
  ["192.0.0.0", 24],     // IETF protocol assignments
  ["192.0.2.0", 24],     // TEST-NET-1 documentation
  ["192.168.0.0", 16],   // RFC1918
  ["198.18.0.0", 15],    // benchmarking
  ["198.51.100.0", 24],  // TEST-NET-2 documentation
  ["203.0.113.0", 24],   // TEST-NET-3 documentation
  ["224.0.0.0", 4],      // multicast
  ["240.0.0.0", 4],      // reserved
].map(([base, bits]) => ({ base: ipv4ToInt(base), bits }));
const inCidrV4 = (n, { base, bits }) => (n >>> (32 - bits)) === (base >>> (32 - bits));
const isPrivateIpv4 = n => PRIVATE_V4.some(cidr => inCidrV4(n, cidr));

// Expand an IPv6 literal (without brackets; may carry a dotted-quad tail)
// to eight 16-bit words, or null when it is not valid IPv6.
const expandIpv6 = host => {
  const halves = host.split("::");
  if (halves.length > 2) return null;
  const parseHalf = half => {
    if (half === "") return [];
    const words = [];
    for (const piece of half.split(":")) {
      if (piece.includes(".")) {
        const n = ipv4ToInt(piece);
        if (n === null) return null;
        words.push((n >>> 16) & 0xffff, n & 0xffff);
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null;
        words.push(parseInt(piece, 16));
      }
    }
    return words;
  };
  const left = parseHalf(halves[0]);
  const right = halves.length === 2 ? parseHalf(halves[1]) : [];
  if (!left || !right) return null;
  const gap = 8 - left.length - right.length;
  if (halves.length === 2 ? gap < 0 : gap !== 0) return null;
  return [...left, ...Array(gap).fill(0), ...right];
};

const isPrivateIpv6 = words => {
  const zeroThrough = n => words.slice(0, n + 1).every(word => word === 0);
  if (zeroThrough(6) && words[7] <= 1) return true;                 // :: and ::1
  if (zeroThrough(4) && words[5] === 0xffff) {                     // ::ffff:0:0/96 mapped
    return isPrivateIpv4((((words[6] << 16) | words[7]) >>> 0));
  }
  if ((words[0] & 0xffc0) === 0xfe80) return true;                 // fe80::/10 link-local
  if ((words[0] & 0xfe00) === 0xfc00) return true;                 // fc00::/7 ULA
  if ((words[0] & 0xff00) === 0xff00) return true;                 // ff00::/8 multicast
  if (words[0] === 0x2001 && words[1] === 0x0db8) return true;     // 2001:db8::/32 docs
  return false;
};

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
  const v4 = ipv4ToInt(name);
  if (v4 !== null) {
    if (isPrivateIpv4(v4)) fail("invalid_webhook", "webhook url must not target a private or reserved IP address");
    return;
  }
  if (name.startsWith("[")) {
    // An IPv6 literal (the parser keeps brackets on hostname). Fail closed
    // on anything unparseable.
    const words = expandIpv6(stripBrackets(name));
    if (!words || isPrivateIpv6(words)) fail("invalid_webhook", "webhook url must not target a private or reserved IP address");
  }
  // Anything else is a DNS name: subscribe-time resolution is the opt-in
  // assertWebhookHostDnsPublic below (DNS rebinding).
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

// DNS-rebinding companion for callers that can await: run the synchronous
// checks, then resolve the hostname's A/AAAA records and re-run the
// private-range checks against every answer. IP literals are already
// screened by validateWebhookUrl; a name with no usable records is rejected
// (fail closed). The resolver is injectable so tests never touch the
// network. Residual window: a record can still flip between subscribe and
// dispatch, so the dispatch path should re-check before each POST.
export async function assertWebhookHostDnsPublic(url, { resolve4 = dns.resolve4, resolve6 = dns.resolve6 } = {}) {
  let host;
  try { host = new URL(validateWebhookUrl(url)).hostname.toLowerCase().replace(/\.$/, ""); }
  catch (error) { throw error; }
  if (host.startsWith("[") || ipv4ToInt(host) !== null) return url; // literals already screened
  const settled = await Promise.allSettled([resolve4(host), resolve6(host)]);
  const answers = settled.flatMap(result => (result.status === "fulfilled" ? result.value : []));
  if (answers.length === 0) fail("invalid_webhook", "webhook hostname does not resolve to a public address");
  for (const answer of answers) {
    const v4 = ipv4ToInt(answer);
    if (v4 !== null) {
      if (isPrivateIpv4(v4)) fail("invalid_webhook", "webhook hostname resolves to a private or reserved IP address");
      continue;
    }
    const words = expandIpv6(stripBrackets(answer));
    if (!words || isPrivateIpv6(words)) fail("invalid_webhook", "webhook hostname resolves to a private or reserved IP address");
  }
  return url;
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
