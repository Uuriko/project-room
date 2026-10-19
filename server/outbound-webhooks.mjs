// Outbound webhooks (B020). A webhook manager: register webhooks
// (URL + event filter), match room events against filters, build delivery
// payloads, and track delivery state (pending → delivered/failed).
// HTTP delivery is implemented in server/webhook-dispatch.mjs. This module
// does not POST. Registration state is caller-owned. Hostname checks use
// node:dns on Node and DNS-over-HTTPS on Workers. Malformed inputs throw
// WebhookError.
import { promises as dns } from "node:dns";
import { parseIpv4, parseIpv6, isBlockedIp, isBlockedIpv6Value, extractEmbeddedIpv4, isWorkersRuntime } from "./ip-blocklist.mjs";

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

// Hostnames that are internal by name. On Cloudflare Workers there is no
// DNS pin, so these stay refused even when resolution is skipped. A
// trailing dot is already stripped by the caller.
const METADATA_HOSTS = new Set([
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "metadata.azure.com",
  "instance-data",
  "instance-data.ec2.internal",
]);
const METADATA_SUFFIXES = ["metadata.google.internal", "metadata.goog"];

function isMetadataHostname(hostname) {
  const name = String(hostname ?? "").toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (!name) return false;
  if (METADATA_HOSTS.has(name)) return true;
  return METADATA_SUFFIXES.some(suffix => name.endsWith(`.${suffix}`));
}

// True when a DNS answer is not a vetted public IP. Unparseable answers
// fail closed: a record we cannot classify is not something we dial.
function answerIsBlocked(answer) {
  if (typeof answer !== "string" || answer.length === 0) return true;
  if (parseIpv4(answer) !== null) return isBlockedIp(answer);
  const v6 = parseIpv6(answer);
  return v6 === null || isBlockedIpv6Value(v6);
}

function normalizeLookup(records) {
  if (!records) return [];
  const list = Array.isArray(records) ? records : [records];
  const answers = [];
  for (const record of list) {
    if (typeof record === "string") answers.push(record);
    else if (record && typeof record.address === "string") answers.push(record.address);
  }
  return answers;
}

// Reject hostnames that can only be internal. hostname comes from the
// WHATWG parser (already lowercased); a trailing dot is stripped so
// "localhost." cannot dodge the name check.
// Q3-D: a host or port that cannot be public answers webhook_url_not_public,
// the same code the subscribe-time DNS check uses.
const notPublic = message => fail("webhook_url_not_public", message);
function assertPublicHost(hostname) {
  const name = hostname.toLowerCase().replace(/\.$/, "");
  if (!name) fail("invalid_webhook", "webhook url must include a hostname");
  if (name === "localhost" || name.endsWith(".localhost")) {
    notPublic("webhook url must not target localhost");
  }
  if (isMetadataHostname(name)) {
    notPublic("webhook url must not target a private or reserved metadata hostname");
  }
  // Link-local and cluster names are not public hosts. .localhost is already
  // refused above. A trailing dot was stripped, so "db.internal." cannot dodge.
  const internalNames = new Set(["internal", "local", "svc", "cluster.local"]);
  const internalSuffixes = [".internal", ".local", ".svc", ".cluster.local"];
  if (internalNames.has(name) || internalSuffixes.some(suffix => name.endsWith(suffix))) {
    notPublic("webhook url must not target a private or reserved hostname");
  }
  if (isBlockedIp(name)) {
    notPublic("webhook url must not target a private or reserved IP address");
  }
  if (name.startsWith("[")) {
    // A bracketed host that is not a blocked IP literal is either public
    // or unparseable. Fail closed on the unparseable (IPv6 zone IDs, junk):
    // it cannot be a DNS name, so there is nothing else it could be.
    const v6 = parseIpv6(name);
    if (v6 === null || isBlockedIpv6Value(v6)) {
      notPublic("webhook url must not target a private or reserved IP address");
    }
  }
  // Anything else is a DNS name: subscribe-time resolution is
  // resolveWebhookTarget below (DNS rebinding).
}

