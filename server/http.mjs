import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createHash, timingSafeEqual } from "node:crypto";
import { ServiceError } from "./store.mjs";
import { clientAddress } from "./deployment.mjs";
import { validId } from "../src/events.js";

const roomCookieName = "room_session";
const accountCookieName = "account_session";
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const bindingPattern = /^[a-f0-9]{64}$/;
const assets = new Map([
  ["/", ["index.html", "text/html"]], ["/index.html", ["index.html", "text/html"]],
  ...["app.js", "client.js", "events.js", "conversation.js", "workflow.js", "share-links.js", "agent-connections.js", "return-brief.js", "work-selectors.js", "work-status.js", "work-packet.js", "portable-work.js", "reminders.js", "reminder-time.js", "room-charter.js", "room-instructions.js", "reply-requests.js", "work-help.js", "help-offers.js"].map(name => [`/src/${name}`, [`src/${name}`, "text/javascript"]]),
  ...["inbox-client.js", "inbox-ui.js"].map(name => [`/src/${name}`, [`src/${name}`, "text/javascript"]]),
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
  expiresAt: auth.expiresAt
});
const exact = (value, fields) => Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
const rateHash = value => createHash("sha256").update(String(value)).digest("hex");

export function createRoomServer({ store, origin, assetRoot = new URL("../", import.meta.url), streamInterval = 1000, trustedLocalProxy = false,
  loadAsset = path => readFile(new URL(path, assetRoot)), resolveClientAddress = req => clientAddress(req, trustedLocalProxy),
  resolveRequestSignal = () => null,
  serviceMode = trustedLocalProxy ? "invite-only-pilot" : "single-node-pilot" }) {
  if (trustedLocalProxy && !origin?.startsWith("https://")) throw new Error("The deployment proxy requires a fixed HTTPS origin");
  if (origin) {
    const url = new URL(origin);
    if (url.origin !== origin || !["http:", "https:"].includes(url.protocol)) throw new Error("Origin must be a fixed HTTP(S) origin without a path");
    if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("Non-loopback origins require HTTPS");
  }
  const expectedOrigin = () => origin || `http://127.0.0.1:${server.address().port}`;
  const scopedCookieName = name => expectedOrigin().startsWith("https:") ? `__Host-${name}` : name;
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
  function cookie(req, name) {
    const scoped = scopedCookieName(name);
    const matches = (req.headers.cookie || "").split(";").map(value => value.trim()).filter(value => value.startsWith(`${scoped}=`));
    if (matches.length > 1) reject(401, "ambiguous_session_cookie", "Conflicting browser session cookies; clear this site's cookies and sign in again");
    return matches[0]?.slice(scoped.length + 1);
  }
  function bearer(req) {
    if (!req.headers.authorization) return null;
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization);
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
  function stream(req, res, token, roomId, after, auth) {
    const binding = auth.sessionBinding;
    store.eventsAfter(token, roomId, after, 100, binding);
    if (streams.size >= 100 || [...streams].filter(item => item.credentialHash === auth.credentialHash).length >= 3) reject(429, "stream_limit", "Close another room connection before opening more");
    res.writeHead(200, { "Content-Type": "text/event-stream", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    const entry = { credentialHash: auth.credentialHash, sessionBinding: binding, res };
    streams.add(entry);
    let cursor = after;
    let timer;
    const signal = resolveRequestSignal(req);
    const cleanup = () => { clearInterval(timer); streams.delete(entry); signal?.removeEventListener("abort", abort); };
    const end = data => { cleanup(); if (!res.destroyed && !res.writableEnded) res.end(data); };
    const abort = () => end();
    const pump = () => {
      if (res.destroyed || res.writableEnded) { cleanup(); return; }
      try {
        const batch = store.eventsAfter(token, roomId, cursor, 100, binding);
        if (!batch.events.length && !res.write(": connected transport only\n\n")) end();
        for (const item of batch.events) {
          if (!res.write(`id: ${item.sequence}\nevent: room-event\ndata: ${JSON.stringify(item)}\n\n`)) { end(); break; }
          cursor = item.sequence;
        }
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
      const url = new URL(req.url, expectedOrigin());
      if (url.pathname === "/api/health" && req.method === "GET") return json(res, 200, { status: "ok", mode: serviceMode });
      if (url.pathname === "/api/ready" && req.method === "GET") {
        try {
          if (!store.db.prepare("SELECT 1 FROM rooms LIMIT 1").get()) throw new Error("No room");
          return json(res, 200, { status: "ready" });
        } catch { return json(res, 503, { status: "unavailable" }); }
      }
      if (assets.has(url.pathname) && ["GET", "HEAD"].includes(req.method)) {
        const [path, type] = assets.get(url.pathname);
        const data = await loadAsset(path);
        res.writeHead(200, { "Content-Type": `${type}; charset=utf-8` });
        return res.end(req.method === "HEAD" ? undefined : data);
      }
      if (url.pathname === "/api/inbox" || url.pathname.startsWith("/api/inbox/")) {
        // Inbox authority is an account session, never a Room/agent bearer key.
        if (req.headers.authorization) reject(401, "account_session_required", "Use your current account session.");
        const token = cookie(req, accountCookieName), binding = accountBinding(req);
        const auth = store.authenticateAccountSession(token, null, binding);
        if (url.pathname === "/api/inbox" && req.method === "GET") return json(res, 200, store.inbox.list(token, binding));
        const source = /^\/api\/inbox\/sources\/([^/]{1,384})(?:\/(share-context|room-results))?$/.exec(url.pathname);
        if (source && req.method === "GET") {
          const id = pathId(source[1]);
          if (source[2]) {
            const roomId = url.searchParams.get("roomId");
            if (!roomId || url.searchParams.getAll("roomId").length !== 1) reject(422, "invalid_room", "Choose a room.");
            if (source[2] === "room-results") {
              if (url.searchParams.getAll("workItemId").length > 1) reject(422, "invalid_inbox_result", "Choose a result.");
              return json(res, 200, store.inbox.results(token, id, roomId, binding, url.searchParams.get("workItemId")));
            }
            return json(res, 200, store.inbox.shareContext(token, id, roomId, binding));
          }
          return json(res, 200, store.inbox.read(token, id, binding));
        }
        if (url.pathname === "/api/inbox/commands" && req.method === "POST") {
          protectWrite(req, auth, false); rate(`inbox:${auth.account.id}`, 60);
          const result = store.inbox.apply(token, await body(req), binding);
          return json(res, result.duplicate ? 200 : 201, result);
        }
        reject(404, "not_found", "Inbox route not found.");
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
      const match = /^\/api\/rooms\/([^/]{1,384})(?:\/(commands|events|stream|cursor|return-brief|work-context|work-discussion|work-result|charter|reply-requests|reply-context|reply-history|invitations|share-links|share-links-cancel|reminders|agent-connections))?$/.exec(url.pathname);
      if (!match && !revokeMatch) reject(404, "not_found", "Not found");
      const roomId = pathId((match ?? revokeMatch)[1]);
      const invitationId = revokeMatch ? pathId(revokeMatch[2]) : null;
      const route = match ? (match[2] ?? "") : "invitation-revoke";
      const selected = roomCredentials(req, url);
      const fence = selected.mode === "account" ? accountBinding(req, route === "stream" ? url : null) : expectedBinding(req);
      const auth = selected.mode === "account" ? store.authenticateAccountSession(selected.token, roomId, fence)
        : store.authenticate(selected.token, roomId, fence, { allowAccountSession: false });
      if (selected.bearer && auth.credentialScope !== "room") reject(403, "access_denied", "Bearer account sessions are not accepted");
      if (!selected.bearer && auth.kind !== "session") reject(401, "unauthenticated", "Browser session required");
      rate(`read:${auth.credentialHash}`, 600);
      if (!["GET", "HEAD"].includes(req.method)) { protectWrite(req, auth, selected.bearer); rate(`write:${auth.credentialHash}`, 60); }
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
      if (route === "agent-connections" && req.method === "GET") return json(res, 200, store.agentConnections.list(selected.token, roomId, fence));
      if (route === "agent-connections" && req.method === "POST") {
        const result = store.agentConnections.apply(selected.token, roomId, await body(req), fence);
        return json(res, result.duplicate ? 200 : 201, result);
      }
      if (route === "reminders" && req.method === "POST") {
        const result = store.reminders.mutate(selected.token, roomId, await body(req), fence);
        return json(res, result.duplicate ? 200 : 201, result);
      }
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
      if (route === "events" && req.method === "GET") return json(res, 200, store.eventsAfter(selected.token, roomId, Number(url.searchParams.get("after") || 0), Number(url.searchParams.get("limit") || 100), fence));
      if (route === "stream" && req.method === "GET") return stream(req, res, selected.token, roomId, Number(req.headers["last-event-id"] ?? url.searchParams.get("after") ?? 0), auth);
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
