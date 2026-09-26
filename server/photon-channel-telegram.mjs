// Photon R2: Telegram as channel provider #1.
//
// Wraps the existing Telegram drivers without reimplementing or weakening
// anything: send goes through TelegramTransport (server/channel-adapters/
// telegram-transport.mjs) with its retry, idempotency-by-operation-id and
// receipt semantics intact; inbound normalization reuses normalizeTelegramUpdate
// from server/channel-adapters/telegram.mjs. The fixture fallback mirrors
// server/http.mjs: no configured bindings, no network, every send answered
// "accepted" as a sample. No credentials live in this module.
import { defineChannelProvider, ChannelProviderError } from "./photon-channel-provider.mjs";
import { channel, provider, normalizeTelegramUpdate } from "./channel-adapters/telegram.mjs";
import { telegramSendAdapter } from "./channel-adapters/telegram-transport.mjs";
import { FixtureChannelSender } from "./inbox-transport.mjs";

const fail = (code, message) => { throw new ChannelProviderError(code, message); };

// Shape-check the telegramConfig() object the room passes around: configured
// must be an explicit boolean, and a configured binding must expose methodUrl.
// Never inspects the token itself; a shape this validates is what
// TelegramTransport requires before it will construct.
export function validateTelegramProviderConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config) || typeof config.configured !== "boolean")
    fail("invalid_provider_config", "Telegram provider config must come from telegramConfig().");
  if (config.configured && typeof config.methodUrl !== "function")
    fail("invalid_provider_config", "A configured Telegram provider needs methodUrl.");
  return config;
}

export const telegramChannelProvider = defineChannelProvider({
  name: provider, // "telegram-bot"
  channel,        // "telegram"
  // All four ingress/egress paths are real today: sendMessage out, webhook
  // and getUpdates-poller in (both feed raw updates through normalize), and
  // channel_post / edited_message updates receive side included.
  capabilities: { send: true, receive: true, webhook: true, poll: true },
  validateConfig: validateTelegramProviderConfig,
  // deps: { config, fixture?, fetch?, sleep?, now?, receipts?, status?,
  //         accountId?, connectionId?, ...transportLimits }.
  // `fixture` is the submit/lookup sender used while unconfigured; the
  // remaining options pass through to TelegramTransport.
  createSender: ({ config, fixture, ...options } = {}) => {
    const checked = validateTelegramProviderConfig(config);
    const fallback = fixture ?? new FixtureChannelSender({ kind: provider,
      status: options.status ?? null, accountId: options.accountId ?? null, connectionId: options.connectionId ?? null });
    return telegramSendAdapter({ config: checked, fixture: fallback, ...options });
  },
  // Raw Bot API update (from the webhook body or one getUpdates item) into the
  // normalized telegram envelope. Throws a contract error on malformed input.
  normalize: (connection, raw) => normalizeTelegramUpdate(connection, raw),
});
