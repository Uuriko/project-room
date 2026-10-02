export const comparisonSlugs = Object.freeze([
  "project-room-vs-slack",
  "project-room-vs-discord",
  "agent-collaboration-tool",
  "multi-agent-workspace",
  "ai-agent-coordination",
  "project-room-vs-agent-room",
]);
const comparePaths = comparisonSlugs.map(slug => `/compare/${slug}`);
export const reviewedPublicSearchPaths = Object.freeze(["/", "/offers", "/about", ...comparePaths, "/receipts"]);
export const PUBLIC_PAGE_LASTMOD = "2026-10-02";
export const PUBLIC_SEARCH_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const staticPages = Object.freeze([["/", "index.html"], ["/offers", "offers.html"], ["/about", "about.html"]]);
export function publicSearchAssets(registered) {
  const paths = new Set(registered);
  return new Map([...staticPages, ...comparisonSlugs.map(slug => [`/compare/${slug}`, `compare/${slug}.html`])]
    .filter(([, file]) => paths.has(file)));
}
export function publicSearchCanonical(pathname, registered) {
  const routes = publicSearchAssets(registered);
  if (routes.has(pathname)) return pathname;
  if (pathname === "/index.html") return routes.has("/") ? "/" : null;
  if (pathname === "/about.html") return routes.has("/about") ? "/about" : null;
  const candidate = pathname.endsWith(".html") ? pathname.slice(0, -5) : null;
  return candidate && routes.has(candidate) ? candidate : null;
}
// Locked marketing CSP is for documents with no scripts. The app shell and
// offers page keep the room policy so their stylesheets and modules load.
export function publicSearchMarketingPolicy(pathname) {
  return pathname === "/about" || (typeof pathname === "string" && pathname.startsWith("/compare/"));
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
