// Unsubscribe detection (A027). A pure detector: given a message, it finds
// unsubscribe mechanisms — the List-Unsubscribe header (mailto and http),
// mailto links in the body, and links whose text says unsubscribe — and
// returns them ranked (header first, then body). It never clicks anything;
// the caller decides whether the owner approves the unsubscribe. Pure,
// dependency-free, deterministic; frozen outputs.
class UnsubscribeError extends Error { constructor(code, message) { super(message); this.name = "UnsubscribeError"; this.code = code; } }
const fail = (code, message) => { throw new UnsubscribeError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_unsubscribe_input", message); };

const headerOf = message => {
  const headers = message.headers;
  if (!headers) return {};
  check(typeof headers === "object" && !Array.isArray(headers), "headers must be an object");
  return headers;
};
// Parse angle-bracketed URIs from a List-Unsubscribe header value.
const parseHeaderTargets = value => {
  if (typeof value !== "string") return [];
  return [...value.matchAll(/<([^<>\s]+)>/g)].map(match => match[1].trim()).filter(Boolean);
};
const classify = target => {
  if (/^mailto:/i.test(target)) return "mailto";
  if (/^https?:\/\//i.test(target)) return "http";
  return null;
};
const fromBody = body => {
  if (typeof body !== "string") return [];
  const found = [];
  // mailto links anywhere in the body.
  for (const match of body.matchAll(/mailto:([^\s"'<>]+)/gi)) found.push({ method: "mailto", target: `mailto:${match[1]}`, source: "body" });
  // <a> links whose visible text mentions unsubscribe.
  for (const match of body.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([^<]{0,120})<\/a>/gi)) {
    if (/unsubscrib/i.test(match[2]) && classify(match[1])) found.push({ method: classify(match[1]), target: match[1], source: "body" });
  }
  return found;
};
// Detect unsubscribe mechanisms. Returns null when none are found.
export function detectUnsubscribe(message) {
  check(message !== null && typeof message === "object" && !Array.isArray(message), "message must be an object");
  check(typeof message.id === "string" && message.id.length > 0, "message id must be text");
  const mechanisms = [];
  const headers = headerOf(message);
  for (const key of Object.keys(headers)) {
    if (!/^list-unsubscribe(-post)?$/i.test(key)) continue;
    for (const target of parseHeaderTargets(headers[key])) {
      const method = classify(target);
      if (method) mechanisms.push(Object.freeze({ method, target, source: "header" }));
    }
  }
  mechanisms.push(...fromBody(message.body).map(m => Object.freeze(m)));
  if (mechanisms.length === 0) return null;
  // Dedup by target, header-ranked first.
  const seen = new Set(), ranked = [];
  for (const mechanism of mechanisms) {
    if (seen.has(mechanism.target)) continue;
    seen.add(mechanism.target);
    ranked.push(mechanism);
  }
  return Object.freeze({ messageId: message.id, mechanisms: Object.freeze(ranked),
    recommended: ranked[0], oneClick: /^list-unsubscribe-post$/i.test(Object.keys(headers).find(k => /^list-unsubscribe-post$/i.test(k)) ?? "") });
}
// Batch helper: which messages in a list are unsubscribable?
export function unsubscribableMessages(messages) {
  check(Array.isArray(messages), "messages must be a list");
  return messages.map(detectUnsubscribe).filter(Boolean);
}
export { UnsubscribeError };
