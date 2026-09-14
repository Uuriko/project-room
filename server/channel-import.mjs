// Channel-agnostic fixture synchronization. No credentials, fetch, sockets or
// send API: a bound adapter reads a recording and the account's importer
// (store.email, i.e. store.connections) persists the resulting page.
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { emailDigest } from "./email-envelope.mjs";
import { connectionState, profileChannel, requireContract } from "./channel-connection.mjs";
import * as telegram from "./channel-adapters/telegram.mjs";
import { validId } from "../src/events.js";
import { ServiceError } from "./store.mjs";

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };
// Webhook route limits (server/http.mjs): the JSON body cap is 64 KB because a
// Telegram Update embeds the whole replied-to message (every other route keeps
// the 16 KB default); deliveries are counted per verified connection, plus a
// high per-address guard because Telegram's egress addresses are shared.
export const channelSyncLimits = Object.freeze({ pageMessages: 50, webhookUpdates: 100, webhookBacklog: 500,
  webhookBodyBytes: 65536, webhookPerConnection: 60, webhookPerAddress: 1200 });
// B49 (I3): the owner-chosen webhook secret must carry some entropy. 16-256
// characters, no whitespace or control characters, at least 6 distinct
// characters, so an obviously weak value (one repeated character, "abab...")
// is refused where the plaintext enters the server (`ChannelWebhookInbox.hash`)
// and at receive time before any hash compare. Choose >=32 random bytes; a
// random 16-hex secret fails the distinct bound about 3 times in 100000.
export const webhookSecretLimits = Object.freeze({ minChars: 16, maxChars: 256, minDistinct: 6 });
export const validateWebhookSecret = secret => typeof secret === "string" && secret.isWellFormed()
  && secret.length >= webhookSecretLimits.minChars && secret.length <= webhookSecretLimits.maxChars
  && !/[\s\p{Cc}]/u.test(secret) && new Set(secret).size >= webhookSecretLimits.minDistinct;

// Prepare and apply stay separate so a lost acknowledgement can be retried with
// the exact operation. A new prepare rehydrates; it never rebases old content.
export async function prepareChannelFixturePage({ store, token, binding, connectionId, folderId, adapter, requestId = randomUUID(), reset = false }) {
  requireContract(adapter && typeof adapter.changes === "function" && typeof adapter.hydrate === "function" && typeof adapter.normalize === "function"
    && typeof reset === "boolean", "channel_adapter_required");
  const captured = store.email.state(token, connectionId, folderId, binding), connection = captured.connection.profile;
  const guard = () => {
    const current = store.email.state(token, connectionId, folderId, binding);
    if (!current.canImport || current.connection.mode !== "fixture" || emailDigest(current.connection) !== emailDigest(captured.connection))
      fail(409, "email_connection_changed", "Connection changed. Reconnect before importing.");
    if ((current.folder?.revision ?? 0) !== (captured.folder?.revision ?? 0))
      fail(409, "stale_email_page", "Sync progress changed. Prepare the current page again.");
  };
  guard();
  requireContract(profileChannel(connection) === adapter.channel && connection.provider === adapter.provider, "channel_recording_scope_changed");
  const cursor = reset || captured.needsReset ? null : captured.expectedCursor;
  const page = await adapter.changes({ cursor }); guard();
  requireContract(page && Array.isArray(page.changes) && typeof page.cursor === "string" && typeof page.complete === "boolean", "channel_fixture_page_failed");
  const ids = [...new Set(page.changes.map(change => change.messageId))];
  requireContract(ids.length <= channelSyncLimits.pageMessages, "channel_sync_page_limit");
  const observations = [];
  for (const messageId of ids) {
    guard();
    let expectedSourceRevision = 0;
    try { expectedSourceRevision = store.inbox.read(token, adapter.sourceId(messageId), binding).source.revision; }
    catch (error) { if (error.status !== 404) throw error; }
    const hydrated = await adapter.hydrate(messageId); guard();
    if (hydrated === null) { observations.push({ kind: "absent", messageId }); continue; }
    const envelope = adapter.normalize(hydrated);
    requireContract(envelope.message.id === messageId, "channel_fixture_hydration_failed");
    observations.push(adapter.scope(envelope) === folderId ? { kind: "message", envelope, expectedSourceRevision } : { kind: "absent", messageId });
  }
  guard();
  return { action: "page.apply", requestId, connectionId, connectionRevision: connection.revision, folderId,
    expectedRevision: captured.folder?.revision ?? 0, expectedCursor: captured.expectedCursor, cursor: page.cursor,
    complete: page.complete, reset: reset || captured.needsReset, observations };
}
export const telegramFolderId = "updates"; // One getUpdates stream per bot.
export async function prepareTelegramFixturePage({ store, token, binding, connectionId, reader, requestId = randomUUID(), reset = false }) {
  requireContract(reader instanceof telegram.RecordedTelegramBot, "telegram_fixture_reader_required");
  const captured = store.email.state(token, connectionId, telegramFolderId, binding);
  requireContract(emailDigest(reader.connection) === emailDigest(captured.connection.profile), "telegram_recording_scope_changed");
  const adapter = telegram.bind({ reader, connection: captured.connection.profile });
  return prepareChannelFixturePage({ store, token, binding, connectionId, folderId: telegramFolderId, adapter, requestId, reset });
}

