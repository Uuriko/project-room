// Self-hosted discovery origin.
//
// Discovery packets, the sitemap, canonical Link headers and the canonical/OG
// tags of public pages are authored once for the hosted service origin
// (src/service-origin.js ROOM_ORIGIN). A fresh self-hosted instance must not
// tell agents and crawlers that its rooms live at room.trydemigod.com, so the
// Node server rewrites those bytes to the instance's own origin: the same
// value (`expectedOrigin()` in server/http.mjs) that invite and agent-connect
// URLs already use.
//
// Hosted mode is a strict no-op. When the instance origin is absent or equals
// ROOM_ORIGIN every function returns its input unchanged (same string or the
// same object), so hosted output stays byte-identical.
import { createHash } from "node:crypto";
import { ROOM_ORIGIN } from "../src/service-origin.js";

const SIGNATURE_FIELDS = Object.freeze(["signatures", "cardSignature", "signedRevision", "keyId", "signatureAgentId", "publicKey"]);
export const SELF_HOSTED_CARD_UNSIGNED_REASON = "self-hosted instance: card origin rewritten, not signed by the project key";

const HOSTED_HOSTNAME = new URL(ROOM_ORIGIN).hostname;
const normalize = origin => (typeof origin === "string" ? origin.trim().replace(/\/+$/, "") : "");

// True when output must stay exactly as authored for the hosted service.
export function isHostedOrigin(origin) {
  const value = normalize(origin);
  return value === "" || value === ROOM_ORIGIN;
}

// The origin to advertise: the hosted constant, or the instance's own.
export function advertisedOrigin(origin) {
  return isHostedOrigin(origin) ? ROOM_ORIGIN : normalize(origin);
}

export function advertisedText(text, origin) {
  if (typeof text !== "string" || isHostedOrigin(origin)) return text;
  const own = normalize(origin);
  let rewritten = text.split(ROOM_ORIGIN).join(own);
  // ARD identifiers are domain-anchored URNs: the publisher domain is the serving host.
  let hostname = "";
  try { hostname = new URL(own).hostname; } catch { /* keep the URL rewrite only */ }
  if (hostname) rewritten = rewritten.split(`urn:air:${HOSTED_HOSTNAME}:`).join(`urn:air:${hostname}:`);
  return rewritten;
}

// HTML pages name the instance only in their discovery tags (canonical, OG,
// Twitter, alternate, JSON-LD). Body links stay as authored: some, such as the
// sample receipt on the front door, point at hosted fixtures that exist only
// on the hosted service and must not be redirected to a 404 on this instance.
export function advertisedHtml(html, origin) {
  if (typeof html !== "string" || isHostedOrigin(origin) || !html.includes(ROOM_ORIGIN)) return html;
  const tag = /<(?:link|meta)\b[^>]*>|<script\b[^>]*type="application\/ld\+json"[^>]*>[\s\S]*?<\/script>/gi;
  return html.replace(tag, match => (/<link\b/i.test(match.slice(0, 6)) && !/rel="(?:canonical|alternate)"/i.test(match)) ? match : advertisedText(match, origin));
}

// A card whose origin was rewritten cannot verify against the pinned project
// key, so it drops the project's signature envelope and says so explicitly,
// the same honest unsigned marking markUnsignedCard() uses in agent-discovery.
function unsignedCardBody(rewritten) {
  let card;
  try { card = JSON.parse(rewritten); } catch { return rewritten; }
  if (!card || typeof card !== "object" || Array.isArray(card)) return rewritten;
  if (!SIGNATURE_FIELDS.some(field => field in card)) return rewritten;
  for (const field of SIGNATURE_FIELDS) delete card[field];
  card.signed = false;
  card.unsignedReason = SELF_HOSTED_CARD_UNSIGNED_REASON;
  return JSON.stringify(card, null, 2) + "\n";
}

// Body of a discovery document (llms.txt, llms-full.txt, agent.json,
// agent-card.json, ...) for this instance.
export function advertisedDocumentBody(type, body, origin) {
  if (typeof body !== "string" || isHostedOrigin(origin)) return body;
  const rewritten = advertisedText(body, origin);
  return String(type).startsWith("application/json") ? unsignedCardBody(rewritten) : rewritten;
}

export function advertisedDocument(doc, origin) {
  if (!doc || isHostedOrigin(origin)) return doc;
  return Object.freeze({ type: doc.type, body: advertisedDocumentBody(doc.type, doc.body, origin) });
}

// The Agent Skills index carries the SHA-256 of the exact skill bytes it lists,
// and clients must verify it. Once the skill text names this instance, the
// digest has to cover the bytes this instance serves, so recompute it from
// the same rewritten document. `lookup(path)` returns the authored { body }.
export function advertisedSkillDigests(body, origin, lookup) {
  if (typeof body !== "string" || isHostedOrigin(origin)) return body;
  let index;
  try { index = JSON.parse(body); } catch { return body; }
  if (!index || !Array.isArray(index.skills)) return body;
  let changed = false;
  for (const skill of index.skills) {
    if (!skill || typeof skill.url !== "string" || typeof skill.digest !== "string" || !skill.digest.startsWith("sha256:")) continue;
    let doc;
    try { doc = lookup(new URL(skill.url, ROOM_ORIGIN).pathname); } catch { doc = null; }
    if (!doc || typeof doc.body !== "string") continue;
    skill.digest = `sha256:${createHash("sha256").update(advertisedText(doc.body, origin)).digest("hex")}`;
    changed = true;
  }
  return changed ? JSON.stringify(index, null, 2) + "\n" : body;
}
