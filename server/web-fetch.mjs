// Room-side web fetch (RC-2026-09-23-102): a clean-room, dependency-free
// scrape-style API for rooms. One POST returns markdown and/or deterministic
// highlights for a public web page, with Context.dev-style mechanics stolen
// deliberately: one fetch covers every requested format, per-URL cache keys
// with maxAgeMs freshness semantics, cache_metadata {status, age_ms},
// deterministic (no-LLM) query highlights, and typed failures that never
// bill as 500s.
//
// Deliberately NOT stolen: screenshots, product extraction, the /answers
// research loop, PDF OCR — all need a browser fleet, an LLM, or binary
// parsers this zero-dependency server module must not grow.
//
// Security: this is the room's biggest new outbound surface, so SSRF is the
// design center. Every hop (initial URL + each redirect) is validated:
// http/https only, no userinfo, ports 80/443 only, the host is DNS-resolved
// and every resolved IP is checked against private/loopback/link-local/
// multicast/reserved/CGNAT ranges. The node:dns pre-check is statically
// imported (same as server/outbound-webhooks.mjs; the Worker build uses
// nodejs_compat, so DNS resolution is available there too).
//
// Auth is owner + full members only; the HTTP layer applies the #798 guest
// gate (403 guest_scope_denied) right after authentication. There is no
// drafts-only member tier in the room data model, so "full member" here
// means an active member whose role is not guest; both ga1. guest-agents
// and human share-link guests (role === "guest") are denied.
//
// Storage is purely additive (web_fetch_cache + web_fetch_log, IF NOT
// EXISTS, no schema version bump), following the wake-queue / heartbeat /
// guest-invite additive pattern. Fetches are journaled per-request (host,
// cache hit/miss, bytes, tags, request_id) — full page content is never
// journaled. Rate limits (100/day/member, 1000/day/room) count successful
// journaled fetches (hit/miss); typed failures are journaled but never
// billed. Cache hits still cost quota, exactly like a credit model.
import { createHash, randomUUID } from "node:crypto";
import { promises as dns } from "node:dns";
import { isGuestAgentMemberId } from "./guest-agent-links.mjs";

export class WebFetchError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}
const fail = (status, code, message, extra) => { throw new WebFetchError(status, code, message, extra); };

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------
export const WEB_FETCH_MAX_BODY_BYTES = 2 * 1024 * 1024;
export const WEB_FETCH_TIMEOUT_MS = 15_000;
export const WEB_FETCH_MAX_REDIRECTS = 5;
export const WEB_FETCH_DEFAULT_MAX_AGE_MS = 86_400_000; // 24h, Context's default
export const WEB_FETCH_MAX_MAX_AGE_MS = 2_592_000_000; // 30d
export const WEB_FETCH_RATE_PER_MEMBER_PER_DAY = 100;
export const WEB_FETCH_RATE_PER_ROOM_PER_DAY = 1000;
export const WEB_FETCH_RATE_WINDOW_MS = 86_400_000;
export const WEB_FETCH_UA = "project-room-web-fetch/1.0 (+room-side research fetch)";
export const WEB_FETCH_HIGHLIGHT_PASSAGES_DEFAULT = 5;
export const WEB_FETCH_HIGHLIGHT_PASSAGES_MAX = 20;
export const WEB_FETCH_HIGHLIGHT_PASSAGE_CHARS = 1500;
export const WEB_FETCH_MAX_TAGS = 20;
export const WEB_FETCH_TAG_CHARS = 64;

// Env-gated loopback allowance for tests (in-process HTTP servers). Strict by
// default: production never sets this. Only the loopback ranges are allowed —
// every other private/reserved range stays blocked, so redirect-to-private
// tests remain meaningful. Guarded for Workers (no process).
const allowLoopback = () => typeof process !== "undefined"
  && process?.env?.WEB_FETCH_ALLOW_LOOPBACK === "1";

export const webFetchSchema = `
  CREATE TABLE IF NOT EXISTS web_fetch_cache (
    key TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    final_url TEXT NOT NULL,
    markdown TEXT NOT NULL,
    metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
    bytes INTEGER NOT NULL CHECK(bytes >= 0),
    fetched_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS web_fetch_log (
    request_id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    member_id TEXT NOT NULL,
    credential_hash TEXT,
    host TEXT NOT NULL,
    cache_status TEXT NOT NULL CHECK(cache_status IN ('hit','miss','error')),
    bytes INTEGER NOT NULL CHECK(bytes >= 0),
    tags_json TEXT NOT NULL CHECK(json_valid(tags_json)),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS web_fetch_log_room_time ON web_fetch_log(room_id, created_at);
  CREATE INDEX IF NOT EXISTS web_fetch_log_member_time ON web_fetch_log(room_id, member_id, created_at);
  CREATE INDEX IF NOT EXISTS web_fetch_log_key_time ON web_fetch_log(credential_hash, created_at);
`;

