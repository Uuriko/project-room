#!/usr/bin/env node
// Alerts that wake an agent: post a signed MCP Events delivery to a room's
// inbound hook (#5878, POST /api/inbound/{hookId}). The hook opens a Board task
// tagged `post-deploy-regression` with the evidence and assigns and wakes the
// hook's target member, the same tag the #5880 post-deploy-check brief uses.
//
// Off unless both ROOM_ALERT_HOOK_URL and ROOM_ALERT_HOOK_SECRET are set
// (exit 0 with "alert hook not configured"). The secret is never printed.
//
//   node scripts/alert-wake.mjs --source <name> --title <t> --url <run url> [--sha <sha>] [--summary <text>] [--event-id <id>]
import { createHmac, createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { eventSigningKey } from "../server/mcp-events-wire.mjs";

export const ALERT_EVENT = "post-deploy-regression";
const clip = (v, n) => String(v ?? "").slice(0, n);

export function alertEvent({ source, title, url, sha = "", summary = "", eventId, now = Date.now() }) {
  const id = eventId ?? `alert-${createHash("sha256").update(`${source}:${url}`).digest("hex").slice(0, 24)}`;
  const body = [`Source: ${clip(source, 80)}`, sha ? `Revision: ${clip(sha, 40)}` : "", summary ? clip(summary, 1500) : ""].filter(Boolean).join("\n");
  return { eventId: id, name: ALERT_EVENT, timestamp: new Date(now).toISOString(), data: { title: clip(title, 200), body, url: clip(url, 500) } };
}

// Standard Webhooks v1 headers over `${id}.${ts}.${body}`.
export function signDelivery(secret, body, { id = randomUUID(), nowS = Math.floor(Date.now() / 1000) } = {}) {
  const sig = createHmac("sha256", eventSigningKey(secret)).update(`${id}.${nowS}.${body}`).digest("base64");
  return { "webhook-id": id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 128), "webhook-timestamp": String(nowS), "webhook-signature": `v1,${sig}` };
}

export async function sendAlert(input, { env = process.env, fetchImpl = fetch } = {}) {
  const url = env.ROOM_ALERT_HOOK_URL, secret = env.ROOM_ALERT_HOOK_SECRET;
  if (!url || !secret) return { sent: false, reason: "alert hook not configured" };
  if (!/^https:\/\/[^/]+\/api\/inbound\/[A-Za-z0-9_-]{1,128}$/.test(url)) return { sent: false, reason: "ROOM_ALERT_HOOK_URL must be https://<host>/api/inbound/<hookId>" };
  const event = alertEvent(input);
  const body = JSON.stringify(event);
  // webhook-id = eventId: a re-run of the same failure is a duplicate delivery.
  const headers = { "Content-Type": "application/json", ...signDelivery(secret, body, { id: event.eventId }) };
  const res = await fetchImpl(url, { method: "POST", headers, body, redirect: "error", signal: AbortSignal.timeout(10000) });
  const out = await res.json().catch(() => ({}));
  return { sent: res.ok, status: res.status, claimId: out.claimId ?? null, duplicate: out.duplicate ?? null };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[i + 1];
  const out = await sendAlert(args).catch(e => ({ sent: false, reason: String(e?.message ?? e).slice(0, 200) }));
  console.log(JSON.stringify(out));
  if (out.reason === "alert hook not configured") process.exit(0);
  process.exit(out.sent ? 0 : 1);
}
