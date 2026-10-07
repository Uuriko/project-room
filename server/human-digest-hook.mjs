// Human digest hook (IS-UX-1, #1601). Policy first, delivery second.
// shouldSendDigest is the pure gate: empty feed, member opt-out, and quiet
// hours all hold the digest before anything renders. digestRenderInput builds
// the renderer's input ({kind:"brief", sections}); buildDigestEmail renders
// it through the existing notification email renderer (server/notify-email.mjs)
// for preview. deliverDigestEmail passes the same INPUT (not the rendered
// mail) to mailer.send, because the mailer renders itself via
// sendNotificationEmail — handing it pre-rendered subject/text would silently
// drop the digest and send an empty batch instead. Delivery stays inert
// without mail infra: with no RESEND_API_KEY the result is {delivered:false,
// reason:"transport_unavailable"}. No scheduler, no new tables, no routes:
// this is the hook a future digest runner calls, not the runner itself.
import { renderNotificationEmail, notificationEmailFromEnv } from "./notify-email.mjs";
import { buildDigestSections } from "./human-digest-content.mjs";
import { isQuietAt } from "./notify-prefs.mjs";

const feedItems = feed => (Array.isArray(feed?.notifications) ? feed.notifications : []);

// Pure policy gate. Returns {send:boolean, reason}.
export function shouldSendDigest({ member = {}, feed = null, now = Date.now() } = {}) {
  const items = feedItems(feed);
  if (items.length === 0) return { send: false, reason: "empty_feed" };
  const prefs = member?.notificationPreferences ?? {};
  if (prefs.email_digest === false) return { send: false, reason: "opted_out" };
  if (prefs.quietHours != null) {
    try {
      if (isQuietAt(prefs.quietHours, now)) return { send: false, reason: "quiet_hours" };
    } catch {
      // Malformed quiet hours fail open: the digest is not safety-critical.
    }
  }
  return { send: true, reason: "ok" };
}

// Renderer input for one digest. This (not the rendered email) is what
// deliverDigestEmail hands to the mailer, which renders it itself.
export function digestRenderInput({ feed = null, roomName = "Room" } = {}) {
  return {
    kind: "brief",
    sections: buildDigestSections({ items: feedItems(feed), roomName })
  };
}

// Rendered email (the renderer's shape), for preview. Callers must check
// shouldSendDigest first; an empty feed renders to {skipped:true} and never
// to an empty mail.
export function buildDigestEmail({ member = {}, feed = null, roomName = "Room" } = {}) {
  return renderNotificationEmail(digestRenderInput({ feed, roomName }));
}

// Sends through the configured transport. `input` is digestRenderInput(...).
// The inner send result is propagated honestly: a skipped render reports
// {delivered:false}, never a phantom success.
export async function deliverDigestEmail({ to, input = null, env = process.env, fetchFn = fetch } = {}) {
  const mailer = notificationEmailFromEnv(env, { fetchFn });
  if (!mailer.available || typeof mailer.send !== "function") {
    return Object.freeze({ delivered: false, reason: "transport_unavailable" });
  }
  const { kind = "brief", sections = [] } = input ?? {};
  const result = await mailer.send({ to, kind, sections });
  if (result?.delivered === true) return Object.freeze({ delivered: true });
  return Object.freeze({ delivered: false, reason: result?.reason ?? "skipped" });
}