// Additive column convergence for databases created before credential_hash
// existed: old rows backfill NULL and read as { credentialHash: null }.
// (Same pattern as migrateSpamQuarantineColumns.)
export function migrateWebFetchLogColumns(db) {
  const columns = new Set(db.prepare("PRAGMA table_info(web_fetch_log)").all().map(c => c.name));
  if (!columns.has("credential_hash")) db.exec("ALTER TABLE web_fetch_log ADD COLUMN credential_hash TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS web_fetch_log_key_time ON web_fetch_log(credential_hash, created_at)");
}

// ---------------------------------------------------------------------------
// URL validation + normalization (invalid_url)
// ---------------------------------------------------------------------------
export function normalizeUrl(raw) {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 2048)
    fail(400, "invalid_url", "url must be a non-empty string up to 2048 characters");
  let url;
  try { url = new URL(raw.trim()); }
  catch { fail(400, "invalid_url", "url is not parseable"); }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    fail(400, "invalid_url", "Only http and https URLs can be fetched");
  if (url.username || url.password)
    fail(400, "invalid_url", "URLs with credentials are not fetchable");
  if (!url.hostname)
    fail(400, "invalid_url", "URL must have a host");
  const defaultPort = url.protocol === "http:" ? "80" : "443";
  // The test-only loopback allowance also opens arbitrary loopback ports so
  // in-process HTTP servers on random ports can be exercised; production
  // stays on 80/443 only.
  const loopbackPortOk = allowLoopback()
    && (url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1");
  if (url.port && url.port !== defaultPort && !loopbackPortOk)
    fail(400, "invalid_url", "Only ports 80 and 443 can be fetched");
  if (!loopbackPortOk) url.port = "";
  url.hash = "";
  return url.href;
}

