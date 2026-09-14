// Channel-agnostic fixture synchronization. No credentials, fetch, sockets or
// send API: a bound adapter reads a recording and the account's importer
// (store.email, i.e. store.connections) persists the resulting page.
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { emailDigest } from "./email-envelope.mjs";
import { profileChannel, requireContract } from "./channel-connection.mjs";
import * as telegram from "./channel-adapters/telegram.mjs";
import { validId } from "../src/events.js";
import { ServiceError } from "./store.mjs";

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };
export const channelSyncLimits = Object.freeze({ pageMessages: 50, webhookUpdates: 100, webhookBacklog: 500 });

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
  static hash(secret) { return createHash("sha256").update(secret).digest("hex"); }
  #match(connectionId, secret) {
    if (!validId(connectionId) || typeof secret !== "string" || secret.length < 16 || secret.length > 256) return null;
    const presented = Buffer.from(ChannelWebhookInbox.hash(secret), "hex");
    let found = null;
    // Connection IDs are only unique per account; compare every candidate in constant time.
    for (const row of this.#store.db.prepare("SELECT account_id,data_json FROM private_email_connections WHERE id=?").all(connectionId)) {
      const connection = JSON.parse(row.data_json), stored = connection.webhook?.secretHash;
      const ok = typeof stored === "string" && stored.length === 64 && timingSafeEqual(Buffer.from(stored, "hex"), presented);
      if (ok && connection.state === "active" && profileChannel(connection.profile) === "telegram") found = { accountId: row.account_id, connectionId };
    }
    return found;
  }
  // Match, validate and journal in one store transaction: a delivery is either
  // fully recorded or refused unchanged. A redelivered update id is a no-op.
  receive({ connectionId, secret, body }) {
    return this.#store.transaction(() => {
      const match = this.#match(connectionId, secret);
      if (!match) fail(401, "channel_webhook_denied", "Webhook not accepted.");
      // Telegram posts one Update per request; a replayed batch uses { updates: [...] }.
      const updates = body && typeof body === "object" && !Array.isArray(body) && Object.hasOwn(body, "update_id") ? [body] : body?.updates;
      if (!Array.isArray(updates) || !updates.length || updates.length > channelSyncLimits.webhookUpdates
        || (body.updates && Object.keys(body).length !== 1)
        || !updates.every(update => update && typeof update === "object" && !Array.isArray(update) && Number.isSafeInteger(update.update_id) && update.update_id >= 0))
        fail(422, "invalid_channel_update", "Supply Telegram Update objects.");
      const journaled = this.#store.channelUpdates.record(match.accountId, connectionId, updates, { backlog: channelSyncLimits.webhookBacklog });
      return { accountId: match.accountId, connectionId, received: journaled.received, accepted: journaled.accepted, pending: journaled.pending };
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

// Account-session sync of one recorded Telegram page. `updates` null drains
// updates the webhook already verified for this connection.
export async function syncTelegramConnection({ store, token, binding, connectionId, requestId, updates, webhooks = null }) {
  const captured = store.email.state(token, connectionId, telegramFolderId, binding);
  if (profileChannel(captured.connection.profile) !== "telegram") fail(409, "channel_sync_unsupported", "Recorded sync is available for Telegram connections only.");
  if (captured.connection.mode !== "fixture") fail(409, "channel_sync_unavailable", "Only fixture connections can import a recorded page.");
  if (!validId(requestId)) fail(422, "invalid_channel_update", "Supply a stable request ID.");
  // A retried sync returns its journaled page receipt instead of re-reading the recording.
  const prior = store.email.priorReceipt(captured.connection.profile.accountId, requestId);
  if (prior) {
    if (prior.action !== "page.apply" || prior.connectionId !== connectionId) fail(409, "idempotency_conflict", "Request ID already used for different import content.");
    return { receipt: prior, duplicate: true, source: "journal", request: null };
  }
  const accountId = captured.connection.profile.accountId;
  let source = "recording";
  if (updates === null) {
    if (!webhooks) fail(409, "channel_webhook_unavailable", "Webhook delivery is not configured here.");
    // A backlog above one request's worth stays importable: take the oldest pending slice.
    updates = webhooks.pending(accountId, connectionId, { limit: channelSyncLimits.webhookUpdates }); source = "webhook";
  }
  if (!Array.isArray(updates) || updates.length > channelSyncLimits.webhookUpdates) fail(422, "invalid_channel_update", "Supply at most 100 recorded Telegram updates.");
  if (source === "webhook") {
    // A journaled update that cannot be normalized records one failed attempt
    // and leaves this page, so it never blocks the updates around it; after the
    // bound it parks as failed. Non-message updates (callback queries) are
    // skipped by the reader and pass through here.
    const poison = new Map();
    for (const update of updates) {
      if (!telegram.updateKind(update)) continue;
      try { telegram.normalizeTelegramUpdate(captured.connection.profile, update); }
      catch (error) { if (error?.name !== "EmailContractError") throw error; poison.set(update.update_id, error); }
    }
    for (const [updateId, error] of poison) webhooks.fail(accountId, connectionId, [updateId], error);
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
