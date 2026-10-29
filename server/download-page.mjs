// Public /download. Honest per-platform status. No Mac app download is offered.
import { DARK_DECLARATIONS } from "../src/design-tokens.js";
import { escapeHtml } from "./html-escape.mjs";
import { publicPageCsp } from "./public-search.mjs";
import { deployedInfo, ROOM_ORIGIN, ROOM_SOURCE } from "./agent-discovery.mjs";
import { BUILD_ID, PACKAGE_VERSION, SOURCE_REVISION } from "./version.mjs";

export const RUNTIME_RELEASE_URL = "https://github.com/Uuriko/project-room/releases/latest";
export const MAC_APP_STATUS = "No public Mac app yet. Use the web app and the Node agent runtime; record desktop install as pending.";

export function downloadFacts() {
  const stamped = SOURCE_REVISION !== "unstamped" && BUILD_ID !== "unstamped";
  const deployed = deployedInfo();
  const buildDate = stamped && /^(\d{4}-\d{2}-\d{2})/.test(BUILD_ID) ? BUILD_ID.slice(0, 10) : null;
  return {
    packageVersion: PACKAGE_VERSION,
    revision: stamped ? deployed.revision : null,
    buildDate,
    buildId: stamped && !buildDate ? BUILD_ID : null,
    stamped,
  };
}

export function downloadPageHtml() {
  const facts = downloadFacts();
  const revision = facts.revision
    ? `Deployed SHA ${escapeHtml(facts.revision)}.`
    : "This build is unstamped. No deployed SHA is available.";
  const when = facts.buildDate
    ? `Built ${escapeHtml(facts.buildDate)}.`
    : facts.buildId
      ? `Build id ${escapeHtml(facts.buildId)}.`
      : "No build date is available.";
  const macReadme = `${ROOM_SOURCE}/blob/main/desktop/macos/README.md`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Download Project Room</title>
<style>
:root{color-scheme:dark;${DARK_DECLARATIONS}}
body{margin:0;background:var(--bg);color:var(--text);font:17px/1.55 var(--font-sans)}
main{max-width:40rem;margin:0 auto;padding:2rem 1.25rem 4rem}
h1{font-size:1.6rem;line-height:1.2;margin:0 0 1rem}
h2{font-size:1.1rem;margin:1.75rem 0 .4rem}
a{color:var(--blue);min-height:24px;display:inline-block;padding:.25rem 0}
p{margin:.4rem 0}
</style>
</head>
<body>
<main>
<p><a href="/">Project Room</a></p>
<h1>Download</h1>
<p>${escapeHtml(MAC_APP_STATUS)}</p>
<h2>Web</h2>
<p>Ready. <a href="${escapeHtml(ROOM_ORIGIN)}">Open the web app</a>.</p>
<h2>Node agent runtime</h2>
<p>Version ${escapeHtml(facts.packageVersion)}. ${revision} ${when} Requires Node 24.19+.</p>
<p><a href="${escapeHtml(RUNTIME_RELEASE_URL)}">Download the latest runtime</a> (project-room-runtime.tar.gz).</p>
<h2>Mac</h2>
<p>Dev build only. There is no public Mac download. The local build is ad-hoc signed and not notarized.</p>
<p><a href="${escapeHtml(macReadme)}">Mac dev build notes</a></p>
</main>
</body>
</html>
`;
}

export function downloadRoute(ctx) {
  ctx.rate(`acquisition:${ctx.remoteAddress}`, 120);
  const bytes = Buffer.from(downloadPageHtml());
  ctx.res.setHeader("X-Robots-Tag", "all");
  ctx.res.setHeader("Cache-Control", "public, max-age=60");
  ctx.res.setHeader("Content-Security-Policy", publicPageCsp(ctx.expectedOrigin()));
  ctx.res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": bytes.length });
  return ctx.res.end(ctx.req.method === "HEAD" ? undefined : bytes);
}

export const DOWNLOAD_ROUTES = Object.freeze(["GET", "HEAD"].map(method => Object.freeze({
  id: `download-${method.toLowerCase()}`,
  method,
  path: "/download",
  auth: "none",
  capability: null,
  scope: "public",
  handler: downloadRoute,
  parity: "exempt:public download status page; no MCP tool serves install status",
  publication: "open:install status page with build facts only; no member or room data is served",
  schema: { response: { type: "string" } },
  events: [],
})));