// ---------------------------------------------------------------------------
// SSRF: IP parsing + blocked ranges (blocked_host)
// ---------------------------------------------------------------------------
function parseIpv4(host) {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const v = Number(part);
    if (v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

// Parse IPv6 (with :: compression and embedded IPv4) into a 128-bit BigInt.
function parseIpv6(host) {
  let h = host;
  // IPv4-mapped tail: ::ffff:1.2.3.4
  let tail = null;
  const lastColon = h.lastIndexOf(":");
  if (lastColon !== -1 && h.slice(lastColon + 1).includes(".")) {
    const v4 = parseIpv4(h.slice(lastColon + 1));
    if (v4 === null) return null;
    tail = [(v4 >>> 16) & 0xffff, v4 & 0xffff];
    h = h.slice(0, lastColon + 1) + "0:0";
  }
  const halves = h.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && left.length !== 8) return null;
  if (left.length + right.length > 8) return null;
  const groups = [...left, ...new Array(8 - left.length - right.length).fill("0"), ...right];
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  if (tail) n = (n & ~0xffffn) | BigInt(tail[0]) << 16n | BigInt(tail[1]);
  return n;
}

const IPV4_BLOCKS = [
  [0x00000000, 8], // 0.0.0.0/8 "this network"
  [0x0a000000, 8], // 10.0.0.0/8 private
  [0x64400000, 10], // 100.64.0.0/10 CGNAT
  [0x7f000000, 8], // 127.0.0.0/8 loopback
  [0xa9fe0000, 16], // 169.254.0.0/16 link-local
  [0xac100000, 12], // 172.16.0.0/12 private
  [0xc0a80000, 16], // 192.168.0.0/16 private
  [0xc0000200, 24], // 192.0.2.0/24 documentation (TEST-NET-1)
  [0xc6336400, 24], // 198.51.100.0/24 documentation (TEST-NET-2)
  [0xcb007100, 24], // 203.0.113.0/24 documentation (TEST-NET-3)
  [0xe0000000, 4], // 224.0.0.0/4 multicast
  [0xf0000000, 4], // 240.0.0.0/4 reserved
];
const IPV6_BLOCKS = [
  [0n, 128], // ::/128 unspecified
  [1n, 128], // ::1/128 loopback
  [0xfe800000000000000000000000000000n, 10], // fe80::/10 link-local
  [0xfc000000000000000000000000000000n, 7], // fc00::/7 unique local
  [0xff000000000000000000000000000000n, 8], // ff00::/8 multicast
  [0x20010db8000000000000000000000000n, 32], // 2001:db8::/32 documentation
];
const ipv4In = (ip, [base, bits]) => (ip >>> (32 - bits)) === (base >>> (32 - bits));
const ipv6In = (ip, [base, bits]) => (ip >> BigInt(128 - bits)) === (base >> BigInt(128 - bits));

// True when a literal IP string is in a blocked range. Non-IP hostnames
// return false here — they go through DNS resolution instead.
export function ipLiteralBlocked(host) {
  const v4 = parseIpv4(host);
  if (v4 !== null) {
    // The test-only loopback allowance opens 127/8 and ::1; every other
    // private/reserved range stays blocked under it.
    if (allowLoopback() && ipv4In(v4, [0x7f000000, 8])) return false;
    return IPV4_BLOCKS.some(block => ipv4In(v4, block));
  }
  // Strip brackets if a caller passes [::1].
  const v6 = parseIpv6(host.replace(/^\[|\]$/g, ""));
  if (v6 !== null) {
    if (allowLoopback() && v6 === 1n) return false; // ::1
    // IPv4-mapped IPv6 (::ffff:10.0.0.1) inherits the IPv4 verdict.
    if ((v6 >> 32n) === 0xffffn) {
      const mapped = Number(v6 & 0xffffffffn);
      if (allowLoopback() && ipv4In(mapped, [0x7f000000, 8])) return false;
      return IPV4_BLOCKS.some(block => ipv4In(mapped, block));
    }
    return IPV6_BLOCKS.some(block => ipv6In(v6, block));
  }
  return false;
}

// Resolve the host and reject when every path leads somewhere private.
// Returns the resolved address list (empty when the name was a literal IP).
// node:dns is statically imported like server/outbound-webhooks.mjs — the
// Worker build runs with nodejs_compat, so DNS is available there too.
export async function assertPublicHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (ipLiteralBlocked(host))
    fail(403, "blocked_host", "Refusing to fetch a private, loopback, or otherwise reserved address");
  const addresses = new Set();
  for (const fn of ["resolve4", "resolve6"]) {
    try { for (const ip of await dns[fn](host)) addresses.add(ip); } catch { /* NXDOMAIN etc: fetch reports it */ }
  }
  for (const ip of addresses) {
    if (ipLiteralBlocked(ip))
      fail(403, "blocked_host", "Refusing to fetch a host that resolves to a private, loopback, or otherwise reserved address");
  }
  // Unresolvable here usually means NXDOMAIN; the fetch itself then produces
  // the typed failure, so DNS quirks never become 500s either way.
  return [...addresses];
}

// Full per-hop SSRF validation: scheme/credentials/port plus host checks.
export async function assertFetchableUrl(href) {
  const normalized = normalizeUrl(href);
  const { hostname } = new URL(normalized);
  await assertPublicHost(hostname);
  return normalized;
}

