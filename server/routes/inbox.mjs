// Inbox mounts (batch RT). Moved verbatim from server/http.mjs.
// One mount owns every /api/inbox path: account-session checks run before
// method checks, and an unknown path under the prefix is still 404.
// Later gates are not added in this move.

import { createHash, randomUUID } from "node:crypto";
import { ServiceError } from "../service-error.mjs";
import { validId } from "../../src/events.js";
import { GmailSync } from "../gmail-sync.mjs";
import { GmailActions } from "../gmail-actions.mjs";
import { GmailSender, gmailCredentialsFor, sendTelegramDirect } from "../inbox-transport.mjs";
import { validateDirectSend, recordDirectSend, completeDirectSend, publicDirectSend } from "../inbox-outbox.mjs";
import { channelSyncLimits, syncTelegramConnection } from "../channel-import.mjs";
import { telegramLiveView } from "../channel-adapters/telegram-config.mjs";
import { webhookAcceptsHash, webhookRotationDefaults } from "../channel-adapters/telegram-rotation.mjs";
import { getTracer, SPAN_NAMES, ATTR } from "../delivery-tracing.mjs";

const connectionRoutes = Object.freeze({
  list: "/api/inbox/connections",
  read: "/api/inbox/connections/{id}",
  commands: "/api/inbox/connections/commands",
  sync: "/api/inbox/connections/{id}/sync",
  reconnect: "/api/inbox/connections/{id}/reconnect",
  webhook: "/api/inbox/webhooks/{connectionId}",
  channelSends: "/api/inbox/channel-sends",
});
const routePattern = template => new RegExp("^" + template.replaceAll("/", "\\/").replace(/\{[A-Za-z]+\}/g, "([^/]{1,384})") + "$");
const webhookSecretHeader = "x-telegram-bot-api-secret-token";

const objectResponse = Object.freeze({ type: "object" });
const noteBody = Object.freeze({
  type: "object",
  required: ["quarantineId"],
  properties: {
    quarantineId: { type: "string" },
    note: { type: ["string", "null"] },
  },
});

function inboxRoute(row) {
  return {
    capability: null,
    events: [],
    scope: "worker",
    mount: true,
    handler: handleInboxMount,
    ...row,
    schema: { response: objectResponse, ...row.schema },
  };
}