// Validate a webhook URL: https only, public host only (SSRF guard —
// RC-2026-09-19-087). Returns the url unchanged when it passes.
export function validateWebhookUrl(url) {
  check(typeof url === "string" && url.length > 0 && url.length <= 2000, "url must be 1-2000 chars");
  // Q3-D: the WHATWG parser silently strips some control characters, so the
  // raw string is checked before parsing.
  check(!/[\u0000-\u001f\u007f-\u009f]/.test(url), "url must not contain control characters");
  check(URL_PATTERN.test(url), "url must be a valid https URL");
  let parsed;
  try { parsed = new URL(url); } catch { fail("invalid_webhook", "url must be a valid https URL"); }
  check(parsed.protocol === "https:", "url must be a valid https URL");
  // Host first, so example.com@127.0.0.1 stays an SSRF refusal. A public
  // host with userinfo is a different miss: node:https sends it as Basic.
  assertPublicHost(parsed.hostname);
  check(!parsed.username && !parsed.password, "url must be an https URL without credentials");
  // Default https is 443. An explicit port is only 443 or 8443.
  if (parsed.port !== "" && parsed.port !== "443" && parsed.port !== "8443") {
    notPublic("webhook url must use port 443 or 8443");
  }
  return url;
}

// Same checks, also returning the DNS addresses that passed, so the
// dispatch path can pin the connection to exactly those (no second,
// unchecked resolution — the M-1 DNS-rebinding fix). IP literals are
// already screened by validateWebhookUrl; their own address is the pinned
// set. A name with no usable records is rejected (fail closed). The
// resolver is injectable so tests never touch the network.
//
// On Node the default resolver is dns.lookup({ all: true }), the same
// getaddrinfo path the socket would use (it honours hosts-file entries
// that resolve4/resolve6 never see). Callers that pass resolve4/resolve6
// keep that older injection. On Workers there is no pin API, so the name
// is resolved through DNS-over-HTTPS and every A/AAAA answer is classified
// with the same private-range checks. A Node lookup passed in from a test
// is ignored on Workers. A resolution failure is not treated as public.
const DOH_CACHE_CAP_MS = 5 * 60 * 1000;
const dohCache = new Map();