// ---------------------------------------------------------------------------
// Fetch pipeline: manual redirects with per-hop SSRF re-validation,
// 2MB body cap, 15s total timeout, HTML-only.
// ---------------------------------------------------------------------------
async function readCapped(body, limit) {
  const reader = body.getReader();
  const chunks = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > limit) {
      try { await reader.cancel(); } catch { /* ignore */ }
      fail(502, "fetch_failed", `Response body exceeds the ${limit} byte fetch limit`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

function decodeBody(bytes, contentType) {
  const charset = /charset=([^;]+)/i.exec(contentType || "")?.[1]?.trim().toLowerCase();
  if (charset && charset !== "utf-8" && charset !== "utf8") {
    try { return new TextDecoder(charset, { fatal: false }).decode(bytes); } catch { /* fall through */ }
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

const HTML_CONTENT = /text\/html|application\/xhtml\+xml/i;

export async function fetchPage(startUrl) {
  const signal = AbortSignal.timeout(WEB_FETCH_TIMEOUT_MS);
  let current = await assertFetchableUrl(startUrl);
  const seen = new Set([current]);
  for (let hop = 0; hop <= WEB_FETCH_MAX_REDIRECTS; hop++) {
    let res;
    try {
      res = await fetch(current, {
        redirect: "manual",
        signal,
        headers: { "User-Agent": WEB_FETCH_UA, "Accept": "text/html,application/xhtml+xml" },
      });
    } catch (error) {
      if (error?.name === "TimeoutError" || signal.aborted)
        fail(504, "timeout", "Fetching the page exceeded the 15 second limit");
      fail(502, "fetch_failed", "Could not fetch the page");
    }
    const status = res.status;
    if (status >= 300 && status < 400) {
      const location = res.headers.get("location");
      try { await res.body?.cancel(); } catch { /* ignore */ }
      if (!location) fail(502, "fetch_failed", `Redirect (${status}) without a location`);
      if (hop === WEB_FETCH_MAX_REDIRECTS)
        fail(502, "fetch_failed", `Too many redirects (over ${WEB_FETCH_MAX_REDIRECTS})`);
      let next;
      try { next = new URL(location, current).href; }
      catch { fail(502, "fetch_failed", "Redirect location is not a valid URL"); }
      // Per-hop SSRF re-validation: a redirect to a private host is blocked.
      try { current = await assertFetchableUrl(next); }
      catch (error) {
        if (error instanceof WebFetchError) throw error;
        fail(403, "blocked_host", "Redirect target is not fetchable");
      }
      if (seen.has(current)) fail(502, "fetch_failed", "Redirect loop detected");
      seen.add(current);
      continue;
    }
    if (status !== 200) {
      try { await res.body?.cancel(); } catch { /* ignore */ }
      fail(502, "fetch_failed", `Fetch failed with HTTP status ${status}`);
    }
    const contentType = res.headers.get("content-type") || "";
    let bytes;
    try {
      bytes = await readCapped(res.body, WEB_FETCH_MAX_BODY_BYTES);
    } catch (error) {
      if (error instanceof WebFetchError) throw error;
      if (signal.aborted) fail(504, "timeout", "Fetching the page exceeded the 15 second limit");
      fail(502, "fetch_failed", "Could not read the response body");
    }
    const html = decodeBody(bytes, contentType);
    // Accept explicit HTML types; when the server sends no content type,
    // sniff the payload rather than failing a page that is plainly HTML.
    if (!HTML_CONTENT.test(contentType)
      && !(contentType.trim() === "" && /^\s*</.test(html)))
      fail(415, "unsupported_content", "Only HTML pages can be fetched");
    return { finalUrl: current, html, bytes: bytes.byteLength };
  }
  fail(502, "fetch_failed", "Redirect handling exhausted");
}

// ---------------------------------------------------------------------------
// HTML -> markdown (hand-rolled, zero dependencies)
// ---------------------------------------------------------------------------
const ENTITY_MAP = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  hellip: "…", copy: "©", reg: "®", trade: "™", times: "×",
};
export function decodeEntities(text) {
  return text.replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity[0] === "#") {
      const code = entity[1] === "x" || entity[1] === "X"
        ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      if (Number.isSafeInteger(code) && code > 0 && code < 0x110000) {
        try { return String.fromCodePoint(code); } catch { return match; }
      }
      return match;
    }
    return ENTITY_MAP[entity] ?? match;
  });
}

const stripTags = html => html.replace(/<[^>]*>/g, "");
const cleanInline = html => decodeEntities(stripTags(html)).replace(/\s+/g, " ").trim();

function resolveLink(href, baseUrl) {
  if (!href) return null;
  const trimmed = href.trim();
  if (/^(javascript|data|mailto|tel|sms|ftp):/i.test(trimmed)) return null;
  try {
    const resolved = new URL(trimmed, baseUrl);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null;
    return resolved.href;
  } catch { return null; }
}

// mainContentOnly: drop scripts, styles, nav/footer/aside chrome. Shared by
// the markdown converter and metadata extraction so headings describe the
// same main content the markdown contains.
const stripChrome = html => String(html)
  .replace(/<!--[\s\S]*?-->/g, " ")
  .replace(/<(script|style|noscript|template)[^>]*>[\s\S]*?<\/\1>/gi, " ")
  .replace(/<(nav|footer|aside)[^>]*>[\s\S]*?<\/\1>/gi, " ");