export async function handleInboxMount(ctx) {
  const {
    req, res, url, store, remoteAddress, loopback,
    json, reject, rate, cookie, setCookie, body,
    accountBinding, protectWrite, exact, pathId,
    accountCookieName, gmail, channelWebhooks, telegram, telegramStatus,
    sendBudgets, sendBudgetChannelFor, syntheticInboxTransport,
    resolveChannelTransport, directSendFetch,
  } = ctx;
  // { quarantineId, note? } payload shared by the three quarantine mutations.
  const quarantineNote = data => data && typeof data === "object" && !Array.isArray(data)
    && (exact(data, ["quarantineId"]) || exact(data, ["quarantineId", "note"]))
    && typeof data.quarantineId === "string"
    && (data.note === undefined || data.note === null || typeof data.note === "string");
  // { action: dispatch|reconcile, sourceId, sendId } for channel sends and sample sending.
  const sendRequest = (data, hint) => {
    if (!data || !exact(data, ["action", "sourceId", "sendId"]) || !["dispatch", "reconcile"].includes(data.action)
      || !validId(data.sourceId) || !validId(data.sendId)) reject(422, "invalid_inbox_send", hint);
  };
  const webhook = routePattern(connectionRoutes.webhook).exec(url.pathname);
  if (webhook) {
    // Provider callbacks carry a per-connection secret, never an account session.
    // Verified updates only wait for the owner's import; nothing is stored here.
    if (req.method !== "POST") reject(405, "method_not_allowed", "Method not allowed");
    // Telegram's shared egress addresses make the per-address key only a
    // coarse flood guard; the budget that matters is per verified
    // connection, counted after the secret matched (channelSyncLimits).
    rate(`inbox-webhook:${remoteAddress}`, channelSyncLimits.webhookPerAddress);
    if (!channelWebhooks) reject(409, "channel_webhook_unavailable", "Webhook delivery is not configured here.");
    const connectionId = pathId(webhook[1]), secret = req.headers[webhookSecretHeader];
    if (typeof secret !== "string") reject(401, "channel_webhook_denied", "Webhook not accepted.");
    const received = channelWebhooks.receive({ connectionId, secret, body: await body(req, { limit: channelSyncLimits.webhookBodyBytes }),
      verified: match => rate(`inbox-webhook-connection:${match.accountId}:${match.connectionId}`, channelSyncLimits.webhookPerConnection) });
    telegramStatus.received(received.accountId, connectionId, { at: store.now(), count: received.received });
    return json(res, 202, { contractVersion: 1, connectionId, received: received.received, pending: received.pending });
  }
  if (url.pathname === "/api/inbox" || url.pathname.startsWith("/api/inbox/")) {
    // Inbox authority is an account session, never a Room/agent bearer key.
    if (req.headers.authorization) reject(401, "account_session_required", "Use your current account session.");
    const token = cookie(req, accountCookieName), binding = accountBinding(req);
    const auth = store.authenticateAccountSession(token, null, binding);
    // The shared write gate for account-session inbox mutations: CSRF plus the
    // per-account inbox write rate limit.
    const inboxWrite = () => { protectWrite(req, auth, false); rate(`inbox:${auth.account.id}`, 60); };
    if (url.pathname === "/api/inbox/setup") {
      if (!['GET', 'POST'].includes(req.method)) reject(405, 'method_not_allowed', 'Method not allowed');
      if (req.method === 'POST') {
        protectWrite(req, auth, false); rate(`setup:${auth.account.id}`, 30);
        const data = await body(req);
        if (!exact(data, ['name', 'purpose', 'platforms', 'step', 'completed']) || typeof data.name !== 'string' || data.name.length > 80
          || !['', 'personal', 'team', 'agents'].includes(data.purpose) || !Array.isArray(data.platforms) || data.platforms.length > 6
          || !data.platforms.every(p => ['Gmail', 'Outlook', 'Slack', 'Discord', 'Telegram', 'WhatsApp'].includes(p))
          || ![0, 1, 2].includes(data.step) || typeof data.completed !== 'boolean') reject(422, 'invalid_setup', 'Choose your setup preferences.');
        store.transaction(() => {
          if (data.name.trim()) store.updateAccountProfile(auth.account.id, { displayName: data.name.trim() });
          store.db.prepare('INSERT INTO account_setup VALUES(?,?) ON CONFLICT(account_id) DO UPDATE SET data_json=excluded.data_json').run(auth.account.id, JSON.stringify(data));
          if (data.completed) store.completeOnboarding(auth.account.id);
        });
      }
      const saved = store.db.prepare('SELECT data_json FROM account_setup WHERE account_id=?').get(auth.account.id);
      const profile = store.accountProfile(auth.account.id);
      // A room guest has not created a durable sign-in account. Do not
      // interrupt the invitation with personal-mail setup; offer it once
      // they add a sign-in method, or open setup themselves.
      const guest = store.db.prepare('SELECT origin FROM accounts WHERE id=?').get(auth.account.id)?.origin === 'share-link-guest'
        && store.accountLogins.listMethods(auth.account.id).length === 0;
      return json(res, 200, { contractVersion: 1, viewer: { accountId: auth.account.id, authEpoch: auth.account.authEpoch, sessionBinding: auth.sessionBinding, sessionRevision: auth.sessionRevision },
        setup: saved ? JSON.parse(saved.data_json) : { name: profile.displayName ?? '', purpose: '', platforms: [], step: 0, completed: profile.onboardingComplete || guest } });
    }
    if (url.pathname === "/api/inbox/gmail" || url.pathname.startsWith('/api/inbox/gmail/')) {
      const projection = extra => ({ contractVersion: 1, viewer: { accountId: auth.account.id, authEpoch: auth.account.authEpoch,
        sessionBinding: auth.sessionBinding, sessionRevision: auth.sessionRevision }, ...extra });
      if (url.pathname === "/api/inbox/gmail" && req.method === 'GET')
        return json(res, 200, projection(gmail ? gmail.status(auth) : { state: 'unavailable', address: null, syncedAt: null }));
      if (!gmail || !gmail.allowed(auth)) reject(503, 'gmail_not_configured', 'Gmail is not available on this service yet.');
      if (req.method !== 'POST') reject(405, 'method_not_allowed', 'Method not allowed');
      protectWrite(req, auth, false); rate(`gmail:${auth.account.id}`, 60);
      if (url.pathname === "/api/inbox/gmail/mailbox") return json(res, 200, projection(await new GmailActions(gmail).run(token, binding, await body(req, { limit: 16 * 1024 * 1024 }))));
      if (url.pathname === "/api/inbox/gmail/connect") {
        const authorizationUrl = gmail.begin(token, binding, await body(req));
        // Lax admits Google's top-level return while the account cookie
        // stays Strict. HttpOnly + __Host- binds consent to this browser.
        setCookie(res, 'gmail_oauth', new URL(authorizationUrl).searchParams.get('state'), 600, 'Lax');
        return json(res, 200, projection({ authorizationUrl }));
      }
      if (url.pathname === "/api/inbox/gmail/sync") return json(res, 200, projection(await new GmailSync(gmail).mailboxTick(auth.account.id, (await body(req)).mailboxId ?? gmail.record(auth)?.connectionId, () => gmail.auth(token, binding))));
      if (url.pathname === "/api/inbox/gmail/disconnect") { gmail.disconnect(token, binding, (await body(req)).mailboxId ?? null); return json(res, 200, projection(gmail.status(auth))); }
      reject(404, 'not_found', 'Not found');
    }
    const view = url.searchParams.get("view");
    const replySource = /^\/api\/inbox\/sources\/([^/]{1,384})\/reply-review$/.exec(url.pathname);
    if (replySource && req.method === "GET") {
      if (!["reply-review-v1", "reply-review-v2", "reply-review-v3", "reply-review-v4"].includes(view) || [...url.searchParams.keys()].length !== 1) reject(422, "unsupported_inbox_view", "Choose the supported reply review.");
      return json(res, 200, store.inbox.replyReviewContext(token, pathId(replySource[1]), binding, { view }));
    }
    if (url.pathname === "/api/inbox/review" && req.method === "POST") {
      inboxWrite();
      const result = store.inbox.reviewReply(token, await body(req), binding);
      return json(res, result.duplicate ? 200 : 201, result);
    }
    if (view !== null && (!["email-text-v1", "email-excerpt-v1"].includes(view) || url.searchParams.getAll("view").length !== 1))
      reject(422, "unsupported_inbox_view", "This inbox view is not supported.");
    if (url.pathname === "/api/inbox/threads" && req.method === "GET") return json(res, 200, store.inbox.threads(token, binding,
      { sourceId: url.searchParams.get("sourceId"), limit: url.searchParams.get("limit"), includeChannels: view !== null }));
    // Held-message quarantine review (owner surface): the four routes ride
    // the existing account-session auth, and the three mutations reuse
    // account session + CSRF + the same inbox rate limit as every other write.
    if (url.pathname === "/api/inbox/quarantine" && req.method === "GET")
      return json(res, 200, store.inbox.quarantineReview(token, binding,
        { status: url.searchParams.get("status") ?? undefined, limit: url.searchParams.get("limit") }));
    // Review-coverage dashboard for the quarantine review UI: per-signal
    // held/reviewed coverage and the Confirm vs Dismiss precision inputs.
    // Read-only, same account-session auth as the review listing.
    if (url.pathname === "/api/inbox/quarantine/coverage" && req.method === "GET")
      return json(res, 200, store.inbox.quarantineCoverage(token, binding));
    // The three quarantine mutations share auth, rate limit, body shape, and
    // payload; only the store call, error code, and hint differ.
    const quarantineWrites = Object.freeze({
      release: { call: "quarantineRelease", code: "invalid_quarantine_release", hint: "Choose the held message to confirm." },
      dismiss: { call: "quarantineDismiss", code: "invalid_quarantine_dismiss", hint: "Choose the held message to dismiss." },
      split: { call: "quarantineSplit", code: "invalid_quarantine_split", hint: "Choose the held message to split." },
    });
    const quarantineWrite = /^\/api\/inbox\/quarantine\/(release|dismiss|split)$/.exec(url.pathname);
    if (quarantineWrite && req.method === "POST") {
      inboxWrite();
      const { call, code, hint } = quarantineWrites[quarantineWrite[1]];
      const data = await body(req);
      if (!quarantineNote(data)) reject(422, code, hint);
      return json(res, 200, store.inbox[call](token, binding, { quarantineId: data.quarantineId, note: data.note }));
    }
    // SLA dashboard (task 26): response-time percentiles, breach counts by
    // channel and severity, and the end-of-day open-conversation sweep
    // ("nothing closes unowned"). Read-only, same account-session auth.
    if (url.pathname === "/api/inbox/sla/dashboard" && req.method === "GET")
      return json(res, 200, store.inbox.slaDashboard(token, binding));
    if (url.pathname === "/api/inbox/search" && req.method === "GET") return json(res, 200, store.inbox.search(token, binding,
      { query: url.searchParams.get("q"), sourceId: url.searchParams.get("sourceId"), limit: url.searchParams.get("limit"), includeChannels: view !== null }));
    if (url.pathname === "/api/inbox" && req.method === "GET") return json(res, 200, store.inbox.list(token, binding,
      { includeChannels: view !== null, cursor: url.searchParams.get("cursor"), limit: url.searchParams.get("limit") }));
    if (url.pathname === connectionRoutes.list && req.method === "GET") return json(res, 200, store.connections.connections(token, binding));
    // The card's live facts: binding state, webhook hash agreement, last delivery and send. Never values or hashes.
    const liveRecord = connectionId => {
      const record = store.connections.connectionRecord(token, connectionId, binding);
      const live = telegramLiveView({ config: telegram, connection: store.connections.connection(auth.account.id, connectionId), record: record.connection,
        status: telegramStatus, importAvailable: Boolean(channelWebhooks),
        // Send-budget diagnostics (task #41): remaining sends and refill time.
        sendBudget: sendBudgets.view({ channel: "telegram", accountId: auth.account.id, connectionId: record.connection.id }) });
      return { ...record, syncAvailable: loopback, live };
    };
    if (url.pathname === connectionRoutes.commands && req.method === "POST") {
      // Owner-managed connection records over HTTP: configure (add or update a
      // bot or mailbox profile) and disconnect ("Remove": saved copies stay,
      // nothing is deleted). Webhook hashes and import pages never come from here.
      protectWrite(req, auth, false); rate(`inbox-connections:${auth.account.id}`, 30);
      const data = await body(req);
      if (!data || typeof data !== "object" || Array.isArray(data) || !["connection.configure", "connection.disconnect"].includes(data.action) || !validId(data.connectionId))
        reject(422, "invalid_channel_connection", "Supply a connection.configure or connection.disconnect request.");
      const result = store.connections.apply(token, data, binding);
      return json(res, result.duplicate ? 200 : 201, { ...liveRecord(data.connectionId), receipt: result.receipt, duplicate: result.duplicate });
    }
    // The transport a channel source's replies go through, if this deployment has one.
    const channelSendFor = sourceId => {
      const link = store.inbox.sourceConnection(token, sourceId, binding);
      if (!link || link.state !== "active" || !link.send) return null;
      const sender = resolveChannelTransport({ provider: link.provider, accountId: auth.account.id, connectionId: link.connectionId });
      return sender ? { ...link, ...sender } : null;
    };
    const channelSendView = sender => sender ? { provider: sender.provider, mode: sender.mode } : null;
    const connection = routePattern(connectionRoutes.read).exec(url.pathname);
    if (connection && req.method === "GET") return json(res, 200, liveRecord(pathId(connection[1])));
    const trigger = routePattern(connectionRoutes.reconnect).exec(url.pathname);
    if (trigger && req.method === "POST") {
      // Owner-authenticated import trigger for hosted deployments: the account
      // session plus CSRF is the connection owner's authority, no loopback needed.
      protectWrite(req, auth, false); rate(`inbox-import:${auth.account.id}`, 30);
      const connectionId = pathId(trigger[1]), data = await body(req);
      if (!exact(data, ["requestId"]) || !validId(data.requestId) || data.requestId.length > 100) reject(422, "invalid_channel_update", "Supply a stable request ID.");
      const current = store.connections.connectionRecord(token, connectionId, binding);
      if (current.connection.channel !== "telegram") reject(409, "channel_sync_unsupported", "Live import is available for Telegram connections only.");
      // Re-register: when the bindings are set, the connection accepts deliveries
      // signed with TELEGRAM_WEBHOOK_SECRET (only its SHA-256 is stored). A
      // changed binding starts a rotation instead of a hard swap: the new
      // secret verifies at once and the old one stays accepted until the
      // rotation window ends, so in-flight Telegram deliveries are never
      // refused mid-swap. A pending rotation is left alone.
      let registered = false;
      const webhook = store.connections.connection(auth.account.id, connectionId)?.webhook ?? null;
      const bindingHash = telegram.configured ? telegram.webhookSecretHash() : null;
      if (telegram.configured && current.connection.state === "active" && bindingHash && !webhookAcceptsHash(webhook, bindingHash, store.now())) {
        const webhookRequestId = data.requestId + "-webhook", now = store.now();
        if (webhook?.secretHash && webhook.secretHash !== bindingHash) {
          store.connections.apply(token, { action: "connection.webhook.rotate", requestId: webhookRequestId + "-rotate", connectionId,
            expectedRevision: current.connection.revision, secretHash: bindingHash, previousSecretHash: webhook.secretHash,
            rotationExpiresAt: now + webhookRotationDefaults.windowMs }, binding);
        } else {
          store.connections.apply(token, { action: "connection.webhook", requestId: webhookRequestId, connectionId,
            expectedRevision: current.connection.revision, secretHash: bindingHash }, binding);
        }
        registered = true;
      }
      if (!channelWebhooks && !registered) reject(409, "channel_webhook_unavailable", "Webhook delivery is not configured here.");
      // Drain what the webhook already verified through the existing sync path.
      const result = channelWebhooks ? await syncTelegramConnection({ store, token, binding, connectionId, requestId: data.requestId, updates: null, webhooks: channelWebhooks }) : null;
      return json(res, result && !result.duplicate ? 201 : 200, { ...liveRecord(connectionId), registered, receipt: result?.receipt ?? null,
        duplicate: result?.duplicate ?? false, source: result?.source ?? null, imported: result?.receipt.imports?.length ?? null });
    }
    const sync = routePattern(connectionRoutes.sync).exec(url.pathname);
    if (sync && req.method === "POST") {
      protectWrite(req, auth, false); rate(`inbox-sync:${auth.account.id}`, 60);
      // Recorded imports are local-only (like sample sending) and fixture-mode only.
      if (!loopback) reject(403, "channel_sync_local_only", "Recorded imports are local only.");
      const connectionId = pathId(sync[1]), data = await body(req);
      if (!exact(data, ["requestId", "updates"]) || !validId(data.requestId) || !(data.updates === null || Array.isArray(data.updates)))
        reject(422, "invalid_channel_update", "Supply a request ID and recorded updates, or null to import webhook updates.");
      const result = await syncTelegramConnection({ store, token, binding, connectionId, requestId: data.requestId, updates: data.updates, webhooks: channelWebhooks });
      return json(res, result.duplicate ? 200 : 201, { ...store.connections.connectionRecord(token, connectionId, binding), receipt: result.receipt, duplicate: result.duplicate, source: result.source });
    }
    const attachmentsList = /^\/api\/inbox\/sources\/([^/]{1,384})\/attachments$/.exec(url.pathname);
    if (attachmentsList && req.method === "GET") {
      return json(res, 200, store.inbox.attachments(token, binding,
        { sourceId: pathId(attachmentsList[1]), includeChannels: view !== null }));
    }
    const attachmentItem = /^\/api\/inbox\/sources\/([^/]{1,384})\/attachments\/([^/]{1,8192})$/.exec(url.pathname);
    if (attachmentItem && req.method === "GET") {
      // Attachment ids are opaque provider values (they may carry "="
      // padding that pathId rejects); the membership check is the real
      // validation, so decode without the id-shape gate.
      let attachmentId;
      try { attachmentId = decodeURIComponent(attachmentItem[2]); } catch { reject(404, "not_found", "Not found"); }
      return json(res, 200, store.inbox.attachment(token, binding,
        { sourceId: pathId(attachmentItem[1]), attachmentId, includeChannels: view !== null }));
    }
    const source = /^\/api\/inbox\/sources\/([^/]{1,384})(?:\/(share-context|room-results|send-context|sends))?$/.exec(url.pathname);
    if (source && req.method === "GET") {
      const id = pathId(source[1]);
      if (source[2] === "send-context") return json(res, 200, { ...store.inbox.sendContext(token, id, binding), simulationAvailable: Boolean(syntheticInboxTransport), channelSend: channelSendView(channelSendFor(id)) });
      if (source[2] === "sends") return json(res, 200, { ...store.inbox.sends(token, id, binding), simulationAvailable: Boolean(syntheticInboxTransport), channelSend: channelSendView(channelSendFor(id)) });
      if (source[2]) {
        const roomId = url.searchParams.get("roomId");
        if (!roomId || url.searchParams.getAll("roomId").length !== 1) reject(422, "invalid_room", "Choose a room.");
        if (source[2] === "room-results") {
          if (url.searchParams.getAll("workItemId").length > 1) reject(422, "invalid_inbox_result", "Choose a result.");
          return json(res, 200, store.inbox.results(token, id, roomId, binding, url.searchParams.get("workItemId")));
        }
        return json(res, 200, store.inbox.shareContext(token, id, roomId, binding));
      }
      return json(res, 200, store.inbox.read(token, id, binding, { emailView: view !== null, excerptView: view === "email-excerpt-v1" }));
    }
    if (url.pathname === "/api/inbox/commands" && req.method === "POST") {
      inboxWrite();
      const result = store.inbox.apply(token, await body(req), binding);
      return json(res, result.duplicate ? 200 : 201, result);
    }
    if (url.pathname === connectionRoutes.channelSends && req.method === "POST") {
      // Reply from the Inbox through a channel transport (Telegram today). The
      // owner's session plus CSRF is the authority; the journal already holds
      // the queued attempt, so this only dispatches or reconciles it.
      protectWrite(req, auth, false); rate(`inbox-channel-send:${auth.account.id}`, 30);
      const data = await body(req);
      // Direct send: {channel, to, subject, body, threadId?} — compose freely
      // and deliver through the live provider now. The attempt is journaled
      // pending → sent|failed; unconnected channels fail honestly, never fake.
      if (data && typeof data === "object" && !Array.isArray(data) && typeof data.channel === "string") {
        rate(`inbox-direct-send:${auth.account.id}`, 20);
        validateDirectSend(data);
        // Per-connection send budget (task #41): a Telegram send costs one
        // token; exhaustion is an honest 429 with Retry-After before
        // anything is journaled. Gmail is NOT budgeted: live Gmail send
        // budgets are [JOHN]-gated (task 17) and wait on that approval
        // (see server/channel-send-budgets.mjs).
        if (data.channel === "telegram")
          sendBudgets.check({ channel: "telegram", accountId: auth.account.id, connectionId: null });
        const fetchImpl = directSendFetch ?? fetch;
        const sendId = randomUUID();
        const bodyHash = createHash("sha256").update(data.body, "utf8").digest("hex");
        recordDirectSend(store.db, { id: sendId, accountId: auth.account.id, channel: data.channel,
          to: data.to, subject: data.subject, bodyHash, threadId: data.threadId ?? null, at: store.now() });
        // R1 delivery-path tracing (RC-2026-09-26-966): delivery.bridge_send
        // spans the provider send; delivery.receipt spans the journal
        // settle. Only the channel, the send id, and outcomes are recorded
        // — never bodies or recipients.
        const tracer = getTracer();
        const bridgeSpan = tracer.startSpan(SPAN_NAMES.BRIDGE_SEND, { attributes: {
          [ATTR.CHANNEL]: data.channel, [ATTR.MESSAGE_ID]: sendId } });
        let providerId = null, sendError = null;
        try {
          if (data.channel === "gmail") {
            const sender = new GmailSender({ fetchImpl, credentialProvider: () => gmailCredentialsFor(store, auth.account.id) });
            providerId = (await sender.send({ to: data.to, subject: data.subject, body: data.body })).id;
          } else {
            providerId = (await sendTelegramDirect({ config: telegram, to: data.to, text: data.body, fetchImpl })).messageId;
            telegramStatus.sent(auth.account.id, null, { at: store.now(), outcome: "sent", code: "direct" });
          }
          bridgeSpan.setAttribute(ATTR.OUTCOME, "ok");
          bridgeSpan.setStatusOk();
        } catch (error) { sendError = error; bridgeSpan.recordException(error); }
        finally { bridgeSpan.end(); }
        const receiptSpan = tracer.startSpan(SPAN_NAMES.RECEIPT, { parent: bridgeSpan, attributes: {
          [ATTR.CHANNEL]: data.channel, [ATTR.MESSAGE_ID]: sendId } });
        try {
          const settled = completeDirectSend(store.db, sendId, sendError
            ? { status: "failed", errorCode: sendError instanceof ServiceError ? sendError.code : "channel_send_failed", at: store.now() }
            : { status: "sent", providerId, at: store.now() });
          receiptSpan.setAttribute(ATTR.OUTCOME, sendError ? "error" : "ok");
          receiptSpan.setStatusOk();
          if (sendError) throw sendError;
          return json(res, 200, { contractVersion: 1,
            viewer: { accountId: auth.account.id, authEpoch: auth.account.authEpoch, sessionBinding: auth.sessionBinding, sessionRevision: auth.sessionRevision },
            send: publicDirectSend(settled) });
        } finally {
          receiptSpan.end();
        }
      }
      sendRequest(data, "Choose the existing channel reply.");
      const sender = channelSendFor(data.sourceId);
      if (!sender) reject(409, "channel_sending_unavailable", "Sending is not enabled for this channel.");
      // Per-connection send budget for reply dispatches (task #41): one
      // token per dispatch, honest 429 with Retry-After on exhaustion.
      // Reconciles only read provider state, so they spend no budget.
      if (data.action === "dispatch") {
        const budgetChannel = sendBudgetChannelFor(sender.provider);
        if (budgetChannel) sendBudgets.check({ channel: budgetChannel, accountId: auth.account.id, connectionId: sender.connectionId });
      }
      const send = await sender.transport[data.action](token, data.sourceId, data.sendId, binding);
      const last = telegramStatus.snapshot(auth.account.id, sender.connectionId).lastSendResult;
      return json(res, 200, { ...store.inbox.sends(token, data.sourceId, binding), simulationAvailable: Boolean(syntheticInboxTransport), channelSend: channelSendView(sender), send,
        lastSendResult: last ? { at: new Date(last.at).toISOString(), outcome: last.outcome, code: last.code } : null });
    }
    if (url.pathname === "/api/inbox/simulation" && req.method === "POST") {
      protectWrite(req, auth, false); rate(`inbox-simulation:${auth.account.id}`, 60);
      if (!loopback) reject(403, "inbox_simulation_local_only", "Sample sending is local only.");
      if (!syntheticInboxTransport) reject(409, "inbox_simulation_unavailable", "Sample sending is unavailable here.");
      const data = await body(req);
      sendRequest(data, "Choose the existing sample reply.");
      const send = await syntheticInboxTransport[data.action](token, data.sourceId, data.sendId, binding);
      return json(res, 200, { ...store.inbox.sends(token, data.sourceId, binding), simulationAvailable: true, send });
    }
    reject(404, "not_found", "Inbox route not found.");
  }
}

