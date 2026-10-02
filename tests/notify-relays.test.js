// Slack and Discord relay adapters, and the notification email renderer.
// Fetch is injected. Webhook URLs are not echoed in errors.
import test from "node:test";
import assert from "node:assert/strict";
import { RelayError } from "../server/channel-adapters/webhook-secret.mjs";
import {
  validateSlackWebhookUrl, sealSlackWebhookUrl, openSlackWebhookUrl, slackPayload, send as sendSlack
} from "../server/channel-adapters/slack-webhook.mjs";
import {
  validateDiscordWebhookUrl, sealDiscordWebhookUrl, openDiscordWebhookUrl, discordPayload, send as sendDiscord
} from "../server/channel-adapters/discord-webhook.mjs";
import {
  renderNotificationEmail, signUnsubscribe, verifyUnsubscribe, sendNotificationEmail, notificationEmailFromEnv
} from "../server/notify-email.mjs";

const KEY = "ab".repeat(32);
const SLACK = "https://hooks.slack.com/services/T000/B000/super-secret-token";
const DISCORD = "https://discord.com/api/webhooks/123/super-secret-token";
const DISCORD_APP = "https://discordapp.com/api/webhooks/123/super-secret-token";
const lookup = async () => [{ address: "1.1.1.1" }];
const SECRET = "the seahorse password is coral-99";

const message = {
  title: "Codex needs you",
  reason: "because Codex asked you to approve 'deploy staging'",
  context: "Muse Room",
  url: "https://room.example/?room=muse",
  approveUrl: "https://room.example/m/needs-you",
  fullText: SECRET,
  includeFullText: false
};

const refuses = (fn) => assert.throws(fn, error =>
  error instanceof RelayError && error.code === "invalid_webhook_url" && !error.message.includes("super-secret-token"));

test("relay URLs accept only the public webhook hosts", () => {
  assert.equal(validateSlackWebhookUrl(SLACK), SLACK);
  assert.equal(validateDiscordWebhookUrl(DISCORD), DISCORD);
  assert.equal(validateDiscordWebhookUrl(DISCORD_APP), DISCORD_APP);
  refuses(() => validateSlackWebhookUrl("https://example.com/services/T/B/super-secret-token"));
  refuses(() => validateSlackWebhookUrl("http://hooks.slack.com/services/T/B/super-secret-token"));
  refuses(() => validateSlackWebhookUrl("https://127.0.0.1/services/T/B/super-secret-token"));
  refuses(() => validateSlackWebhookUrl("https://10.1.2.3/services/T/B/super-secret-token"));
  refuses(() => validateDiscordWebhookUrl("https://10.1.2.3/api/webhooks/1/super-secret-token"));
  refuses(() => validateDiscordWebhookUrl("http://discord.com/api/webhooks/1/super-secret-token"));
  refuses(() => validateDiscordWebhookUrl("https://discord.com.evil.example/api/webhooks/1/super-secret-token"));
});

test("a webhook URL is sealed and does not appear in the stored secret", () => {
  const sealed = sealSlackWebhookUrl(SLACK, KEY);
  assert.equal(sealed.includes("hooks.slack.com"), false);
  assert.equal(sealed.includes("super-secret-token"), false);
  assert.equal(openSlackWebhookUrl(sealed, KEY), SLACK);
  const discord = sealDiscordWebhookUrl(DISCORD, KEY);
  assert.equal(discord.includes("discord.com"), false);
  assert.equal(openDiscordWebhookUrl(discord, KEY), DISCORD);
  assert.throws(() => openSlackWebhookUrl(sealed, "cd".repeat(32)), error =>
    error instanceof RelayError && error.code === "invalid_webhook_secret" && !error.message.includes("hooks.slack.com"));
});

test("Slack Block Kit and Discord embed payloads omit the message body", () => {
  assert.deepEqual(slackPayload(message), {
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: "Codex needs you\nbecause Codex asked you to approve 'deploy staging'" } },
      { type: "context", elements: [{ type: "mrkdwn", text: "Muse Room" }] },
      { type: "actions", elements: [
        { type: "button", text: { type: "plain_text", text: "Open in Room" }, url: "https://room.example/?room=muse" },
        { type: "button", text: { type: "plain_text", text: "Approve" }, url: "https://room.example/m/needs-you" }
      ] }
    ]
  });
  assert.equal(JSON.stringify(slackPayload(message)).includes(SECRET), false);
  assert.equal(JSON.stringify(slackPayload({ ...message, includeFullText: true })).includes(SECRET), true);

  assert.deepEqual(discordPayload(message), {
    embeds: [{
      title: "Codex needs you",
      description: "because Codex asked you to approve 'deploy staging'",
      url: "https://room.example/?room=muse"
    }],
    components: [{
      type: 1,
      components: [
        { type: 2, style: 5, label: "Open in Room", url: "https://room.example/?room=muse" },
        { type: 2, style: 5, label: "Approve", url: "https://room.example/m/needs-you" }
      ]
    }]
  });
  assert.equal(JSON.stringify(discordPayload(message)).includes(SECRET), false);
});

