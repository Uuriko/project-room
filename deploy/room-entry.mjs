import { createHash } from "node:crypto";
import { discoveryDoc, ROOM_ORIGIN, COMPUTE_DOOR } from "./agent-discovery.mjs";

const DOOR_PAGES = new Set(["/room", "/room/", "/project-room", "/project-room/"]);
export const PUBLIC_DOOR_PATHS = Object.freeze(["/room", "/room/"]);
// Hash-forward only: rewrite Open/People to #room/{roomId}. No keys, no people-data.
export const ROOM_DEEP_LINK_SCRIPT = "(function(){function id(){var m=/^#room\\/([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})$/.exec(location.hash);return m&&m[1];}function handoff(href){var room=id();if(!room||!href)return href;var u=new URL(href,location.href);u.searchParams.set(\"room\",room);u.hash=\"#room/\"+room;return u.href;}function apply(){var o=document.querySelector(\"a.open\"),p=document.querySelector(\"a.people\");if(!id()||!o)return;o.setAttribute(\"href\",handoff(o.getAttribute(\"href\")));if(p)p.setAttribute(\"href\",o.getAttribute(\"href\"));}apply();addEventListener(\"hashchange\",apply);document.addEventListener(\"click\",function(e){var a=e.target.closest&&e.target.closest(\"a.open, a.people\");if(!a||!id())return;var next=handoff(a.getAttribute(\"href\"));if(next&&next!==a.href){e.preventDefault();location.assign(next);}},true);})()";
const SCRIPT_HASH = createHash("sha256").update(ROOM_DEEP_LINK_SCRIPT).digest("base64");
export const PUBLIC_DOOR_CSP = `default-src 'none'; script-src 'sha256-${SCRIPT_HASH}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
function discoveryHeaders(type) {
  return {
    "Content-Type": type, "Cache-Control": "no-store",
    "X-Robots-Tag": "all", "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  };
}
export function isPublicRoomDoorPath(pathname) {
  return PUBLIC_DOOR_PATHS.includes(pathname);
}
export function wantsPublicDoorHtml(accept) {
  const value = String(accept ?? "");
  if (/text\/html/i.test(value)) return true;
  if (/text\/plain/i.test(value)) return false;
  return true;
}
export function publicRoomDoorHtml() {
  return PUBLIC_ROOM_DOOR_HTML;
}
export function roomEntry(request) {
  const url = new URL(request.url);
  if (url.hostname !== "www.trydemigod.com") return null;
  if (DOOR_PAGES.has(url.pathname)) {
    const headers = {
      "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": PUBLIC_DOOR_CSP
    };
    if (!["GET", "HEAD"].includes(request.method)) return new Response("Method not allowed", { status: 405, headers: { ...headers, Allow: "GET, HEAD" } });
    return new Response(request.method === "HEAD" ? null : ROOM_ENTRY_HTML, { headers });
  }
  const doc = discoveryDoc(url.pathname);
  if (doc) {
    const headers = discoveryHeaders(doc.type);
    if (!["GET", "HEAD"].includes(request.method)) return new Response("Method not allowed", { status: 405, headers: { ...headers, Allow: "GET, HEAD" } });
    return new Response(request.method === "HEAD" ? null : doc.body, { headers });
  }
  return null;
}
export const ROOM_ENTRY_HTML = "PLACEHOLDER_RESTORE_FROM_973ca801";
export const PUBLIC_ROOM_DOOR_HTML = "PLACEHOLDER_RESTORE_FROM_973ca801";
