// Connection health assessment (A007). Pure and fixture-driven: no store,
// network, or credential access. Given a stored connection record, the
// account's current auth epoch, and the last sync outcome, it derives one
// health status plus whether the owner must re-authenticate the provider.
//
// Statuses:
//   healthy        last sync succeeded (or never ran and the connection is active)
//   degraded       recent sync failures, not yet conclusive
//   unreachable    repeated failures (>= 3 consecutive) — provider or network down
//   auth_required  the provider rejected our credentials — re-auth prompt
//   disconnected   the owner disconnected this connection on purpose
import { channelProfile, connectionState, isEmailProfile, requireContract } from "./channel-connection.mjs";
import { emailConnection } from "./email-envelope.mjs";

export const healthStatuses = Object.freeze(["healthy", "degraded", "unreachable", "auth_required", "disconnected"]);
// Failures at or above this count mean the provider is down, not flaky.
export const unreachableAfterFailures = 3;

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
// Error codes/statuses that mean "our credential is dead", never "try again later".
const authErrorCodes = Object.freeze(["unauthorized", "token_expired", "invalid_grant", "auth_required", "reconnect_required", "invalid_credentials"]);
const isAuthFailure = error => error != null && (error.status === 401 || error.status === 403 || authErrorCodes.includes(error.code));

const text = (value, max) => {
  requireContract(typeof value === "string" && value.isWellFormed() && value.length <= max, "invalid_channel_health");
  return value;
};
const isoDate = value => {
  requireContract(typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,7})?Z$/.test(value) && Number.isFinite(Date.parse(value)), "invalid_channel_health");
  return value;
};
const count = value => { requireContract(Number.isSafeInteger(value) && value >= 0, "invalid_channel_health"); return value; };
// The last sync outcome: when it ran, whether it failed, and how. Null error = success.
export function lastSyncOutcome(value) {
  requireContract(object(value), "invalid_channel_health");
  const { at = null, error = null, consecutiveFailures = 0 } = value;
  requireContract(at === null || typeof at === "string", "invalid_channel_health");
  if (error !== null) {
    requireContract(object(error), "invalid_channel_health");
    if (error.code !== undefined) text(error.code, 128);
    if (error.status !== undefined) requireContract(Number.isSafeInteger(error.status), "invalid_channel_health");
  }
  return { at: at === null ? null : isoDate(at), error, consecutiveFailures: count(consecutiveFailures) };
}
// Email keeps its Graph-shaped profile; normalize it to channel/provider for health.
const normalizeProfile = value => {
  if (isEmailProfile(value)) { const validated = emailConnection(value); return { channel: "email", provider: validated.provider }; }
  return channelProfile(value);
};
// A stored connection record as health sees it: profile + state + auth epoch marker.
export function healthConnection(value) {
  requireContract(object(value), "invalid_channel_health");
  requireContract(typeof value.id === "string" && Number.isSafeInteger(value.authEpoch), "invalid_channel_health");
  const profile = normalizeProfile(value.profile);
  requireContract(["active", "disconnected", "reconnect_required"].includes(value.state), "invalid_channel_health");
  return { id: text(value.id, 2048), authEpoch: value.authEpoch, state: value.state, profile };
}
export function assessConnectionHealth(connectionValue, authEpoch, syncValue = {}) {
  requireContract(Number.isSafeInteger(authEpoch), "invalid_channel_health");
  const connection = healthConnection(connectionValue), sync = lastSyncOutcome(syncValue);
  const state = connectionState({ state: connection.state, authEpoch: connection.authEpoch }, authEpoch);
  if (state === "disconnected") {
    return { connectionId: connection.id, channel: connection.profile.channel, provider: connection.profile.provider,
      status: "disconnected", reAuthRequired: false, lastSyncAt: sync.at,
      consecutiveFailures: sync.consecutiveFailures, reason: "owner disconnected this connection" };
  }
  if (state === "reconnect_required" || isAuthFailure(sync.error)) {
    return { connectionId: connection.id, channel: connection.profile.channel, provider: connection.profile.provider,
      status: "auth_required", reAuthRequired: true, lastSyncAt: sync.at,
      consecutiveFailures: sync.consecutiveFailures,
      reason: state === "reconnect_required" ? "authorization epoch changed; reconnect the provider" : `provider rejected credentials (${sync.error.code ?? sync.error.status})` };
  }
  if (sync.consecutiveFailures >= unreachableAfterFailures) {
    return { connectionId: connection.id, channel: connection.profile.channel, provider: connection.profile.provider,
      status: "unreachable", reAuthRequired: false, lastSyncAt: sync.at,
      consecutiveFailures: sync.consecutiveFailures, reason: `${sync.consecutiveFailures} consecutive sync failures` };
  }
  if (sync.error !== null || sync.consecutiveFailures > 0) {
    return { connectionId: connection.id, channel: connection.profile.channel, provider: connection.profile.provider,
      status: "degraded", reAuthRequired: false, lastSyncAt: sync.at,
      consecutiveFailures: sync.consecutiveFailures, reason: `last sync failed (${sync.error?.code ?? sync.error?.status ?? "unknown"})` };
  }
  return { connectionId: connection.id, channel: connection.profile.channel, provider: connection.profile.provider,
    status: "healthy", reAuthRequired: false, lastSyncAt: sync.at,
    consecutiveFailures: 0, reason: sync.at === null ? "active; no sync has run yet" : "last sync succeeded" };
}
// Account-level rollup: one row per connection plus the headline counts the
// inbox UI needs (how many need attention, how many need re-auth).
export function summarizeConnectionHealth(connections, authEpoch, syncByConnectionId = {}) {
  requireContract(Array.isArray(connections), "invalid_channel_health");
  requireContract(object(syncByConnectionId), "invalid_channel_health");
  const rows = connections.map(connection => assessConnectionHealth(connection, authEpoch, syncByConnectionId[connection.id] ?? {}));
  const needsAttention = rows.filter(row => row.status !== "healthy").length;
  return { rows, total: rows.length,
    healthy: rows.filter(row => row.status === "healthy").length,
    needsAttention, reAuthRequired: rows.filter(row => row.reAuthRequired).length };
}
