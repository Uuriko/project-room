// MCP Events wire boundary. Not advertised until durable subscriptions and
// current-grant authorization are mounted by the server.
// Protocol: https://developers.openai.com/plugins/build/mcp-events
// Signature: https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md
// Reuses Room's public-address validation and DNS-pinned HTTPS transport.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { resolveWebhookTarget } from "./outbound-webhooks.mjs";
import { pinnedDispatchPost, classifyHttpStatus } from "./webhook-dispatch.mjs";
import { isWorkersRuntime } from "./ip-blocklist.mjs";

export const MCP_EVENT_MAX_BYTES = 262144;

export function eventSigningKey(secret) {
  if (typeof secret !== "string" || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) throw new TypeError("Invalid event signing secret");
  const encoded = secret.slice(6), key = Buffer.from(encoded, "base64");
  if (key.length < 24 || key.length > 64 || key.toString("base64") !== encoded) throw new TypeError("Invalid event signing secret");
  return key;
}

export function signedEventRequest({ subscriptionId, secret, previousSecret, eventId, body, now = Date.now() }) {
  if (![subscriptionId, eventId].every(value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value))) throw new TypeError("Invalid event identity");
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("Invalid signing time");
  if (typeof body !== "string" || Buffer.byteLength(body) > MCP_EVENT_MAX_BYTES) throw new TypeError("Event payload exceeds limit");
  const timestamp = String(Math.floor(now / 1000));
  const signatures = [...new Set([secret, previousSecret].filter(value => value !== undefined))].map(value =>
    `v1,${createHmac("sha256", eventSigningKey(value)).update(`${eventId}.${timestamp}.${body}`).digest("base64")}`);
  return { body, headers: {
    "content-type": "application/json", "webhook-id": eventId,
    "webhook-timestamp": timestamp, "webhook-signature": signatures.join(" "),
    "X-MCP-Subscription-Id": subscriptionId,
  } };
}

// An injected transport must connect to these validated addresses, preserve
// TLS hostname verification, bound response size/time, and NEVER redirect.
// Workers has no DNS-pinning API: do not silently weaken this contract there.
export async function postMcpEvent({ url, request, dnsResolvers, transport, timeoutMs = 10000, beforeSend }) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw new TypeError("Invalid delivery timeout");
  if (!transport && isWorkersRuntime()) throw new Error("MCP Events requires a vetted egress transport on Workers");
  const deadline = Date.now() + timeoutMs;
  const remaining = () => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw Object.assign(new Error("Event delivery timed out"), { code: "event_timeout" });
    return ms;
  };
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const checked = await resolveWebhookTarget(url, dnsResolvers ?? {});
        remaining();
        if (beforeSend) await beforeSend();
        const response = await (transport ?? pinnedDispatchPost)(checked.url, checked.addresses, { ...request, timeoutMs: remaining() });
        remaining();
        // No redirect follow-up, even to a public IP.
        const status = Number(response.status);
        return { response, status, classification: classifyHttpStatus(status) };
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("Event delivery timed out"), { code: "event_timeout" })), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

export async function verifyMcpEventCallback({ subscriptionId, secret, url, dnsResolvers, transport, now = Date.now() }) {
  const challenge = randomBytes(32).toString("base64url");
  const body = JSON.stringify({ type: "verification", challenge });
  const request = signedEventRequest({ subscriptionId, secret, eventId: `verify_${randomBytes(16).toString("hex")}`, body, now });
  let delivery;
  try { delivery = await postMcpEvent({ url, request, dnsResolvers, transport }); }
  catch { throw callbackError("transport_failed"); }
  if (delivery.classification !== "delivered") throw callbackError("challenge_failed");
  let echoed;
  try {
    const text = await delivery.response.text();
    if (Buffer.byteLength(text) > 4096) throw new Error("oversize");
    echoed = JSON.parse(text).challenge;
  } catch { throw callbackError("challenge_failed"); }
  if (typeof echoed !== "string") throw callbackError("challenge_failed");
  const actual = Buffer.from(echoed), expected = Buffer.from(challenge);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw callbackError("challenge_failed");
  return { verified: true };
}

function callbackError(reason) {
  return Object.assign(new Error("Callback verification failed"), { code: -32015, data: { reason } });
}

export async function deliverMcpEvent({ subscription, event, authorize, now = Date.now(), dnsResolvers, transport }) {
  const startedAt = Date.now();
  const currentTime = () => now + Date.now() - startedAt;
  // Revalidate before every attempt; a successful old subscription grants no
  // enduring permission after account/room membership or consent is revoked.
  if (typeof authorize !== "function" || !await authorize(subscription)) return { classification: "revoked" };
  if (!Number.isSafeInteger(subscription.expiresAt) || subscription.expiresAt <= currentTime()) return { classification: "expired" };
  if (!event || typeof event.name !== "string" || event.name !== subscription.name || typeof event.timestamp !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(event.timestamp) || !Number.isFinite(Date.parse(event.timestamp)) || !event.data || typeof event.data !== "object" || Array.isArray(event.data)) throw new TypeError("Invalid event envelope");
  const body = JSON.stringify({ eventId: event.eventId, name: event.name, timestamp: event.timestamp, data: event.data, cursor: event.cursor ?? null });
  const request = signedEventRequest({ subscriptionId: subscription.id, secret: subscription.secret,
    previousSecret: subscription.previousSecretExpiresAt > now ? subscription.previousSecret : undefined,
    eventId: event.eventId, body, now });
  try {
    const { status, classification } = await postMcpEvent({ url: subscription.url, request, dnsResolvers, transport, beforeSend: async () => {
      if (!await authorize(subscription)) throw Object.assign(new Error("Event access revoked"), { code: "event_revoked" });
      if (subscription.expiresAt <= currentTime()) throw Object.assign(new Error("Event subscription expired"), { code: "event_expired" });
    } });
    return { status, classification }; // 2xx means receipt, never agent execution.
  } catch (error) {
    if (error?.code === "event_revoked") return { classification: "revoked" };
    if (error?.code === "event_expired") return { classification: "expired" };
    return { status: 0, classification: error?.code === "webhook_url_not_public" || error?.code === "invalid_webhook" ? "dead" : "retry" };
  }
}
