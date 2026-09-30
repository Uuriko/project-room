// Photon R2 channel provider: registry/spec contracts plus the Telegram
// provider's send path. Each test guards a distinct contract at this
// boundary; the underlying transport/normalize internals stay owned by their
// own test files (telegram-transport, telegram-adapter).
import test from "node:test";
import assert from "node:assert/strict";
import { defineChannelProvider, createChannelProviderRegistry, CHANNEL_CAPABILITIES } from "../server/photon-channel-provider.mjs";
import { telegramChannelProvider, validateTelegramProviderConfig } from "../server/photon-channel-telegram.mjs";
import { telegramContractFixture } from "../scripts/telegram-contract-fixture.mjs";

const validSpec = (overrides = {}) => ({
  name: "sms-test", channel: "sms",
  capabilities: { send: true, receive: true, webhook: false, poll: false },
  validateConfig: config => config,
  createSender: () => ({}),
  normalize: () => ({}),
  ...overrides,
});

test("defines a frozen provider and registers it for lookup by name", () => {
  const defined = defineChannelProvider(validSpec());
  assert.equal(defined.name, "sms-test");
  assert.deepEqual(defined.capabilities, { send: true, receive: true, webhook: false, poll: false });
  assert.ok(Object.isFrozen(defined) && Object.isFrozen(defined.capabilities), "definitions are immutable once built");
  const registry = createChannelProviderRegistry();
  assert.deepEqual(registry.names(), [], "empty until registered");
  assert.equal(registry.register(defined), defined);
  assert.equal(registry.provider("sms-test"), defined, "lookup returns the registered definition");
  assert.deepEqual(registry.names(), ["sms-test"]);
  assert.deepEqual(CHANNEL_CAPABILITIES, ["send", "receive", "webhook", "poll"]);
});

test("registry rejects duplicates, unknown lookups and hand-rolled impostors", () => {
  const registry = createChannelProviderRegistry();
  registry.register(defineChannelProvider(validSpec({ name: "one" })));
  assert.throws(() => registry.register(defineChannelProvider(validSpec({ name: "one" }))), { name: "ChannelProviderError", code: "duplicate_provider" });
  assert.throws(() => registry.provider("missing"), { name: "ChannelProviderError", code: "unknown_provider" });
  // A duck-typed object with every field present is still refused: only
  // defineChannelProvider output carries the brand.
  const impostor = { name: "impostor", channel: "sms", capabilities: { send: false, receive: false, webhook: false, poll: false },
    validateConfig: c => c, createSender: null, normalize: null };
  assert.throws(() => registry.register(impostor), { name: "ChannelProviderError", code: "invalid_provider_spec" });
});

test("spec validation fails fast on malformed declarations", () => {
  const cases = [
    ["not an object", null],
    ["missing name", validSpec({ name: undefined })],
    ["name not a slug", validSpec({ name: "Telegram Bot" })],
    ["missing channel", validSpec({ channel: "" })],
    ["missing capabilities", validSpec({ capabilities: undefined })],
    ["capability not a boolean", validSpec({ capabilities: { send: 1, receive: false, webhook: false, poll: false } })],
    ["unknown capability key", validSpec({ capabilities: { send: false, receive: false, webhook: false, poll: false, carrierPigeon: true } })],
    ["send declared without createSender", validSpec({ createSender: undefined })],
    ["receive declared without normalize", validSpec({ normalize: undefined })],
    ["missing validateConfig", validSpec({ validateConfig: undefined })],
  ];
  for (const [label, spec] of cases) {
    assert.throws(() => defineChannelProvider(spec), { name: "ChannelProviderError", code: "invalid_provider_spec" }, label);
  }
  // Declared-but-unbacked is fine when the capability is false: a send-only
  // provider needs no normalize hook.
  const sendOnly = defineChannelProvider(validSpec({ name: "send-only", capabilities: { send: true, receive: false, webhook: false, poll: false }, normalize: undefined }));
  assert.equal(sendOnly.normalize, null);
});

