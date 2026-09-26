// Photon R2: channel provider abstraction.
//
// A provider declares the uniform surface every channel presents to the room:
//   name            - provider slug, e.g. "telegram-bot" (matches the ids in
//                     server/channel-adapters/index.mjs).
//   channel         - channel family, e.g. "telegram".
//   capabilities    - explicit booleans: { send, receive, webhook, poll }.
//                     A declared capability must be backed by the matching
//                     interface; the spec is rejected otherwise.
//   validateConfig  - (config) -> config. Shape-checks the provider's config
//                     without ever carrying credentials; throws on mismatch.
//   createSender    - (deps) -> { kind, submit, lookup }. Present when the send
//                     capability is declared. The returned sender obeys the
//                     SyntheticInboxTransport contract: submit({ operationId,
//                     envelope }) -> receipt, lookup({ operationId }) -> receipt
//                     or null. One operation id maps to one provider attempt:
//                     a retried submit replays the recorded receipt.
//   normalize       - (connection, raw) -> envelope. Present when the receive
//                     capability is declared. Accepts a raw inbound payload
//                     (a webhook body or one getUpdates item) and returns the
//                     normalized envelope; throws a contract error on garbage.
//
// Providers wrap the existing drivers (server/channel-adapters/*,
// server/inbox-transport.mjs) without reimplementing or weakening them.
// This module never touches the network, credentials, or server/http.mjs;
// http integration is a follow-up slice. The registry below is the lookup
// surface that follow-up will dispatch through.

export class ChannelProviderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ChannelProviderError";
    this.code = code;
  }
}

export const CHANNEL_CAPABILITIES = Object.freeze(["send", "receive", "webhook", "poll"]);

const defined = new WeakSet();
const fail = (code, message) => { throw new ChannelProviderError(code, message); };
const slug = value => typeof value === "string" && /^[a-z0-9][a-z0-9_-]*$/.test(value);

// Validate a provider declaration and return the frozen definition. Every
// mismatch fails here, at definition time, so a bad provider can never reach
// the registry and surface as a confusing runtime error later.
export function defineChannelProvider(spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) fail("invalid_provider_spec", "A provider spec object is required.");
  const { name, channel, capabilities, validateConfig, createSender, normalize } = spec;
  if (!slug(name)) fail("invalid_provider_spec", "Provider name must be a lowercase slug like \"telegram-bot\".");
  if (typeof channel !== "string" || !channel.trim()) fail("invalid_provider_spec", "Provider channel must be a non-empty string.");
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities))
    fail("invalid_provider_spec", "Provider capabilities must declare { send, receive, webhook, poll }.");
  for (const key of CHANNEL_CAPABILITIES) {
    if (typeof capabilities[key] !== "boolean")
      fail("invalid_provider_spec", `Capability "${key}" must be an explicit boolean; declare what the provider backs, don't imply it.`);
  }
  const unknown = Object.keys(capabilities).filter(key => !CHANNEL_CAPABILITIES.includes(key));
  if (unknown.length) fail("invalid_provider_spec", `Unknown capabilities: ${unknown.join(", ")}.`);
  if (typeof validateConfig !== "function") fail("invalid_provider_spec", "validateConfig(config) is required.");
  if (capabilities.send && typeof createSender !== "function")
    fail("invalid_provider_spec", "createSender(deps) is required when the send capability is declared.");
  if (capabilities.receive && typeof normalize !== "function")
    fail("invalid_provider_spec", "normalize(connection, raw) is required when the receive capability is declared.");
  const provider = {
    name, channel,
    capabilities: Object.freeze({ send: capabilities.send, receive: capabilities.receive, webhook: capabilities.webhook, poll: capabilities.poll }),
    validateConfig,
    createSender: typeof createSender === "function" ? createSender : null,
    normalize: typeof normalize === "function" ? normalize : null,
  };
  defined.add(provider);
  return Object.freeze(provider);
}

// Minimal registry for defined providers: register / lookup by name / list.
// Only defineChannelProvider definitions are accepted; duplicates and unknown
// lookups throw so dispatch can never silently fall through to nothing.
export function createChannelProviderRegistry() {
  const providers = new Map();
  return Object.freeze({
    register(provider) {
      if (!provider || typeof provider !== "object" || !defined.has(provider))
        fail("invalid_provider_spec", "Only defineChannelProvider definitions can be registered.");
      if (providers.has(provider.name)) fail("duplicate_provider", `Channel provider "${provider.name}" is already registered.`);
      providers.set(provider.name, provider);
      return provider;
    },
    provider(name) {
      const provider = providers.get(name);
      if (!provider) fail("unknown_provider", `No channel provider registered as "${name}".`);
      return provider;
    },
    names() { return [...providers.keys()]; },
  });
}
