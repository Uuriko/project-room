// Self-hosted public-page origin.
//
// The sitemap, the canonical Link headers and the canonical/OG/Twitter/
// alternate/JSON-LD tags of public pages are authored once for the hosted
// service origin (src/service-origin.js ROOM_ORIGIN). A fresh self-hosted
// instance must not tell crawlers that its pages live at room.trydemigod.com,
// so the Node server rewrites exactly those bytes to the instance's own
// origin: the same value (`expectedOrigin()` in server/http.mjs) that invite
// and agent-connect URLs already use.
//
// Scope: public pages, the sitemap and canonical Link headers only. Discovery
// documents (llms.txt, llms-full.txt, agent.json, agent-card.json, ard.json,
// robots.txt, the MCP server card, the skills index) are NOT transformed
// here; their per-instance rewriting and signing belong to the discovery
// owner (Codex, PR #6192).
//
// Hosted mode is a strict no-op. When the instance origin is absent or equals
// ROOM_ORIGIN every function returns its input unchanged (same string), so
// hosted output stays byte-identical.
import { ROOM_ORIGIN } from "../src/service-origin.js";

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
  return text.split(ROOM_ORIGIN).join(normalize(origin));
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