export function htmlToMarkdown(html, baseUrl) {
  let s = stripChrome(html);
  // Headings -> markdown headings (also the section markers for highlights).
  s = s.replace(/<(h[1-6])[^>]*>([\s\S]*?)<\/\1>/gi,
    (match, tag, inner) => `\n\n${"#".repeat(Number(tag[1]))} ${cleanInline(inner)}\n\n`);
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi,
    (match, inner) => `\n\n\`\`\`\n${decodeEntities(stripTags(inner)).replace(/^\n+|\n+$/g, "")}\n\`\`\`\n\n`);
  // Blockquotes before paragraphs so the prefix survives.
  s = s.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (match, inner) => {
    const text = cleanInline(inner).split("\n").map(line => `> ${line}`).join("\n");
    return `\n\n${text}\n\n`;
  });
  s = s.replace(/<(p|div|section|article|main|header|figure|figcaption|tr)[^>]*>/gi, "\n\n");
  s = s.replace(/<\/(p|div|section|article|main|header|figure|figcaption)>/gi, "\n\n");
  s = s.replace(/<br[^>]*>/gi, "\n");
  s = s.replace(/<hr[^>]*>/gi, "\n\n---\n\n");
  s = s.replace(/<(ul|ol)[^>]*>/gi, "\n\n");
  s = s.replace(/<\/(ul|ol)>/gi, "\n\n");
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi,
    (match, inner) => `\n- ${cleanInline(inner)}`);
  s = s.replace(/<(td|th)[^>]*>([\s\S]*?)<\/\1>/gi,
    (match, tag, inner) => `${tag === "th" ? "**" : ""}${cleanInline(inner)}${tag === "th" ? "**" : ""} | `);
  s = s.replace(/<\/tr>/gi, "\n");
  // Links: [text](url), resolved against the final URL; non-web schemes
  // degrade to their text.
  s = s.replace(/<a[^>]*>([\s\S]*?)<\/a>/gi, (match, inner) => {
    const href = /href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(match)?.slice(2, 5).find(Boolean);
    const text = cleanInline(inner);
    const resolved = resolveLink(href, baseUrl);
    if (!resolved || !text) return text ? ` ${text} ` : " ";
    if (resolved === text || resolved.replace(/\/$/, "") === text) return ` ${text} `;
    return ` [${text}](${resolved}) `;
  });
  s = s.replace(/<img[^>]*>/gi, match => {
    const alt = /alt\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(match)?.slice(2, 5).find(Boolean);
    return alt ? ` [${cleanInline(alt)}] ` : " ";
  });
  s = s.replace(/<[^>]*>/g, " ");
  s = decodeEntities(s);
  s = s.replace(/[ \t\u00a0]+/g, " ");
  s = s.replace(/\n[ \t]+/g, "\n");
  s = s.replace(/[ \t]+\n/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

// ---------------------------------------------------------------------------
// Metadata: title, description, language, headings[]
// ---------------------------------------------------------------------------
export function extractMetadata(html) {
  const s = String(html);
  const title = cleanInline(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(s)?.[1] ?? "");
  let description = "";
  for (const meta of s.matchAll(/<meta[^>]*>/gi)) {
    const tag = meta[0];
    const name = /name\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag)?.slice(2, 5).find(Boolean)?.toLowerCase();
    const property = /property\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag)?.slice(2, 5).find(Boolean)?.toLowerCase();
    if (name === "description" || property === "og:description") {
      const content = /content\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag)?.slice(2, 5).find(Boolean);
      if (content) { description = cleanInline(content); break; }
    }
  }
  const language = /<html[^>]*\slang\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(s)?.slice(2, 5).find(Boolean)?.trim().toLowerCase() || "";
  // Headings honor the same main-content-only extraction as the markdown:
  // chrome regions are stripped first so nav/footer headings never appear.
  const headings = [];
  for (const match of stripChrome(s).matchAll(/<(h[1-6])[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const text = cleanInline(match[2]);
    if (text) headings.push(text);
  }
  return { title, description, language, headings };
}

// ---------------------------------------------------------------------------
// Deterministic highlights: split markdown on headings, score sections by
// query-term overlap, return top passages in page order, each prefixed with
// its section heading in [brackets]. No LLM, no extra cost.
// ---------------------------------------------------------------------------
export function extractHighlights(markdown, query, maxPassages = WEB_FETCH_HIGHLIGHT_PASSAGES_DEFAULT, title = "") {
  const terms = String(query || "").toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length > 2);
  if (!terms.length) return [];
  const limit = Math.min(Math.max(Number(maxPassages) || WEB_FETCH_HIGHLIGHT_PASSAGES_DEFAULT, 1),
    WEB_FETCH_HIGHLIGHT_PASSAGES_MAX);
  const sections = [];
  let current = { heading: null, text: [] };
  for (const line of String(markdown).split("\n")) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line.trim());
    if (heading) {
      if (current.heading !== null || current.text.length) sections.push(current);
      current = { heading: heading[2].trim(), text: [] };
    } else if (line.trim()) {
      current.text.push(line.trim());
    }
  }
  if (current.heading !== null || current.text.length) sections.push(current);
  const countTerm = (haystack, term) => {
    let count = 0, from = 0;
    for (;;) {
      const at = haystack.indexOf(term, from);
      if (at === -1) return count;
      count++;
      from = at + term.length;
    }
  };
  const scored = sections.map((section, index) => {
    const heading = (section.heading ?? "").toLowerCase();
    const body = section.text.join(" ").toLowerCase();
    let score = 0;
    for (const term of terms) score += countTerm(heading, term) * 3 + countTerm(body, term);
    return { index, section, score };
  })
    // Sections whose only match is the heading but that carry no passage
    // text contribute nothing readable; drop them so highlights stay
    // non-empty or absent entirely.
    .filter(entry => entry.score > 0 && entry.section.text.join(" ").trim().length > 0);
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  const top = scored.slice(0, limit).sort((a, b) => a.index - b.index);
  return top.map(({ section }) => {
    const heading = section.heading || title || "Introduction";
    let passage = section.text.join(" ");
    if (passage.length > WEB_FETCH_HIGHLIGHT_PASSAGE_CHARS) {
      passage = passage.slice(0, WEB_FETCH_HIGHLIGHT_PASSAGE_CHARS);
      const cut = passage.lastIndexOf(" ");
      passage = `${cut > 200 ? passage.slice(0, cut) : passage}…`;
    }
    return `[${heading}] ${passage}`;
  });
}

