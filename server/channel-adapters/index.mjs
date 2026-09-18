// Channel registry: provider -> adapter module. Every adapter exposes
// { channel, provider, readEnvelope, sourceId, scope, bind }.
// bind({ reader, connection, ... }) returns the uniform driver interface
// { channel, provider, normalize(raw), changes({ cursor }), hydrate(id), submit(), lookup() },
// plus close() when the reader has a lifecycle (the live Telegram poller).
// Readers start as fixtures; live drivers slot into the same bind.
import * as email from "./email.mjs";
import * as telegram from "./telegram.mjs";
import * as gmail from "./gmail.mjs";
import * as whatsapp from "./whatsapp.mjs";
import * as sms from "./sms.mjs";
import * as messenger from "./messenger.mjs";
import { ContractError, channelProviders, profileChannel } from "../channel-connection.mjs";

export const channelAdapters = Object.freeze(new Map([email, telegram, gmail, whatsapp, sms, messenger].map(adapter => [adapter.provider, adapter])));
for (const [channel, providers] of Object.entries(channelProviders)) {
  for (const provider of providers) if (channelAdapters.get(provider)?.channel !== channel) throw new Error(`Channel adapter missing for ${provider}`);
}
export function adapterFor(provider) {
  const adapter = channelAdapters.get(provider);
  if (!adapter) throw new ContractError("unsupported_channel");
  return adapter;
}
export const adapterForChannel = channel => adapterFor(channelProviders[channel]?.[0] ?? "");
export const adapterForProfile = profile => adapterForChannel(profileChannel(profile));
// Dispatch on the envelope's declared channel; each adapter re-derives and checks it.
export function readChannelEnvelope(value) {
  if (!value || typeof value !== "object" || !Object.hasOwn(channelProviders, value.channel)) throw new ContractError("unsupported_channel");
  return adapterForChannel(value.channel).readEnvelope(value);
}