export const INBOX_ROUTES = Object.freeze([
  inboxRoute({ id: "inbox.list", method: "GET", path: "/api/inbox", auth: "account", schema: { query: { type: "object" } } }),
  inboxRoute({ id: "inbox.search", method: "GET", path: "/api/inbox/search", auth: "account", schema: { query: { type: "object" } } }),
  inboxRoute({ id: "inbox.threads", method: "GET", path: "/api/inbox/threads", auth: "account", schema: { query: { type: "object" } } }),
  inboxRoute({ id: "inbox.setup.read", method: "GET", path: "/api/inbox/setup", auth: "account" }),
  inboxRoute({
    id: "inbox.setup.write", method: "POST", path: "/api/inbox/setup", auth: "account",
    schema: { body: { type: "object", required: ["name", "purpose", "platforms", "step", "completed"], additionalProperties: false, properties: {
      name: { type: "string" }, purpose: { type: "string" }, platforms: { type: "array" }, step: { type: "integer" }, completed: { type: "boolean" },
    } } },
  }),
  inboxRoute({ id: "inbox.gmail.status", method: "GET", path: "/api/inbox/gmail", auth: "account" }),
  inboxRoute({ id: "inbox.gmail.mailbox", method: "POST", path: "/api/inbox/gmail/mailbox", auth: "account", bodyLimit: 16 * 1024 * 1024, schema: { body: { type: "object" } } }),
  inboxRoute({ id: "inbox.gmail.connect", method: "POST", path: "/api/inbox/gmail/connect", auth: "account", schema: { body: { type: "object" } } }),
  inboxRoute({ id: "inbox.gmail.sync", method: "POST", path: "/api/inbox/gmail/sync", auth: "account", schema: { body: { type: "object" } } }),
  inboxRoute({ id: "inbox.gmail.disconnect", method: "POST", path: "/api/inbox/gmail/disconnect", auth: "account", schema: { body: { type: "object" } } }),
  inboxRoute({ id: "inbox.review", method: "POST", path: "/api/inbox/review", auth: "account", schema: { body: { type: "object" } } }),
  inboxRoute({ id: "inbox.quarantine.list", method: "GET", path: "/api/inbox/quarantine", auth: "account", schema: { query: { type: "object" } } }),
  inboxRoute({ id: "inbox.quarantine.coverage", method: "GET", path: "/api/inbox/quarantine/coverage", auth: "account" }),
  inboxRoute({ id: "inbox.quarantine.release", method: "POST", path: "/api/inbox/quarantine/release", auth: "account", schema: { body: noteBody } }),
  inboxRoute({ id: "inbox.quarantine.dismiss", method: "POST", path: "/api/inbox/quarantine/dismiss", auth: "account", schema: { body: noteBody } }),
  inboxRoute({ id: "inbox.quarantine.split", method: "POST", path: "/api/inbox/quarantine/split", auth: "account", schema: { body: noteBody } }),
  inboxRoute({ id: "inbox.sla", method: "GET", path: "/api/inbox/sla/dashboard", auth: "account" }),
  inboxRoute({ id: "inbox.connections.list", method: "GET", path: "/api/inbox/connections", auth: "account" }),
  inboxRoute({ id: "inbox.connections.read", method: "GET", path: "/api/inbox/connections/{id}", auth: "account", schema: { params: { type: "object" } } }),
  inboxRoute({ id: "inbox.connections.commands", method: "POST", path: "/api/inbox/connections/commands", auth: "account", schema: { body: { type: "object", required: ["action", "connectionId"] } } }),
  inboxRoute({ id: "inbox.connections.reconnect", method: "POST", path: "/api/inbox/connections/{id}/reconnect", auth: "account", schema: { params: { type: "object" }, body: { type: "object", required: ["requestId"], additionalProperties: false, properties: {
    // The handler demands exactly { requestId: validId string <= 100 }.
    requestId: { type: "string" },
  } } } }),
  inboxRoute({ id: "inbox.connections.sync", method: "POST", path: "/api/inbox/connections/{id}/sync", auth: "account", schema: { params: { type: "object" }, body: { type: "object", required: ["requestId", "updates"], additionalProperties: false, properties: {
    // The handler accepts updates === null (full sync) or an array of updates.
    requestId: { type: "string" }, updates: { type: ["array", "null"] },
  } } } }),
  inboxRoute({ id: "inbox.sources.read", method: "GET", path: "/api/inbox/sources/{sourceId}", auth: "account", schema: { params: { type: "object" }, query: { type: "object" } } }),
  inboxRoute({ id: "inbox.sources.attachments", method: "GET", path: "/api/inbox/sources/{sourceId}/attachments", auth: "account", schema: { params: { type: "object" } } }),
  inboxRoute({ id: "inbox.sources.attachment", method: "GET", path: "/api/inbox/sources/{sourceId}/attachments/{attachmentId}", auth: "account", schema: { params: { type: "object" } } }),
  inboxRoute({ id: "inbox.sources.replyReview", method: "GET", path: "/api/inbox/sources/{sourceId}/reply-review", auth: "account", schema: { params: { type: "object" }, query: { type: "object" } } }),
  inboxRoute({ id: "inbox.sources.roomResults", method: "GET", path: "/api/inbox/sources/{sourceId}/room-results", auth: "account", schema: { params: { type: "object" }, query: { type: "object" } } }),
  inboxRoute({ id: "inbox.sources.sendContext", method: "GET", path: "/api/inbox/sources/{sourceId}/send-context", auth: "account", schema: { params: { type: "object" } } }),
  inboxRoute({ id: "inbox.sources.sends", method: "GET", path: "/api/inbox/sources/{sourceId}/sends", auth: "account", schema: { params: { type: "object" } } }),
  inboxRoute({ id: "inbox.sources.shareContext", method: "GET", path: "/api/inbox/sources/{sourceId}/share-context", auth: "account", schema: { params: { type: "object" }, query: { type: "object" } } }),
  inboxRoute({ id: "inbox.commands", method: "POST", path: "/api/inbox/commands", auth: "account", schema: { body: { type: "object" } } }),
  inboxRoute({ id: "inbox.channelSends", method: "POST", path: "/api/inbox/channel-sends", auth: "account", schema: { body: { type: "object" } } }),
  inboxRoute({ id: "inbox.simulation", method: "POST", path: "/api/inbox/simulation", auth: "account", schema: { body: { type: "object", required: ["action", "sourceId", "sendId"], additionalProperties: false, properties: {
    // The handler demands exactly { action: dispatch|reconcile, sourceId, sendId } as valid ids.
    action: { type: "string", enum: ["dispatch", "reconcile"] }, sourceId: { type: "string" }, sendId: { type: "string" },
  } } } }),
  inboxRoute({ id: "inbox.webhook", method: "POST", path: "/api/inbox/webhooks/{connectionId}", auth: "none", schema: { params: { type: "object" }, body: { type: "object" } } }),
]);
