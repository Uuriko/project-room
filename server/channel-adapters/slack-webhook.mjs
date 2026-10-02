// Slack incoming webhook (HB-1a). Block Kit: one section, a context line, and
// link buttons. The webhook URL is sealed and never logged. Full message text
// is omitted unless the caller sets includeFullText.
import { assertRelayUrl, sealWebhookUrl, openWebhookUrl, postWebhook } from "./webhook-secret.mjs";

const HOSTS = Object.freeze(["hooks.slack.com"]);
const PATHS = Object.freeze(["/services/"]);

export function validateSlackWebhookUrl(url) {
  return assertRelayUrl(url, { hosts: HOSTS, pathPrefix: PATHS });
}

export function sealSlackWebhookUrl(url, key) {
  return sealWebhookUrl(url, key, validateSlackWebhookUrl);
}

export function openSlackWebhookUrl(sealed, key) {
  return openWebhookUrl(sealed, key, validateSlackWebhookUrl);
}

const clip = (value, max) => typeof value === "string" ? value.replace(/[\r\n]/g, " ").trim().slice(0, max) : "";

function linkButton(text, url) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
  return { type: "button", text: { type: "plain_text", text }, url: parsed.toString() };
}

// Compact Block Kit body. fullText is included only when includeFullText is
// true, and then only the first 140 characters.
export function slackPayload(message = {}) {
  const title = clip(message.title, 120) || "Room";
  const reason = clip(message.reason, 200);
  const context = clip(message.context, 120);
  const lines = [title];
  if (reason) lines.push(reason);
  if (message.includeFullText === true) {
    const extra = clip(message.fullText, 140);
    if (extra) lines.push(extra);
  }
  const blocks = [{ type: "section", text: { type: "mrkdwn", text: lines.join("\n") } }];
  if (context) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: context }] });
  const buttons = [linkButton("Open in Room", message.url), linkButton("Approve", message.approveUrl)].filter(Boolean);
  if (buttons.length) blocks.push({ type: "actions", elements: buttons });
  return { blocks };
}

export async function send(webhookUrl, message, options = {}) {
  const url = validateSlackWebhookUrl(webhookUrl);
  return postWebhook({ url, body: slackPayload(message), ...options });
}
