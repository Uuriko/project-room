// Webhook delivery for alert events (G013). A pure webhook payload
// builder: given an alert event, build the signed webhook payload for
// delivery to a subscriber URL. HMAC signing uses a caller-supplied
// secret; the module is pure and dependency-free (uses node:crypto).
// Frozen outputs; malformed inputs throw WebhookError. Actual HTTP
// delivery is a later slice.
import { createHmac } from "node:crypto";
class WebhookError extends Error { constructor(code, message) { super(message); this.name = "WebhookError"; this.code = code; } }
const fail = (code, message) => { throw new WebhookError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_webhook", message); };
// Build a webhook payload for an alert event.
// alert: { alertId, ruleId, roomId, message, timestamp, severity }
// Returns { url, headers, body } ready for POST.
export function buildWebhook({ alert, url, secret }) {
  check(alert !== null && typeof alert === "object", "alert must be an object");
  check(typeof alert.alertId === "string" && alert.alertId.length > 0, "alert.alertId must be non-empty");
  check(typeof alert.ruleId === "string" && alert.ruleId.length > 0, "alert.ruleId must be non-empty");
  check(typeof url === "string" && url.startsWith("https://"), "url must be an https URL");
  check(typeof secret === "string" && secret.length > 0, "secret must be non-empty");
  const body = JSON.stringify({ event: "alert.fired", alertId: alert.alertId,
    ruleId: alert.ruleId, roomId: alert.roomId || null,
    message: alert.message || "", severity: alert.severity || "info",
    timestamp: alert.timestamp || new Date().toISOString() });
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  return Object.freeze({ url, headers: Object.freeze({
      "Content-Type": "application/json",
      "X-Webhook-Signature": `sha256=${signature}`,
      "X-Webhook-Event": "alert.fired" }),
    body });
}
// Verify a webhook signature (for the receiver side).
export function verifyWebhook({ body, signature, secret }) {
  check(typeof body === "string", "body must be a string");
  check(typeof signature === "string", "signature must be a string");
  check(typeof secret === "string" && secret.length > 0, "secret must be non-empty");
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  return signature === expected;
}
export { WebhookError };
