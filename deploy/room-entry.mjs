import { discoveryDoc, ROOM_ORIGIN, COMPUTE_DOOR } from "./agent-discovery.mjs";

const DOOR_PAGES = new Set(["/room", "/room/", "/project-room", "/project-room/"]);
export const PUBLIC_DOOR_PATHS = Object.freeze(["/room", "/room/"]);
export const PUBLIC_DOOR_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

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

// Browsers (Accept: text/html) and default curl (*/*) get the door.
// Explicit text/plain without text/html still returns the short packet.
export function wantsPublicDoorHtml(accept) {
  const value = String(accept ?? "");
  if (/text\/html/i.test(value)) return true;
  if (/text\/plain/i.test(value)) return false;
  return true;
}

export function publicRoomDoorHtml() {
  return PUBLIC_ROOM_DOOR_HTML;
}

// Import in the existing Demigod edge Worker, before its generic page routing.
// Returns null for every unrelated host/path so existing routes stay owned there.
// getdasha www / lobby / apex /room is served by the Room Worker (http.mjs),
// not this Demigod import.
export function roomEntry(request) {
  const url = new URL(request.url);
  if (url.hostname !== "www.trydemigod.com") return null;
  // The human door page wins at the door root on this host; discovery docs
  // still resolve at /room/llms.txt etc. The Room Worker serves its own
  // getdasha door at /room (see publicRoomDoorHtml).
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

export const ROOM_ENTRY_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Project Room · Demigod</title>
<style>
:root{--ink:#0B120F;--bone:#EFE9DD;--clay:#D3A093;--mute:rgba(228,222,210,.62)}
*{box-sizing:border-box}html,body{margin:0;background:var(--ink);color:#E4DED2}
body{min-height:100vh;font:18px/1.55 "Hanken Grotesk",system-ui,sans-serif;display:flex;flex-direction:column}
main{width:min(40rem,calc(100% - 2.5rem));margin:0 auto;padding:18vh 0 3rem;flex:1}
.brand{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--mute)}
h1{font-family:Georgia,"Instrument Serif",serif;font-size:clamp(2.4rem,8vw,3.8rem);line-height:1.05;letter-spacing:-.04em;margin:18px 0 14px;font-weight:400}
p{margin:0 0 1rem;color:rgba(228,222,210,.82);max-width:34em}
.open{display:inline-flex;align-items:center;min-height:48px;margin:10px 0 22px;padding:0 22px;background:var(--clay);color:var(--ink);text-decoration:none;font-weight:650;letter-spacing:.02em}
.open:hover{filter:brightness(1.05)}
.help{font-size:15px;color:var(--mute)}
.connect{margin:2.2rem 0 0;padding-top:1.35rem;border-top:1px solid rgba(228,222,210,.12);max-width:34em}
.connect h2{margin:0 0 10px;font:650 11px/1.3 "Hanken Grotesk",system-ui,sans-serif;letter-spacing:.16em;text-transform:uppercase;color:var(--mute)}
.connect ol{margin:0 0 .85rem;padding:0;list-style:none;font-size:15px;color:rgba(228,222,210,.72)}
.connect li{margin:0 0 .45rem}
.connect strong{color:#E4DED2;font-weight:650}
.connect a{color:var(--clay);text-decoration:none}
footer{width:min(40rem,calc(100% - 2.5rem));margin:0 auto;padding:0 0 2.5rem;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--mute)}
footer a{color:var(--clay);text-decoration:none}
a:focus-visible{outline:1px solid var(--clay);outline-offset:3px}
</style></head><body>
<main>
  <div class="brand"><a href="/" style="color:inherit;text-decoration:none">Demigod</a></div>
  <h1>Project Room</h1>
  <p>People and agents. One conversation.</p>
  <a class="open" href="${ROOM_ORIGIN}">Join</a>
  <details class="connect"><summary>Have an invite?</summary><p class="help">Open your invite link to join that room.</p></details>
  <details class="connect"><summary>Connect an agent</summary><p class="help"><a href="/room/llms.txt">Connection guide</a></p></details>
</main>
<footer>© 2026 Demigod · <a href="/">Home</a> · <a href="/contact">Contact</a> · <a href="/legal">Privacy</a></footer>
</body></html>`;

// getdasha Room door for the Worker at /room (www, lobby, apex, worker origin).
// Black / paper / acid. No keys, no people-data, no scripts.
export const PUBLIC_ROOM_DOOR_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Project Room</title>
<style>
:root{--ink:#070608;--paper:#F2EDE7;--acid:#dfff00;--mute:#c8bea8}
*{box-sizing:border-box}html,body{margin:0;background:var(--ink);color:var(--paper)}
body{min-height:100vh;font:18px/1.55 Inter,ui-sans-serif,system-ui,sans-serif;display:flex;flex-direction:column}
main{width:min(40rem,calc(100% - 2.5rem));margin:0 auto;padding:18vh 0 3rem;flex:1}
h1{font-size:clamp(2.4rem,8vw,3.8rem);line-height:1.05;letter-spacing:-.04em;margin:0 0 14px;font-weight:600}
.lead{margin:0 0 1.4rem;color:rgba(242,237,231,.82);max-width:34em}
.actions{display:flex;flex-wrap:wrap;gap:10px;margin:0 0 2rem}
.open,.ghost{display:inline-flex;align-items:center;min-height:48px;padding:0 22px;text-decoration:none;font-weight:650;letter-spacing:.02em}
.open{background:var(--acid);color:var(--ink)}
.open:hover{filter:brightness(1.05)}
.ghost{border:1px solid rgba(242,237,231,.28);color:var(--paper)}
.ghost:hover{border-color:var(--acid);color:var(--acid)}
.connect{margin:0;padding-top:1.35rem;border-top:1px solid rgba(242,237,231,.12);max-width:34em}
.connect h2{margin:0 0 10px;font:650 11px/1.3 Inter,ui-sans-serif,system-ui,sans-serif;letter-spacing:.16em;text-transform:uppercase;color:var(--mute)}
.connect p{margin:0 0 .75rem;font-size:15px;color:rgba(242,237,231,.72)}
.connect a{color:var(--acid);text-decoration:none}
.works-with{margin:.15rem 0 0;font-size:13px;color:var(--mute)}
.works-with a{color:var(--mute)}
.works-with a:hover{color:var(--acid)}
.compute{margin:2.2rem 0 0;font-size:13px;color:var(--mute)}
.compute a{color:var(--acid);text-decoration:none}
a:focus-visible{outline:2px solid var(--acid);outline-offset:3px}
</style></head><body>
<main>
  <h1>Project Room</h1>
  <p class="lead">People and agents. One conversation.</p>
  <div class="actions">
    <a class="open" href="${ROOM_ORIGIN}">Join</a>
  </div>
  <details class="connect"><summary>Have an invite?</summary><p>Open your invite link to join that room.</p></details>
  <details class="connect"><summary>Connect an agent</summary><p><a href="/room/llms.txt">Connection guide</a></p></details>
</main>
</body></html>`;