// Cache key: SHA-256 over the canonical options plus the normalized URL.
// The converter version and the main-content-only extraction flag are part
// of the key so a future converter change invalidates old entries.
// Highlights need no key component: they are derived deterministically from
// the cached markdown, so the same network payload serves every query.
const WEB_FETCH_CACHE_KEY_VERSION = "web-fetch-cache-v1";
const WEB_FETCH_MD_CONVERTER_VERSION = "md-converter-v1";
export function cacheKeyFor(normalizedUrl) {
  return createHash("sha256")
    .update([WEB_FETCH_CACHE_KEY_VERSION, WEB_FETCH_MD_CONVERTER_VERSION, "main-content-only", normalizedUrl].join("\n"))
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Store-bound service: validation, rate limits, cache, journaling.
// ---------------------------------------------------------------------------
function validateInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    fail(422, "invalid_fetch_input", "Request body must be a JSON object");
  // Repository style is strict about unknown fields (the exact() helper on
  // other routes): a misspelled option should fail loudly, not be ignored.
  for (const key of Object.keys(input)) {
    if (!["url", "formats", "highlightsParams", "maxAgeMs", "tags"].includes(key))
      fail(422, "invalid_fetch_input", `Unknown field: ${key}`);
  }
  const { url, formats, highlightsParams, maxAgeMs, tags } = input;
  if (typeof formats !== "object" || formats === null || Array.isArray(formats))
    fail(422, "invalid_fetch_input", "formats must be an object");
  for (const key of Object.keys(formats)) {
    if (!["markdown", "highlights"].includes(key))
      fail(422, "invalid_fetch_input", `Unknown formats field: ${key}`);
  }
  const markdown = formats?.markdown === true;
  const highlights = formats?.highlights === true;
  if (!markdown && !highlights)
    fail(422, "invalid_fetch_input", "formats must request at least one of markdown or highlights");
  let query = null, maxPassages = WEB_FETCH_HIGHLIGHT_PASSAGES_DEFAULT;
  if (highlights) {
    if (typeof highlightsParams !== "object" || highlightsParams === null || Array.isArray(highlightsParams))
      fail(422, "invalid_fetch_input", "highlightsParams must be an object");
    for (const key of Object.keys(highlightsParams)) {
      if (!["query", "maxPassages"].includes(key))
        fail(422, "invalid_fetch_input", `Unknown highlightsParams field: ${key}`);
    }
    query = highlightsParams?.query;
    if (typeof query !== "string" || !query.trim() || query.length > 500)
      fail(422, "invalid_fetch_input", "highlightsParams.query is required when highlights are requested");
    if (highlightsParams?.maxPassages !== undefined) {
      maxPassages = highlightsParams.maxPassages;
      if (!Number.isInteger(maxPassages) || maxPassages < 1 || maxPassages > WEB_FETCH_HIGHLIGHT_PASSAGES_MAX)
        fail(422, "invalid_fetch_input", `highlightsParams.maxPassages must be 1..${WEB_FETCH_HIGHLIGHT_PASSAGES_MAX}`);
    }
  } else if (highlightsParams !== undefined) {
    fail(422, "invalid_fetch_input", "highlightsParams requires formats.highlights");
  }
  let maxAge = WEB_FETCH_DEFAULT_MAX_AGE_MS;
  if (maxAgeMs !== undefined) {
    if (typeof maxAgeMs !== "number" || !Number.isFinite(maxAgeMs) || maxAgeMs < 0 || maxAgeMs > WEB_FETCH_MAX_MAX_AGE_MS)
      fail(422, "invalid_fetch_input", `maxAgeMs must be 0..${WEB_FETCH_MAX_MAX_AGE_MS}`);
    maxAge = maxAgeMs;
  }
  let tagList = [];
  if (tags !== undefined) {
    if (!Array.isArray(tags) || tags.length > WEB_FETCH_MAX_TAGS
      || tags.some(tag => typeof tag !== "string" || !tag.trim() || tag.length > WEB_FETCH_TAG_CHARS))
      fail(422, "invalid_fetch_input", `tags must be an array of at most ${WEB_FETCH_MAX_TAGS} short strings`);
    tagList = tags.map(tag => tag.trim());
  }
  return { url, markdown, highlights, query, maxPassages, maxAgeMs: maxAge, tags: tagList };
}

