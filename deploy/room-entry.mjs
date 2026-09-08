// Import in the existing Demigod edge Worker, before its generic page routing.
// Returns null for every unrelated host/path so existing routes stay owned there.
export function roomEntry(request) {
  const url = new URL(request.url);
  if (url.hostname !== "www.trydemigod.com" || !["/room", "/room/"].includes(url.pathname)) return null;
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
*{box-sizing:border-box}body{margin:0;background:#f6f5f1;color:#242621;font:18px/1.6 system-ui,sans-serif}
main{max-width:660px;margin:12vh auto;padding:32px}p{color:#565b51}h1{font-size:clamp(2.5rem,9vw,4rem);line-height:1.08;letter-spacing:-.055em;margin:24px 0}
.brand{font-size:13px;letter-spacing:.12em;text-transform:uppercase}.open{display:inline-block;margin:18px 0;padding:14px 22px;background:#263c30;color:white;border-radius:8px;text-decoration:none;font-weight:600}
a:focus-visible{outline:3px solid #447759;outline-offset:5px}.help{font-size:15px;max-width:36em}
</style></head><body><main><div class="brand">Demigod</div><h1>Project Room</h1>
<p>A shared space to talk, work together, and pick up where you left off.</p>
<a class="open" href="https://project-room-staging.getdasha.workers.dev">Open Project Room</a>
<p class="help">Use your invitation to join, or sign in with your existing access. Already joined? Open the room in the same browser to return.</p>
<p class="help">Need an invitation or help returning? Ask the room owner.</p>
</main></body></html>`;
