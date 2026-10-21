// Public agent-connect page for one invite code: GET /a/<code>.
//
// The page is a reading of the existing invite preview. It does not mint a
// credential and it does not change who may issue a code. DX-1a's
// server/connect-snippets.mjs replaces the connect command table when that
// module lands.

import { createHash } from "node:crypto";
import { buildSetupIntro } from "../setup-intro.mjs";

const PAGE_BUDGET = 3072;
export const UNAVAILABLE = "Ask the room owner for a new link.\nAlready redeemed it? Resend the same redeem request with the same requestId, or with your saved identity secret as the Bearer token, to get your connection again.\n";
const HOSTED_ORIGIN = "https://room.trydemigod.com";

const PERMISSION_WORDS = Object.freeze({
  chat: "You can chat.",
  contribute: "You can take tasks.",
  review: "You can review.",
  collaborate: "You can do everything except manage people.",
});

const COPY_SCRIPT = 'document.getElementById("copy").addEventListener("click",function(){var input=document.getElementById("link");input.select();navigator.clipboard.writeText(input.value);});';
const COPY_SCRIPT_HASH = createHash("sha256").update(COPY_SCRIPT).digest("base64");
export const AGENT_CONNECT_CSP = `default-src 'none'; script-src 'sha256-${COPY_SCRIPT_HASH}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

export function connectFields(origin = HOSTED_ORIGIN) {
  const base = String(origin || HOSTED_ORIGIN).replace(/\/$/, "");
  const mcpUrl = `${base}/mcp`;
  return {
    mcpUrl,
    claude: `claude mcp add --transport http project-room ${mcpUrl} --header "Authorization: Bearer $PROJECT_ROOM_SECRET"`,
    codex: `codex mcp add project-room --url ${mcpUrl} --bearer-token-env-var PROJECT_ROOM_SECRET`,
    httpHeader: "Authorization: Bearer $PROJECT_ROOM_SECRET",
  };
}

function claimList(store, roomId) {
  try {
    const items = store.workClaims?.list?.(roomId);
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

export function starterFor(store, roomId, memberId) {
  const match = claimList(store, roomId).find(item => {
    if (!item || item.state === "done" || item.state === "closed") return false;
    const tags = Array.isArray(item.tags) ? item.tags : [];
    return tags.includes("starter") || (memberId && item.owner === memberId);
  });
  if (!match) return null;
  return { claimId: match.id, title: typeof match.title === "string" && match.title ? match.title : match.id };
}

function pageClaims(store, roomId) {
  const open = claimList(store, roomId).filter(item => item && item.state === "unclaimed");
  open.sort((a, b) => {
    const aStarter = Array.isArray(a.tags) && a.tags.includes("starter") ? 0 : 1;
    const bStarter = Array.isArray(b.tags) && b.tags.includes("starter") ? 0 : 1;
    return aStarter - bStarter;
  });
  return open.slice(0, 3).map(item => ({
    id: item.id,
    title: typeof item.title === "string" && item.title ? item.title : item.id,
    assigned: Array.isArray(item.tags) && item.tags.includes("starter"),
  }));
}

function plain(value, max) {
  const text = String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/[^\P{C}]/gu, "").trim();
  return text.length > max ? text.slice(0, max).trim() : text;
}

function minutesLeft(expiresAt) {
  const ms = Number(expiresAt) - Date.now();
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.ceil(ms / 60000));
}

// "43198 minutes" is arithmetic for the reader; say it the way a person would.
export function expiryWords(expiresAt) {
  const minutes = minutesLeft(expiresAt);
  const unit = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (minutes < 120) return unit(minutes, "minute");
  if (minutes < 48 * 60) return unit(Math.round(minutes / 60), "hour");
  return unit(Math.round(minutes / 1440), "day");
}

function permissionLine(profile, permissions) {
  if (PERMISSION_WORDS[profile]) return PERMISSION_WORDS[profile];
  const names = Array.isArray(permissions) ? permissions.filter(name => typeof name === "string") : [];
  return names.length ? `Permissions: ${names.join(", ")}.` : "Permissions are on the invite.";
}

function curl(method, url, body, authenticated = true) {
  const auth = authenticated ? '-H "authorization: Bearer $PROJECT_ROOM_SECRET"' : "";
  const headers = body ? `${auth} -H 'content-type: application/json' -d '${body}'` : auth;
  const verb = method === "GET" ? "" : `-X ${method} `;
  const address = `'${url.replaceAll("'", "'\\''")}'`;
  return `curl -sS ${verb}${address} ${headers}`.replace(/\s+/g, " ").trim();
}

function claimCurls(origin, roomId, claim) {
  const room = `${origin}/api/rooms/${encodeURIComponent(roomId)}`;
  const item = `${room}/work-claims/${encodeURIComponent(claim.id)}`;
  return [
    curl("POST", `${item}/claim`, "{}"),
    curl("POST", `${item}/update`, '{"state":"in_progress"}'),
    curl("POST", `${item}/update`, '{"state":"done","deliveryMode":"result"}'),
  ];
}

export function renderAgentConnectMarkdown({ origin, code, roomId, title, purpose, profile, permissions, expiresAt, claims }) {
  const base = String(origin).replace(/\/$/, "");
  const connect = connectFields(base);
  const redeemBody = JSON.stringify({ code, displayName: "<your name>" });
  const lines = [
    "You've been invited to a Project Room as an agent.",
    "",
    `Room: ${plain(title, 120) || roomId}`,
    `Purpose: ${plain(purpose, 400) || "This room has no purpose text."}`,
    permissionLine(profile, permissions),
    `Single use. This link expires in ${expiryWords(expiresAt)}.`,
    "",
    "## 1. Redeem",
    "",
    "Save the response field identitySecret: your durable credential, shown once, with no scheduled expiry (it can still be rotated or revoked); it works on /mcp and every room route. Store it in a secret store or a file with mode 0600. Never print it into chat. (mcpToken.credential is a 30-day token for this room only; you do not need it.)",
    "To make a retry safe, add \"requestId\" (any UUID) to the body and keep it private like a password: with this code it can recover your identity. Resending the same request returns your connection again, even after the link is used: with your identitySecret as the Bearer token it keeps that credential; with no credential it works for 30 days and rotates in a fresh identitySecret.",
    "",
    curl("POST", `${base}/api/agent-invites/redeem`, redeemBody, false),
    "",
    `MCP only, no HTTP client: connect to ${connect.mcpUrl} with no credential, call room_identity_mint, save structuredContent.secret as PROJECT_ROOM_SECRET, reconnect with it as the Bearer token, then call room_join with {"inviteCode":"${code}"}. If your host only calls listed tools and room_join is missing, connect once to ${connect.mcpUrl}?profile=full to join, then reconnect without it.`,
    "",
    "## 2. Connect",
    "",
    "Set PROJECT_ROOM_SECRET to identitySecret. The commands below do not contain it.",
    "",
    `Claude Code: ${connect.claude}`,
    `Codex: ${connect.codex}`,
    `HTTP: ${connect.httpHeader}`,
    "",
    "## 3. First work",
    "",
    "Read the room with this GET.",
    "",
    curl("GET", `${base}/api/rooms/${encodeURIComponent(roomId)}/activation-pack?view=brief`),
    "",
  ];
  const enrollment = [...lines];
  const assigned = claims.filter(claim => claim.assigned);
  const open = claims.filter(claim => !claim.assigned);
  if (assigned.length) {
    lines.push("Assigned to you:");
    for (const claim of assigned) {
      lines.push(`- ${claim.id}: ${plain(claim.title, 120)}`);
      lines.push(...claimCurls(base, roomId, claim));
    }
    lines.push("");
  }
  if (open.length) {
    lines.push("Open on the board:");
    for (const claim of open) {
      lines.push(`- ${claim.id}: ${plain(claim.title, 120)}`);
      lines.push(...claimCurls(base, roomId, claim));
    }
    lines.push("");
  }
  if (!assigned.length && !open.length) {
    lines.push("No starter is on the board yet. Read the room, then list GET " + `${base}/api/rooms/${encodeURIComponent(roomId)}/work-claims` + ".");
    lines.push("");
  }
  let text = `${lines.join("\n").trim()}\n`;
  if (Buffer.byteLength(text) <= PAGE_BUDGET) {
    // Optional one-paste setup intro: shed first when the page is full.
    const intro = setupIntroText(base, roomId);
    const withIntro = `${text}\n## 4. Finish setup\n\n${intro}`;
    return intro && Buffer.byteLength(withIntro) <= PAGE_BUDGET ? withIntro : text;
  }
  const shorter = lines.filter(line => !line.startsWith("curl ") || line.includes("/agent-invites/redeem") || line.includes("/activation-pack"));
  text = `${shorter.join("\n").trim()}\n`;
  if (Buffer.byteLength(text) <= PAGE_BUDGET) return text;
  // Optional room context must never crowd out the credential instructions or
  // first authenticated read. Byte-slicing can leave agents with half a shell
  // command (and can split UTF-8). Shed whole optional sections instead.
  const essentials = enrollment.filter(line => !line.startsWith("Room:") && !line.startsWith("Purpose:"));
  text = `${essentials.join("\n").trim()}\n`;
  if (Buffer.byteLength(text) <= PAGE_BUDGET) return text;
  // Long self-hosted origins can repeat throughout the full CLI examples.
  // Keep a complete HTTP path and MCP alternative rather than truncating either.
  return [
    "You've been invited to a Project Room as an agent.",
    "Save the response field identitySecret in a secret store or mode-0600 file as PROJECT_ROOM_SECRET. Never print it into chat. Do not save the expiring room token instead.",
    'Add a UUID requestId to the redeem body and keep it private like a password. Preserve the same request for retries.',
    curl("POST", `${base}/api/agent-invites/redeem`, redeemBody, false),
    `MCP: ${connect.mcpUrl}; room_identity_mint, save structuredContent.secret, reconnect with it, then room_join with {"inviteCode":"${code}"}. If unlisted, use ${connect.mcpUrl}?profile=full to join.`,
    `HTTP: ${connect.httpHeader}`,
    curl("GET", `${base}/api/rooms/${encodeURIComponent(roomId)}/activation-pack?view=brief`),
    "Read the room before choosing work. A connection does not start a listener.",
    "",
  ].join("\n");
}

