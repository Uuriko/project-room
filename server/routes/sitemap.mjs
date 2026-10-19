// Sitemap family (PERF2-SITEMAP, C-2; batch RT route rows).
//
// /sitemap.xml is a sitemap INDEX. The core child keeps every non-receipt
// entry the old single urlset carried (asset pages, /receipts, legal,
// templates, agents, room pages); receipt URLs live in paged children,
// /sitemap-receipts-<n>.xml, so the set is complete by construction — the
// old handler's read silently clamped at 1,000 receipts (9,000 of 10,000
// missing at the PERF2-MEASURE S1 shape) and its room walk cost one SQL
// statement per room. A page past the end is an explicit 404. The GR1
// /room-prefixed aliases are rows of their own: dispatch runs before the
// GR1 rewrite in server/http.mjs, and the legacy allowlist only shrinks,
// so new routes land here, never inline.
import { EDGE_DOOR_HOSTS, ROOM_ORIGIN } from "../agent-discovery.mjs";
import { LEGAL_SITEMAP_PATHS } from "../legal-pages.mjs";
import { publicAssetPaths } from "../public-assets.mjs";
import { RECEIPT_SITEMAP_PAGE_SIZE } from "../public-read-model.mjs";
import { publicSitemapEntries } from "../public-rooms.mjs";
import {
  PUBLIC_PAGE_LASTMOD,
  publicSearchAssets,
  publicSearchSitemap,
  publicSearchSitemapIndex,
  reviewedPublicSearchPaths,
} from "../public-search.mjs";
import { countPublicReceiptSitemap, listPublicReceiptSitemap } from "../receipts-live.mjs";

// The Link header the legacy sitemap carried (RFC 8288 discovery hints +
// canonical), reproduced from server/http.mjs's publicPageLinks — the
// canonical target is always the unprefixed path, as the GR1 rewrite made
// it before.
const discoveryLinks = url => {
  const base = url.origin === ROOM_ORIGIN || EDGE_DOOR_HOSTS.includes(url.hostname) ? ROOM_ORIGIN : "";
  return [
    `<${base}/.well-known/agent-card.json>; rel="alternate"; type="application/json"`,
    `<${base}/llms.txt>; rel="help"`,
    `<${base}/skills>; rel="describedby"`,
    `<${base}/room>; rel="alternate"; type="text/html"`,
  ].join(", ");
};
const pageLinks = (url, pathname) => `${discoveryLinks(url)}, <${ROOM_ORIGIN}${pathname}>; rel="canonical"`;

function sendSitemap(ctx, canonicalPath, xml) {
  const { req, res, url } = ctx;
  if (!url.search) res.setHeader("X-Robots-Tag", "all");
  res.setHeader("Link", pageLinks(url, canonicalPath));
  res.writeHead(200, { "Content-Type": "application/xml; charset=utf-8" });
  return res.end(req.method === "HEAD" ? undefined : xml);
}

function receiptPageCount(store) {
  return Math.ceil(countPublicReceiptSitemap(store) / RECEIPT_SITEMAP_PAGE_SIZE);
}

async function sitemapIndex(ctx) {
  const pages = receiptPageCount(ctx.store);
  const entries = [{ path: "/sitemap-core.xml" }];
  for (let page = 1; page <= pages; page++) entries.push({ path: `/sitemap-receipts-${page}.xml` });
  return sendSitemap(ctx, "/sitemap.xml", publicSearchSitemapIndex(ROOM_ORIGIN, entries));
}

async function sitemapCore(ctx) {
  // Confirm bytes exist before advertising an asset-backed canonical URL.
  const candidates = [...publicSearchAssets(publicAssetPaths)]
    .filter(([path]) => reviewedPublicSearchPaths.includes(path));
  // Independent immutable assets need no serial I/O round trips. Keep
  // catalog order and use the same loader as page serving; a failed
  // read still excludes the page rather than poisoning the whole map.
  const availability = await Promise.allSettled(candidates.map(async ([, file]) => ctx.loadAsset(file)));
  const available = candidates.filter((_, i) => availability[i].status === "fulfilled")
    .map(([path]) => path);
  const xml = publicSearchSitemap(ROOM_ORIGIN, [
    ...available.map(path => ({ path, lastmod: PUBLIC_PAGE_LASTMOD })),
    { path: "/receipts", lastmod: PUBLIC_PAGE_LASTMOD },
    ...LEGAL_SITEMAP_PATHS.map(path => ({ path, lastmod: PUBLIC_PAGE_LASTMOD })),
    ...publicSitemapEntries(ctx.store), // GR2 templates, agents, and opted-in room pages
  ]);
  return sendSitemap(ctx, "/sitemap-core.xml", xml);
}

async function sitemapReceiptsPage(ctx) {
  const raw = ctx.params.page;
  const page = Number(raw);
  if (!Number.isInteger(page) || page < 1 || String(page) !== raw) {
    return ctx.reject(404, "not_found", "Not found");
  }
  if (page > receiptPageCount(ctx.store)) {
    return ctx.reject(404, "not_found", "Not found");
  }
  const entries = listPublicReceiptSitemap(ctx.store, {
    limit: RECEIPT_SITEMAP_PAGE_SIZE,
    offset: (page - 1) * RECEIPT_SITEMAP_PAGE_SIZE,
  }).map(item => ({ path: item.path, lastmod: item.lastmod || PUBLIC_PAGE_LASTMOD }));
  return sendSitemap(ctx, `/sitemap-receipts-${page}.xml`, publicSearchSitemap(ROOM_ORIGIN, entries));
}

const SITEMAP_DOCS = [
  { name: "index", path: "/sitemap.xml", handler: sitemapIndex },
  { name: "core", path: "/sitemap-core.xml", handler: sitemapCore },
  { name: "receipts", path: "/sitemap-receipts-{page}.xml", handler: sitemapReceiptsPage },
];

export const SITEMAP_ROUTES = Object.freeze(["", "/room"].flatMap(prefix =>
  SITEMAP_DOCS.flatMap(doc => ["GET", "HEAD"].map(method => Object.freeze({
    id: `sitemap-${doc.name}${prefix ? "-room" : ""}-${method.toLowerCase()}`,
    method,
    path: `${prefix}${doc.path}`,
    auth: "none",
    capability: null,
    scope: "public",
    handler: doc.handler,
    parity: "exempt:crawler furniture; no MCP tool serves sitemap documents",
    schema: { response: { type: "string" } },
    events: [],
  })))));
