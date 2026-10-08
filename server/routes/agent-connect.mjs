// Public agent-connect page for one invite code: GET /a/<code>.
//
// The page is a reading of the existing invite preview. It does not mint a
// credential and it does not change who may issue a code. DX-1a's
// server/connect-snippets.mjs replaces the connect command table when that
// module lands.

import { createHash } from "node:crypto";

const PAGE_BUDGET = 3072;
const UNAVAILABLE = "Ask the room owner for a new link.\n";
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

function permissionLine(profile, permissions) {
  if (PERMISSION_WORDS[profile]) return PERMISSION_WORDS[profile];
  const names = Array.isArray(permissions) ? permissions.filter(name => typeof name === "string") : [];
  return names.length ? `Permissions: ${names.join(", ")}.` : "Permissions are on the invite.";
}

function curl(method, url, body) {
  const headers = body
    ? `-H 'authorization: Bearer $PROJECT_ROOM_SECRET' -H 'content-type: application/json' -d '${body}'`
    : `-H 'authorization: Bearer $PROJECT_ROOM_SECRET'`;
  const verb = method === "GET" ? "" : `-X ${method} `;
  return `curl -sS ${verb}${url} ${headers}`.replace(/\s+/g, " ").trim();
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
    `This link expires in ${minutesLeft(expiresAt)} minutes.`,
    "",
    "## 1. Redeem",
    "",
    "The response field mcpToken.credential is a room-scoped token shown once. Store it in a secret store or a file with mode 0600. Never print it into chat.",
    "",
    `curl -sS -X POST ${base}/api/agent-invites/redeem -H 'content-type: application/json' -d '${redeemBody}'`,
    "",
    "## 2. Connect",
    "",
    "Set PROJECT_ROOM_SECRET to that token. The commands below do not contain the token.",
    "",
    `Claude Code: ${connect.claude}`,
    `Codex: ${connect.codex}`,
    `HTTP: ${connect.httpHeader}`,
    "",
    "## 3. First work",
    "",
    "Read the room with this GET.",
    "",
    curl("GET", `${base}/api/rooms/${encodeURIComponent(roomId)}/orient`),
    "",
  ];
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
  if (Buffer.byteLength(text) <= PAGE_BUDGET) return text;
  const shorter = lines.filter(line => !line.startsWith("curl ") || line.includes("/agent-invites/redeem") || line.includes("/orient"));
  text = `${shorter.join("\n").trim()}\n`;
  if (Buffer.byteLength(text) <= PAGE_BUDGET) return text;
  return Buffer.from(text).subarray(0, PAGE_BUDGET).toString("utf8").replace(/\s+\S*$/, "\n");
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function renderHtml({ pageUrl, origin, code, roomId, title, purpose, profile, permissions, expiresAt }) {
  const steps = renderAgentConnectMarkdown({
    origin, code, roomId, title, purpose, profile, permissions, expiresAt, claims: [],
  });
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Agent invite</title><style>body{font-family:system-ui,sans-serif;max-width:36rem;margin:2rem auto;padding:0 1rem;color:#1a1a1a}button,input{font:inherit}input{width:100%;margin:.5rem 0}pre{white-space:pre-wrap}</style></head><body><p>This link is for your AI agent. Paste it into Claude Code, Codex, Cursor or any agent with web access.</p><p><input id="link" readonly value="${escapeHtml(pageUrl)}"><button id="copy" type="button">Copy</button></p><details><summary>Three steps</summary><pre>${escapeHtml(steps)}</pre></details><script>${COPY_SCRIPT}</script></body></html>`;
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

function unavailable(res, req, status) {
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
  catch { return unavailable(res, req, 404); }
  if (!code || code.length > 64) return unavailable(res, req, 404);
  let preview;
  try { preview = store.invites.preview(code); }
  catch (error) {
    const status = error?.status === 404 ? 404 : (error?.status === 409 || error?.status === 410 ? 410 : null);
    if (status) return unavailable(res, req, status);
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
