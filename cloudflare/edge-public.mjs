// Static assets and discovery documents answered by the Worker isolate.
// They must not enter the invite-only-pilot Durable Object: that object is
// single-threaded, and a cold wake or a synchronous stretch closes its input
// gate for every route that shares it. Asset bytes are cached for the life
// of this isolate; a deploy starts a new one.
import { publicAssetPaths } from '../deploy/public-assets.mjs';
import { publicSearchAssets, publicSearchCanonical, publicSearchMarketingPolicy, PUBLIC_SEARCH_CSP, reviewedPublicSearchPaths } from '../deploy/public-search.mjs';
import { discoveryDoc, EDGE_DOOR_HOSTS, ROOM_ORIGIN, SKILLS_CATALOG_PATH } from '../deploy/agent-discovery.mjs';
import { buildOpenApiJson } from '../server/discoverability.mjs';
import { MCP_SERVER_CARD_PATH, MCP_DISCOVERY_CACHE_CONTROL, MCP_SERVER_CARD_CORS } from '../src/mcp-server-card.mjs';

const APP_CSP = "default-src 'none'; script-src 'self' https://static.cloudflareinsights.com; style-src 'self'; connect-src 'self' https://cloudflareinsights.com; img-src 'self'; manifest-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const ASSET_CACHE_MAX = 96;
const assetCache = new Map();
let openApiCache = null;

const assetType = path => path.endsWith('.js') ? 'text/javascript'
  : path.endsWith('.css') ? 'text/css'
  : path.endsWith('.html') ? 'text/html'
  : path.endsWith('.png') ? 'image/png'
  : path.endsWith('.svg') ? 'image/svg+xml'
  : 'text/markdown; charset=utf-8';

const assets = new Map([
  ['/', ['index.html', 'text/html']],
  ['/offers', ['offers.html', 'text/html']],
  ...publicAssetPaths.map(path => [`/${path}`, [path, assetType(path)]])
]);
for (const [url, file] of publicSearchAssets(publicAssetPaths)) assets.set(url, [file, 'text/html']);
// DX-1a begin: scripts/install.sh is the installer. Its public URL is /install.sh.
assets.set('/install.sh', ['scripts/install.sh', 'text/plain']);
// DX-1a end

const skillsDoc = discoveryDoc(SKILLS_CATALOG_PATH);

function discoveryLinks(url) {
  const base = url.origin === ROOM_ORIGIN || EDGE_DOOR_HOSTS.includes(url.hostname) ? ROOM_ORIGIN : '';
  return [
    `<${base}/.well-known/agent-card.json>; rel="alternate"; type="application/json"`,
    `<${base}/llms.txt>; rel="help"`,
    `<${base}/skills>; rel="describedby"`,
    `<${base}/room>; rel="alternate"; type="text/html"`
  ].join(', ');
}

function baseHeaders(url) {
  const headers = new Headers();
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Robots-Tag', 'noindex, nofollow');
  if (url.protocol === 'https:') headers.set('Strict-Transport-Security', 'max-age=31536000');
  headers.set('Content-Security-Policy', APP_CSP);
  return headers;
}

function methodNotAllowed(headers, allow) {
  headers.set('Allow', allow);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  const body = JSON.stringify({ error: { code: 'method_not_allowed', message: 'Method not allowed' } });
  headers.set('Content-Length', String(body.length));
  return new Response(body, { status: 405, headers });
}

// `asset` is a file served from env.ASSETS. `discovery` and `openapi` are
// generated documents with no per-caller data. The skills catalog is not
// here: the Durable Object injects the live member layer.
// GR1: www.getdasha.com/room/<page> keeps the prefix through the worker rewrite.
// The same packaged document is served, with a canonical Link on the room host.
function roomMarketingPath(pathname) {
  if (!pathname.startsWith('/room/')) return null;
  const rest = pathname.slice('/room'.length);
  // /room/ is the public door, not the app shell.
  if (rest === '/' || rest === '') return null;
  return assets.has(rest) ? rest : null;
}

export function classifyEdgePath(pathname) {
  if (pathname === '/openapi.json' || pathname === '/room/openapi.json') return 'openapi';
  const doc = discoveryDoc(pathname);
  if (doc && doc !== skillsDoc) return 'discovery';
  if (assets.has(pathname) || roomMarketingPath(pathname)) return 'asset';
  return null;
}