const BOT_URL = "https://api.telegram.test/botTEST/";
const liveConfig = () => ({ configured: true, methodUrl: method => BOT_URL + method });
// The fake transport throws on anything it does not expect, so a rewired
// sender that hits the wrong URL or method fails loudly instead of passing.
function fakeTelegramTransport(calls, { messageId = 77 } = {}) {
  return async (url, init) => {
    if (url !== BOT_URL + "sendMessage") throw new Error("unexpected fetch url: " + url);
    if (init?.method !== "POST") throw new Error("unexpected fetch method: " + init?.method);
    calls.push({ url, body: JSON.parse(init.body) });
    return { status: 200, ok: true, json: async () => ({ ok: true, result: { message_id: messageId } }) };
  };
}
const outboxEnvelope = (overrides = {}) => ({
  adapter: "telegram", provider: "telegram-bot",
  target: { chatId: "-1001000000001", replyToMessageId: null, threadId: "-1001000000001" },
  body: "Hello from the Photon provider test",
  previewVersion: "pv-1",
  ...overrides,
});
const sender = (config, fetchImpl) => telegramChannelProvider.createSender({
  config, fetch: fetchImpl, receipts: new Map(), sleep: () => Promise.resolve(), now: () => 1788948000000,
});

test("telegram provider sends through createSender against a fake transport", async () => {
  const calls = [];
  const transport = sender(liveConfig(), fakeTelegramTransport(calls));
  assert.equal(transport.kind, "telegram-bot");
  const receipt = await transport.submit({ operationId: "op-1", envelope: outboxEnvelope() });
  assert.equal(receipt.outcome, "accepted");
  assert.equal(receipt.providerId, "telegram:-1001000000001:77");
  assert.equal(receipt.operationId, "op-1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.chat_id, "-1001000000001", "the Bot API sendMessage body reaches the right chat (M-25: ids travel as validated digit strings)");
  assert.equal(calls[0].body.text, "Hello from the Photon provider test");
  const lookedUp = await transport.lookup({ operationId: "op-1" });
  assert.equal(lookedUp.providerId, receipt.providerId, "the recorded receipt is reconcilable by operation id");
  assert.equal(await transport.lookup({ operationId: "op-unknown" }), null);
});

test("telegram provider preserves at-most-once send across retried submits", async () => {
  const calls = [];
  const transport = sender(liveConfig(), fakeTelegramTransport(calls));
  const envelope = outboxEnvelope();
  const first = await transport.submit({ operationId: "op-retry", envelope });
  const second = await transport.submit({ operationId: "op-retry", envelope: structuredClone(envelope) });
  assert.deepEqual(second, first, "a retried submit replays the recorded receipt");
  assert.equal(calls.length, 1, "the provider hit the Bot API exactly once");
});

test("telegram provider falls back to the fixture sender while unconfigured", async () => {
  let fetched = false;
  const transport = telegramChannelProvider.createSender({ config: { configured: false }, fetch: async () => { fetched = true; throw new Error("must not reach the network"); } });
  assert.equal(transport.kind, "telegram-bot");
  const receipt = await transport.submit({ operationId: "op-fixture", envelope: outboxEnvelope() });
  assert.equal(receipt.outcome, "accepted");
  assert.match(receipt.providerId, /^fixture:/);
  assert.equal(fetched, false, "nothing leaves the process while unconfigured");
});

test("telegram provider advertises capabilities backed by working interfaces", () => {
  assert.deepEqual(telegramChannelProvider.capabilities, { send: true, receive: true, webhook: true, poll: true });
  assert.equal(telegramChannelProvider.name, "telegram-bot");
  assert.equal(telegramChannelProvider.channel, "telegram");
  // send: createSender yields the submit/lookup surface the room dispatches on.
  const transport = telegramChannelProvider.createSender({ config: { configured: false } });
  assert.equal(typeof transport.submit, "function");
  assert.equal(typeof transport.lookup, "function");
  // receive: a raw Bot API update normalizes into the telegram envelope.
  const { connection, updates } = telegramContractFixture();
  const envelope = telegramChannelProvider.normalize(connection, updates[0]);
  assert.equal(envelope.channel, "telegram");
  assert.equal(envelope.message.id, "-1001000000001:41");
  assert.match(envelope.body.content, /Shall we work on this together/);
});

test("telegram config validation accepts telegramConfig() shapes and rejects the rest", () => {
  const live = { configured: true, methodUrl: () => "https://x/" };
  assert.equal(validateTelegramProviderConfig({ configured: false }).configured, false);
  assert.equal(validateTelegramProviderConfig(live), live, "a valid config passes through unchanged");
  for (const bad of [null, undefined, {}, [], { configured: "yes" }, { configured: true }, { configured: true, methodUrl: "nope" }]) {
    assert.throws(() => validateTelegramProviderConfig(bad), { name: "ChannelProviderError", code: "invalid_provider_config" });
  }
  // createSender runs the same validation before any driver is constructed.
  assert.throws(() => telegramChannelProvider.createSender({ config: { configured: true } }), { name: "ChannelProviderError", code: "invalid_provider_config" });
});
