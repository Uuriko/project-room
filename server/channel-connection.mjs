// Channel-agnostic connection record. Data contract only: no credentials,
// network, persistence or send authority. Email (Graph) and Telegram share it.
export class ContractError extends TypeError {
  constructor(code) { super(code); this.name = "EmailContractError"; this.code = code; }
}
export const requireContract = (condition, code = "invalid_channel_connection") => { if (!condition) throw new ContractError(code); };
const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
export const exactFields = (v, keys) => object(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const text = (value, max, empty = false) => {
  requireContract(typeof value === "string" && value.isWellFormed() && (empty || value.trim().length > 0)
    && Buffer.byteLength(value) <= max && !/[\u0000-\u001f\u007f]/.test(value));
  return value;
};
const localId = value => { requireContract(typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)); return value; };
const boolean = value => { requireContract(typeof value === "boolean"); return value; };

// Registry of known channels and their providers. Adding a platform means adding
// its provider here and an adapter module under server/channel-adapters/.
export const channelProviders = Object.freeze({ email: Object.freeze(["microsoft-graph", "gmail-api"]), telegram: Object.freeze(["telegram-bot"]), whatsapp: Object.freeze(["whatsapp-cloud"]), sms: Object.freeze(["sms-gateway"]), messenger: Object.freeze(["messenger-api"]) });
export const channels = Object.freeze(Object.keys(channelProviders));
export const connectionStates = Object.freeze(["active", "disconnected", "reconnect_required"]);
export const participantKinds = Object.freeze(["mailbox", "user", "bot", "chat", "group", "channel"]);
const profileFields = ["accountId", "id", "revision", "channel", "provider", "externalId", "identity", "capabilities"];
const capabilityFields = ["read", "send", "threads", "edit"];

// One shape for a connection identity and for message participants.
export function channelParticipant(value) {
  requireContract(exactFields(value, ["kind", "id", "handle", "displayName"]) && participantKinds.includes(value.kind), "invalid_channel_participant");
  return { kind: value.kind, id: text(value.id, 2048), handle: text(value.handle, 320, true), displayName: text(value.displayName, 1024, true) };
}
export function channelCapabilities(value) {
  requireContract(exactFields(value, capabilityFields), "invalid_channel_capabilities");
  return Object.fromEntries(capabilityFields.map(k => [k, boolean(value[k])]));
}
// The configured profile: what an owner supplies and what envelopes embed.
export function channelProfile(value) {
  requireContract(exactFields(value, profileFields));
  requireContract(channels.includes(value.channel) && channelProviders[value.channel].includes(value.provider), "unsupported_channel");
  requireContract(Number.isSafeInteger(value.revision) && value.revision > 0);
  return { accountId: localId(value.accountId), id: localId(value.id), revision: value.revision, channel: value.channel,
    provider: value.provider, externalId: text(value.externalId, 2048), identity: channelParticipant(value.identity),
    capabilities: channelCapabilities(value.capabilities) };
}
// The full record: profile plus its current connection state. Extra keys are rejected.
export function channelConnection(value) {
  requireContract(exactFields(value, [...profileFields, "state"]));
  requireContract(connectionStates.includes(value.state), "invalid_channel_connection");
  const { state, ...profile } = value;
  return { ...channelProfile(profile), state };
}
// Email profiles keep their historical Graph shape in journals and envelopes.
// This maps either stored shape onto the generic record without rewriting data.
export const isEmailProfile = value => object(value) && Object.hasOwn(value, "mailboxId");
export function toChannelProfile(profile) {
  if (!isEmailProfile(profile)) return channelProfile(profile);
  requireContract(object(profile.identity), "invalid_email_connection");
  return channelProfile({ accountId: profile.accountId, id: profile.id, revision: profile.revision, channel: "email", provider: profile.provider,
    externalId: profile.mailboxId, identity: { kind: "mailbox", id: profile.identity.address, handle: profile.identity.address, displayName: profile.identity.name },
    capabilities: { read: true, send: false, threads: true, edit: false } });
}
// Effective state of a stored connection for the account's current authorization epoch.
export const connectionState = (connection, authEpoch) => connection.state === "disconnected" ? "disconnected"
  : connection.authEpoch !== authEpoch ? "reconnect_required" : "active";
// Column values shared by every channel in the connections table.
export const profileExternalId = profile => isEmailProfile(profile) ? profile.mailboxId : profile.externalId;
export const profileChannel = profile => isEmailProfile(profile) ? "email" : profile?.channel;
