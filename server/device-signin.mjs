// No-browser sign-in for agents on SSH boxes (RFC 8628 shape, small):
//   1. CLI: POST /api/rooms/{roomId}/device-signin {name}
//        -> { deviceCode, userCode, verificationUri, expiresIn, interval }
//      The CLI prints verificationUri; deviceCode stays on the box.
//   2. A signed-in room member opens /device?code=ABCD-EFGH on any device and
//      presses Approve (plain HTML form, room session cookie, same-origin).
//      Approval mints a 10-minute single-use agent invite for that name.
//   3. CLI: POST /api/device-signin/poll {deviceCode}
//        -> { status: "pending" } | { status: "approved", inviteCode } (once)
//      and redeems the invite through the normal room login path.
// Only hashes of the device code are stored; the invite code is handed out
// once and deleted. Codes live 10 minutes.
import { createHash, randomBytes } from "node:crypto";
import { escapeHtml } from "./receipts-page.mjs";

export const DEVICE_TTL_MS = 10 * 60 * 1000;
export const DEVICE_POLL_SECONDS = 5;
const ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const hash = value => createHash("sha256").update(value).digest("hex");
const schema = `CREATE TABLE IF NOT EXISTS device_signins (
  device_hash TEXT PRIMARY KEY, user_code TEXT NOT NULL UNIQUE, room_id TEXT NOT NULL, agent_name TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, approved_by TEXT, invite_code TEXT)`;

function fail(status, code, message) {
  const error = new Error(message); error.status = status; error.code = code; throw error;
}

export function normalizeUserCode(value) {
  const letters = String(value ?? "").toUpperCase().replace(/[^A-Z]/g, "");
  return letters.length === 8 ? `${letters.slice(0, 4)}-${letters.slice(4)}` : null;
}

export class DeviceSignin {
  constructor(store, { now = () => store.now() } = {}) {
    this.store = store; this.now = now;
    store.db.exec(schema);
  }

  sweep() { this.store.db.prepare("DELETE FROM device_signins WHERE expires_at<=?").run(this.now()); }

  start(roomId, name) {
    if (typeof roomId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(roomId)) fail(422, "invalid_room", "Unknown room");
    const agentName = typeof name === "string" ? name.trim() : "";
    if (!agentName || agentName.length > 80 || /[\u0000-\u001f\u007f]/.test(agentName)) fail(422, "invalid_name", "name must be 1 to 80 printable characters");
    this.sweep();
    const deviceCode = "dvc_" + randomBytes(24).toString("base64url");
    const bytes = randomBytes(8);
    const userCode = normalizeUserCode([...bytes].map(b => ALPHABET[b % ALPHABET.length]).join(""));
    const at = this.now();
    this.store.db.prepare("INSERT INTO device_signins(device_hash,user_code,room_id,agent_name,created_at,expires_at) VALUES(?,?,?,?,?,?)")
      .run(hash(deviceCode), userCode, roomId, agentName, at, at + DEVICE_TTL_MS);
    return { deviceCode, userCode, expiresIn: DEVICE_TTL_MS / 1000, interval: DEVICE_POLL_SECONDS };
  }

  lookup(userCode) {
    const code = normalizeUserCode(userCode);
    if (!code) return null;
    const row = this.store.db.prepare("SELECT room_id AS roomId, agent_name AS agentName, expires_at AS expiresAt, approved_by AS approvedBy FROM device_signins WHERE user_code=?").get(code);
    return row && row.expiresAt > this.now() ? { ...row, userCode: code } : null;
  }

  // token: the approver's room credential. The invite is created with the
  // approver's own authority, so it can never exceed what they hold.
  approve(token, userCode) {
    const found = this.lookup(userCode);
    if (!found) fail(404, "device_code_not_found", "That code is unknown or expired");
    if (found.approvedBy) fail(409, "device_code_used", "That code was already approved");
    const invite = this.store.invites.create(token, found.roomId, { profile: "chat", displayName: found.agentName, expiresInMinutes: 10 });
    const auth = this.store.authenticate(token, found.roomId);
    this.store.db.prepare("UPDATE device_signins SET approved_by=?, invite_code=? WHERE user_code=? AND approved_by IS NULL")
      .run(auth.member.id, invite.code, found.userCode);
    return { roomId: found.roomId, agentName: found.agentName };
  }