// Verified raw updates are journaled in the store (pending_channel_updates, see
// channel-journal.mjs) until the account owner imports them through the
// recorded-page path, so they survive a restart. Nothing is fetched or sent.
export class ChannelWebhookInbox {
  #store;
  constructor(store) { this.#store = store; }
  // The only place a plaintext secret enters the server; `connection.webhook` stores this hash.
  static hash(secret) {
    if (!validateWebhookSecret(secret)) fail(422, "weak_webhook_secret", "Choose a webhook secret of 16 to 256 characters without whitespace and with at least 6 distinct characters.");
    return createHash("sha256").update(secret).digest("hex");
  }
  #match(connectionId, secret) {
    if (!validId(connectionId) || !validateWebhookSecret(secret)) return null;
    const presented = Buffer.from(ChannelWebhookInbox.hash(secret), "hex");
    let found = null;
    // Connection IDs are only unique per account; compare every candidate in constant time.
    // The account's current auth epoch decides the state (connectionState): a
    // connection whose owner must reconnect refuses deliveries like a disconnected one.
    for (const row of this.#store.db.prepare("SELECT c.account_id,c.data_json,a.auth_epoch FROM private_email_connections c JOIN accounts a ON a.id=c.account_id WHERE c.id=?").all(connectionId)) {
      const connection = JSON.parse(row.data_json), stored = connection.webhook?.secretHash;
      const ok = typeof stored === "string" && stored.length === 64 && timingSafeEqual(Buffer.from(stored, "hex"), presented);
      if (ok && connectionState(connection, row.auth_epoch) === "active" && profileChannel(connection.profile) === "telegram") found = { accountId: row.account_id, connectionId, profile: connection.profile };
    }
    return found;
  }
  // A message-kind update the Telegram adapter cannot normalize is journaled
  // straight into 'failed' with the contract code, never 'pending': it must not
  // occupy the backlog or a sync attempt, and refusing it (4xx) would only make
  // the provider redeliver it and stall its own queue behind it.
  static rejected(profile, updates) {
    const rejected = new Map();
    for (const update of updates) {
      if (!telegram.updateKind(update)) continue;
      try { telegram.normalizeTelegramUpdate(profile, update); }
      catch (error) { if (error?.name !== "EmailContractError") throw error; rejected.set(update.update_id, String(error.code ?? error.message)); }
    }
    return rejected;
  }
  // Match, validate and journal in one store transaction: a delivery is either
  // fully recorded or refused unchanged. A redelivered update id is a no-op.
  // `verified` runs once the secret matched and before anything is journaled;
  // it may throw (the HTTP route counts its per-connection rate limit there).
  receive({ connectionId, secret, body, verified = null }) {
    return this.#store.transaction(() => {
      const match = this.#match(connectionId, secret);
      if (!match) fail(401, "channel_webhook_denied", "Webhook not accepted.");
      if (verified) verified({ accountId: match.accountId, connectionId });
      // Telegram posts one Update per request; a replayed batch uses { updates: [...] }.
      const updates = body && typeof body === "object" && !Array.isArray(body) && Object.hasOwn(body, "update_id") ? [body] : body?.updates;
      if (!Array.isArray(updates) || !updates.length || updates.length > channelSyncLimits.webhookUpdates
        || (body.updates && Object.keys(body).length !== 1)
        || !updates.every(update => update && typeof update === "object" && !Array.isArray(update) && Number.isSafeInteger(update.update_id) && update.update_id >= 0))
        fail(422, "invalid_channel_update", "Supply Telegram Update objects.");
      const journaled = this.#store.channelUpdates.record(match.accountId, connectionId, updates, { backlog: channelSyncLimits.webhookBacklog, rejected: ChannelWebhookInbox.rejected(match.profile, updates) });
      return { accountId: match.accountId, connectionId, received: journaled.received, accepted: journaled.accepted, rejected: journaled.rejected, pending: journaled.pending };
    });
  }
  // Oldest pending updates first; `limit` null returns the whole pending backlog.
  pending(accountId, connectionId, { limit = null } = {}) { return this.#store.channelUpdates.pending(accountId, connectionId, { limit }).map(row => row.payload); }
  journal(accountId, connectionId) { return this.#store.channelUpdates.summary(accountId, connectionId); }
  // Mark exactly the updates the applied page consumed as imported (caller runs this in the page transaction).
  acknowledge(accountId, connectionId, updateIds) { return this.#store.channelUpdates.imported(accountId, connectionId, updateIds); }
  // Record one failed attempt on the slice the importer took; bounded by channelJournalLimits.maxAttempts.
  fail(accountId, connectionId, updateIds, error) { return this.#store.channelUpdates.failed(accountId, connectionId, updateIds, error); }
}

// Replays the pure part of prepare (page, hydrate, normalize) over the supplied
// updates with the journaled cursor context and compares it with the journaled
// page.apply request envelope by envelope. Source revisions are state, not
// content, and stay out of the comparison; the envelopes carry the connection
// profile as it was, so a replay after a reconnect still compares like for like.
async function sameRecording(store, accountId, requestId, profile, updates) {
  const row = store.db.prepare("SELECT request_json FROM private_email_commands WHERE account_id=? AND request_id=?").get(accountId, requestId);
  const request = row ? JSON.parse(row.request_json) : null;
  if (request?.action !== "page.apply") return false;
  const connection = request.observations.find(observation => observation.kind === "message")?.envelope.connection ?? profile;
  try {
    const reader = new telegram.RecordedTelegramBot({ connection, updates, limit: channelSyncLimits.pageMessages }), adapter = telegram.bind({ reader, connection });
    const page = await adapter.changes({ cursor: request.reset ? null : request.expectedCursor });
    if (page.cursor !== request.cursor || page.complete !== request.complete) return false;
    const ids = [...new Set(page.changes.map(change => change.messageId))];
    if (ids.length !== request.observations.length) return false;
    for (const [index, messageId] of ids.entries()) {
      const observation = request.observations[index], hydrated = await adapter.hydrate(messageId);
      if (hydrated === null ? observation.kind !== "absent" || observation.messageId !== messageId
        : observation.kind !== "message" || emailDigest(observation.envelope) !== emailDigest(adapter.normalize(hydrated))) return false;
    }
    return true;
  } catch (error) { if (error?.name !== "EmailContractError") throw error; return false; }
}

// Account-session sync of one recorded Telegram page. `updates` null drains
// updates the webhook already verified for this connection.
export async function syncTelegramConnection({ store, token, binding, connectionId, requestId, updates, webhooks = null }) {
  const captured = store.email.state(token, connectionId, telegramFolderId, binding);
  if (profileChannel(captured.connection.profile) !== "telegram") fail(409, "channel_sync_unsupported", "Recorded sync is available for Telegram connections only.");
  if (captured.connection.mode !== "fixture") fail(409, "channel_sync_unavailable", "Only fixture connections can import a recorded page.");
  if (!validId(requestId)) fail(422, "invalid_channel_update", "Supply a stable request ID.");
  const accountId = captured.connection.profile.accountId;
  // A retried sync returns its journaled page receipt instead of re-reading the
  // recording, but only for the same content: a supplied recording must rebuild
  // the journaled page (I2). A drain (`updates: null`) takes a server-chosen
  // slice, so a retried drain is always the same request.
  const prior = store.email.priorReceipt(accountId, requestId);
  if (prior) {
    if (prior.action !== "page.apply" || prior.connectionId !== connectionId || (updates !== null && !await sameRecording(store, accountId, requestId, captured.connection.profile, updates)))
      fail(409, "idempotency_conflict", "Request ID already used for different import content.");
    return { receipt: prior, duplicate: true, source: "journal", request: null };
  }
  let source = "recording";
  if (updates === null) {
    if (!webhooks) fail(409, "channel_webhook_unavailable", "Webhook delivery is not configured here.");
    // A backlog above one request's worth stays importable: take the oldest pending slice.
    updates = webhooks.pending(accountId, connectionId, { limit: channelSyncLimits.webhookUpdates }); source = "webhook";
  }
  if (!Array.isArray(updates) || updates.length > channelSyncLimits.webhookUpdates) fail(422, "invalid_channel_update", "Supply at most 100 recorded Telegram updates.");
  if (source === "webhook") {
    // Backstop for a journaled update the adapter can no longer normalize
    // (receive() already parks those it can see): it records one failed attempt
    // and leaves this page, so it never blocks the updates around it; after the
    // bound it parks as failed. Non-message updates (callback queries) are
    // skipped by the reader and pass through here.
    const poison = ChannelWebhookInbox.rejected(captured.connection.profile, updates);
    for (const [updateId, code] of poison) webhooks.fail(accountId, connectionId, [updateId], code);
    updates = updates.filter(update => !poison.has(update.update_id));
  }
  // A drained slice that still cannot be imported records one attempt on every
  // row it holds and is offered again until the bound. Only content and
  // importer faults count (422, 5xx, unexpected errors); authority and state
  // conflicts (401, 403, 404, 409) are not the updates' fault and count nothing.
  const journalFailure = error => {
    const counts = error?.status === undefined || error.status === 422 || error.status >= 500;
    if (source === "webhook" && updates.length && counts) webhooks.fail(accountId, connectionId, updates.map(update => update.update_id), error);
    throw error;
  };
  let reader, request;
  try {
    // The reader pages at the importer's message cap, so one sync never prepares
    // more sources than page.apply accepts; a partial page reports complete: false.
    try { reader = new telegram.RecordedTelegramBot({ connection: captured.connection.profile, updates, limit: channelSyncLimits.pageMessages }); }
    catch (error) { if (error?.name !== "EmailContractError") throw error; fail(422, "invalid_channel_update", "Recorded updates could not be confirmed."); }
    try { request = await prepareTelegramFixturePage({ store, token, binding, connectionId, reader, requestId }); }
    catch (error) { if (error?.name !== "EmailContractError") throw error; fail(422, "invalid_channel_update", "Recorded updates could not be confirmed."); }
  } catch (error) { journalFailure(error); }
  let result;
  try {
    // The page and its acknowledgement commit together: exactly the slice rows
    // this page consumed (cursor is the next update id) turn imported, never
    // updates still waiting behind the reader's page.
    result = store.transaction(() => {
      const applied = store.email.apply(token, request, binding);
      const consumed = updates.filter(update => update.update_id < Number(request.cursor)).map(update => update.update_id);
      if (source === "webhook" && consumed.length) webhooks.acknowledge(accountId, connectionId, consumed);
      return applied;
    });
  } catch (error) { journalFailure(error); }
  return { ...result, source, request };
}