test("a 429 waits out a short Retry-After and reports a long one", async () => {
  let calls = 0;
  const slept = [];
  const delivered = await sendSlack(SLACK, message, {
    lookup,
    sleep: async (ms) => { slept.push(ms); },
    fetchFn: async () => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 429, headers: { get: () => "0" } };
      return { ok: true, status: 204, headers: { get: () => null } };
    }
  });
  assert.equal(delivered.delivered, true);
  assert.equal(delivered.status, 204);
  assert.deepEqual(slept, [0]);

  const now = 1_700_000_000_000;
  const deferred = await sendDiscord(DISCORD, message, {
    lookup, now: () => now, sleep: async () => { throw new Error("should not wait"); },
    fetchFn: async () => ({ ok: false, status: 429, headers: { get: () => "30" } })
  });
  assert.equal(deferred.delivered, false);
  assert.equal(deferred.status, 429);
  assert.equal(deferred.retryAt, now + 30_000);
});

test("a webhook name that resolves to a private address is not posted", async () => {
  let called = false;
  await assert.rejects(() => sendSlack(SLACK, message, {
    lookup: async () => [{ address: "10.0.0.8" }],
    fetchFn: async () => { called = true; return { ok: true, status: 200 }; }
  }), error => error instanceof RelayError && error.code === "invalid_webhook_url" && !error.message.includes("super-secret-token"));
  assert.equal(called, false);
});

test("notification email carries one-click unsubscribe headers and skips an empty brief", () => {
  const unsubscribe = signUnsubscribe({
    memberId: "ada", scope: "room:muse", secret: "s".repeat(16), baseUrl: "https://room.example"
  });
  assert.equal(unsubscribe.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  assert.match(unsubscribe.headers["List-Unsubscribe"], /^<https:\/\/room\.example\/unsubscribe\?u=v1\./);
  assert.deepEqual(verifyUnsubscribe(unsubscribe.token, "s".repeat(16)), { memberId: "ada", scope: "room:muse", issuedAt: verifyUnsubscribe(unsubscribe.token, "s".repeat(16)).issuedAt });
  assert.equal(verifyUnsubscribe(unsubscribe.token, "t".repeat(16)), null);

  const rendered = renderNotificationEmail({
    kind: "batch",
    items: [{ title: "deploy staging", reason: "because Codex asked you to approve 'deploy staging'", url: "https://room.example/?room=muse", fullText: SECRET }],
    unsubscribe
  });
  assert.equal(rendered.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  assert.equal(rendered.text.includes(SECRET), false);
  assert.equal(rendered.html.includes(SECRET), false);
  assert.match(rendered.text, /because Codex asked you to approve 'deploy staging'/);

  const shown = renderNotificationEmail({
    kind: "batch",
    items: [{ title: "deploy staging", reason: "because Codex asked you to approve 'deploy staging'", includeFullText: true, fullText: SECRET, url: "https://room.example/?room=muse" }],
    unsubscribe
  });
  assert.equal(shown.text.includes(SECRET), true);

  assert.equal(renderNotificationEmail({ kind: "brief", sections: [] }).skipped, true);
});

test("an unconfigured mailer is unavailable and sends nothing", async () => {
  assert.deepEqual(notificationEmailFromEnv({}), { available: false, reason: "unavailable", send: null });
  let called = false;
  const missing = await sendNotificationEmail({
    to: "ada@example.com",
    items: [{ title: "deploy staging", reason: "because Codex asked you to approve 'deploy staging'" }]
  });
  assert.deepEqual(missing, { available: false, reason: "unavailable" });

  const calls = [];
  const configured = notificationEmailFromEnv({
    RESEND_API_KEY: "re_test", ROOM_MAGIC_FROM: "Room <noreply@example.com>"
  }, {
    fetchFn: async (_url, options) => {
      called = true;
      calls.push(JSON.parse(options.body));
      return { ok: true, status: 200, text: async () => "" };
    }
  });
  const unsubscribe = signUnsubscribe({ memberId: "ada", secret: "s".repeat(16), baseUrl: "https://room.example" });
  const sent = await configured.send({
    to: "ada@example.com",
    kind: "batch",
    items: [{ title: "deploy staging", reason: "because Codex asked you to approve 'deploy staging'", url: "https://room.example/?room=muse", fullText: SECRET }],
    unsubscribe
  });
  assert.equal(sent.delivered, true);
  assert.equal(called, true);
  assert.equal(calls[0].headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  assert.match(calls[0].headers["List-Unsubscribe"], /unsubscribe\?u=/);
  assert.equal(JSON.stringify(calls[0]).includes(SECRET), false);
});