  poll(deviceCode) {
    if (typeof deviceCode !== "string" || !deviceCode.startsWith("dvc_")) fail(422, "invalid_device_code", "deviceCode is required");
    const row = this.store.db.prepare("SELECT room_id AS roomId, expires_at AS expiresAt, invite_code AS inviteCode FROM device_signins WHERE device_hash=?").get(hash(deviceCode));
    if (!row || row.expiresAt <= this.now()) return { status: "expired" };
    if (!row.inviteCode) return { status: "pending", interval: DEVICE_POLL_SECONDS };
    this.store.db.prepare("DELETE FROM device_signins WHERE device_hash=?").run(hash(deviceCode));
    return { status: "approved", roomId: row.roomId, inviteCode: row.inviteCode };
  }
}

const page = (title, inner) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>${title} — Project Room</title><link rel="stylesheet" href="/src/styles.css"></head><body><main class="join-page"><h1 class="join-brand">Project Room</h1><section class="join-card">${inner}</section></main></body></html>`;

export function createDeviceSigninRoutes({ store, json, reject, body, rate, cookie, checkOrigin, origin }) {
  let flows = null;
  const device = () => (flows ??= new DeviceSignin(store));
  const html = (res, status, text) => {
    res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(text), "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });
    res.end(text);
    return true;
  };
  return async function serve(req, res, { url, remoteAddress }) {
    const start = /^\/api\/rooms\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/device-signin$/.exec(url.pathname);
    try {
      if (start && req.method === "POST") {
        rate(`device-start:${remoteAddress}`, 10);
        const data = await body(req);
        const started = device().start(start[1], data?.name);
        return json(res, 201, { ...started, verificationUri: `${origin()}/device?code=${started.userCode}` });
      }
      if (url.pathname === "/api/device-signin/poll" && req.method === "POST") {
        rate(`device-poll:${remoteAddress}`, 30);
        const data = await body(req);
        return json(res, 200, device().poll(data?.deviceCode));
      }
      if (url.pathname === "/device" && req.method === "GET") {
        const found = device().lookup(url.searchParams.get("code"));
        if (!found) return html(res, 404, page("Sign in an agent", "<p>That code is unknown or expired. Run the sign-in command again for a new link.</p>"));
        if (found.approvedBy) return html(res, 200, page("Sign in an agent", "<p>Already approved. The agent finishes setup on its own.</p>"));
        return html(res, 200, page("Sign in an agent", `<h2>Let ${escapeHtml(found.agentName)} into room ${escapeHtml(found.roomId)}?</h2>
<p>Code <strong>${escapeHtml(found.userCode)}</strong>. Check it matches what the agent's terminal shows. You need to be signed in to this room in this browser.</p>
<form method="post" action="/device"><input type="hidden" name="code" value="${escapeHtml(found.userCode)}"><button class="button primary" type="submit">Approve</button></form>`));
      }
      if (url.pathname === "/device" && req.method === "POST") {
        checkOrigin(req, true);
        rate(`device-approve:${remoteAddress}`, 20);
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 2048) reject(413, "too_large", "Form too large"); chunks.push(chunk); }
        const code = new URLSearchParams(Buffer.concat(chunks).toString("utf8")).get("code");
        const token = cookie(req, "room_session");
        if (!token) return html(res, 401, page("Sign in an agent", "<p>Sign in to the room in this browser first, then open the link again.</p>"));
        const approved = device().approve(token, code);
        return html(res, 200, page("Agent approved", `<p>${escapeHtml(approved.agentName)} is approved for room ${escapeHtml(approved.roomId)}. It finishes setup on its own; you can close this page.</p>`));
      }
    } catch (error) {
      if (error && typeof error.status === "number" && url.pathname === "/device") {
        return html(res, error.status, page("Sign in an agent", `<p>${escapeHtml(error.message)}</p>`));
      }
      if (error && typeof error.status === "number" && error.code) reject(error.status, error.code, error.message);
      throw error;
    }
    return false;
  };
}
