// Notification email renderer (HB-1a). NOTIFY and the morning brief call this.
// Delivery is inert: nothing in the server sends these messages. When Resend
// is unconfigured the result is `unavailable`, which is what the settings
// page will say. Bodies stay out unless the caller set includeFullText.
import { createHmac, timingSafeEqual } from "node:crypto";
import { resendTransport } from "./resend-mailer.mjs";

const CLIP = 140;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function clip(value, max = CLIP) {
  if (typeof value !== "string") return "";
  const clean = value.replace(/[\r\n\u0000-\u001f\u007f]/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function lineFor(item) {
  const reason = clip(item?.reason, 200);
  const title = clip(item?.title, 120);
  const text = item?.includeFullText === true ? clip(item.fullText) : "";
  const href = typeof item?.url === "string" && item.url.startsWith("https://") ? item.url : "";
  const head = reason || title || "An update is waiting in Room";
  return { head, text, href };
}

// Plain text plus a short HTML twin. `kind` is "batch" (needs-you items) or
// "brief" (HB-2 sections). An empty brief is skipped: no empty mail.
export function renderNotificationEmail({ kind = "batch", items = [], sections = [], unsubscribe } = {}) {
  if (kind !== "batch" && kind !== "brief") {
    return { skipped: true, reason: "unknown_kind" };
  }
  const rows = kind === "brief"
    ? (Array.isArray(sections) ? sections : []).map(section => ({
      head: clip(section?.heading, 80),
      text: clip(section?.text, 200),
      href: typeof section?.url === "string" && section.url.startsWith("https://") ? section.url : ""
    })).filter(row => row.head || row.text)
    : (Array.isArray(items) ? items : []).map(lineFor);
  if (rows.length === 0) return { skipped: true, reason: "empty" };
  const subject = kind === "brief" ? "Your Room brief" : rows.length === 1 ? "Something needs you in Room" : `${rows.length} things need you in Room`;
  const textLines = rows.map(row => {
    const extra = row.text ? `\n${row.text}` : "";
    const link = row.href ? `\n${row.href}` : "";
    return `${row.head}${extra}${link}`;
  });
  const text = [...textLines, "", "Unsubscribe: " + (unsubscribe?.url ?? "")].join("\n").trim();
  const htmlRows = rows.map(row => {
    const link = row.href ? ` <a href="${escapeHtml(row.href)}">Open in Room</a>` : "";
    const extra = row.text ? `<br>${escapeHtml(row.text)}` : "";
    return `<p>${escapeHtml(row.head)}${extra}${link}</p>`;
  }).join("");
  const html = `<div>${htmlRows}<p><a href="${escapeHtml(unsubscribe?.url ?? "")}">Unsubscribe</a></p></div>`;
  const headers = unsubscribe?.headers ?? {};
  return { skipped: false, subject, text, html, headers };
}

function sign(secret, payload) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

// Per-user unsubscribe link. scope is "global" or "room:<id>". The signature
// covers the payload; NOTIFY accepts it without a session (one-click).
export function signUnsubscribe({ memberId, scope = "global", secret, baseUrl, now = Date.now() } = {}) {
  if (typeof memberId !== "string" || !memberId || typeof secret !== "string" || secret.length < 16) {
    throw new Error("unsubscribe link needs a member and a signing secret");
  }
  if (scope !== "global" && !/^room:[A-Za-z0-9_.:-]{1,128}$/.test(scope)) {
    throw new Error("unsubscribe scope must be global or room:<id>");
  }
  let origin;
  try { origin = new URL(baseUrl); } catch { throw new Error("unsubscribe link needs an https base URL"); }
  if (origin.protocol !== "https:") throw new Error("unsubscribe link needs an https base URL");
  const payload = Buffer.from(JSON.stringify({ m: memberId, s: scope, t: Math.floor(now / 1000) })).toString("base64url");
  const version = "v1";
  const token = `${version}.${payload}.${sign(secret, payload)}`;
  const url = new URL("/unsubscribe", origin.origin);
  url.searchParams.set("u", token);
  return Object.freeze({
    url: url.toString(),
    token,
    headers: Object.freeze({
      "List-Unsubscribe": `<${url.toString()}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"
    })
  });
}

export function verifyUnsubscribe(token, secret) {
  if (typeof token !== "string" || typeof secret !== "string" || secret.length < 16) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const expected = sign(secret, parts[1]);
  const got = Buffer.from(parts[2]);
  const want = Buffer.from(expected);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const body = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (!body || typeof body.m !== "string" || typeof body.s !== "string") return null;
    if (body.s !== "global" && !/^room:[A-Za-z0-9_.:-]{1,128}$/.test(body.s)) return null;
    return Object.freeze({ memberId: body.m, scope: body.s, issuedAt: body.t });
  } catch {
    return null;
  }
}

// Inert unless the caller passes a transport. An unconfigured mailer returns
// unavailable and sends nothing.
export async function sendNotificationEmail({ transport, to, ...message } = {}) {
  if (typeof transport !== "function") return Object.freeze({ available: false, reason: "unavailable" });
  const rendered = renderNotificationEmail(message);
  if (rendered.skipped) return Object.freeze({ available: true, delivered: false, reason: rendered.reason });
  await transport({ to, subject: rendered.subject, text: rendered.text, html: rendered.html, headers: rendered.headers });
  return Object.freeze({ available: true, delivered: true });
}

export function notificationEmailFromEnv(env = process.env, { fetchFn = fetch } = {}) {
  const from = typeof env?.ROOM_MAGIC_FROM === "string" && env.ROOM_MAGIC_FROM
    ? env.ROOM_MAGIC_FROM
    : "Project Room <noreply@trydemigod.com>";
  const transport = resendTransport({ apiKey: env?.RESEND_API_KEY, from, fetchFn });
  if (!transport) return Object.freeze({ available: false, reason: "unavailable", send: null });
  return Object.freeze({
    available: true,
    reason: null,
    send: message => sendNotificationEmail({ transport, ...message })
  });
}
