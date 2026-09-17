import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ServiceError } from "./store.mjs";
import { clientAddress, STREAM_INTERVAL_DEFAULT_MS } from "./deployment.mjs";
import { validId } from "../src/events.js";
import { SyntheticInboxTransport, FixtureChannelSender } from "./inbox-transport.mjs";
import { channelSyncLimits, syncTelegramConnection } from "./channel-import.mjs";
import { telegramConfig, TelegramLiveStatus, telegramLiveView } from "./channel-adapters/telegram-config.mjs";
import { TelegramTransport } from "./channel-adapters/telegram-transport.mjs";
import { SOURCE_REVISION, BUILD_ID } from "./version.mjs";
import { agentErrorBody, errorCategory } from "../src/agent-error.mjs";
import { DiagnosticsLog, supportExportBundle } from "./diagnostics.mjs";
import { renderRoomExportHtml, EXPORT_HTML_CSP } from "./room-export-html.mjs";
import { discoveryDoc, isHealthAliasPath } from "../deploy/agent-discovery.mjs";
import { isPublicRoomDoorPath, wantsPublicDoorHtml, publicRoomDoorHtml, PUBLIC_DOOR_CSP } from "../deploy/room-entry.mjs";
import { guestAgentLinkContract } from "./guest-agent-links.mjs";
import { isSessionStatus, workItemSessionContract } from "../src/work-item-session.js";
import { accessReviewReport } from "./access-review.mjs";
import { roomUsageSummary, parseUsageDays } from "./usage-summary.mjs";
import { AccessRequests } from "./access-requests.mjs";
import { readSpendAllowance, setSpendAllowance } from "./spend-allowance.mjs";
import { listPins, setPin } from "./pins.mjs";

const roomCookieName = "room_session";
const accountCookieName = "account_session";
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const bindingPattern = /^[a-f0-9]{64}$/;
const assets = new Map([
  ["/", ["index.html", "text/html"]], ["/index.html", ["index.html", "text/html"]],
  ...["app.js", "client.js", "events.js", "conversation.js", "workflow.js", "share-links.js", "agent-connections.js", "return-brief.js", "work-selectors.js", "work-status.js", "work-packet.js", "portable-work.js", "reminders.js", "reminder-time.js", "room-charter.js", "room-instructions.js", "reply-requests.js", "work-help.js", "help-offers.js", "work-item-session.js", "work-loops.js", "work-recipes.js"].map(name => [`/src/${name}`, [`src/${name}`, "text/javascript"]]),
  ...["inbox-client.js", "inbox-ui.js", "inbox-send-ui.js", "room-roster.js"].map(name => [`/src/${name}`, [`src/${name}`, "text/javascript"]]),
  ["/src/styles.css", ["src/styles.css", "text/css"]]
]);
const reject = (status, code, message) => { throw new ServiceError(status, code, message); };
const pathId = encoded => {
  let id;
  try { id = decodeURIComponent(encoded); } catch { reject(404, "not_found", "Not found"); }
  if (!validId(id)) reject(404, "not_found", "Not found");
  return id;
};
const accountView = auth => ({
  authenticated: Boolean(auth.account),
  account: auth.account ? { id: auth.account.id, revision: auth.account.revision, authEpoch: auth.account.authEpoch } : null,
  csrf: auth.csrf,
  sessionBinding: auth.sessionBinding,
  sessionRevision: auth.sessionRevision,
  expiresAt: auth.expiresAt,
  authenticatedUntil: auth.authenticatedUntil ?? null
});
const sessionView = auth => ({
  authMode: auth.credentialScope === "account-session" ? "account" : "room",
  account: auth.account ? { id: auth.account.id, revision: auth.account.revision, authEpoch: auth.account.authEpoch } : null,
  member: auth.member,
  roomId: auth.roomId,
  csrf: auth.csrf,
  sessionBinding: auth.sessionBinding,
  sessionRevision: auth.sessionRevision ?? null,
  credentialKind: auth.kind,
  expiresAt: auth.expiresAt
});
const exact = (value, fields) => Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
// Unified inbox connection routes, documented under the same templates in docs/openapi.yaml.
const connectionRoutes = Object.freeze({ list: "/api/inbox/connections", read: "/api/inbox/connections/{id}", commands: "/api/inbox/connections/commands",
  sync: "/api/inbox/connections/{id}/sync", reconnect: "/api/inbox/connections/{id}/reconnect", webhook: "/api/inbox/webhooks/{connectionId}",
  channelSends: "/api/inbox/channel-sends" });
// Providers the browser may reply through from the Inbox. Email stays out until
// an outbound email slice exists; its sources report send: false.
const channelSendProviders = Object.freeze(["telegram-bot"]);
const routePattern = template => new RegExp("^" + template.replaceAll("/", "\\/").replace(/\{[A-Za-z]+\}/g, "([^/]{1,384})") + "$");
const webhookSecretHeader = "x-telegram-bot-api-secret-token";
const JSON_BODY_BYTES = 16384;
const rateHash = value => createHash("sha256").update(String(value)).digest("hex");
// A lagging stream that still has not drained its final event by now is dropped.
const STREAM_DRAIN_GRACE_MS = 5000;