function setupIntroText(origin, roomId) {
  try { return buildSetupIntro({ origin, roomId, platform: "other" }).text; }
  catch { return ""; }
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function renderHtml({ pageUrl, origin, code, roomId, title, purpose, profile, permissions, expiresAt }) {
  const steps = renderAgentConnectMarkdown({
    origin, code, roomId, title, purpose, profile, permissions, expiresAt, claims: [],
  });
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Agent invite</title><style>body{font-family:system-ui,sans-serif;max-width:36rem;margin:2rem auto;padding:0 1rem;color:#1a1a1a}button,input{font:inherit}input{box-sizing:border-box;width:100%;margin:.5rem 0}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body><p>This link is for your AI agent. Paste it into Claude Code, Codex, Cursor or any agent with web access.</p><p><input id="link" readonly value="${escapeHtml(pageUrl)}"><button id="copy" type="button">Copy</button></p><h2>Steps for the agent</h2><pre>${escapeHtml(steps)}</pre><script>${COPY_SCRIPT}</script></body></html>`;
}

function finish(res, req, status, type, body, extra = {}) {
  const bytes = Buffer.from(body);
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Length": bytes.length,
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
    ...extra,
  });
  res.end(req.method === "HEAD" ? undefined : bytes);
  return true;
}

// A person who opens a dead link in a browser gets a small page with a way
// home; agents and other non-HTML readers keep the one plain line.
const UNAVAILABLE_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Invite link not available</title><style>body{font-family:system-ui,sans-serif;max-width:36rem;margin:2rem auto;padding:0 1rem;color:#1a1a1a}</style></head><body><h1>This invite link no longer works</h1>${UNAVAILABLE.trim().split("\n").map(line => `<p>${line}</p>`).join("")}<p><a href="/">Go to Project Room</a></p></body></html>`;

function unavailable(res, req, status, url) {
  if (url && !wantsMarkdown(req, url)) {
    return finish(res, req, status, "text/html; charset=utf-8", UNAVAILABLE_HTML, { "Content-Security-Policy": AGENT_CONNECT_CSP });
  }
  return finish(res, req, status, "text/plain; charset=utf-8", UNAVAILABLE);
}

function wantsMarkdown(req, url) {
  if (url.searchParams.get("format") === "md") return true;
  const accept = String(req.headers.accept || "");
  if (accept.includes("text/html")) return false;
  return true;
}

export function handleAgentConnect(req, url, ctx) {
  const match = /^\/a\/([^/]+)$/.exec(url.pathname);
  if (!match) return false;
  const { res, store, remoteAddress, rate, reject, origin } = ctx;
  if (!["GET", "HEAD"].includes(req.method)) {
    reject(405, "method_not_allowed", "Method not allowed", { Allow: "GET, HEAD" });
  }
  rate(`agent-connect:${remoteAddress}`, 30);
  let code = "";
  try { code = decodeURIComponent(match[1]); }
  catch { return unavailable(res, req, 404, url); }
  if (!code || code.length > 64) return unavailable(res, req, 404, url);
  let preview;
  // A caller that already read this code's preview (GET /join/<code>)
  // passes it in, so the scrypt lookup runs once per request.
  try { preview = ctx.preview ?? store.invites.preview(code); }
  catch (error) {
    const status = error?.status === 404 ? 404 : (error?.status === 409 || error?.status === 410 ? 410 : null);
    if (status) return unavailable(res, req, status, url);
    throw error;
  }
  const room = store.room(preview.roomId);
  const purpose = room.state?.room?.purpose ?? "";
  const base = String(origin).replace(/\/$/, "");
  const pageUrl = `${base}/a/${encodeURIComponent(code)}`;
  if (wantsMarkdown(req, url)) {
    const body = renderAgentConnectMarkdown({
      origin: base,
      code,
      roomId: preview.roomId,
      title: preview.roomTitle,
      purpose,
      profile: preview.profile,
      permissions: preview.permissions,
      expiresAt: preview.expiresAt,
      claims: pageClaims(store, preview.roomId),
    });
    return finish(res, req, 200, "text/markdown; charset=utf-8", body);
  }
  const html = renderHtml({
    pageUrl, origin: base, code, roomId: preview.roomId, title: preview.roomTitle, purpose,
    profile: preview.profile, permissions: preview.permissions, expiresAt: preview.expiresAt,
  });
  return finish(res, req, 200, "text/html; charset=utf-8", html, { "Content-Security-Policy": AGENT_CONNECT_CSP });
}

// One link per agent invite. The code is single-use and short-lived, and the
// web app already shares it as /join/<code>; this is the same code on the
// page that works with no browser.
const AGENT_INVITE_CODE = /^RM-[A-Z0-9]{4,60}$/;

export function agentInviteLink(origin, code) {
  return `${String(origin).replace(/\/$/, "")}/a/${encodeURIComponent(code)}`;
}

// The invite create response carries the link, and its share step leads with
// it, so the owner sends one thing instead of building a URL by hand.
export function withAgentInviteLink(created, origin) {
  if (!created || typeof created.code !== "string") return created;
  const url = agentInviteLink(origin, created.code);
  const next = Array.isArray(created.next) ? created.next.map(step => step?.action === "share-code"
    ? Object.freeze({ ...step, url, description: `Send the invitee this link: ${url} (an agent can follow it with no browser; a person can open it). ${step.description}` })
    : step) : created.next;
  return { ...created, url, next: Object.freeze(next) };
}

// GET /join/<code> is the link the web app hands out. It is a browser page
// that needs JavaScript, so an agent fetching it got "Loading your invite"
// and a pointer to the full discovery packet. A non-browser request for an
// agent invite code now gets the /a/<code> steps instead; browsers still get
// the join page.
export function joinPathAgentCode(pathname) {
  const match = /^\/(?:room\/)?join\/([^/]{1,128})\/?$/.exec(pathname);
  if (!match) return null;
  let code;
  try { code = decodeURIComponent(match[1]); } catch { return null; }
  return AGENT_INVITE_CODE.test(code) ? code : null;
}

// Only a live invite is rerouted. A dead or unknown code keeps the join page,
// whose client shows the error screen and the way back to sign-in.
export function agentInvitePreview(store, code) {
  try { return store.invites.preview(code) ?? null; }
  catch { return null; }
}

export function liveAgentInvite(store, code) {
  return Boolean(agentInvitePreview(store, code));
}

// For browser-based agent fetchers (they ask for HTML), point the page's
// no-JavaScript agent line at this invite's /a/ page instead of the packet.
export const JOIN_PAGE_AGENT_LINE = "Fetch <code>/llms.txt</code> from the host serving this page (the address in your browser's address bar) and follow the agent enrollment flow documented there.";

export function joinPageForAgentCode(page, code) {
  const path = `/a/${encodeURIComponent(code)}`;
  return page.replace(JOIN_PAGE_AGENT_LINE,
    `Read <code>${path}</code> on this host: it has this invite's steps as plain text. Otherwise ${JOIN_PAGE_AGENT_LINE.charAt(0).toLowerCase()}${JOIN_PAGE_AGENT_LINE.slice(1)}`);
}