async function loadCachedAsset(env, file) {
  const cached = assetCache.get(file);
  if (cached) {
    assetCache.delete(file);
    assetCache.set(file, cached);
    return cached;
  }
  if (!env?.ASSETS || typeof env.ASSETS.fetch !== 'function' || !env.ROOM_ORIGIN) return null;
  const response = await env.ASSETS.fetch(new Request(new URL('/' + file, env.ROOM_ORIGIN)));
  if (!response.ok) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  assetCache.set(file, bytes);
  while (assetCache.size > ASSET_CACHE_MAX) assetCache.delete(assetCache.keys().next().value);
  return bytes;
}

function openApiBody(origin) {
  if (!openApiCache || openApiCache.origin !== origin) {
    openApiCache = { origin, body: JSON.stringify(buildOpenApiJson({ origin })) };
  }
  return openApiCache.body;
}

function openApiResponse(request, url) {
  const headers = baseHeaders(url);
  if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed(headers, 'GET, HEAD');
  const bytes = new TextEncoder().encode(openApiBody(url.origin));
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Content-Length', String(bytes.byteLength));
  return new Response(request.method === 'HEAD' ? null : bytes, { status: 200, headers });
}

function discoveryResponse(request, url) {
  const doc = discoveryDoc(url.pathname);
  const headers = baseHeaders(url);
  headers.set('X-Robots-Tag', 'all');
  headers.set('Link', discoveryLinks(url));
  const card = doc === discoveryDoc(MCP_SERVER_CARD_PATH);
  if (card) {
    headers.set('Cache-Control', MCP_DISCOVERY_CACHE_CONTROL);
    for (const [name, value] of Object.entries(MCP_SERVER_CARD_CORS)) headers.set(name, value);
  }
  const allow = card ? 'GET, HEAD, OPTIONS' : 'GET, HEAD';
  if (request.method === 'OPTIONS' && card) {
    headers.set('Allow', allow);
    return new Response(null, { status: 204, headers });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed(headers, allow);
  let body;
  try { body = doc.body; }
  catch { return null; }
  const bytes = new TextEncoder().encode(body);
  headers.set('Content-Type', doc.type);
  headers.set('Content-Length', String(bytes.byteLength));
  return new Response(request.method === 'HEAD' ? null : bytes, { status: 200, headers });
}

async function assetResponse(request, env, url) {
  const headers = baseHeaders(url);
  const servedPath = roomMarketingPath(url.pathname) ?? url.pathname;
  const canonical = publicSearchCanonical(servedPath, publicAssetPaths);
  const canonicalTarget = canonical && reviewedPublicSearchPaths.includes(canonical) ? canonical : null;
  headers.set('Link', canonicalTarget ? `${discoveryLinks(url)}, <${ROOM_ORIGIN}${canonicalTarget}>; rel="canonical"` : discoveryLinks(url));
  // About and compare pages have no scripts. The app shell and offers page keep
  // the room policy from baseHeaders so their modules load.
  if (canonical && publicSearchMarketingPolicy(canonical)) headers.set('Content-Security-Policy', PUBLIC_SEARCH_CSP);
  if (canonical && !url.search && canonical !== servedPath) {
    headers.set('Location', canonical);
    return new Response(null, { status: 301, headers });
  }
  if (canonical && !url.search && reviewedPublicSearchPaths.includes(canonical)) headers.set('X-Robots-Tag', 'all');
  const [file, type] = assets.get(servedPath);
  const bytes = await loadCachedAsset(env, file);
  if (!bytes) {
    // A reviewed page with no packaged bytes is an error, not a public
    // document. Do not leave the indexable robots tag that a present page
    // would have set above.
    headers.set('X-Robots-Tag', 'noindex, nofollow');
    headers.set('Content-Type', 'text/plain; charset=utf-8');
    return new Response(request.method === 'HEAD' ? null : 'Not found\n', { status: 404, headers });
  }
  const contentType = type.startsWith('image/') && !type.includes('svg') ? type : (type.includes('charset') ? type : `${type}; charset=utf-8`);
  headers.set('Content-Type', contentType);
  headers.set('Content-Length', String(bytes.byteLength));
  return new Response(request.method === 'HEAD' ? null : bytes, { status: 200, headers });
}

// Response for a path that must not enter the Durable Object, or null when
// the request still belongs to the object (health, API, skills members).
export async function edgePublicResponse(request, env, url) {
  const kind = classifyEdgePath(url.pathname);
  if (!kind) return null;
  if (kind === 'openapi') return openApiResponse(request, url);
  if (kind === 'discovery') return discoveryResponse(request, url);
  if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed(baseHeaders(url), 'GET, HEAD');
  return assetResponse(request, env, url);
}
