// Discord incoming webhook (HB-1a). One embed plus link-button components.
// The webhook URL is sealed and never logged. Full message text is omitted
// unless the caller sets includeFullText.
import { assertRelayUrl, sealWebhookUrl, openWebhookUrl, postWebhook } from "./webhook-secret.mjs";

const HOSTS = Object.freeze(["discord.com", "discordapp.com"]);
const PATHS = Object.freeze(["/api/webhooks/"]);

export function validateDiscordWebhookUrl(url) {
  return assertRelayUrl(url, { hosts: HOSTS, pathPrefix: PATHS });
}

export function sealDiscordWebhookUrl(url, key) {
  return sealWebhookUrl(url, key, validateDiscordWebhookUrl);
}

export function openDiscordWebhookUrl(sealed, key) {
  return openWebhookUrl(sealed, key, validateDiscordWebhookUrl);
}

const clip = (value, max) => typeof value === "string" ? value.replace(/[\r\n]/g, " ").trim().slice(0, max) : "";

function linkButton(label, url) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
  return { type: 2, style: 5, label, url: parsed.toString() };
}

export function discordPayload(message = {}) {
  const title = clip(message.title, 120) || "Room";
  const reason = clip(message.reason, 200);
  const description = message.includeFullText === true && clip(message.fullText, 140)
    ? `${reason}\n${clip(message.fullText, 140)}`.trim()
    : reason;
  const embed = { title };
  if (description) embed.description = description;
  let open;
  try { open = new URL(message.url); } catch { open = null; }
  if (open && open.protocol === "https:" && !open.username) embed.url = open.toString();
  const buttons = [linkButton("Open in Room", message.url), linkButton("Approve", message.approveUrl)].filter(Boolean);
  const payload = { embeds: [embed] };
  if (buttons.length) payload.components = [{ type: 1, components: buttons }];
  return payload;
}

export async function send(webhookUrl, message, options = {}) {
  const url = validateDiscordWebhookUrl(webhookUrl);
  return postWebhook({ url, body: discordPayload(message), ...options });
}
