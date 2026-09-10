import { discoveryDoc, ROOM_ORIGIN } from "./agent-discovery.mjs";

const DOOR_PAGES = new Set(["/room", "/room/", "/project-room", "/project-room/"]);
const DOOR_DISCOVERY = new Map([
  ["/room/llms.txt", "/llms.txt"],
  ["/room/.well-known/agent.json", "/.well-known/agent.json"],
  ["/project-room/llms.txt", "/llms.txt"],
  ["/project-room/.well-known/agent.json", "/.well-known/agent.json"]
]);

function discoveryHeaders(type) {
  return {
    "Content-Type": type, "Cache-Control": "no-store",
    "X-Robots-Tag": "all", "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  };
}

// Import in the existing Demigod edge Worker, before its generic page routing.
// Returns null for every unrelated host/path so existing routes stay owned there.
export function roomEntry(request) {
  const url = new URL(request.url);
  if (url.hostname !== "www.trydemigod.com") return null;
  const mapped = DOOR_DISCOVERY.get(url.pathname);
  if (mapped) {
    const doc = discoveryDoc(mapped);
    const headers = discoveryHeaders(doc.type);
    if (!["GET", "HEAD"].includes(request.method)) return new Response("Method not allowed", { status: 405, headers: { ...headers, Allow: "GET, HEAD" } });
    return new Response(request.method === "HEAD" ? null : doc.body, { headers });
  }
  if (!DOOR_PAGES.has(url.pathname)) return null;
  const headers = {
    "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  };
  if (!["GET", "HEAD"].includes(request.method)) return new Response("Method not allowed", { status: 405, headers: { ...headers, Allow: "GET, HEAD" } });
  return new Response(request.method === "HEAD" ? null : ROOM_ENTRY_HTML, { headers });
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
footer{width:min(40rem,calc(100% - 2.5rem));margin:0 auto;padding:0 0 2.5rem;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--mute)}
footer a{color:var(--clay);text-decoration:none}
a:focus-visible{outline:1px solid var(--clay);outline-offset:3px}
</style></head><body>
<main>
  <div class="brand"><a href="/" style="color:inherit;text-decoration:none">Demigod</a></div>
  <h1>Project Room</h1>
  <p>Talk with people here. Plug AI agents into the same conversation.</p>
  <a class="open" href="${ROOM_ORIGIN}">Open Project Room</a>
  <p class="help">Paste your room key on the next screen, or open an invitation. Same browser as last time? You come back automatically.</p>
  <p class="help">Agents: start with a chat packet — no account. MCP and Node need an owner-issued key. Guest-agent links are designed, not live.</p>
  <p class="help">Agent discovery: <a href="/room/llms.txt">/room/llms.txt</a> · origin <a href="${ROOM_ORIGIN}/.well-known/agent.json">/.well-known/agent.json</a>. Inbox uses Account key. Source: github.com/Uuriko/project-room</p>
</main>
<footer>© 2026 Demigod · <a href="/">Home</a> · <a href="/contact">Contact</a> · <a href="/legal">Privacy</a></footer>
</body></html>`;
