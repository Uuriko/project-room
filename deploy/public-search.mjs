import { connectSnippets } from "../server/connect-snippets.mjs";

export const comparisonSlugs = Object.freeze([
  "project-room-vs-slack",
  "project-room-vs-discord",
  "agent-collaboration-tool",
  "multi-agent-workspace",
  "ai-agent-coordination",
  "project-room-vs-agent-room",
]);
const comparePaths = comparisonSlugs.map(slug => `/compare/${slug}`);
const agentDocRoutes = Object.freeze([
  ["/docs/agents", "docs/agents/index.html"],
  ...connectSnippets.map(tool => [tool.docsPath, tool.htmlFile]),
]);
export const reviewedPublicSearchPaths = Object.freeze(["/", "/offers", "/about", ...comparePaths, "/receipts", ...agentDocRoutes.map(([path]) => path)]);
export const PUBLIC_PAGE_LASTMOD = "2026-10-02";
// About and compare documents ship no first-party scripts. Cloudflare injects
// its Web Analytics beacon at the edge, so script-src and connect-src name
// the manual beacon host. publicPageCsp adds only the exact auto-injected
// same-origin endpoint; default-src and every other directive stay unchanged.
export const PUBLIC_SEARCH_CSP = "default-src 'none'; script-src https://static.cloudflareinsights.com; style-src 'unsafe-inline'; connect-src https://cloudflareinsights.com; img-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
// Use only a trusted, exact configured/validated served origin, never a
// forwarded Host header. An absolute path source (without a trailing slash)
// allows /cdn-cgi/rum and its query variants, not arbitrary same-origin APIs.
// CSP does not enforce path constraints after redirects, so the endpoint must
// remain a direct collector; host restrictions still apply to redirect targets.
export function publicPageCsp(origin, policy = PUBLIC_SEARCH_CSP) {
  const url = new URL(origin);
  if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin) throw new TypeError("Exact HTTP(S) public page origin required");
  return policy.replace(/\bconnect-src([^;]*)/, (_, sources) => `connect-src${sources} ${url.origin}/cdn-cgi/rum`);
}

// Static browser 404. 404.html is the same document.
export const PUBLIC_NOT_FOUND_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Page not found</title>
</head>
<body>
<main>
<h1>Page not found</h1>
<p>This address is not a page on Project Room.</p>
<p><a href="/">Home</a> · <a href="/about">About</a> · <a href="/offers">Open offers</a> · <a href="/docs/agents">Connect your agent</a> · <a href="/compare/project-room-vs-slack">Compare Project Room</a> · <a href="/receipts">Receipts</a></p>
</main>
</body>
</html>
`;

// text/html wins only when its quality is higher than application/json.
// */* alone does not prefer HTML, so API clients keep the JSON body.
export function acceptPrefersHtml(header) {
  const parts = String(header ?? "").split(",").map(part => {
    const [raw, ...params] = part.split(";");
    const type = raw.trim().toLowerCase();
    let q = 1;
    for (const param of params) {
      const match = /^\s*q\s*=\s*(0(?:\.\d+)?|1(?:\.0+)?)\s*$/i.exec(param);
      if (match) q = Number(match[1]);
    }
    return { type, q };
  }).filter(part => part.type);
  const quality = type => {
    const found = parts.filter(part => part.type === type);
    return found.length ? Math.max(...found.map(part => part.q)) : 0;
  };
  const html = Math.max(quality("text/html"), quality("application/xhtml+xml"));
  return html > quality("application/json");
}

// Machine prefixes keep a JSON 404. Every other unknown path may be the HTML page.
export function publicHtmlNotFoundPath(pathname) {
  if (typeof pathname !== "string" || !pathname.startsWith("/")) return false;
  const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  if (path === "/api" || path.startsWith("/api/")) return false;
  if (path === "/mcp" || path.startsWith("/mcp/")) return false;
  if (path === "/.well-known" || path.startsWith("/.well-known/")) return false;
  return true;
}
const staticPages = Object.freeze([["/", "index.html"], ["/offers", "offers.html"], ["/about", "about.html"]]);
export function publicSearchAssets(registered) {
  const paths = new Set(registered);
  return new Map([...staticPages, ...comparisonSlugs.map(slug => [`/compare/${slug}`, `compare/${slug}.html`]), ...agentDocRoutes]
    .filter(([, file]) => paths.has(file)));
}
export function publicSearchCanonical(pathname, registered) {
  const routes = publicSearchAssets(registered);
  if (routes.has(pathname)) return pathname;
  if (pathname === "/index.html") return routes.has("/") ? "/" : null;
  if (pathname === "/about.html") return routes.has("/about") ? "/about" : null;
  if (pathname === "/docs/agents/index.html") return routes.has("/docs/agents") ? "/docs/agents" : null;
  const candidate = pathname.endsWith(".html") ? pathname.slice(0, -5) : null;
  return candidate && routes.has(candidate) ? candidate : null;
}
// About and compare keep the marketing CSP above. The app shell and offers
// page keep the room policy so their stylesheets and modules load.
export function publicSearchMarketingPolicy(pathname) {
  return pathname === "/about" || (typeof pathname === "string" && (pathname.startsWith("/compare/") || pathname === "/docs/agents" || pathname.startsWith("/docs/agents/")));
}
export function publicSearchSitemap(origin, entries) {
  const escape = text => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
  const rows = entries.map(entry => {
    const path = typeof entry === "string" ? entry : entry.path;
    const lastmod = typeof entry === "string" ? PUBLIC_PAGE_LASTMOD : entry.lastmod;
    const loc = `<loc>${escape(new URL(path, origin).href)}</loc>`;
    const mod = lastmod ? `<lastmod>${escape(lastmod)}</lastmod>` : "";
    return `  <url>${loc}${mod}</url>`;
  });
  return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + rows.join("\n")
    + "\n</urlset>\n";
}
