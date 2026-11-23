import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Agent, createServer, request } from "node:http";
import { pipeline } from "node:stream";

const bootstrapPath = "/.room-preview";
const ticketMs = 30_000, sessionMs = 30 * 60_000, sessionLimit = 64;
const token = () => randomBytes(32).toString("hex");
const matches = (value, expected) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
  && timingSafeEqual(Buffer.from(value, "hex"), Buffer.from(expected, "hex"));
const baseHeaders = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin",
  "Cross-Origin-Opener-Policy": "same-origin" };
const deny = (res, code = 404) => res.writeHead(code, baseHeaders).end();
const bootstrap = `(async () => {
  const ticket = location.hash.slice(1);
  history.replaceState(null, "", location.pathname);
  try {
    const reply = await fetch(location.pathname, { method: "POST", body: ticket });
    if (reply.ok) return location.replace("/");
  } catch {}
  document.body.textContent = "This live preview is unavailable. Reopen it from Project Room.";
})();`;
const bootstrapHash = createHash("sha256").update(bootstrap).digest("base64");

export function workspacePreviewViewerConfig(env, roomOrigin, brokerEnabled) {
  const { ROOM_WORKSPACE_VIEWER_ORIGIN: value, ROOM_WORKSPACE_VIEWER_PORT: port } = env;
  if (value === undefined && port === undefined) return null;
  let origin;
  try { origin = new URL(value); } catch { throw Error("Workspace viewer requires an exact origin"); }
  const room = new URL(roomOrigin), loopback = origin.hostname === "localhost";
  if (!brokerEnabled || origin.origin !== value || !/^[a-z][a-z0-9.-]+$/i.test(origin.hostname)
    || (!loopback && origin.protocol !== "https:")
    || (loopback && (origin.protocol !== "http:" || room.protocol !== "http:" || origin.port !== port))
    || room.hostname === origin.hostname || room.hostname.endsWith("." + origin.hostname)
    || origin.hostname.endsWith("." + room.hostname)
    || !/^[0-9]+$/.test(port ?? "") || Number(port) < 1 || Number(port) > 65535) {
    throw Error("Workspace viewer requires its own wildcard HTTPS origin, listener port, and publisher broker");
  }
  return { origin, port: Number(port) };
}