export class WebFetch {
  constructor(store) {
    this.store = store;
    this.db = store.db;
  }

  verifySchema({ allowAbsent = false } = {}) {
    const normalize = sql => sql?.trim().replace(/;$/, "").replace(/IF NOT EXISTS /g, "").replace(/\s+/g, " ");
    const expected = webFetchSchema.trim().split(/;\s*(?=CREATE|$)/).filter(Boolean)
      .map(sql => ({ sql, actual: this.db.prepare("SELECT sql FROM sqlite_master WHERE name=?")
        .get(/^CREATE (?:UNIQUE )?(?:TABLE|INDEX) (?:IF NOT EXISTS )?([a-z_]+)/.exec(sql.trim())[1])?.sql }));
    if (allowAbsent && expected.every(({ actual }) => actual === undefined)) return false;
    for (const { sql, actual } of expected) {
      if (normalize(actual) !== normalize(sql)) throw new Error("Web fetch schema requires operator reconciliation");
    }
    return true;
  }

  checkRateLimits(roomId, memberId, now) {
    const since = now - WEB_FETCH_RATE_WINDOW_MS;
    const limited = (count, per, scope) => {
      if (count < per) return;
      const oldest = this.db.prepare(
        `SELECT MIN(created_at) AS at FROM web_fetch_log WHERE room_id=? ${scope} AND created_at>? AND cache_status IN ('hit','miss')`)
        .get(roomId, ...(scope ? [memberId] : []), since).at ?? now;
      const resetAt = oldest + WEB_FETCH_RATE_WINDOW_MS;
      fail(429, "rate_limited",
        `Web fetch quota exceeded (${per} per day ${scope ? "for this member" : "for this room"})`,
        { retryAfterMs: Math.max(0, resetAt - now), resetAt });
    };
    // Only successful fetches (hit/miss) consume quota; typed failures are
    // journaled but never billed.
    limited(this.db.prepare(
      "SELECT COUNT(*) AS n FROM web_fetch_log WHERE room_id=? AND member_id=? AND created_at>? AND cache_status IN ('hit','miss')")
      .get(roomId, memberId, since).n, WEB_FETCH_RATE_PER_MEMBER_PER_DAY, "AND member_id=?");
    limited(this.db.prepare(
      "SELECT COUNT(*) AS n FROM web_fetch_log WHERE room_id=? AND created_at>? AND cache_status IN ('hit','miss')")
      .get(roomId, since).n, WEB_FETCH_RATE_PER_ROOM_PER_DAY, "");
  }

  getCache(key, now, maxAgeMs) {
    if (maxAgeMs === 0) return null; // fresh: never serve cache
    const row = this.db.prepare("SELECT * FROM web_fetch_cache WHERE key=?").get(key);
    if (!row) return null;
    const ageMs = now - row.fetched_at;
    if (ageMs > maxAgeMs) return null; // stale: refetch
    return { row, ageMs };
  }

  putCache(key, url, finalUrl, markdown, metadata, bytes, now) {
    this.db.prepare(`INSERT INTO web_fetch_cache(key, url, final_url, markdown, metadata_json, bytes, fetched_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET
      url=excluded.url, final_url=excluded.final_url, markdown=excluded.markdown,
      metadata_json=excluded.metadata_json, bytes=excluded.bytes, fetched_at=excluded.fetched_at`)
      .run(key, url, finalUrl, markdown, JSON.stringify(metadata), bytes, now);
    // Opportunistic prune: nothing older than the maximum cache age survives.
    this.db.prepare("DELETE FROM web_fetch_cache WHERE fetched_at<?").run(now - WEB_FETCH_MAX_MAX_AGE_MS);
  }

