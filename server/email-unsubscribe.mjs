// One-click unsubscribe for notification email (RFC 8058). The link that
// signUnsubscribe builds lands here. GET shows a confirm button, so mail
// scanners that prefetch links never opt anyone out; POST records the opt-out.
// The signed token is the only credential: no session, cookie or Origin.
import { verifyUnsubscribe } from "./notify-email.mjs";

export function unsubscribeSecretFromEnv(env = process.env) {
  const value = env?.ROOM_UNSUBSCRIBE_SECRET;
  return typeof value === "string" && value.length >= 16 ? value : null;
}

function ensureTable(db) {
  db.exec("CREATE TABLE IF NOT EXISTS email_optouts (member_id TEXT NOT NULL, scope TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(member_id, scope))");
}

export function recordEmailOptOut(db, { memberId, scope, at = Date.now() }) {
  ensureTable(db);
  db.prepare("INSERT INTO email_optouts (member_id, scope, at) VALUES (?, ?, ?) ON CONFLICT(member_id, scope) DO NOTHING").run(memberId, scope, at);
}

// True when the member opted out of everything, or of this room.
export function isEmailOptedOut(db, memberId, roomId = null) {
  ensureTable(db);
  const scopes = roomId ? ["global", `room:${roomId}`] : ["global"];
  const row = db.prepare(`SELECT 1 AS hit FROM email_optouts WHERE member_id = ? AND scope IN (${scopes.map(() => "?").join(",")}) LIMIT 1`).get(memberId, ...scopes);
  return Boolean(row);
}

const page = (title, body, form = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title></head><body><main><h1>${title}</h1><p>${body}</p>${form}</main></body></html>`;

function send(res, status, html) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
  });
  res.end(html);
}

// Returns true when it answered the request.
export function handleUnsubscribe(req, res, { url, db, secret }) {
  if (url.pathname !== "/unsubscribe" && url.pathname !== "/unsubscribe/") return false;
  if (!["GET", "HEAD", "POST"].includes(req.method)) {
    res.writeHead(405, { Allow: "GET, HEAD, POST", "Cache-Control": "no-store" }); res.end(); return true;
  }
  if (!secret) { send(res, 503, page("Unsubscribe unavailable", "Unsubscribe is not configured on this server.")); return true; }
  const token = url.searchParams.get("u") ?? "";
  const claim = verifyUnsubscribe(token, secret);
  if (!claim) { send(res, 400, page("Link not valid", "This unsubscribe link is not valid. Use the newest link from a Project Room email.")); return true; }
  const what = claim.scope === "global" ? "all Project Room notification email" : "notification email from this room";
  if (req.method === "POST") {
    recordEmailOptOut(db, { memberId: claim.memberId, scope: claim.scope });
    req.resume?.();
    send(res, 200, page("Unsubscribed", `You will no longer get ${what}.`));
    return true;
  }
  const action = `/unsubscribe?u=${encodeURIComponent(token)}`;
  const form = `<form method="post" action="${action.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"><button type="submit">Unsubscribe</button></form>`;
  send(res, 200, req.method === "HEAD" ? "" : page("Unsubscribe", `Stop ${what}?`, form));
  return true;
}