async function resolveWebhookAddressesViaDoh(hostname, { dohFetch = globalThis.fetch, now = Date.now() } = {}) {
  const key = hostname.toLowerCase();
  const hit = dohCache.get(key);
  if (hit && hit.expiresAt > now) return hit.addresses;
  if (hit) dohCache.delete(key);
  if (typeof dohFetch !== "function") throw new Error("webhook hostname does not resolve");
  const addresses = [];
  let minTtlSec = null;
  for (const type of ["A", "AAAA"]) {
    const response = await dohFetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(key)}&type=${type}`, {
      headers: { accept: "application/dns-json" },
    });
    if (!response?.ok) throw new Error("webhook hostname does not resolve");
    const body = typeof response.json === "function" ? await response.json() : null;
    const answers = Array.isArray(body?.Answer) ? body.Answer : [];
    for (const answer of answers) {
      const kind = Number(answer?.type);
      if (kind !== 1 && kind !== 28) continue;
      const data = String(answer?.data ?? "").trim();
      if (!data) continue;
      addresses.push(data);
      const ttl = Number(answer?.TTL);
      if (Number.isFinite(ttl) && ttl >= 0) minTtlSec = minTtlSec === null ? ttl : Math.min(minTtlSec, ttl);
    }
  }
  if (addresses.length === 0) throw new Error("webhook hostname does not resolve");
  if (minTtlSec !== null && minTtlSec > 0) {
    dohCache.set(key, { addresses, expiresAt: now + Math.min(minTtlSec * 1000, DOH_CACHE_CAP_MS) });
  }
  return addresses;
}

// Resolve a hostname to its A/AAAA answers with the injectable machinery
// the strict resolver honours (test lookup / resolve4 / resolve6, or
// DNS-over-HTTPS on Workers). No range verdict is applied here — callers
// decide which answers are acceptable — and an empty result means the
// name did not resolve (callers fail closed on it).
async function resolveHostAddresses(host, options = {}) {
  if (isWorkersRuntime()) {
    try {
      return await resolveWebhookAddressesViaDoh(host, options);
    } catch (error) {
      if (error?.name === "WebhookError") throw error;
      fail("invalid_webhook", "webhook hostname does not resolve to a public address");
    }
  }
  const explicit4 = typeof options.resolve4 === "function";
  const explicit6 = typeof options.resolve6 === "function";
  const explicitLookup = typeof options.lookup === "function";
  if (explicitLookup || (!explicit4 && !explicit6)) {
    const lookup = explicitLookup ? options.lookup : dns.lookup;
    try {
      return normalizeLookup(await lookup(host, { all: true, verbatim: true }));
    } catch {
      return [];
    }
  }
  const resolve4 = explicit4 ? options.resolve4 : async () => [];
  const resolve6 = explicit6 ? options.resolve6 : async () => [];
  const settled = await Promise.allSettled([resolve4(host), resolve6(host)]);
  return settled.flatMap(result => (result.status === "fulfilled" ? result.value : []));
}

export async function resolveWebhookTarget(url, options = {}) {
  let host;
  try { host = new URL(validateWebhookUrl(url)).hostname.toLowerCase().replace(/\.$/, ""); }
  catch (error) { throw error; }
  if (host.startsWith("[") || parseIpv4(host) !== null) {
    return { url, addresses: [stripBrackets(host)] };
  }
  const answers = await resolveHostAddresses(host, options);
  if (answers.length === 0) fail("invalid_webhook", "webhook hostname does not resolve to a public address");
  for (const answer of answers) {
    if (answerIsBlocked(answer)) {
      fail("invalid_webhook", "webhook hostname resolves to a private or reserved IP address");
    }
  }
  return { url, addresses: answers };
}

// Subscribe-time gate (QA2 finding P2-8). validateWebhookUrl already
// refuses IP literals, localhost, and metadata names. On Node, also
// dns.lookup({ all: true }) and refuse when any address is loopback,
// RFC1918, CGNAT, link-local, unique-local, or an IPv4-mapped form of
// those. Callers await this before opening the write transaction. On Node
// a lookup failure or an empty answer refuses the subscription — the
// registration gate agrees with the dispatcher's fail-closed re-check —
// for every name, with no exemptions: a name that does not resolve cannot
// be a real delivery target, and an exemption in production code is an
// SSRF-shaped hole (Instinct-3 review, PR #1590 seq 4267). Tests that need
// a fixture name to resolve inject a fake resolver through the `lookup`
// option (dns.lookup-compatible); production wiring always passes the
// real resolver. On Workers a resolution failure refuses the subscription
// for every name; delivery retries that failure instead of treating it as
// allowed.
export async function assertAgentWebhookUrlPublic(url, options = {}) {
  const lookup = typeof options.lookup === "function" ? options.lookup : dns.lookup;
  // A non-public host or port already throws webhook_url_not_public here.
  validateWebhookUrl(url);
  const host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  if (isWorkersRuntime()) {
    try {
      await resolveWebhookTarget(url, { dohFetch: options.dohFetch, now: options.now });
    } catch (error) {
      if (error?.name === "WebhookError" && /private or reserved|does not resolve|metadata hostname/.test(error.message ?? "")) {
        fail("webhook_url_not_public", "That webhook URL is not on the public internet.");
      }
      throw error;
    }
    return url;
  }
  const bare = stripBrackets(host);
  if (parseIpv4(bare) !== null || parseIpv6(bare) !== null) return url;
  // hw-sec-15-dns-failclosed: a name that does not resolve is refused —
  // fully fail-closed, no reserved-name exemption in production.
  let records;
  try {
    records = await lookup(bare, { all: true, verbatim: true });
  } catch {
    fail("webhook_url_not_public", "webhook hostname does not resolve to a public address");
  }
  const answers = normalizeLookup(records);
  if (answers.length === 0) {
    fail("webhook_url_not_public", "webhook hostname does not resolve to a public address");
  }
  for (const answer of answers) {
    if (answerIsBlocked(answer)) {
      fail("webhook_url_not_public", "webhook hostname resolves to a private or reserved IP address");
    }
  }
  return url;
}

// DNS-rebinding companion for callers that can await: run the synchronous
// checks, then resolve the hostname's A/AAAA records and re-run the
// private-range checks against every answer. See resolveWebhookTarget for
// the address-returning form used by the dispatch path.
export async function assertWebhookHostDnsPublic(url, opts = {}) {
  return (await resolveWebhookTarget(url, opts)).url;
}

// --- Operator wake-target allowlist (WAKE0-3a) ------------------------------
// The synthesis ruling stands: loopback/private wake targets stay refused
// on the public doors — no API call can arm one. A SELF-HOST deployment
// arms specific hosts through operator config only: the env var below
// names hosts (comma-separated hostnames or IP literals, exact match
// after lowercasing and trailing-dot/bracket normalisation; no wildcards,
// no subdomain implication) that the WAKE surfaces may use — heartbeat
// push targets, host wakeUrls, wake-only (agent.wake) webhook
// subscriptions, and deliveries to those targets. An armed host may be
// reached over http or https, on any port, at loopback/RFC1918/ULA
// addresses: the operator named the machine, and the wake payload is a
// content-free pointer, so the dial is the operator's own doorbell.
// Everything else is unchanged: an unarmed host gets the strict checks
// above with identical codes and messages, general webhooks are never
// relaxed, userinfo stays refused everywhere, and the platform metadata
// plane (metadata hostnames and the 169.254.0.0/16 / fe80::/10 link-local
// ranges that carry it) can NEVER be armed — naming it in the env is
// ignored, not honoured.
export const WAKE_TARGET_ALLOWLIST_ENV = "ROOM_WAKE_TARGET_ALLOWLIST";

function normalizeArmedHostName(value) {
  let name = String(value ?? "").trim().toLowerCase();
  if (!name) return "";
  if (name.includes("://")) {
    try { name = new URL(name).hostname.toLowerCase(); } catch { return ""; }
  }
  name = name.replace(/\.$/, "");
  if (name.startsWith("[")) {
    // "[::1]" or "[::1]:8787" — the host is inside the brackets.
    const close = name.indexOf("]");
    if (close > 0) name = name.slice(1, close);
  } else if (/^[^:[\]]+:\d+$/.test(name)) {
    name = name.slice(0, name.lastIndexOf(":"));
  }
  return name;
}

export function operatorWakeTargetHosts(env = process.env) {
  const raw = env?.[WAKE_TARGET_ALLOWLIST_ENV];
  const hosts = new Set();
  if (typeof raw !== "string") return hosts;
  for (const part of raw.split(",")) {
    const name = normalizeArmedHostName(part);
    if (name) hosts.add(name);
  }
  return hosts;
}

// Hosts that name the platform metadata plane are unarmable even when the
// operator lists them: the allowlist arms the operator's own machines,
// never the cloud's control plane.
function isUnarmableWakeHost(name) {
  if (isMetadataHostname(name)) return true;
  const bare = stripBrackets(name);
  const v4 = parseIpv4(bare);
  if (v4 !== null) return (v4 >>> 16) === 0xa9fe; // 169.254.0.0/16
  const embedded = extractEmbeddedIpv4(bare);
  if (embedded !== null) return (embedded >>> 16) === 0xa9fe;
  const v6 = parseIpv6(bare);
  if (v6 !== null) return (v6 >> 118n) === 0x3fan; // fe80::/10 link-local
  return false;
}

export function isOperatorWakeTarget(hostname, env = process.env) {
  const name = String(hostname ?? "").toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (!name || isUnarmableWakeHost(name)) return false;
  return operatorWakeTargetHosts(env).has(name);
}

// Wake-scoped URL validation: identical to validateWebhookUrl for an
// unarmed host (same codes, same messages — the public refusal is the
// ruling, not a bug). For an operator-armed host only the public-posture
// checks relax: http is allowed, any port is allowed, and loopback /
// private / local names pass. Shape checks (length, control characters,
// a parseable URL, no credentials) never relax.
export function validateWakeTargetUrl(url, { env = process.env } = {}) {
  check(typeof url === "string" && url.length > 0 && url.length <= 2000, "url must be 1-2000 chars");
  check(!/[\u0000-\u001f\u007f-\u009f]/.test(url), "url must not contain control characters");
  let parsed;
  try { parsed = new URL(url); } catch { return validateWebhookUrl(url); }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (!isOperatorWakeTarget(host, env)) return validateWebhookUrl(url);
  if (!host) fail("invalid_webhook", "webhook url must include a hostname");
  check(parsed.protocol === "https:" || parsed.protocol === "http:",
    "url must be a valid http or https URL");
  check(!parsed.username && !parsed.password, "url must be an http or https URL without credentials");
  return url;
}

// Wake-scoped resolver: the strict resolver for unarmed hosts. For an
// armed host, DNS answers in blocked ranges are accepted as the pinned
// set (the operator named this host; pinning still applies, so a later
// rebind cannot move the dial), but a name that does not resolve at all
// still fails closed — armed is not the same as reachable.
export async function resolveWakeTarget(url, options = {}) {
  const env = options.env ?? process.env;
  const clean = validateWakeTargetUrl(url, { env });
  const host = new URL(clean).hostname.toLowerCase().replace(/\.$/, "");
  if (!isOperatorWakeTarget(host, env)) return resolveWebhookTarget(url, options);
  const bare = stripBrackets(host);
  if (parseIpv4(bare) !== null || parseIpv6(bare) !== null) {
    return { url: clean, addresses: [bare] };
  }
  const answers = await resolveHostAddresses(bare, options);
  if (answers.length === 0) fail("invalid_webhook", "webhook hostname does not resolve to a public address");
  return { url: clean, addresses: [...new Set(answers)] };
}

// Subscribe-time gate for wake surfaces: assertAgentWebhookUrlPublic for
// unarmed hosts; for an armed host the name must still resolve (to any
// address, public or not) before the URL is stored.
export async function assertWakeTargetUrl(url, options = {}) {
  const env = options.env ?? process.env;
  let host = "";
  try { host = new URL(url).hostname.toLowerCase().replace(/\.$/, ""); } catch { /* the strict gate throws below */ }
  if (!isOperatorWakeTarget(host, env)) return assertAgentWebhookUrlPublic(url, options);
  validateWakeTargetUrl(url, { env });
  const bare = stripBrackets(host);
  if (parseIpv4(bare) !== null || parseIpv6(bare) !== null) return url;
  if (isWorkersRuntime()) {
    try {
      await resolveWakeTarget(url, options);
    } catch (error) {
      if (error?.name === "WebhookError" && /does not resolve/.test(error.message ?? "")) {
        fail("webhook_url_not_public", "That wake target URL's hostname does not resolve.");
      }
      throw error;
    }
    return url;
  }
  const lookup = typeof options.lookup === "function" ? options.lookup : dns.lookup;
  let records;
  try {
    records = await lookup(bare, { all: true, verbatim: true });
  } catch {
    fail("webhook_url_not_public", "webhook hostname does not resolve to a public address");
  }
  if (normalizeLookup(records).length === 0) {
    fail("webhook_url_not_public", "webhook hostname does not resolve to a public address");
  }
  return url;
}

// DNS companion for the push-registration path (assertPushDns): the
// wake-scoped form of assertWebhookHostDnsPublic.
export async function assertWakeTargetHostDns(url, opts = {}) {
  return (await resolveWakeTarget(url, opts)).url;
}
// The canonical wake-ping event name. An agent.wake delivery is journaled
// pending when an offline wakeable agent is @-mentioned or DM'd; the same
// payload shape is returned on the agent's next heartbeat and is the shape
// a future HTTP dispatch would POST to the host's registered wake URL.
export const WAKE_PING_EVENT = "agent.wake";
// Ack copy carried on every agent.wake payload (and on the journaled
// pending-wake signal): wakes are acknowledged explicitly by signal id.
export const WAKE_ACK_HINT = "ack with heartbeat_ack (POST /api/agent-heartbeats/ack { signalIds })";
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