  journal(entry) {
    // credential_hash is the key-awareness seam: a future outside-agent API
    // tier (e.g. N fetches/day/key) can count per key off this column without
    // rework. It is journaled, never enforced, today.
    this.db.prepare(`INSERT INTO web_fetch_log(request_id, room_id, member_id, credential_hash, host, cache_status, bytes, tags_json, created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(entry.requestId, entry.roomId, entry.memberId, entry.credentialHash ?? null,
      entry.host, entry.cacheStatus, entry.bytes, JSON.stringify(entry.tags), entry.at);
  }

  async fetch(roomId, memberId, input, opts = {}) {
    // The request id is minted before validation so every typed failure
    // carries it — clients can correlate a failure with the room journal,
    // which records error attempts under the same id.
    const requestId = `wf_${randomUUID()}`;
    const credentialHash = opts.credentialHash ?? null;
    try {
      return await this.fetchInner(roomId, memberId, input, requestId, credentialHash);
    } catch (error) {
      if (error instanceof WebFetchError) error.requestId = requestId;
      throw error;
    }
  }

  async fetchInner(roomId, memberId, input, requestId, credentialHash) {
    const req = validateInput(input);
    const now = this.store.now();
    const normalized = normalizeUrl(req.url); // invalid_url before quota is touched
    this.checkRateLimits(roomId, memberId, now); // rate_limited: 429 + retry info
    const key = cacheKeyFor(normalized);
    const cached = this.getCache(key, now, req.maxAgeMs);
    let finalUrl, markdown, metadata, bytes, cacheStatus, ageMs;
    if (cached) {
      ({ final_url: finalUrl, markdown, bytes } = cached.row);
      metadata = JSON.parse(cached.row.metadata_json);
      cacheStatus = "hit";
      ageMs = cached.ageMs;
    } else {
      let page;
      try {
        page = await fetchPage(normalized); // blocked_host / fetch_failed / timeout / unsupported_content
      } catch (error) {
        if (error instanceof WebFetchError) {
          this.journal({ requestId, roomId, memberId, credentialHash, host: safeHost(normalized), cacheStatus: "error", bytes: 0, tags: req.tags, at: this.store.now() });
        }
        throw error;
      }
      markdown = htmlToMarkdown(page.html, page.finalUrl);
      metadata = extractMetadata(page.html);
      finalUrl = page.finalUrl;
      bytes = page.bytes;
      this.store.transaction(() => {
        this.putCache(key, normalized, finalUrl, markdown, metadata, bytes, this.store.now());
      });
      cacheStatus = "miss";
      ageMs = 0; // freshly fetched: zero age
    }
    const highlights = req.highlights
      ? extractHighlights(markdown, req.query, req.maxPassages, metadata.title)
      : [];
    this.journal({
      requestId, roomId, memberId, credentialHash, host: safeHost(finalUrl),
      cacheStatus, bytes, tags: req.tags, at: this.store.now(),
    });
    return {
      url: finalUrl,
      markdown: { requested: req.markdown, data: req.markdown ? markdown : null },
      highlights: { requested: req.highlights, data: highlights },
      metadata,
      cache_metadata: { status: cacheStatus, age_ms: ageMs },
      request_id: requestId,
    };
  }
}

function safeHost(href) {
  try { return new URL(href).hostname; } catch { return ""; }
}

// Owner + full-member gate helper for the HTTP layer: guests (ga1.
// guest-agents and human share-link guests with role === "guest") are
// refused with the #798 code and copy. There is no drafts-only member
// tier in the room data model, so every other active member qualifies.
export function isWebFetchGuest(member) {
  return !!member && (member.role === "guest" || isGuestAgentMemberId(member.id));
}

// Contract for API docs / clients.
export function webFetchContract() {
  return {
    status: "live",
    route: "POST /api/web/fetch",
    auth: "owner_and_full_members",
    formats: ["markdown", "highlights"],
    limits: {
      bodyBytes: WEB_FETCH_MAX_BODY_BYTES,
      timeoutMs: WEB_FETCH_TIMEOUT_MS,
      maxRedirects: WEB_FETCH_MAX_REDIRECTS,
      defaultMaxAgeMs: WEB_FETCH_DEFAULT_MAX_AGE_MS,
      maxMaxAgeMs: WEB_FETCH_MAX_MAX_AGE_MS,
      perMemberPerDay: WEB_FETCH_RATE_PER_MEMBER_PER_DAY,
      perRoomPerDay: WEB_FETCH_RATE_PER_ROOM_PER_DAY,
    },
    typedErrors: ["invalid_url", "blocked_host", "fetch_failed", "unsupported_content", "rate_limited", "timeout"],
  };
}
