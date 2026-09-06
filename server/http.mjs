import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { ServiceError } from "./store.mjs";

const cookieName = "room_session";
const assets = new Map([
  ["/", ["index.html", "text/html"]], ["/index.html", ["index.html", "text/html"]],
  ...["app.js", "client.js", "events.js", "conversation.js"].map(name => [`/src/${name}`, [`src/${name}`, "text/javascript"]]),
  ["/src/styles.css", ["src/styles.css", "text/css"]]
]);
const reject = (status, code, message) => { throw new ServiceError(status, code, message); };
const sessionView = auth => ({ member: auth.member, roomId: auth.roomId, csrf: auth.csrf, expiresAt: auth.expiresAt });

export function createRoomServer({ store, origin, assetRoot = new URL("../", import.meta.url), streamInterval = 1000 }) {
  if (origin) {
    const url = new URL(origin);
    if (url.origin !== origin || !["http:", "https:"].includes(url.protocol)) throw new Error("Origin must be a fixed HTTP(S) origin without a path");
    if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("Non-loopback origins require HTTPS");
  }
  const expectedOrigin = () => origin || `http://127.0.0.1:${server.address().port}`;
  const streams = new Set();
  const rates = new Map();
  function rate(id, maximum) {
    const now = Date.now();
    for (const [k, v] of rates) if (v.until <= now) rates.delete(k);
    if (!rates.has(id) && rates.size >= 2000) reject(429, "rate_limited", "Service is busy; retry later");
    const entry = rates.get(id) || { n: 0, until: now + 60000 };
    entry.n++;
    rates.set(id, entry);
    if (entry.n > maximum) reject(429, "rate_limited", "Too many requests; retry after a minute");
  }
  function credentials(req) {
    if (req.headers.authorization) {
      const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization);
      if (!match) reject(401, "unauthenticated", "Invalid Authorization header");
      return { token: match[1], bearer: true };
    }
    const token = (req.headers.cookie || "").split(";").map(x => x.trim()).find(x => x.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    return { token, bearer: false };
  }
  function checkOrigin(req, required = false) {
    if ((required || req.headers.origin) && req.headers.origin !== expectedOrigin()) reject(403, "origin_denied", "Request origin is not allowed");
  }
  function protectWrite(req, auth, bearer) {
    checkOrigin(req, !bearer);
    if (!bearer) {
      const csrf = req.headers["x-csrf-token"];
      if (auth.kind !== "session" || typeof csrf !== "string" || !/^[a-f0-9]{64}$/.test(csrf) || !auth.csrf || !timingSafeEqual(Buffer.from(csrf), Buffer.from(auth.csrf))) reject(403, "csrf_denied", "Session confirmation required; sign in again");
    }
  }
  function setSessionCookie(res, token, maxAge) {
    res.setHeader("Set-Cookie", `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${expectedOrigin().startsWith("https:") ? "; Secure" : ""}`);
  }
  function json(res, status, value) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(value));
  }
  async function body(req) {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) reject(415, "json_required", "Use application/json");
    if (Number(req.headers["content-length"]) > 16384) { req.resume(); reject(413, "too_large", "Request is too large"); }
    const text = await new Promise((resolve, rejectPromise) => {
      let bytes = 0; const chunks = [];
      req.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > 16384) { chunks.length = 0; rejectPromise(new ServiceError(413, "too_large", "Request is too large")); }
        else chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", rejectPromise);
      req.on("aborted", () => rejectPromise(new ServiceError(400, "aborted", "Request ended early")));
    });
    try { const value = JSON.parse(text); if (!value || Array.isArray(value) || typeof value !== "object") throw new Error(); return value; }
    catch { reject(400, "invalid_json", "Expected a JSON object"); }
  }
  function stream(req, res, token, roomId, after) {
    const auth = store.authenticate(token, roomId);
    store.eventsAfter(token, roomId, after);
    if (streams.size >= 100 || [...streams].filter(s => s.credentialHash === auth.credentialHash).length >= 3) reject(429, "stream_limit", "Close another room connection before opening more");
    res.writeHead(200, { "Content-Type": "text/event-stream", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    const entry = { credentialHash: auth.credentialHash, res };
    streams.add(entry);
    let cursor = after;
    const pump = () => {
      if (res.destroyed || res.writableEnded) return;
      try {
        const batch = store.eventsAfter(token, roomId, cursor);
        if (!batch.events.length && !res.write(": connected transport only\n\n")) res.end();
        for (const item of batch.events) {
          if (!res.write(`id: ${item.sequence}\nevent: room-event\ndata: ${JSON.stringify(item)}\n\n`)) { res.end(); break; }
          cursor = item.sequence;
        }
      } catch { res.end('event: access-ended\ndata: {"message":"Access ended; sign in again"}\n\n'); }
    };
    const timer = setInterval(pump, streamInterval);
    timer.unref();
    res.on("close", () => { clearInterval(timer); streams.delete(entry); });
    pump();
  }
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    try {
      if (req.headers.host !== new URL(expectedOrigin()).host) reject(403, "host_denied", "Unexpected host");
      checkOrigin(req);
      const url = new URL(req.url, expectedOrigin());
      if (url.pathname === "/api/health" && req.method === "GET") return json(res, 200, { status: "ok", mode: "single-node-pilot" });
      if (assets.has(url.pathname) && ["GET", "HEAD"].includes(req.method)) {
        const [path, type] = assets.get(url.pathname);
        const data = await readFile(new URL(path, assetRoot));
        res.writeHead(200, { "Content-Type": `${type}; charset=utf-8` });
        return res.end(req.method === "HEAD" ? undefined : data);
      }
      if (url.pathname === "/api/session" && req.method === "POST") {
        checkOrigin(req, true);
        rate(`login:${req.socket.remoteAddress}`, 10);
        const data = await body(req);
        if (Object.keys(data).length !== 1 || typeof data.accessKey !== "string") reject(422, "invalid_login", "An access key is required");
        const { token, session } = store.createSession(data.accessKey);
        setSessionCookie(res, token, Math.max(0, Math.floor((session.expiresAt - store.now()) / 1000)));
        return json(res, 201, sessionView(session));
      }
      if (!url.pathname.startsWith("/api/")) reject(404, "not_found", "Not found");
      const { token, bearer } = credentials(req);
      const auth = store.authenticate(token);
      if (!bearer && auth.kind !== "session") reject(401, "unauthenticated", "Browser session required");
      rate(`read:${auth.credentialHash}`, 600);
      if (!["GET", "HEAD"].includes(req.method)) {
        protectWrite(req, auth, bearer);
        rate(`write:${auth.credentialHash}`, 60);
      }
      if (url.pathname === "/api/session") {
        if (req.method === "GET") return json(res, 200, sessionView(auth));
        if (req.method === "DELETE") { store.revoke(token); setSessionCookie(res, "", 0); return json(res, 200, { signedOut: true }); }
        reject(405, "method_not_allowed", "Method not allowed");
      }
      const match = /^\/api\/rooms\/([a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127})(?:\/(commands|events|stream|cursor|return-brief))?$/.exec(url.pathname);
      if (!match) reject(404, "not_found", "Not found");
      const [, roomId, route] = match;
      store.authenticate(token, roomId);
      if (!route && req.method === "GET") return json(res, 200, store.snapshot(token, roomId));
      if (route === "events" && req.method === "GET") return json(res, 200, store.eventsAfter(token, roomId, Number(url.searchParams.get("after") || 0), Number(url.searchParams.get("limit") || 100)));
      if (route === "stream" && req.method === "GET") return stream(req, res, token, roomId, Number(req.headers["last-event-id"] ?? url.searchParams.get("after") ?? 0));
      if (route === "commands" && req.method === "POST") {
        const result = store.command(token, roomId, await body(req));
        return json(res, result.duplicate ? 200 : 201, result);
      }
      if (route === "return-brief" && req.method === "GET") {
        const horizon = url.searchParams.get("horizon"), after = url.searchParams.get("after"), cursor = url.searchParams.get("cursor"), limit = url.searchParams.get("limit");
        return json(res, 200, store.returnBrief(token, roomId, { horizon: horizon === null ? null : Number(horizon), after: after === null ? null : Number(after), cursor: cursor === null ? null : Number(cursor), limit: limit === null ? undefined : Number(limit) }));
      }
      if (route === "cursor" && req.method === "POST") {
        const data = await body(req);
        if (Object.keys(data).length !== 1) reject(422, "invalid_cursor", "Supply sequence only");
        return json(res, 200, store.markCaughtUp(token, roomId, data.sequence));
      }
      reject(405, "method_not_allowed", "Method not allowed");
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      if (error.status === 429) res.setHeader("Retry-After", "60");
      json(res, error.status || 500, { error: { code: error.code || "internal_error", message: error.status ? error.message : "Service could not complete the request; no success is claimed" } });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.closeStreams = () => { for (const { res } of streams) res.end(); };
  return server;
}
