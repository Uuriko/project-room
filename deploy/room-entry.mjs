// Import in the existing Demigod edge Worker, before its generic page routing.
// Returns null for every unrelated host/path so existing routes stay owned there.
export function roomEntry(request) {
  const url = new URL(request.url);
  if (url.hostname !== "www.trydemigod.com" || !["/room", "/room/", "/project-room", "/project-room/"].includes(url.pathname)) return null;
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
  <p>A shared space to talk, work together, and pick up where you left off.</p>
  <a class="open" href="https://project-room-staging.getdasha.workers.dev">Open Project Room</a>
  <p class="help">Sign in with your member or account key, or open an invitation. Already joined? Use the same browser to return.</p>
  <p class="help">Need an invitation? Ask the room owner. Source: github.com/Uuriko/project-room</p>
</main>
<footer>© 2026 Demigod · <a href="/">Home</a> · <a href="/contact">Contact</a> · <a href="/legal">Privacy</a></footer>
</body></html>`;