export function createRoomServer({ store, origin, assetRoot = new URL("../", import.meta.url), streamInterval = STREAM_INTERVAL_DEFAULT_MS, streamQueueCap = 65536, trustedLocalProxy = false,
  loadAsset = path => readFile(new URL(path, assetRoot)), resolveClientAddress = req => clientAddress(req, trustedLocalProxy),
  resolveRequestSignal = () => null, syntheticInboxTransport = null, channelWebhooks = null, cookieNamespace = "",
  telegram = telegramConfig(), telegramStatus = new TelegramLiveStatus(), channelTransports = null,
  serviceMode = trustedLocalProxy ? "invite-only-pilot" : "single-node-pilot", growth = null }) {
  // Live Telegram bindings are read once (Worker secrets or local env); the
  // config never holds up startup and the card reports "not configured".
  if (typeof telegram?.configured !== "boolean" || !Array.isArray(telegram.bindings)) throw new Error("Telegram configuration must come from telegramConfig()");
  if (trustedLocalProxy && !origin?.startsWith("https://")) throw new Error("The deployment proxy requires a fixed HTTPS origin");
  if (!Number.isInteger(streamQueueCap) || streamQueueCap < 1) throw new Error("Stream queue cap must be a positive integer of bytes");
  if (!Number.isInteger(streamInterval) || streamInterval < 1) throw new Error("Stream interval must be a positive integer of milliseconds");
  if (channelTransports !== null && typeof channelTransports !== "function") throw new Error("channelTransports must be a resolver function");
  // One send transport per (provider, account, connection): the live Telegram
  // transport when the bindings are set, otherwise the inert fixture sender. The
  // browser is told which ("live" or "fixture") so it labels outcomes honestly.
  const channelSenders = new Map(), sendReceipts = new Map();
  // access_requests schema is applied in the store open path (server/store.mjs),
  // so every RoomStore — including store-only recovery fixtures — carries it.
  const accessRequests = new AccessRequests(store);
  const resolveChannelTransport = channelTransports ?? (({ provider, accountId, connectionId }) => {
    if (!channelSendProviders.includes(provider)) return null;
    const key = JSON.stringify([provider, accountId, connectionId]);
    if (!channelSenders.has(key)) {
      if (channelSenders.size >= 2000) channelSenders.clear(); // Idle scopes only hold in-memory receipts; the send journal stays authoritative.
      const adapter = telegram.configured ? new TelegramTransport({ config: telegram, status: telegramStatus, accountId, connectionId, receipts: sendReceipts })
        : new FixtureChannelSender({ kind: provider, status: telegramStatus, accountId, connectionId });
      channelSenders.set(key, { mode: telegram.configured ? "live" : "fixture", transport: new SyntheticInboxTransport(store.inbox, adapter) });
    }
    return channelSenders.get(key);
  });
  if (typeof cookieNamespace !== "string" || !/^[A-Za-z0-9_-]{0,64}$/.test(cookieNamespace))
    throw new Error("Cookie namespace must contain at most 64 letters, digits, underscores or hyphens");
  if (syntheticInboxTransport && (!(syntheticInboxTransport instanceof SyntheticInboxTransport)
    || syntheticInboxTransport.inbox !== store.inbox || trustedLocalProxy
    || origin && !["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname)))
    throw new Error("Synthetic inbox transport requires its own loopback test service");
  if (origin) {
    const url = new URL(origin);
    if (url.origin !== origin || !["http:", "https:"].includes(url.protocol)) throw new Error("Origin must be a fixed HTTP(S) origin without a path");
    if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("Non-loopback origins require HTTPS");
  }
  const expectedOrigin = () => origin || `http://127.0.0.1:${server.address().port}`;
  // Avoid local-instance sign-in collisions; namespacing is not host isolation.
  const scopedCookieName = name => `${expectedOrigin().startsWith("https:") ? "__Host-" : ""}${cookieNamespace ? cookieNamespace + "_" : ""}${name}`;
  const streams = new Set();
  const diagnostics = new DiagnosticsLog();

  // Route templates for diagnostics: static words only, ids become :item.
  const templateSegments = rest => rest.split("/").map(segment => /^[a-z][a-z-]{0,40}$/.test(segment) ? segment : ":item").join("/");
  const requestPathname = requestUrl => { try { return new URL(requestUrl, expectedOrigin()).pathname; } catch { return null; } };
  // Room-scoped support-export route templates.
  function diagnosticRoute(requestUrl, roomId) {
    if (!roomId) return null;
    const pathname = requestPathname(requestUrl);
    if (pathname === null) return null;
    const prefix = `/api/rooms/${encodeURIComponent(roomId)}`;
    if (pathname !== prefix && !pathname.startsWith(prefix + "/")) return null;
    const rest = pathname.slice(prefix.length);
    if (!rest) return "/api/rooms/:roomId";
    return `/api/rooms/:roomId/${templateSegments(rest.slice(1))}`;
  }
  // Operator trace for failures outside a room scope: the static path template
  // only, never the query string, headers, body or the error's own message.
  const serviceRoute = requestUrl => {
    const pathname = requestPathname(requestUrl);
    return pathname === null || pathname === "/" ? "/" : "/" + templateSegments(pathname.slice(1).slice(0, 512));
  };
  // Keys are "<family>:<ip or credential...>". Each family keeps at most
  // RATE_FAMILY_KEYS live entries; a flood of foreign keys evicts that family's
  // least recently touched entry instead of refusing every new key, so a busy
  // minute cannot lock out fresh logins or joins, and one family cannot starve
  // another. Map insertion order doubles as the recency order.
  const RATE_FAMILY_KEYS = 2000;
  const rates = new Map(), rateFamilies = new Map();
  const rateFamily = id => id.slice(0, id.indexOf(":"));
  const dropRate = (id, family = rateFamily(id)) => {
    rates.delete(id);
    const left = rateFamilies.get(family) - 1;
    if (left > 0) rateFamilies.set(family, left); else rateFamilies.delete(family);
  };
  function rate(id, maximum) {
    const now = Date.now();
    for (const [k, v] of rates) if (v.until <= now) dropRate(k);
    const family = rateFamily(id);
    let entry = rates.get(id);
    if (entry) rates.delete(id);
    else {
      if ((rateFamilies.get(family) ?? 0) >= RATE_FAMILY_KEYS)
        for (const k of rates.keys()) if (rateFamily(k) === family) { dropRate(k, family); break; }
      rateFamilies.set(family, (rateFamilies.get(family) ?? 0) + 1);
      entry = { n: 0, until: now + 60000 };
    }
    entry.n++;
    rates.set(id, entry);
    if (entry.n > maximum) throw new ServiceError(429, "rate_limited", "Too many requests; retry after a minute",
      { "X-RateLimit-Limit": maximum, "X-RateLimit-Remaining": 0, "X-RateLimit-Reset": Math.ceil(entry.until / 1000) });
  }
  function cookie(req, name) {
    const scoped = scopedCookieName(name);
    const matches = (req.headers.cookie || "").split(";").map(value => value.trim()).filter(value => value.startsWith(`${scoped}=`));
    if (matches.length > 1) reject(401, "ambiguous_session_cookie", "Conflicting browser session cookies; clear this site's cookies and sign in again");
    return matches[0]?.slice(scoped.length + 1);
  }
  function bearer(req) {
    if (!req.headers.authorization) return null;
    const match = /^Bearer ([A-Za-z0-9_-]{43}|ga1\.[A-Za-z0-9_-]{43}|pri_[A-Za-z0-9_-]{43,128})$/.exec(req.headers.authorization);
    if (!match) reject(401, "unauthenticated", "Invalid Authorization header");
    return match[1];
  }
  function roomCredentials(req, url) {
    const bearerToken = bearer(req);
    if (bearerToken) return { token: bearerToken, bearer: true, mode: "room" };
    const requested = req.headers["x-project-room-auth"] ?? url.searchParams.get("auth") ?? "room";
    if (!["room", "account"].includes(requested)) reject(422, "invalid_auth_mode", "Invalid Room authentication mode");
    return { token: cookie(req, requested === "account" ? accountCookieName : roomCookieName), bearer: false, mode: requested };
  }
  function expectedBinding(req) {
    const value = req.headers["x-session-binding"];
    if (value === undefined) return null;
    if (typeof value !== "string" || !bindingPattern.test(value)) reject(422, "invalid_session_binding", "Invalid session response binding");
    return value;
  }
  function accountBinding(req, url = null) {
    const header = expectedBinding(req);
    const values = url?.searchParams.getAll("binding") ?? [];
    if (values.length > 1 || (values.length && !bindingPattern.test(values[0]))
      || (header && values.length && header !== values[0])) reject(422, "invalid_session_binding", "Invalid session response binding");
    const binding = header ?? values[0];
    if (!binding) reject(422, "session_binding_required", "Current account session binding required");
    return binding;
  }
  function checkOrigin(req, required = false) {
    if ((required || req.headers.origin) && req.headers.origin !== expectedOrigin()) reject(403, "origin_denied", "Request origin is not allowed");
  }
  function protectWrite(req, auth, isBearer) {
    checkOrigin(req, !isBearer);
    if (!isBearer) {
      const csrf = req.headers["x-csrf-token"];
      if (auth.kind !== "session" || typeof csrf !== "string" || !bindingPattern.test(csrf) || !auth.csrf
        || !timingSafeEqual(Buffer.from(csrf), Buffer.from(auth.csrf))) reject(403, "csrf_denied", "Session confirmation required; sign in again");
    }
  }
  function setCookie(res, name, token, maxAge) {
    res.setHeader("Set-Cookie", `${scopedCookieName(name)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${expectedOrigin().startsWith("https:") ? "; Secure" : ""}`);
  }
  function json(res, status, value, head = false) {
    const body = JSON.stringify(value);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
    res.end(head ? undefined : body);
  }
  // Bounded request reader shared by the JSON and NDJSON routes: an oversized
  // Content-Length is refused before any byte is read, buffering stops once the
  // streamed bytes pass the limit, and a client that stops sending fails the
  // request at once instead of holding it until the server request timeout.
  function readText(req, limit, tooLarge) {
    if (Number(req.headers["content-length"]) > limit) { req.resume(); throw tooLarge(); }
    return new Promise((resolve, rejectPromise) => {
      let bytes = 0; const chunks = [];
      req.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > limit) { chunks.length = 0; rejectPromise(tooLarge()); }
        else chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", rejectPromise);
      req.on("aborted", () => rejectPromise(new ServiceError(400, "aborted", "Request ended early")));
    });
  }
  // Every JSON route takes the default limit; a caller passes `limit` only where
  // the provider's payload is known to be larger (the Telegram webhook embeds
  // the replied-to message).
  async function body(req, { limit = JSON_BODY_BYTES } = {}) {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) reject(415, "json_required", "Use application/json");
    const text = await readText(req, limit, () => new ServiceError(413, "too_large", "Request is too large"));
    try { const value = JSON.parse(text); if (!value || Array.isArray(value) || typeof value !== "object") throw new Error(); return value; }
    catch { reject(400, "invalid_json", "Expected a JSON object"); }
  }
  function stream(req, res, token, roomId, after, auth, operationId) {
    const binding = auth.sessionBinding;
    store.eventsAfter(token, roomId, after, 100, binding);
    if (streams.size >= 100 || [...streams].filter(item => item.credentialHash === auth.credentialHash).length >= 3) reject(429, "stream_limit", "Close another room connection before opening more");
    res.writeHead(200, { "Content-Type": "text/event-stream", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    const entry = { credentialHash: auth.credentialHash, sessionBinding: binding, memberId: auth.member.id, roomId, res };
    streams.add(entry);
    let cursor = after;
    let timer;
    const signal = resolveRequestSignal(req);
    const cleanup = () => { clearInterval(timer); streams.delete(entry); signal?.removeEventListener("abort", abort); };
    const end = data => { cleanup(); if (!res.destroyed && !res.writableEnded) res.end(data); };
    const abort = () => end();
    // Per-connection send queue: a consumer whose unsent bytes exceed the cap
    // gets one final stream_lagging event and, if it never drains, its socket
    // dropped. Peers keep their own queues. Reconnecting with Last-Event-ID
    // resumes from the last event the client actually processed.
    const lagging = () => res.writableLength > streamQueueCap;
    const lag = () => {
      diagnostics.record({ operationId, at: new Date().toISOString(), status: 200, code: "stream_lagging", category: "unavailable", route: "/api/rooms/:roomId/stream", roomId });
      console.warn(`room diagnostic ${operationId} 200 stream_lagging unavailable /api/rooms/:roomId/stream`);
      const drop = setTimeout(() => res.destroy(), STREAM_DRAIN_GRACE_MS);
      drop.unref();
      res.once("close", () => clearTimeout(drop));
      end('event: stream_lagging\ndata: {"message":"Client fell behind; reconnect with Last-Event-ID to resume"}\n\n');
    };
    const pump = () => {
      if (res.destroyed || res.writableEnded) { cleanup(); return; }
      try {
        const batch = store.eventsAfter(token, roomId, cursor, 100, binding);
        if (!batch.events.length) res.write(": connected transport only\n\n");
        for (const item of batch.events) {
          res.write(`id: ${item.sequence}\nevent: room-event\ndata: ${JSON.stringify(item)}\n\n`);
          cursor = item.sequence;
          if (lagging()) break;
        }
        if (lagging()) lag();
      } catch { end('event: access-ended\ndata: {"message":"Access ended; sign in again"}\n\n'); }
    };
    timer = setInterval(pump, streamInterval);
    timer.unref();
    res.once("close", cleanup); res.once("finish", cleanup); res.once("error", abort);
    // Workers' Node bridge does not emit close when a browser leaves. The
    // request-scoped platform signal releases only this stream and its timer.
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort(); else pump();
  }
  const server = createServer(async (req, res) => {
    const operationId = `op_${randomBytes(6).toString("base64url")}`;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    try {
      if (req.headers.host !== new URL(expectedOrigin()).host) reject(403, "host_denied", "Unexpected host");
      checkOrigin(req);
      let remoteAddress;
      try { remoteAddress = resolveClientAddress(req); }
      catch { reject(403, "proxy_denied", "Invalid proxy configuration"); }
      const url = new URL(req.url, expectedOrigin()), loopback = ["127.0.0.1", "::1"].includes(remoteAddress);
      if (url.pathname.startsWith("/api/")) res.setHeader("X-Operation-Id", operationId);
      if ((url.pathname === "/api/health" || isHealthAliasPath(url.pathname)) && ["GET", "HEAD"].includes(req.method)) {
        return json(res, 200, { status: "ok", mode: serviceMode }, req.method === "HEAD");
      }
      if (url.pathname === "/api/version" && ["GET", "HEAD"].includes(req.method)) {
        return json(res, 200, { status: "ok", mode: serviceMode, sourceRevision: SOURCE_REVISION, buildId: BUILD_ID }, req.method === "HEAD");
      }
      if (url.pathname === "/api/ready" && ["GET", "HEAD"].includes(req.method)) {
        try {
          if (store.storageStatus?.().unavailable) return json(res, 503, { status: "unavailable", reason: "storage_unavailable" }, req.method === "HEAD");
          if (!store.db.prepare("SELECT 1 FROM rooms LIMIT 1").get()) throw new Error("No room");
          return json(res, 200, { status: "ready" }, req.method === "HEAD");
        } catch { return json(res, 503, { status: "unavailable" }, req.method === "HEAD"); }
      }
      // Track C C14 — read-only growth analytics surface. The handler is a
      // pure read over the collector/scheduler; unknown /growth subpaths 404
      // inside the handler so the surface stays explicit. Failure-isolated:
      // a throwing handler degrades to a 503, never to a dropped connection.
      if (growth) {
        let growthReply = null;
        try {
          growthReply = growth.handle(url.pathname, req.method, url.searchParams);
        } catch { return json(res, 503, { status: "unavailable", reason: "growth_unavailable" }); }
        if (growthReply) return json(res, growthReply.status, growthReply.body);
      }
      // Public Hosts (www / lobby / apex) reverse-proxy /room here. Browsers
      // get the getdasha HTML door. / stays the workspace app. Packets stay
      // at /llms.txt, /room/llms.txt, /skill.md, /room/skill, agent.json,
      // and the kits catalog at /kits.txt / /room/kits.
      if (isPublicRoomDoorPath(url.pathname)) {
        if (!["GET", "HEAD"].includes(req.method)) reject(405, "method_not_allowed", "Method not allowed");
        if (wantsPublicDoorHtml(req.headers.accept)) {
          const bytes = Buffer.from(publicRoomDoorHtml());
          res.setHeader("Content-Security-Policy", PUBLIC_DOOR_CSP);
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": bytes.length });
          return res.end(req.method === "HEAD" ? undefined : bytes);
        }
        const packet = discoveryDoc("/llms.txt");
        res.setHeader("X-Robots-Tag", "all");
        const packetBytes = Buffer.from(packet.body);
        res.writeHead(200, { "Content-Type": packet.type, "Content-Length": packetBytes.length });
        return res.end(req.method === "HEAD" ? undefined : packetBytes);
      }
      const discovery = discoveryDoc(url.pathname);
      if (discovery && ["GET", "HEAD"].includes(req.method)) {
        res.setHeader("X-Robots-Tag", "all");
        const bytes = Buffer.from(discovery.body);
        res.writeHead(200, { "Content-Type": discovery.type, "Content-Length": bytes.length });
        return res.end(req.method === "HEAD" ? undefined : bytes);
      }
      if (discovery) reject(405, "method_not_allowed", "Method not allowed");
      if (assets.has(url.pathname) && ["GET", "HEAD"].includes(req.method)) {
        const [path, type] = assets.get(url.pathname);
        const data = await loadAsset(path);
        res.writeHead(200, { "Content-Type": `${type}; charset=utf-8` });
        return res.end(req.method === "HEAD" ? undefined : data);
      }
      const webhook = routePattern(connectionRoutes.webhook).exec(url.pathname);
      if (webhook) {
        // Provider callbacks carry a per-connection secret, never an account session.
        // Verified updates only wait for the owner's import; nothing is stored here.
        if (req.method !== "POST") reject(405, "method_not_allowed", "Method not allowed");
        // Telegram delivers every bot's updates from a few shared egress addresses,
        // so the per-address key is only a high guard against unverified floods;
        // the budget that matters is counted per verified connection, after the
        // secret matched and before anything is journaled (channelSyncLimits).
        rate(`inbox-webhook:${remoteAddress}`, channelSyncLimits.webhookPerAddress);
        if (!channelWebhooks) reject(409, "channel_webhook_unavailable", "Webhook delivery is not configured here.");
        const connectionId = pathId(webhook[1]), secret = req.headers[webhookSecretHeader];
        if (typeof secret !== "string") reject(401, "channel_webhook_denied", "Webhook not accepted.");
        const received = channelWebhooks.receive({ connectionId, secret, body: await body(req, { limit: channelSyncLimits.webhookBodyBytes }),
          verified: match => rate(`inbox-webhook-connection:${match.accountId}:${match.connectionId}`, channelSyncLimits.webhookPerConnection) });
        telegramStatus.received(received.accountId, connectionId, { at: store.now(), count: received.received });
        return json(res, 202, { contractVersion: 1, connectionId, received: received.received, pending: received.pending });
      }
      if (url.pathname === "/api/inbox" || url.pathname.startsWith("/api/inbox/")) {
        // Inbox authority is an account session, never a Room/agent bearer key.
        if (req.headers.authorization) reject(401, "account_session_required", "Use your current account session.");
        const token = cookie(req, accountCookieName), binding = accountBinding(req);
        const auth = store.authenticateAccountSession(token, null, binding);
        const view = url.searchParams.get("view");
        const replySource = /^\/api\/inbox\/sources\/([^/]{1,384})\/reply-review$/.exec(url.pathname);
        if (replySource && req.method === "GET") {
          if (!["reply-review-v1", "reply-review-v2", "reply-review-v3", "reply-review-v4"].includes(view) || [...url.searchParams.keys()].length !== 1) reject(422, "unsupported_inbox_view", "Choose the supported reply review.");
          return json(res, 200, store.inbox.replyReviewContext(token, pathId(replySource[1]), binding, { view }));
        }
        if (url.pathname === "/api/inbox/review" && req.method === "POST") {
          protectWrite(req, auth, false); rate(`inbox:${auth.account.id}`, 60);
          const result = store.inbox.reviewReply(token, await body(req), binding);
          return json(res, result.duplicate ? 200 : 201, result);
        }
        if (view !== null && (!["email-text-v1", "email-excerpt-v1"].includes(view) || url.searchParams.getAll("view").length !== 1))
          reject(422, "unsupported_inbox_view", "This inbox view is not supported.");
        if (url.pathname === "/api/inbox" && req.method === "GET") return json(res, 200, store.inbox.list(token, binding, { includeChannels: view !== null }));
        if (url.pathname === connectionRoutes.list && req.method === "GET") return json(res, 200, store.connections.connections(token, binding));
        // The card's live facts: binding state, webhook hash agreement, last delivery and send. Never values or hashes.
        const liveRecord = connectionId => {
          const record = store.connections.connectionRecord(token, connectionId, binding);
          const live = telegramLiveView({ config: telegram, connection: store.connections.connection(auth.account.id, connectionId), record: record.connection,
            status: telegramStatus, importAvailable: Boolean(channelWebhooks) });
          return { ...record, syncAvailable: loopback, live };
        };
        if (url.pathname === connectionRoutes.commands && req.method === "POST") {
          // Owner-managed connection records over HTTP: configure (add or update a
          // bot or mailbox profile) and disconnect ("Remove": saved copies stay,
          // nothing is deleted). Webhook hashes and import pages never come from here.
          protectWrite(req, auth, false); rate(`inbox-connections:${auth.account.id}`, 30);
          const data = await body(req);
          if (!data || typeof data !== "object" || Array.isArray(data) || !["connection.configure", "connection.disconnect"].includes(data.action) || !validId(data.connectionId))
            reject(422, "invalid_channel_connection", "Supply a connection.configure or connection.disconnect request.");
          const result = store.connections.apply(token, data, binding);
          return json(res, result.duplicate ? 200 : 201, { ...liveRecord(data.connectionId), receipt: result.receipt, duplicate: result.duplicate });
        }
        // The transport a channel source's replies go through, if this deployment has one.
        const channelSendFor = sourceId => {
          const link = store.inbox.sourceConnection(token, sourceId, binding);
          if (!link || link.state !== "active" || !link.send) return null;
          const sender = resolveChannelTransport({ provider: link.provider, accountId: auth.account.id, connectionId: link.connectionId });
          return sender ? { ...link, ...sender } : null;
        };
        const channelSendView = sender => sender ? { provider: sender.provider, mode: sender.mode } : null;
        const connection = routePattern(connectionRoutes.read).exec(url.pathname);
        if (connection && req.method === "GET") return json(res, 200, liveRecord(pathId(connection[1])));
        const trigger = routePattern(connectionRoutes.reconnect).exec(url.pathname);
        if (trigger && req.method === "POST") {
          // Owner-authenticated import trigger for hosted deployments: the account
          // session plus CSRF is the connection owner's authority, no loopback needed.
          protectWrite(req, auth, false); rate(`inbox-import:${auth.account.id}`, 30);
          const connectionId = pathId(trigger[1]), data = await body(req);
          if (!exact(data, ["requestId"]) || !validId(data.requestId) || data.requestId.length > 100) reject(422, "invalid_channel_update", "Supply a stable request ID.");
          const current = store.connections.connectionRecord(token, connectionId, binding);
          if (current.connection.channel !== "telegram") reject(409, "channel_sync_unsupported", "Live import is available for Telegram connections only.");
          // Re-register: when the bindings are set, the connection accepts deliveries
          // signed with TELEGRAM_WEBHOOK_SECRET (only its SHA-256 is stored).
          let registered = false;
          const stored = store.connections.connection(auth.account.id, connectionId)?.webhook?.secretHash ?? null;
          if (telegram.configured && current.connection.state === "active" && stored !== telegram.webhookSecretHash()) {
            store.connections.apply(token, { action: "connection.webhook", requestId: data.requestId + "-webhook", connectionId,
              expectedRevision: current.connection.revision, secretHash: telegram.webhookSecretHash() }, binding);
            registered = true;
          }
          if (!channelWebhooks && !registered) reject(409, "channel_webhook_unavailable", "Webhook delivery is not configured here.");
          // Drain what the webhook already verified through the existing sync path.
          const result = channelWebhooks ? await syncTelegramConnection({ store, token, binding, connectionId, requestId: data.requestId, updates: null, webhooks: channelWebhooks }) : null;
          return json(res, result && !result.duplicate ? 201 : 200, { ...liveRecord(connectionId), registered, receipt: result?.receipt ?? null,
            duplicate: result?.duplicate ?? false, source: result?.source ?? null, imported: result?.receipt.imports?.length ?? null });
        }
        const sync = routePattern(connectionRoutes.sync).exec(url.pathname);
        if (sync && req.method === "POST") {
          protectWrite(req, auth, false); rate(`inbox-sync:${auth.account.id}`, 60);
          // Recorded imports are local-only (like sample sending) and fixture-mode only.
          if (!loopback) reject(403, "channel_sync_local_only", "Recorded imports are local only.");
          const connectionId = pathId(sync[1]), data = await body(req);
          if (!exact(data, ["requestId", "updates"]) || !validId(data.requestId) || !(data.updates === null || Array.isArray(data.updates)))
            reject(422, "invalid_channel_update", "Supply a request ID and recorded updates, or null to import webhook updates.");
          const result = await syncTelegramConnection({ store, token, binding, connectionId, requestId: data.requestId, updates: data.updates, webhooks: channelWebhooks });
          return json(res, result.duplicate ? 200 : 201, { ...store.connections.connectionRecord(token, connectionId, binding), receipt: result.receipt, duplicate: result.duplicate, source: result.source });
        }
        const source = /^\/api\/inbox\/sources\/([^/]{1,384})(?:\/(share-context|room-results|send-context|sends))?$/.exec(url.pathname);
        if (source && req.method === "GET") {
          const id = pathId(source[1]);
          if (source[2] === "send-context") return json(res, 200, { ...store.inbox.sendContext(token, id, binding), simulationAvailable: Boolean(syntheticInboxTransport), channelSend: channelSendView(channelSendFor(id)) });
          if (source[2] === "sends") return json(res, 200, { ...store.inbox.sends(token, id, binding), simulationAvailable: Boolean(syntheticInboxTransport), channelSend: channelSendView(channelSendFor(id)) });
          if (source[2]) {
            const roomId = url.searchParams.get("roomId");
            if (!roomId || url.searchParams.getAll("roomId").length !== 1) reject(422, "invalid_room", "Choose a room.");
            if (source[2] === "room-results") {
              if (url.searchParams.getAll("workItemId").length > 1) reject(422, "invalid_inbox_result", "Choose a result.");
              return json(res, 200, store.inbox.results(token, id, roomId, binding, url.searchParams.get("workItemId")));
            }
            return json(res, 200, store.inbox.shareContext(token, id, roomId, binding));
          }
          return json(res, 200, store.inbox.read(token, id, binding, { emailView: view !== null, excerptView: view === "email-excerpt-v1" }));
        }
        if (url.pathname === "/api/inbox/commands" && req.method === "POST") {
          protectWrite(req, auth, false); rate(`inbox:${auth.account.id}`, 60);
          const result = store.inbox.apply(token, await body(req), binding);
          return json(res, result.duplicate ? 200 : 201, result);
        }
        if (url.pathname === connectionRoutes.channelSends && req.method === "POST") {
          // Reply from the Inbox through a channel transport (Telegram today). The
          // owner's session plus CSRF is the authority; the journal already holds
          // the queued attempt, so this only dispatches or reconciles it.
          protectWrite(req, auth, false); rate(`inbox-channel-send:${auth.account.id}`, 30);
          const data = await body(req);
          if (!data || !exact(data, ["action", "sourceId", "sendId"]) || !["dispatch", "reconcile"].includes(data.action)
            || !validId(data.sourceId) || !validId(data.sendId)) reject(422, "invalid_inbox_send", "Choose the existing channel reply.");
          const sender = channelSendFor(data.sourceId);
          if (!sender) reject(409, "channel_sending_unavailable", "Sending is not enabled for this channel.");
          const send = await sender.transport[data.action](token, data.sourceId, data.sendId, binding);
          const last = telegramStatus.snapshot(auth.account.id, sender.connectionId).lastSendResult;
          return json(res, 200, { ...store.inbox.sends(token, data.sourceId, binding), simulationAvailable: Boolean(syntheticInboxTransport), channelSend: channelSendView(sender), send,
            lastSendResult: last ? { at: new Date(last.at).toISOString(), outcome: last.outcome, code: last.code } : null });
        }
        if (url.pathname === "/api/inbox/simulation" && req.method === "POST") {
          protectWrite(req, auth, false); rate(`inbox-simulation:${auth.account.id}`, 60);
          if (!loopback) reject(403, "inbox_simulation_local_only", "Sample sending is local only.");
          if (!syntheticInboxTransport) reject(409, "inbox_simulation_unavailable", "Sample sending is unavailable here.");
          const data = await body(req);
          if (!data || !exact(data, ["action", "sourceId", "sendId"]) || !["dispatch", "reconcile"].includes(data.action)
            || !validId(data.sourceId) || !validId(data.sendId)) reject(422, "invalid_inbox_send", "Choose the existing sample reply.");
          const send = await syntheticInboxTransport[data.action](token, data.sourceId, data.sendId, binding);
          return json(res, 200, { ...store.inbox.sends(token, data.sourceId, binding), simulationAvailable: true, send });
        }
        reject(404, "not_found", "Inbox route not found.");
      }
      if (url.pathname === "/api/account-rooms" && req.method === "GET") {
        const token = cookie(req, accountCookieName), binding = accountBinding(req);
        if (url.searchParams.getAll("after").length > 1) reject(422, "invalid_room", "Invalid room continuation");
        return json(res, 200, store.accountRooms(token, binding, { after: url.searchParams.get("after") }));
      }
      if (url.pathname === "/api/account-rooms" && req.method === "POST") {
        // Issue #6 A2: create a room for the signed-in account. Account session
        // cookie + X-Session-Binding + CSRF; the store requires membership
        // administration somewhere (owner or manage_members) and bounds the count.
        const token = cookie(req, accountCookieName), binding = accountBinding(req);
        const auth = store.authenticateAccountSession(token, null, binding);
        protectWrite(req, auth, false); rate(`account-room-create:${auth.account.id}`, 10);
        const result = store.createAccountRoom(token, binding, await body(req));
        return json(res, result.duplicate ? 200 : 201, result);
      }
      if (url.pathname === "/api/account-session") {
        const slotToken = cookie(req, accountCookieName);
        if (req.method === "GET") {
          if (!slotToken) {
            rate(`account-slot:${remoteAddress}`, 20);
            const created = store.createAccountSessionSlot();
            setCookie(res, accountCookieName, created.token, Math.max(0, Math.floor((created.session.expiresAt - store.now()) / 1000)));
            return json(res, 200, accountView(created.session));
          }
          let slot;
          try { slot = store.authenticateAccountSession(slotToken); }
          catch (error) {
            if (error.status !== 401) throw error;
            try { slot = store.accountSessionSlot(slotToken); }
            catch (slotError) {
              if (slotError.status !== 401) throw slotError;
              rate(`account-slot:${remoteAddress}`, 20);
              const created = store.createAccountSessionSlot();
              setCookie(res, accountCookieName, created.token, Math.max(0, Math.floor((created.session.expiresAt - store.now()) / 1000)));
              slot = created.session;
            }
          }
          return json(res, 200, accountView(slot));
        }
        checkOrigin(req, true);
        if (!slotToken) reject(401, "account_session_required", "Start an account browser session before signing in");
        const slot = store.accountSessionSlot(slotToken);
        protectWrite(req, slot, false);
        const data = await body(req);
        if (req.method === "POST") {
          if (!exact(data, ["accountAccessKey", "expectedSessionRevision"]) || typeof data.accountAccessKey !== "string") reject(422, "invalid_login", "An account key and current session revision are required");
          rate(`account-login:${remoteAddress}:${slot.credentialHash}`, 10);
          const oldRoomToken = cookie(req, roomCookieName);
          const loggedIn = store.loginAccountSession(slotToken, data.accountAccessKey, data.expectedSessionRevision, {
            revokeRoomToken: oldRoomToken && tokenPattern.test(oldRoomToken) ? oldRoomToken : null
          });
          return json(res, 201, accountView(loggedIn));
        }
        if (req.method === "DELETE") {
          if (!exact(data, ["expectedSessionRevision"])) reject(422, "invalid_logout", "Current session revision required");
          return json(res, 200, accountView(store.logoutAccountSession(slotToken, data.expectedSessionRevision)));
        }
        reject(405, "method_not_allowed", "Method not allowed");
      }
      if (url.pathname === "/api/guest-agent-links" && ["GET", "HEAD"].includes(req.method)) {
        return json(res, 200, guestAgentLinkContract(), req.method === "HEAD");
      }
      if (url.pathname === "/api/work-item-sessions" && ["GET", "HEAD"].includes(req.method)) {
        return json(res, 200, workItemSessionContract(), req.method === "HEAD");
      }
      if (url.pathname === "/api/guest-agent-links" && req.method === "POST") {
        checkOrigin(req, true);
        rate(`guest-agent-mint:${remoteAddress}`, 30);
        const selected = roomCredentials(req, url);
        if (!selected.token) reject(401, "unauthenticated", "Ask the owner to mint a guest-agent credential or Add agent.");
        const data = await body(req);
        if (typeof data.roomId !== "string" || !validId(data.roomId)) reject(422, "invalid_link", "Supply the room and guest-agent mint fields");
        const fence = selected.mode === "account" ? accountBinding(req) : expectedBinding(req);
        const auth = selected.mode === "account" ? store.authenticateAccountSession(selected.token, data.roomId, fence)
          : store.authenticate(selected.token, data.roomId, fence, { allowAccountSession: false });
        if (selected.bearer && auth.credentialScope !== "room") reject(403, "access_denied", "Bearer account sessions are not accepted");
        if (!selected.bearer && auth.kind !== "session") reject(401, "unauthenticated", "Browser session required");
        protectWrite(req, auth, selected.bearer);
        const result = store.guestAgentLinks.mint(selected.token, data.roomId, data, fence);
        return json(res, result.duplicate ? 200 : 201, result);
      }
      if (url.pathname === "/api/guest-agent-links/preview" && req.method === "POST") {
        checkOrigin(req, true);
        rate(`guest-agent-preview:${remoteAddress}`, 30);
        const data = await body(req);
        if (!exact(data, ["linkToken"])) reject(422, "invalid_link", "Guest-agent link required");
        return json(res, 200, store.guestAgentLinks.preview(data.linkToken));
      }
      if (url.pathname === "/api/guest-agent-links/join" && req.method === "POST") {
        checkOrigin(req, true);
        rate(`guest-agent-join:${remoteAddress}`, 20);
        const data = await body(req);
        if (!exact(data, ["linkToken"])) reject(422, "invalid_link", "Guest-agent link required");
        return json(res, 200, store.guestAgentLinks.join(data.linkToken));
      }
      if (url.pathname === "/api/share-links/preview" && req.method === "POST") {
        checkOrigin(req, true);
        rate(`link-preview:${remoteAddress}`, 30);
        const data = await body(req);
        if (!exact(data, ["linkToken"])) reject(422, "invalid_link", "Invitation link required");
        return json(res, 200, store.shareLinks.preview(data.linkToken));
      }
      if (url.pathname === "/api/share-links/join" && req.method === "POST") {
        checkOrigin(req, true);
        const token = cookie(req, accountCookieName), slot = store.accountSessionSlot(token);
        protectWrite(req, slot, false);
        const binding = accountBinding(req);
        const data = await body(req);
        if (!exact(data, ["linkToken", "displayName", "redemptionId", "expectedSessionRevision"])) reject(422, "invalid_join", "Supply the invitation link and your name");
        rate(`link-join:${remoteAddress}`, 20);
        const oldRoomToken = cookie(req, roomCookieName);
        const result = store.shareLinks.join(token, data.linkToken, { ...data, expectedSessionBinding: binding,
          revokeRoomToken: oldRoomToken && tokenPattern.test(oldRoomToken) ? oldRoomToken : null });
        return json(res, result.duplicate ? 200 : 201, result);
      }
      if (url.pathname === "/api/invitations/preview" && req.method === "POST") {
        checkOrigin(req, true);
        rate(`invitation-preview:${remoteAddress}`, 30);
        const data = await body(req);
        if (!exact(data, ["invitationToken"]) || typeof data.invitationToken !== "string") reject(422, "invalid_invitation", "Invitation token required");
        return json(res, 200, store.previewInvitation(data.invitationToken));
      }
      if (url.pathname === "/api/invitations/accept" && req.method === "POST") {
        checkOrigin(req, true);
        const slotToken = cookie(req, accountCookieName);
        const auth = store.authenticateAccountSession(slotToken);
        protectWrite(req, auth, false);
        const data = await body(req);
        if (!exact(data, ["invitationToken", "redemptionId", "expectedRevision"]) || typeof data.invitationToken !== "string" || typeof data.redemptionId !== "string") reject(422, "invalid_invitation_acceptance", "Invitation token, redemption ID, and expected revision required");
        rate(`invitation-accept:${auth.credentialHash}:${rateHash(data.invitationToken)}`, 20);
        const result = store.acceptInvitation(slotToken, data.invitationToken, { redemptionId: data.redemptionId, expectedRevision: data.expectedRevision, expectedSessionBinding: auth.sessionBinding });
        return json(res, result.duplicate ? 200 : 201, result);
      }
      if (url.pathname === "/api/session" && req.method === "POST") {
        checkOrigin(req, true);
        rate(`login:${remoteAddress}`, 10);
        const data = await body(req);
        if (!exact(data, ["accessKey"]) || typeof data.accessKey !== "string") reject(422, "invalid_login", "An access key is required");
        const { token, session } = store.createSession(data.accessKey);
        setCookie(res, roomCookieName, token, Math.max(0, Math.floor((session.expiresAt - store.now()) / 1000)));
        return json(res, 201, sessionView(session));
      }
      if (!url.pathname.startsWith("/api/")) reject(404, "not_found", "Not found");
      if (url.pathname === "/api/session") {
        const selectedRoom = url.searchParams.get("room");
        const authMode = selectedRoom !== null || req.headers["x-project-room-auth"] === "account" ? "account" : "room";
        if (authMode === "account" && req.headers.authorization) reject(403, "access_denied", "Account browser sessions do not use bearer authorization");
        const token = authMode === "account" ? cookie(req, accountCookieName) : (bearer(req) ?? cookie(req, roomCookieName));
        const auth = authMode === "account" ? store.authenticateAccountSession(token, selectedRoom, accountBinding(req))
          : store.authenticate(token, undefined, expectedBinding(req), { allowAccountSession: false });
        const isBearer = Boolean(req.headers.authorization);
        if (!isBearer && auth.kind !== "session") reject(401, "unauthenticated", "Browser session required");
        if (req.method === "GET") return json(res, 200, sessionView(auth));
        if (req.method === "DELETE") {
          protectWrite(req, auth, isBearer);
          if (authMode === "account") store.logoutAccountSession(token, auth.sessionRevision);
          else store.revoke(token);
          return json(res, 200, { signedOut: true });
        }
        reject(405, "method_not_allowed", "Method not allowed");
      }
      const revokeMatch = /^\/api\/rooms\/([^/]{1,384})\/invitations\/([^/]{1,384})\/revoke$/.exec(url.pathname);
      // Round-2 #101: creating an agent identity is open (an identity alone
      // grants nothing); linking it into a room is owner-only per room.
      // Because the route is unauthenticated it is bounded twice: the
      // per-address rate limit here, and the IDENTITY_LIMIT table cap that
      // store.identities.create enforces inside its insert transaction
      // (409 pilot_limit, no row written) — like the credentials table.
      if (url.pathname === "/api/agent-identities" && req.method === "POST") {
        rate(`identity-create:${remoteAddress}`, 30);
        const data = await body(req);
        if (!exact(data, ["displayName"]) || typeof data.displayName !== "string") reject(422, "invalid_identity", "displayName is required");
        return json(res, 201, store.identities.create(data.displayName));
      }
      // Agent invite codes: redemption is unauthenticated (the code is the
      // bearer credential); issuance is owner-only per room.
      if (url.pathname === "/api/agent-invites/redeem" && req.method === "POST") {
        rate(`invite-redeem:${remoteAddress}`, 20);
        const data = await body(req);
        if (!exact(data, ["code", "displayName"]) || typeof data.code !== "string" || typeof data.displayName !== "string") reject(422, "invalid_invite", "Invite code and displayName are required");
        return json(res, 201, store.invites.redeem(data.code, { displayName: data.displayName }));
      }
      // Self-serve access requests: an identity without membership asks to
      // join. Unauthenticated (the identity is not a member yet); the
      // module rate-limits per identity and never reveals more than 404.
      if (url.pathname === "/api/access-requests" && req.method === "POST") {
        const data = await body(req);
        if (!exact(data, ["roomId", "identityId", "displayName", "requestedPermissions", "note", "requestId"])) {
          reject(422, "invalid_request", "roomId, identityId, displayName, requestedPermissions, note, requestId are the accepted fields");
        }
        return json(res, 201, accessRequests.request(data.roomId, data));
      }
      const accessStatusMatch = /^\/api\/access-requests\/([^/]{1,64})$/.exec(url.pathname);
      if (accessStatusMatch && req.method === "GET") {
        const identityId = url.searchParams.get("identityId");
        if (!identityId) reject(422, "invalid_request", "identityId query param is required");
        return json(res, 200, accessRequests.status(pathId(accessStatusMatch[1]), identityId));
      }
      const match = /^\/api\/rooms\/([^/]{1,384})(?:\/(commands|events|stream|cursor|return-brief|work-changes|work-context|work-discussion|work-result|work-sessions|presence|capabilities|onboarding-funnel|export|import|charter|reply-requests|reply-context|reply-history|invitations|share-links|share-links-cancel|reminders|reports|agent-connections|guest-agent-links|diagnostics|diagnostics-export|search|pins|provider-heartbeats|identity-links|agent-invites|agent-pause|access-review|access-requests|usage|notifications|spend-allowance))?$/.exec(url.pathname);
      // Round-2 #112: threaded replies share the room funnel below (id decoding,
      // credential selection, read rate limit) with every other room route.
      const threadMatch = /^\/api\/rooms\/([^/]{1,384})\/messages\/([^/]{1,384})\/thread$/.exec(url.pathname);
      const accessDecideMatch = /^\/api\/rooms\/([^/]{1,384})\/access-requests\/([^/]{1,64})\/decide$/.exec(url.pathname);
      if (!match && !revokeMatch && !threadMatch && !accessDecideMatch) reject(404, "not_found", "Not found");
      const roomId = pathId((match ?? revokeMatch ?? threadMatch ?? accessDecideMatch)[1]);
      const invitationId = revokeMatch ? pathId(revokeMatch[2]) : null;
      const threadMessageId = threadMatch ? pathId(threadMatch[2]) : null;
      const accessRequestId = accessDecideMatch ? pathId(accessDecideMatch[2]) : null;
      const route = match ? (match[2] ?? "") : revokeMatch ? "invitation-revoke" : threadMatch ? "thread" : "access-decide";
      const selected = roomCredentials(req, url);
      const fence = selected.mode === "account" ? accountBinding(req, route === "stream" ? url : null) : expectedBinding(req);
      const auth = selected.mode === "account" ? store.authenticateAccountSession(selected.token, roomId, fence)
        : store.authenticate(selected.token, roomId, fence, { allowAccountSession: false });
      if (selected.bearer && auth.credentialScope !== "room") reject(403, "access_denied", "Bearer account sessions are not accepted");
      if (!selected.bearer && auth.kind !== "session") reject(401, "unauthenticated", "Browser session required");
      rate(`read:${auth.credentialHash}`, 600);
      if (!["GET", "HEAD"].includes(req.method)) { protectWrite(req, auth, selected.bearer); rate(`write:${auth.credentialHash}`, 60); }
      if (route === "thread" && req.method === "GET") return json(res, 200, store.messageThread(selected.token, roomId, threadMessageId, fence));
      if (!route && req.method === "GET") {
        const params = url.searchParams;
        if (params.has("view") && (params.getAll("view").length !== 1 || params.get("view") !== "work"
          || [...params.keys()].some(key => !["view", "auth"].includes(key) || params.getAll(key).length !== 1))) {
          reject(422, "invalid_snapshot_view", "Choose a supported snapshot view");
        }
        const helpContext = req.headers["x-project-room-help-context"];
        if (helpContext !== undefined && (helpContext !== "1" || !params.has("view"))) reject(422, "invalid_help_context", "Choose version 1 with the current work view");
        const offerContext = req.headers["x-project-room-offer-context"];
        if (offerContext !== undefined && (offerContext !== "1" || params.has("view"))) reject(422, "invalid_offer_context", "Choose version 1 with the full room view");
        return json(res, 200, store.snapshot(selected.token, roomId, fence, params.has("view") ? "work" : "full", helpContext === "1", offerContext === "1"));
      }
      if (["reply-requests", "reply-context", "reply-history"].includes(route) && req.method === "GET") {
        const params = url.searchParams, names = route === "reply-requests" ? ["direction", "status"]
          : route === "reply-context" ? ["requestMessageId", "cursor", "limit"] : ["direction", "cursor", "checkpoint", "limit"];
        if ([...params.keys()].some(key => ![...names, "auth"].includes(key) || params.getAll(key).length !== 1)
          || params.has("limit") && !/^[1-9]\d*$/.test(params.get("limit"))) reject(422, "invalid_reply_selection", "Invalid request selection");
        const options = Object.fromEntries(names.filter(key => key !== "requestMessageId" && params.has(key)).map(key => [key, key === "limit" ? Number(params.get(key)) : params.get(key)]));
        options.expectedSessionBinding = fence;
        const value = route === "reply-requests" ? store.replyRequests.list(selected.token, roomId, options)
          : route === "reply-context" ? store.replyRequests.selected(selected.token, roomId, params.get("requestMessageId"), options)
          : store.replyRequests.history(selected.token, roomId, options);
        return json(res, 200, value);
      }
      if (route === "work-changes" && req.method === "GET") {
        // F3: derived read-time change list for one work item; never a write.
        const params = url.searchParams;
        if ([...params.keys()].some(key => !["workItemId", "since", "auth"].includes(key) || params.getAll(key).length !== 1)
          || !params.has("workItemId") || params.has("since") && !/^(0|[1-9]\d*)$/.test(params.get("since"))) reject(422, "invalid_history_selection", "Choose a work item and optional basis revision");
        return json(res, 200, store.workItemHistory(selected.token, roomId, params.get("workItemId"), fence, params.has("since") ? Number(params.get("since")) : null));
      }
      if (route === "charter" && req.method === "GET") {
        const params = url.searchParams;
        if ([...params.keys()].some(key => !["revision", "auth"].includes(key) || params.getAll(key).length !== 1)
          || params.has("revision") && !/^(0|[1-9]\d*)$/.test(params.get("revision"))) reject(422, "invalid_charter_revision", "Choose an instructions version");
        return json(res, 200, store.charter(selected.token, roomId, { ...(params.has("revision") ? { revision: Number(params.get("revision")) } : {}), expectedSessionBinding: fence }));
      }
      if (route === "work-context" && req.method === "GET") {
        const params = url.searchParams;
        const offerContext = req.headers["x-project-room-offer-context"];
        if (offerContext !== undefined && offerContext !== "1") reject(422, "invalid_offer_context", "Choose offer context version 1");
        if ([...params.keys()].some(key => !["workItemId", "includeSource", "auth"].includes(key) || params.getAll(key).length !== 1)
          || (params.has("includeSource") && !["true", "false"].includes(params.get("includeSource")))) {
          reject(422, "invalid_work_context", "Choose one work ID and an optional source inclusion flag");
        }
        return json(res, 200, store.workContext(selected.token, roomId, params.get("workItemId"), {
          includeSource: params.get("includeSource") === "true", includeOffers: offerContext === "1", expectedSessionBinding: fence
        }));
      }
      if (route === "work-result" && req.method === "GET") {
        const params = url.searchParams;
        if ([...params.keys()].some(key => !["workItemId", "completionEventId", "draftMessageId", "auth"].includes(key) || params.getAll(key).length !== 1)) reject(422, "invalid_result_selection", "Invalid result selection");
        return json(res, 200, store.workResult(selected.token, roomId, params.get("workItemId"), {
          completionEventId: params.get("completionEventId"), draftMessageId: params.get("draftMessageId"), expectedSessionBinding: fence
        }));
      }
      if (route === "capabilities" && req.method === "GET") {
        const search = url.searchParams.get("search");
        return json(res, 200, store.capabilities(selected.token, roomId, { search, expectedSessionBinding: fence }));
      }
      if (route === "onboarding-funnel" && req.method === "GET") {
        return json(res, 200, store.onboardingFunnel(selected.token, roomId, fence));
      }
      if (route === "search" && req.method === "GET") {
        // Round-2 #113: full-text search over messages and work items.
        const q = url.searchParams.get("q");
        const kind = url.searchParams.get("kind") ?? "all";
        return json(res, 200, store.search(selected.token, roomId, q, kind, fence));
      }
      if (route === "usage" && req.method === "GET") {
        // F5: read-only per-room usage summary. Member-visible like the
        // sibling dashboards: every figure derives from data a member can
        // already read (membership snapshot, work-session spend, events).
        const params = url.searchParams;
        if ([...params.keys()].some(key => !["days", "auth"].includes(key) || params.getAll(key).length !== 1)) reject(422, "invalid_usage_period", "Choose an optional number of days only");
        return json(res, 200, roomUsageSummary(store, selected.token, roomId, { days: parseUsageDays(params.get("days")), expectedSessionBinding: fence }));
      }
      if (route === "pins") {
        // Issue #6 B2: pinned messages. GET lists the ordered pins; POST pins or unpins one message (server/pins.mjs).
        if (req.method === "GET") return json(res, 200, listPins(store, selected.token, roomId, fence));
        if (req.method === "POST") {
          const result = setPin(store, selected.token, roomId, await body(req), fence);
          return json(res, result.changed ? 201 : 200, result); // 201 when an event was appended, 200 when the room was already in that state or the requestId replayed
        }
        reject(405, "method_not_allowed", "Method not allowed");
      }
      if (route === "provider-heartbeats" && req.method === "GET") {
        // Round-2 #118: provider heartbeat dashboard.
        return json(res, 200, store.providerHeartbeats(selected.token, roomId, fence));
      }
      if (route === "identity-links") {
        // Round-2 #101: multi-room agent identity links.
        const data = req.method === "GET" ? {} : await body(req);
        if (req.method === "GET") return json(res, 200, { roomId, links: store.identities.list(selected.token, roomId, fence) });
        if (req.method === "POST") {
          const keys = Object.keys(data);
          if (!keys.includes("identityId") || !keys.includes("permissions")
            || keys.some(k => !["identityId", "memberId", "displayName", "permissions"].includes(k))
            || typeof data.identityId !== "string") reject(422, "invalid_identity", "identityId and permissions are required");
          return json(res, 201, store.identities.link(selected.token, roomId, data, fence));
        }
        if (req.method === "DELETE") {
          if (!exact(data, ["identityId"]) || typeof data.identityId !== "string") reject(422, "invalid_identity", "identityId is required");
          return json(res, 200, store.identities.unlink(selected.token, roomId, data.identityId, fence));
        }
        reject(405, "method_not_allowed", "Method not allowed");
      }
      if (route === "agent-invites") {
        // One-time agent invite codes: owner-only issuance, audit, revocation.
        const data = req.method === "GET" ? {} : await body(req);
        if (req.method === "GET") return json(res, 200, { roomId, invites: store.invites.list(selected.token, roomId, fence) });
        if (req.method === "POST") {
          const keys = Object.keys(data);
          if ((!keys.includes("permissions") && !keys.includes("profile"))
            || keys.some(k => !["permissions", "profile", "expiresInMinutes", "displayName"].includes(k)))
            reject(422, "invalid_invite", "permissions or profile is required; optional: expiresInMinutes, displayName");
          return json(res, 201, store.invites.create(selected.token, roomId, data, fence));
        }
        if (req.method === "DELETE") {
          if (!exact(data, ["inviteId"]) || typeof data.inviteId !== "string") reject(422, "invalid_invite", "inviteId is required");
          return json(res, 200, store.invites.revoke(selected.token, roomId, data.inviteId, fence));
        }
        reject(405, "method_not_allowed", "Method not allowed");
      }
      if (route === "export" && req.method === "GET") {
        // Round-2 #106: JSONL export of the event log (same visibility as
        // the events route — members only). One {sequence, event} per line.
        // The log is bounded (10000 events per room, the same bound import
        // enforces), so the whole export is materialised before any header
        // is written: an auth, fence or storage failure part-way through
        // takes the normal JSON error path instead of truncating a 200 body
        // that would read as a valid, merely shorter, export. Content-Length
        // lets clients treat a dropped connection as an incomplete download.
        //
        // BUILD-01 F2: ?format=html renders the same event walk as one
        // self-contained document for people (server/room-export-html.mjs).
        // Same auth, same materialise-then-answer rule, same Content-Length
        // framing; the CSP header pins the document's single style block and
        // forbids everything else, so a browser that opens it inline runs
        // nothing.
        const format = url.searchParams.get("format") ?? "jsonl";
        if (!["jsonl", "html"].includes(format) || url.searchParams.getAll("format").length > 1) reject(422, "invalid_format", "format is jsonl (default) or html");
        if (format === "html") {
          const rows = [...store.exportEvents(selected.token, roomId, fence)];
          const bytes = Buffer.from(renderRoomExportHtml(rows, { roomId }), "utf8");
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": bytes.length,
            "Content-Security-Policy": EXPORT_HTML_CSP,
            "Content-Disposition": `attachment; filename="room-${roomId}-export.html"` });
          return res.end(bytes);
        }
        const lines = [];
        for (const line of store.exportEvents(selected.token, roomId, fence)) lines.push(JSON.stringify(line) + "\n");
        const bytes = Buffer.from(lines.join(""), "utf8");
        res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Content-Length": bytes.length,
          "Content-Disposition": `attachment; filename="room-${roomId}-export.jsonl"` });
        return res.end(bytes);
      }
      if (route === "import" && req.method === "POST") {
        // Round-2 #107: NDJSON import (the #106 export format). Owner-only,
        // replaces room history. 8MB cap — larger restores go through backup.
        if (!/^application\/x-ndjson/i.test(req.headers["content-type"] || "")) reject(415, "ndjson_required", "Use application/x-ndjson");
        const text = await readText(req, 8 * 1024 * 1024, () => new ServiceError(413, "too_large", "Import is too large; use database backup instead"));
        // Number lines before dropping blanks so the reported line matches the file.
        const lines = text.split("\n").map((l, i) => [l, i + 1]).filter(([l]) => l.trim()).map(([l, lineNumber]) => {
          try { return JSON.parse(l); } catch { reject(422, "invalid_import", `Line ${lineNumber} is not valid JSON`); }
        });
        return json(res, 200, store.importEvents(selected.token, roomId, lines, fence));
      }
      if (route === "presence" && req.method === "GET") {
        const watchers = [...streams].filter(entry => entry.roomId === roomId).map(entry => entry.memberId);
        return json(res, 200, store.presence(selected.token, roomId, watchers, fence));
      }
      if (route === "work-sessions" && req.method === "GET") {
        const params = url.searchParams;
        if ([...params.keys()].some(key => !["status", "auth"].includes(key) || params.getAll(key).length !== 1)
          || (params.has("status") && !isSessionStatus(params.get("status")))) {
          reject(422, "invalid_session_status", "Choose one session status");
        }
        return json(res, 200, store.workSessions(selected.token, roomId, {
          status: params.get("status"), expectedSessionBinding: fence
        }));
      }
      if (route === "work-sessions" && req.method === "POST") {
        const result = store.mutateWorkSession(selected.token, roomId, await body(req), fence);
        return json(res, result.duplicate ? 200 : 201, result);
      }
      if (route === "spend-allowance" && req.method === "GET") {
        // C3: room spend allowance with spent, reserved and headroom. Member-readable: derived from work-session state members already see.
        if ([...url.searchParams.keys()].some(key => key !== "auth")) reject(422, "invalid_spend_allowance", "This read takes no parameters");
        return json(res, 200, readSpendAllowance(store, selected.token, roomId, fence));
      }
      if (route === "spend-allowance" && req.method === "POST") {
        const result = setSpendAllowance(store, selected.token, roomId, await body(req), fence); // owner-only (403 owner_required)
        return json(res, result.duplicate ? 200 : 201, result);
      }
      if (route === "work-discussion" && req.method === "GET") {
        const params = url.searchParams;
        if ([...params.keys()].some(key => !["workItemId", "cursor", "since", "limit", "auth"].includes(key) || params.getAll(key).length !== 1)
          || ["since", "limit"].some(key => params.has(key) && !/^(0|[1-9]\d*)$/.test(params.get(key)))) reject(422, "invalid_discussion", "Invalid discussion selection");
        return json(res, 200, store.workDiscussion(selected.token, roomId, params.get("workItemId"), {
          cursor: params.get("cursor"), ...(params.has("since") ? { since: Number(params.get("since")) } : {}),
          ...(params.has("limit") ? { limit: Number(params.get("limit")) } : {}), expectedSessionBinding: fence
        }));
      }
      if (route === "reminders" && req.method === "GET") return json(res, 200, store.reminders.list(selected.token, roomId, fence));
      if (route === "notifications" && req.method === "GET") {
        // B4: per-member feed derived from the event tail after the member's cursor. Read model only; the
        // store method re-authenticates membership, and the read rate limit above already covers it.
        const params = url.searchParams;
        if ([...params.keys()].some(key => !["limit", "auth"].includes(key) || params.getAll(key).length !== 1)) reject(422, "invalid_notification_selection", "Choose an optional limit only");
        if (params.has("limit") && !/^[1-9]\d*$/.test(params.get("limit"))) reject(422, "invalid_notification_limit", "Choose a positive limit");
        return json(res, 200, store.notifications.list(selected.token, roomId, fence, params.has("limit") ? { limit: Number(params.get("limit")) } : {}));
      }
      if (route === "agent-connections" && req.method === "GET") return json(res, 200, store.agentConnections.list(selected.token, roomId, fence));
      if (route === "diagnostics" && req.method === "GET") {
        store.agentConnections.owner(selected.token, roomId, fence);
        return json(res, 200, { diagnostics: diagnostics.list(roomId) });
      }
      if (route === "diagnostics-export" && req.method === "GET") {
        // W4-57 M6: sanitized support-export bundle. Owner-only, but accepts the
        // owner's room bearer as well as a signed-in account session, so the
        // CLI (bearer-only) can pull it. Whitelisted scalar fields only — no
        // credentials, hashes, bodies, or member details.
        const exportAuth = store.authenticate(selected.token, roomId, fence);
        if (exportAuth.member.kind !== "human" || exportAuth.member.id !== store.room(roomId).state.room.ownerId
          || !exportAuth.member.permissions.includes("manage_members")) {
          reject(403, "owner_required", "Only the room owner can export diagnostics");
        }
        const bundle = supportExportBundle({ roomId, roomTitle: store.room(roomId).state.room.title,
          service: { sourceRevision: SOURCE_REVISION, buildId: BUILD_ID, mode: serviceMode },
          diagnostics: diagnostics.list(roomId) });
        res.setHeader("Content-Disposition", `attachment; filename="room-${roomId}-support-export.json"`);
        return json(res, 200, bundle);
      }
      if (route === "agent-pause" && req.method === "GET") {
        // C6: wake-pause state for the caller, or (signed-in owner) one named
        // member plus the room's paused roster. Authorization is store-level.
        const params = url.searchParams;
        if ([...params.keys()].some(key => !["memberId", "auth"].includes(key) || params.getAll(key).length !== 1)) reject(422, "invalid_pause_selection", "Choose at most one member");
        return json(res, 200, store.wakeQueue.inspect(selected.token, roomId, { memberId: params.get("memberId") }, fence));
      }
      if (route === "agent-pause" && req.method === "POST") {
        // C6: pause or resume a member's queued wakes (own row, or owner over
        // another member). Draft class: nothing is sent, launched or spent.
        const data = await body(req);
        const fields = data.action === "resume" ? ["action", "memberId", "requestId"] : ["action", "memberId", "requestId", "reason"];
        if (!["pause", "resume"].includes(data.action) || !exact(data, fields) || typeof data.memberId !== "string") reject(422, "invalid_pause_command", "Supply action (pause or resume), memberId, requestId and, for pause, reason or null");
        const target = { memberId: data.memberId };
        const result = data.action === "pause" ? store.wakeQueue.pause(selected.token, roomId, { requestId: data.requestId, reason: data.reason }, fence, target)
          : store.wakeQueue.resume(selected.token, roomId, { requestId: data.requestId }, fence, target);
        return json(res, result.duplicate ? 200 : 201, result);
      }
      if (route === "access-review" && req.method === "GET") {
        // BUILD-01 D4: owner-only periodic access review; assembly lives in
        // server/access-review.mjs and is shared with scripts/access-review.mjs.
        return json(res, 200, accessReviewReport(store, selected.token, roomId, fence));
      }
      if (route === "access-requests" && req.method === "GET") {
        const status = url.searchParams.get("status") ?? "pending";
        return json(res, 200, { roomId, requests: accessRequests.list(selected.token, roomId, { status }, fence) });
      }
      if (route === "access-decide" && req.method === "POST") {
        const data = await body(req);
        if (!exact(data, ["decision", "permissions", "note"])) {
          reject(422, "invalid_request", "decision, permissions, note are the accepted fields");
        }
        return json(res, 200, accessRequests.decide(selected.token, roomId, accessRequestId, data, fence));
      }
      if (route === "agent-connections" && req.method === "POST") {
        const result = store.agentConnections.apply(selected.token, roomId, await body(req), fence);
        return json(res, result.duplicate ? 200 : 201, result);
      }
      if (route === "guest-agent-links" && req.method === "POST") {
        rate(`guest-agent-mint:${remoteAddress}`, 30);
        const result = store.guestAgentLinks.mint(selected.token, roomId, await body(req), fence);
        return json(res, result.duplicate ? 200 : 201, result);
      }
      if (route === "reminders" && req.method === "POST") {
        const result = store.reminders.mutate(selected.token, roomId, await body(req), fence);
        return json(res, result.duplicate ? 200 : 201, result);
      }
      // E4 moderation: any member reports a message (own receipt only); the owner alone lists reports.
      if (route === "reports" && req.method === "GET") return json(res, 200, store.moderation.list(selected.token, roomId, fence));
      if (route === "reports" && req.method === "POST") {
        const result = store.moderation.report(selected.token, roomId, await body(req), fence);
        return json(res, result.duplicate ? 200 : 201, result);
      }
      // Invitation links are administered from a signed-in browser session
      // (room-key or account cookie) only, never a bearer key: the store-level
      // administrator() check accepts any human credential, so refuse here.
      if ((route === "share-links" || route === "share-links-cancel") && selected.bearer) reject(403, "access_denied", "Invitation links require a signed-in browser session");
      if (route === "share-links" && req.method === "GET") return json(res, 200, store.shareLinks.list(selected.token, roomId, fence));
      if (route === "share-links" && req.method === "POST") {
        const data = await body(req);
        if (!exact(data, ["requestId", "linkToken", "expiresAt", "maxJoins", "expectedMemberRevision"])) reject(422, "invalid_link", "Supply the exact invitation link settings");
        const result = store.shareLinks.create(selected.token, roomId, data, fence);
        return json(res, result.duplicate ? 200 : 201, result);
      }
      if (route === "share-links-cancel" && req.method === "POST") {
        const data = await body(req);
        if (!exact(data, ["linkId"])) reject(422, "invalid_link", "Select one invitation link to cancel");
        return json(res, 200, store.shareLinks.cancel(selected.token, roomId, data.linkId, fence));
      }
      if (route === "events" && req.method === "GET") {
        const params = url.searchParams;
        return json(res, 200, store.eventsAfter(selected.token, roomId,
          Number(params.get("after") || 0), Number(params.get("limit") || 100),
          { actor: params.get("actor"), since: params.get("since"), until: params.get("until"), expectedSessionBinding: fence }));
      }
      if (route === "stream" && req.method === "GET") return stream(req, res, selected.token, roomId, Number(req.headers["last-event-id"] ?? url.searchParams.get("after") ?? 0), auth, operationId);
      if (route === "commands" && req.method === "POST") {
        const result = store.command(selected.token, roomId, await body(req), fence);
        return json(res, result.duplicate ? 200 : 201, result);
      }
      if (route === "return-brief" && req.method === "GET") {
        const horizon = url.searchParams.get("horizon"), after = url.searchParams.get("after"), cursor = url.searchParams.get("cursor"), limit = url.searchParams.get("limit");
        return json(res, 200, store.returnBrief(selected.token, roomId, { horizon: horizon === null ? null : Number(horizon), after: after === null ? null : Number(after), cursor: cursor === null ? null : Number(cursor), limit: limit === null ? undefined : Number(limit), expectedSessionBinding: fence }));
      }
      if (route === "cursor" && req.method === "POST") {
        const data = await body(req);
        if (!exact(data, ["sequence"])) reject(422, "invalid_cursor", "Supply sequence only");
        return json(res, 200, store.markCaughtUp(selected.token, roomId, data.sequence, fence));
      }
      if (route === "invitations" && req.method === "GET") {
        // Round-2 #108: invite-link analytics.
        if (selected.mode !== "account" || selected.bearer) reject(403, "account_session_required", "Invitation administration requires an account browser session");
        return json(res, 200, store.invitationStats(selected.token, roomId, auth.sessionBinding));
      }
      if (route === "invitations" && req.method === "POST") {
        if (selected.mode !== "account" || selected.bearer) reject(403, "account_session_required", "Invitation administration requires an account browser session");
        const data = await body(req);
        const fields = ["requestId", "invitationToken", "intendedAccountId", "intendedMemberId", "displayName", "role", "expiresAt", "expectedIssuerMemberRevision"];
        if (!exact(data, fields)) reject(422, "invalid_invitation", "Supply the exact invitation scope");
        const result = store.issueInvitation(selected.token, roomId, { requestId: data.requestId, token: data.invitationToken, intendedAccountId: data.intendedAccountId, intendedMemberId: data.intendedMemberId, displayName: data.displayName, role: data.role, expiresAt: data.expiresAt, expectedIssuerMemberRevision: data.expectedIssuerMemberRevision, expectedSessionBinding: auth.sessionBinding });
        return json(res, result.duplicate ? 200 : 201, result);
      }
      if (route === "invitation-revoke" && req.method === "POST") {
        if (selected.mode !== "account" || selected.bearer) reject(403, "account_session_required", "Invitation administration requires an account browser session");
        const data = await body(req);
        if (!exact(data, ["expectedRevision", "reason"])) reject(422, "invalid_invitation_change", "Invitation revision and reason required");
        return json(res, 200, store.revokeInvitation(selected.token, invitationId, { expectedRevision: data.expectedRevision, reason: data.reason, expectedSessionBinding: auth.sessionBinding, expectedRoomId: roomId }));
      }
      reject(405, "method_not_allowed", "Method not allowed");
    } catch (caught) {
      // Storage failures raised outside a store transaction take the same typed 503 and count toward readiness.
      const error = caught instanceof ServiceError ? caught : store.storageFailure?.(caught) ?? caught;
      if (res.headersSent) { res.end(); return; }
      if (error.status === 429) res.setHeader("Retry-After", "60");
      if (error.headers && typeof error.headers === "object") {
        for (const [name, value] of Object.entries(error.headers)) res.setHeader(name, String(value));
      }
      let roomId, workItemId;
      try {
        const parsed = new URL(req.url, expectedOrigin());
        const match = /^\/api\/rooms\/([^/]+)/.exec(parsed.pathname);
        if (match) {
          try { const id = decodeURIComponent(match[1]); if (validId(id)) roomId = id; } catch { /* ignore */ }
        }
        const selected = parsed.searchParams.get("workItemId");
        if (selected && validId(selected)) workItemId = selected;
      } catch { /* ignore */ }
      const httpStatus = error.status || 500;
      const code = error.code || "internal_error";
      const message = error.status ? error.message : "Service could not complete the request; no success is claimed";
      const category = errorCategory(httpStatus, code);
      const route = diagnosticRoute(req.url, roomId);
      if (route) {
        diagnostics.record({ operationId, at: new Date().toISOString(), status: httpStatus, code, category, route, roomId });
        console.warn(`room diagnostic ${operationId} ${httpStatus} ${code} ${category} ${route}`);
      } else if (httpStatus >= 500) {
        // Non-room 5xx (inbox, account session, login) still leave an operator trace.
        console.warn(`service diagnostic ${operationId} ${httpStatus} ${code} ${category} ${serviceRoute(req.url)}`);
      }
      json(res, httpStatus, { ...agentErrorBody({ httpStatus, code, message, roomId, workItemId }), operationId, category });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.closeStreams = () => { for (const { res } of streams) res.end(); };
  server.rateLimitKeys = () => rates.size;
  return server;
}
