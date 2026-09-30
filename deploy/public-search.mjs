export const PUBLIC_SEARCH_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
// Only explicitly reviewed static marketing pages may override private defaults.
export const comparisonSlugs = Object.freeze([
  "project-room-vs-slack", "project-room-vs-discord", "agent-collaboration-tool",
  "multi-agent-workspace", "ai-agent-coordination", "project-room-vs-agent-room"
]);
export function publicSearchAssets(registered) {
  const paths = new Set(registered);
  return new Map([['/about', 'about.html'], ...comparisonSlugs.map(slug => [`/compare/${slug}`, `compare/${slug}.html`])]
    .filter(([, file]) => paths.has(file)));
}
export function publicSearchCanonical(pathname, registered) {
  const routes = publicSearchAssets(registered);
  if (routes.has(pathname)) return pathname;
  if (pathname === '/about.html') return routes.has('/about') ? '/about' : null;
  const candidate = pathname.endsWith('.html') ? pathname.slice(0, -5) : null;
  return candidate && routes.has(candidate) ? candidate : null;
}
export function publicSearchSitemap(origin, paths) {
  const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + paths.map(path => `  <url><loc>${escape(new URL(path, origin).href)}</loc></url>`).join('\n')
    + '\n</urlset>\n';
}
