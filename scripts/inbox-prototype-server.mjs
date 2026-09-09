// Standalone, loopback-only design preview. Not routed by the production server.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const assets = new Map([["/", ["index.html", "text/html"]], ["/style.css", ["style.css", "text/css"]],
  ["/app.mjs", ["app.mjs", "text/javascript"]], ["/model.mjs", ["model.mjs", "text/javascript"]]]);
export function createInboxPrototypeServer() {
  return createServer(async (req, res) => {
    const asset = assets.get(req.url?.split("?")[0]);
    if (req.method !== "GET" || !asset) { res.writeHead(404); res.end(); return; }
    try {
      const body = await readFile(new URL("inbox-prototype/" + asset[0], import.meta.url));
      res.writeHead(200, { "Content-Type": asset[1] + "; charset=utf-8", "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'self'; connect-src 'none'; img-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
        "X-Content-Type-Options": "nosniff" }); res.end(body);
    } catch { res.writeHead(500); res.end("Preview unavailable"); }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = createInboxPrototypeServer();
  server.listen(0, "127.0.0.1", () => console.log("Design preview: http://127.0.0.1:" + server.address().port));
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { server.closeAllConnections(); server.close(); });
}
