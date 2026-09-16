// Newsletter / bulk-sender detection (A014). A pure classifier: given a
// message's headers and metadata, decide whether it's bulk mail (newsletter,
// marketing, notifications) vs personal mail. Signals: List-Unsubscribe
// header, List-ID, Precedence: bulk, X-Mailer bulk markers, and
// sender-domain reputation hints. Returns a classification with confidence
// and the unsubscribe URL when present. Pure, dependency-free,
// deterministic; frozen outputs. Store/UI wiring is a later slice.
const BULK_HEADERS = Object.freeze([
  "list-unsubscribe", "list-id", "list-unsubscribe-post",
]);
const BULK_PRECEDENCE = Object.freeze(["bulk", "list", "junk"]);
const BULK_MARKERS = Object.freeze([
  /mailchimp/i, /sendgrid/i, /constantcontact/i, /campaign/i,
  /newsletter/i, /marketing/i, /hubspot/i, /marketo/i,
]);
class BulkDetectError extends Error { constructor(code, message) { super(message); this.name = "BulkDetectError"; this.code = code; } }
const fail = (code, message) => { throw new BulkDetectError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_bulk_detect", message); };

const headerOf = (headers, name) => {
  const key = Object.keys(headers).find(k => k.toLowerCase() === name);
  return key ? headers[key] : undefined;
};
// Extract an unsubscribe URL from a List-Unsubscribe header value.
const unsubscribeUrlOf = value => {
  if (!value) return null;
  const match = /<(https?:[^>]+)>/.exec(value) || /(https?:\S+)/.exec(value);
  return match ? match[1] : null;
};
// Classify a message. message is { headers: {...}, from, subject }.
export function classifyBulk(message) {
  check(message !== null && typeof message === "object", "message must be an object");
  check(message.headers !== null && typeof message.headers === "object", "message.headers must be an object");
  const headers = message.headers;
  const signals = [];
  let score = 0;
  for (const name of BULK_HEADERS) {
    if (headerOf(headers, name)) { signals.push(`header:${name}`); score += 3; }
  }
  const precedence = headerOf(headers, "precedence");
  if (precedence && BULK_PRECEDENCE.includes(String(precedence).toLowerCase().trim())) {
    signals.push("precedence:bulk"); score += 3;
  }
  const from = message.from ?? "", subject = message.subject ?? "";
  for (const marker of BULK_MARKERS) {
    if (marker.test(from) || marker.test(subject) || marker.test(headerOf(headers, "x-mailer") ?? "")) {
      signals.push(`marker:${marker.source}`); score += 2; break;
    }
  }
  const listUnsub = headerOf(headers, "list-unsubscribe");
  const unsubscribeUrl = unsubscribeUrlOf(listUnsub);
  if (unsubscribeUrl) { signals.push("unsubscribe-url"); score += 1; }
  const isBulk = score >= 3;
  const confidence = Math.min(1, score / 9);
  return Object.freeze({ isBulk, confidence: Math.round(confidence * 100) / 100,
    unsubscribeUrl, signals: Object.freeze(signals) });
}
export { BulkDetectError };
