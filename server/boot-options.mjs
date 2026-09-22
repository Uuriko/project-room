import { googleConfig } from './google-oauth.mjs';
import { gmailConfig } from './gmail-mailbox.mjs';
// The default boot path wires its HTTP server arguments here so both the
// local/staging entry point (server.mjs) and any test can build the exact
// same server the boot would. The ChannelWebhookInbox is constructed next to
// the store: without it the webhook route answers 409 channel_webhook_unavailable
// and Telegram inbound deliveries never land. Cloudflare's entry point
// (cloudflare/room.mjs) passes an equivalent value itself.
import { ChannelWebhookInbox } from "./channel-import.mjs";
import { createMagicLinkMailer } from "./magic-links.mjs";
import { magicLinkMailerFromEnv } from "./resend-mailer.mjs";

export function defaultServerArgs({ store, env = process.env, ...rest }) {
  const send = magicLinkMailerFromEnv(env);
  const magicLinkMailer = send
    ? createMagicLinkMailer({ send, baseUrl: rest.origin ?? null })
    : createMagicLinkMailer();
  const googleAuth = rest.origin ? googleConfig(env, rest.origin) : null;
  const gmailAuth = rest.origin ? gmailConfig(env, rest.origin, googleAuth) : null;
  return { googleAuth, gmailAuth, ...rest, store, channelWebhooks: store ? new ChannelWebhookInbox(store) : null, magicLinkMailer };
}