export function createWorkspacePreviewViewer({ origin }, broker) {
  const sessions = new Map();
  const cookieName = origin.protocol === "https:" ? "__Host-room-preview" : "room-preview";

  function retire(session) {
    if (!sessions.delete(session.host)) return;
    clearTimeout(session.timer);
    session.agent.destroy();
    for (const stream of session.streams) stream.destroy();
  }
  function current(session) {
    if (session && sessions.get(session.host) === session
      && broker.generationFor(session.selection) === session.generation) {
      try { if (session.canRead()) return true; } catch { /* Fail closed after access loss. */ }
    }
    if (session) retire(session);
    return false;
  }
  function hasSession(req, session) {
    const prefix = cookieName + "=";
    const cookies = (req.headers.cookie ?? "").split(";").map(value => value.trim()).filter(value => value.startsWith(prefix));
    return session.claimed && cookies.length === 1 && matches(cookies[0].slice(prefix.length), session.secret);
  }
  function target(req, session) {
    if (!req.url?.startsWith("/") || req.url.startsWith("//")) return null;
    try {
      const url = new URL(req.url, session.origin);
      return url.origin === session.origin ? url : null;
    } catch { return null; }
  }
  function track(session, stream) {
    if (session.streams.size >= 24) return false;
    session.streams.add(stream);
    stream.once("close", () => session.streams.delete(stream));
    return true;
  }
  function readHeaders(session) {
    const wsOrigin = session.origin.replace(/^http/, "ws");
    return { ...baseHeaders, "Content-Security-Policy": [
      "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
      "connect-src 'self' " + wsOrigin, "base-uri 'none'", "frame-ancestors 'none'",
      "form-action 'none'", "worker-src 'none'", "object-src 'none'"
    ].join("; ") };
  }
  function claim(req, res, session) {
    if (req.method === "GET") {
      if (session.claimed || Date.now() >= session.ticketExpires) return deny(res);
      res.writeHead(200, { ...baseHeaders, "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": `default-src 'none'; script-src 'sha256-${bootstrapHash}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'` });
      return res.end(`<!doctype html><title>Open live preview</title><body>Opening live preview…<script>${bootstrap}</script>`);
    }
    if (req.method !== "POST" || req.headers.origin !== session.origin) return deny(res);
    let presented = "";
    req.setEncoding("utf8");
    req.on("error", () => res.destroy());
    req.on("data", chunk => {
      presented += chunk;
      if (presented.length > 64) req.destroy();
    });
    req.on("end", () => {
      if (!current(session) || session.claimed || Date.now() >= session.ticketExpires || !matches(presented, session.ticket))
        return deny(res);
      session.claimed = true;
      session.ticket = undefined;
      clearTimeout(session.timer);
      session.timer = setTimeout(() => retire(session), sessionMs);
      res.writeHead(204, { ...baseHeaders, "Set-Cookie": `${cookieName}=${session.secret}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionMs / 1000}${origin.protocol === "https:" ? "; Secure" : ""}` }).end();
    });
  }
  const server = createServer((req, res) => {
    const session = sessions.get(req.headers.host);
    if (!current(session)) return deny(res);
    const url = target(req, session);
    if (!url) return deny(res);
    if (url.pathname === bootstrapPath) return url.search ? deny(res) : claim(req, res, session);
    if (!["GET", "HEAD"].includes(req.method) || !hasSession(req, session) || !track(session, res)) return deny(res);
    const upstream = request({ hostname: "127.0.0.1", path: url.pathname + url.search, method: req.method,
      agent: session.agent, headers: { Accept: req.headers.accept ?? "*/*" } }, reply => {
      if (!current(session) || reply.statusCode !== 200) {
        reply.destroy();
        return res.destroyed ? undefined : deny(res);
      }
      res.writeHead(200, { ...readHeaders(session), "Content-Type": reply.headers["content-type"] ?? "application/octet-stream" });
      pipeline(reply, res, () => {});
    });
    res.once("close", () => upstream.destroy());
    upstream.once("error", () => res.headersSent ? res.destroy() : deny(res, 503));
    upstream.end();
  });
  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => socket.destroy());
    const session = sessions.get(req.headers.host);
    const url = session && target(req, session);
    const protocol = req.headers["sec-websocket-protocol"];
    const supported = protocol === "vite-hmr" && url?.pathname === "/" || protocol === undefined && url?.pathname === "/ws";
    if (!supported || !current(session) || !hasSession(req, session) || req.method !== "GET"
      || req.headers.origin !== session.origin || req.headers.upgrade?.toLowerCase() !== "websocket"
      || req.headers["sec-websocket-version"] !== "13" || !/^[A-Za-z0-9+/]{22}==$/.test(req.headers["sec-websocket-key"] ?? "")
      || !track(session, socket)) return socket.destroy();
    const upstream = request({ hostname: "127.0.0.1", path: url.pathname + url.search, agent: session.agent,
      headers: { Connection: "Upgrade", Upgrade: "websocket", Origin: session.origin, "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": req.headers["sec-websocket-key"], ...(protocol && { "Sec-WebSocket-Protocol": protocol }) } });
    socket.once("close", () => upstream.destroy());
    upstream.once("error", () => socket.destroy());
    upstream.once("response", res => { res.destroy(); socket.destroy(); });
    upstream.once("upgrade", (response, app, appHead) => {
      if (!current(session) || socket.destroyed || response.headers["sec-websocket-protocol"] !== protocol
        || !/^[A-Za-z0-9+/]{27}=$/.test(response.headers["sec-websocket-accept"] ?? "")) {
        app.destroy();
        return socket.destroy();
      }
      app.on("error", () => socket.destroy());
      app.once("close", () => socket.destroy());
      socket.once("close", () => app.destroy());
      socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: "
        + response.headers["sec-websocket-accept"] + "\r\n" + (protocol ? "Sec-WebSocket-Protocol: " + protocol + "\r\n" : "") + "\r\n");
      if (appHead.length) socket.write(appHead);
      if (head.length) app.write(head);
      socket.pipe(app).pipe(socket);
    });
    upstream.end();
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 3_000;
  return {
    server,
    hasPublisher(selection) { return Boolean(broker.generationFor(selection)); },
    issue(selection, canRead) {
      const generation = broker.generationFor(selection);
      if (!generation || !canRead() || sessions.size >= sessionLimit) return null;
      const url = new URL(origin);
      url.hostname = "view-" + randomBytes(12).toString("hex") + "." + origin.hostname;
      const session = { origin: url.origin, host: url.host, selection, generation, canRead, streams: new Set(),
        ticket: token(), secret: token(), ticketExpires: Date.now() + ticketMs, claimed: false, agent: new Agent({ keepAlive: false }) };
      session.agent.createConnection = (_options, callback) => {
        if (!current(session)) return callback(Error("Workspace preview is unavailable"));
        broker.openLane(selection, callback);
      };
      session.timer = setTimeout(() => retire(session), ticketMs);
      sessions.set(session.host, session);
      url.pathname = bootstrapPath;
      url.hash = session.ticket;
      return url.href;
    },
    revalidate(roomId) {
      for (const session of sessions.values()) if (roomId === undefined || session.selection.roomId === roomId) current(session);
    },
    close() {
      for (const session of sessions.values()) retire(session);
      if (server.listening) {
        server.close();
        server.closeAllConnections();
      }
    }
  };
}
