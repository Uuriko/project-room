import { GmailSync } from '../server/gmail-sync.mjs';
import { GmailMailbox, gmailConfig } from '../server/gmail-mailbox.mjs';
import { DurableObject } from 'cloudflare:workers';
import { httpServerHandler } from 'cloudflare:node';
import { isIP } from 'node:net';
import { AsyncLocalStorage } from 'node:async_hooks';
import { RoomStore } from '../server/store.mjs';
import { stitchConfigFromEnv } from '../server/inbox-stitch.mjs';
import { createRoomServer } from '../server/http.mjs';
import { googleConfig } from '../server/google-oauth.mjs';
import { ChannelWebhookInbox } from '../server/channel-import.mjs';
import { createMagicLinkMailer } from '../server/magic-links.mjs';
import { magicLinkMailerFromEnv } from '../server/resend-mailer.mjs';
import { ChannelDrainer } from '../server/channel-drain.mjs';
import { DurableDatabase, durableStorage } from './storage.mjs';
import { bootstrapRoom } from './bootstrap.mjs';
import { maintenanceEnabled, maintenanceResponse } from '../server/maintenance.mjs';
import { isEdgeDoorUrl, EDGE_DOOR_HOSTS, rewriteRoomApiPrefix } from '../deploy/agent-discovery.mjs';
// E1 — email inbound (Worker email() handler). These must come after the
// imports above: server/channel-adapters/index.mjs has a module-init order
// constraint and is only safely evaluated after store.mjs/http.mjs.
import { routeInboundEmail, emailRoutingLimits, emailRoutingRejections, connectionAddresses, routingKey } from '../server/email-routing-inbound.mjs';
import { emailConnection } from '../server/email-envelope.mjs';
import { isEmailProfile } from '../server/channel-connection.mjs';
import { scheduledRetentionTick } from '../server/retention-run.mjs';
import { HEARTBEAT_STORAGE_KEY, applyOutcomes, jobHealthResponse, jobHealthUnavailable, jobHealthView, runCronJobs } from './job-heartbeat.mjs';
import { SOURCE_REVISION, BUILD_ID } from '../server/version.mjs';

function roomOrigin(env) {
  const origin = new URL(env.ROOM_ORIGIN);
  if (origin.protocol !== 'https:' || origin.origin !== env.ROOM_ORIGIN) throw new Error('Exact HTTPS Room origin required');
  return origin;
}

// One pilot workspace per object, not one object per member. Account/session
// ownership currently spans rooms, so splitting by room would break that contract.
export class ProjectRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // DurableObject stores the context on this.ctx. Keep this.state and this.env
    // as aliases so existing reads of either name stay valid.
    this.state = ctx;
    this.env = env;
    this.requestSignals = new AsyncLocalStorage();
    const origin = roomOrigin(env);
    this.paused = maintenanceEnabled(env.ROOM_MAINTENANCE);
    if (this.paused) return;
    this.store = new RoomStore(null, { database: new DurableDatabase(ctx.storage), storagePlatform: durableStorage,
      stitch: stitchConfigFromEnv(env) });
    // Event-push dispatch: same fire-and-forget flush as the node entry
    // point. The Durable Object may suspend before the microtask drains;
    // the cron tick remains the restart-safe backstop.
    this.store.agentPlugin.setDispatchKick(() => {
      queueMicrotask(() => { this.store.agentPlugin.drainWebhookDeliveries().catch(() => {}); });
    });
    bootstrapRoom(this.store, env);
    this.store.landQueue.configure({ env });
    // Google sign-in is optional: unconfigured or misconfigured credentials
    // disable the /api/auth/google routes (503) instead of breaking the room.
    let googleAuth = null;
    try { googleAuth = googleConfig(env, env.ROOM_ORIGIN); }
    catch (error) { console.warn(`room google auth disabled: ${error.message}`); }
    let gmailAuth = null;
    try { gmailAuth = gmailConfig(env, env.ROOM_ORIGIN, googleAuth); }
    catch (error) { console.warn(`room Gmail disabled: ${error.message}`); }
    this.gmailSync = gmailAuth ? new GmailSync(new GmailMailbox(this.store, gmailAuth)) : null;
    const deployment = env.ROOM_DEPLOYMENT === 'production' || env.ROOM_DEPLOYMENT === 'staging' ? env.ROOM_DEPLOYMENT : undefined;
    this.server = createRoomServer({ store: this.store, origin: env.ROOM_ORIGIN, assetRoot: origin, serviceMode: env.ROOM_SERVICE_MODE ?? 'cloudflare-staging',
      deployment,
      googleAuth,
      gmailAuth,
      // Magic-link email is optional like Google auth: without RESEND_API_KEY
      // the mailer seam reports mail_not_configured instead of breaking boot.
      magicLinkMailer: (() => {
        const send = magicLinkMailerFromEnv(env);
        return send
          ? createMagicLinkMailer({ send, baseUrl: env.ROOM_ORIGIN })
          : createMagicLinkMailer();
      })(),
      // Verified provider webhook updates are journaled in the Durable Object's
      // SQLite (pending_channel_updates), so they survive eviction and restart.
      channelWebhooks: (this.channelWebhooks = new ChannelWebhookInbox(this.store)),
      resolveRequestSignal: () => this.requestSignals.getStore(),
      loadAsset: async path => {
        const response = await env.ASSETS.fetch(new Request(new URL('/' + path, env.ROOM_ORIGIN)));
        if (!response.ok) throw new Error('Room asset unavailable');
        return Buffer.from(await response.arrayBuffer());
      },
      resolveClientAddress: req => {
        // Only the front Worker may call this DO binding. It overwrites this
        // internal header from Cloudflare's incoming visitor-IP header.
        const address = req.headers['x-room-visitor-ip'];
        const kind = typeof address === 'string' && isIP(address);
        if (!kind) throw new Error('Trusted visitor address missing');
        return kind === 6 ? new URL(`http://[${address}]`).hostname : address;
      }
    });
    this.handler = httpServerHandler(this.server);
  }
  fetch(request) { return this.paused ? maintenanceResponse(request) : this.requestSignals.run(request.signal, () => this.handler.fetch(request)); }

  async syncGmailMailboxes() {
    if (this.paused) return { completed: 0 };
    // Unconfigured Gmail is visible in /api/health/jobs instead of looking like a quiet success.
    if (!this.gmailSync) return { completed: 0, configured: false };
    return this.gmailSync.tick();
  }

  // Cron heartbeat: the Worker records each tick's per-job outcome here after
  // the jobs settle; GET /api/health/jobs reads it back (no secrets stored).
  async recordCronTick(outcomes) {
    const previous = await this.ctx.storage.get(HEARTBEAT_STORAGE_KEY);
    const next = applyOutcomes(previous, outcomes);
    await this.ctx.storage.put(HEARTBEAT_STORAGE_KEY, next);
    return { recorded: Array.isArray(outcomes) ? outcomes.length : 0 };
  }
  async readJobHealth() {
    return jobHealthView(await this.ctx.storage.get(HEARTBEAT_STORAGE_KEY), Date.now());
  }

  // E1 — RPC: active email connections whose identity or alias lists this
  // routing key. Runs in the DO so no connection data leaves it. Returns the
  // profile or null.
  lookupRoutedConnection(address) {
    if (this.paused) return null;
    const key = routingKey(address);
    if (!key) return null;
    return this.store.readTransaction(() => {
      for (const row of this.store.db.prepare("SELECT data_json FROM private_email_connections WHERE provider='microsoft-graph'").all()) {
        const connection = JSON.parse(row.data_json);
        if (connection.state !== 'active' || !isEmailProfile(connection.profile)) continue;
        if (connectionAddresses(emailConnection(connection.profile)).includes(key)) return connection.profile;
      }
      return null;
    });
  }
  // Task 9 — auto-drain RPC for the Worker's cron trigger. Scans the webhook
  // journal and poison-screens pending slices (both session-free, so they run
  // on schedule); the inbox import itself still needs an owner session (B20
  // system import authority), so slices without one are honestly deferred,
  // never imported. Runs in the DO so no connection data leaves it.
  async drainChannelBacklog() {
    if (this.paused) throw new Error('Room paused');
    const drainer = new ChannelDrainer({ store: this.store, webhooks: this.channelWebhooks });
    return drainer.tick();
  }
  // RC-2026-09-19-064 — signed webhook dispatch RPC for the Worker's cron
  // trigger. Sweeps due deliveries (pending/failed with next_attempt_at <=
  // now), POSTs each with a fresh timestamped HMAC signature, and advances
  // the pending -> delivered | failed -> dead_letter lifecycle with
  // exponential backoff. Runs in the DO so signing secrets never leave it.
  async drainWebhookDeliveries() {
    if (this.paused) throw new Error('Room paused');
    return this.store.agentPlugin.drainWebhookDeliveries();
  }
  // Land queue: gentle GitHub poll on the per-minute cron. Merged and closed
  // items are skipped, unchanged items back off, and a rate-limit response
  // waits until the reset. A missing token is counted, not thrown, and the
  // token itself is never logged.
  async refreshLandQueue() {
    if (this.paused) return { checked: 0, updated: 0, unconfigured: 0 };
    this.store.landQueue.configure({ env: this.env });
    return this.store.landQueue.refreshDue();
  }
  // Records an analytics/audit retention plan. The tick passes no live rows
  // and no deleter, so a config flag cannot delete production room data.
  planRetention() {
    if (this.paused) return { dryRun: true, deleted: 0, skipped: "paused" };
    return scheduledRetentionTick({
      env: this.env,
      now: new Date().toISOString(),
      record: plan => { this.lastRetentionPlan = plan; }
    });
  }
  // E1 — RPC: hand an accepted, already-routed message to the importer. Needs
  // the system import authority from B20; until then it parks the request so
  // the owner's next sync imports it. Returns { accepted, duplicate }.
  importRoutedEmail(routed) {
    if (this.paused) throw new Error('Room paused');
    // B20: replace with the account-scoped import authority, e.g.
    //   return this.store.email.applyRouted(routed)  (completeRoutedImport + apply under the import fence)
    this.routedMail ??= new Map();
    if (this.routedMail.has(routed.requestId)) return { accepted: true, duplicate: true };
    if (this.routedMail.size >= 500) throw new Error('Routed mail backlog full');
    this.routedMail.set(routed.requestId, routed);
    return { accepted: true, duplicate: false };
  }
}

export default {
  async fetch(request, env) {
    // getdasha edge doors: rewrite onto the Room origin BEFORE the origin
    // check so the worker Host reaches the guard, not the browser Host - the
    // guard 403s anything that is not ROOM_ORIGIN. Packets keep /room;
    // /room/api/* becomes /api/* so identity-create, agent-rooms, and
    // invite redeem hit the same handlers as origin (www /api/* is Webflow).
    if (isEdgeDoorUrl(request.url)) {
      const inbound = new URL(request.url);
      const path = rewriteRoomApiPrefix(inbound.pathname) + inbound.search;
      request = new Request(new URL(path, roomOrigin(env).origin), request);
    } else if (EDGE_DOOR_HOSTS.includes(new URL(request.url).hostname)) {
      // The /room* route also catches /rooms, /roommates and similar lookalikes
      // (an exact pattern would drop /room?ref= query strings). Those are simply
      // not pages here: answer 404, not the 403 meant for a spoofed Host.
      return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
    }
    const url = new URL(request.url);
    // Never derive the trusted origin from a caller-controlled Host header.
    if (url.origin !== roomOrigin(env).origin) return new Response('Unexpected host', { status: 403 });
    // Storage/DO-independent version signal: answered entirely from module
    // scope and env, never touching the Durable Object, so deploy
    // verification stays available when the DO is down (2026-09-25 outage:
    // /api/version 1101'd with everything else, hiding what was deployed).
    // The durable-object id is derived with idFromName - it names the object
    // this Worker WOULD route to, which is what a door-split check compares;
    // it says nothing about room health. Placed before the maintenance gate
    // and the visitor-address guard so plain monitors always get an answer.
    if ((url.pathname === '/api/version/worker' || url.pathname === '/api/version/worker/') && (request.method === 'GET' || request.method === 'HEAD')) {
      const deployment = env.ROOM_DEPLOYMENT === 'production' || env.ROOM_DEPLOYMENT === 'staging' ? { deployment: env.ROOM_DEPLOYMENT } : {};
      const body = JSON.stringify({
        status: 'ok', servedBy: 'worker', sourceRevision: SOURCE_REVISION, buildId: BUILD_ID, ...deployment,
        durableObject: { name: 'invite-only-pilot', id: env.ROOM.idFromName('invite-only-pilot').toString() }
      });
      return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
    }
    if (maintenanceEnabled(env.ROOM_MAINTENANCE)) return maintenanceResponse(request);
    // Read-only cron heartbeat (per-job lastSuccessAt / lastError). 503 when a
    // job is stale or failing, so a plain status check catches dead crons.
    if ((url.pathname === '/api/health/jobs' || url.pathname === '/api/health/jobs/') && (request.method === 'GET' || request.method === 'HEAD')) {
      const head = request.method === 'HEAD';
      try { return jobHealthResponse(await env.ROOM.getByName('invite-only-pilot').readJobHealth(), { head }); }
      catch (error) { console.error(`[job-heartbeat] read failed: ${error?.message ?? error}`); return jobHealthUnavailable({ head }); }
    }
    const address = request.headers.get('CF-Connecting-IP');
    if (!address || !isIP(address)) return new Response('Visitor address unavailable', { status: 403 });
    const headers = new Headers(request.headers);
    // Worker Request.url is the external authority. The Node bridge needs it
    // explicitly; a local runtime's transport Host can be a loopback address.
    headers.set('Host', url.host);
    headers.set('X-Room-Visitor-IP', address);
    headers.delete('X-Real-IP');
    headers.delete('X-Forwarded-For');
    const response = await env.ROOM.getByName('invite-only-pilot').fetch(new Request(request, { headers }));
    const authFailure = response.headers.get('X-Room-Auth-Failure');
    if (authFailure && /^[a-z][a-z0-9_]{0,63}$/.test(authFailure)) console.warn(`room authentication failed: ${authFailure}; ${response.headers.get("X-Room-Auth-Diagnostic") || ""}`);
    return response;
  },

  // E1 — Cloudflare Email Routing calls this for every message a routing rule
  // sends to the Worker. message.from / message.to are the SMTP envelope
  // addresses; message.raw is a ReadableStream of the RFC 5322 bytes;
  // message.rawSize is its length; setReject() answers a permanent SMTP error
  // with the reason.
  async email(message, env, ctx) {
    if (maintenanceEnabled(env.ROOM_MAINTENANCE)) { message.setReject(emailRoutingRejections.unavailable); return; }
    // Refuse before reading the stream: the size cap is the first defence.
    if (message.rawSize > emailRoutingLimits.rawBytes) { message.setReject(emailRoutingRejections.tooLarge); return; }
    const room = env.ROOM.getByName('invite-only-pilot');
    let routed;
    try {
      const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
      routed = await routeInboundEmail(
        { from: message.from, to: message.to, raw, rawSize: message.rawSize, receivedAt: new Date().toISOString() },
        { lookup: address => room.lookupRoutedConnection(address) });
    } catch {
      // Storage or RPC failure: temporary reject so the sender retries; never a silent drop.
      message.setReject(emailRoutingRejections.unavailable); return;
    }
    if (!routed.decision.accept) { message.setReject(routed.decision.reason); return; }
    try { await room.importRoutedEmail(routed); }
    catch { message.setReject(emailRoutingRejections.unavailable); }
  },

  // Task 9 — Worker cron (see triggers.crons in wrangler.jsonc): drain the
  // Telegram webhook journal on a schedule. The tick runs inside the Durable
  // Object via RPC; a failing tick is logged, never retried by the cron.
  // RC-2026-09-19-064: the same tick also sweeps due signed-webhook
  // deliveries (pending -> delivered | failed -> dead_letter).
  // Every job's outcome is recorded as a heartbeat (GET /api/health/jobs), and
  // any failed job makes the scheduled invocation itself fail so Cron Events and
  // tail show an exception instead of a green "ok" over swallowed warnings.
  async scheduled(event, env, ctx) {
    if (maintenanceEnabled(env.ROOM_MAINTENANCE)) return;
    const room = env.ROOM.getByName('invite-only-pilot');
    const outcomes = await runCronJobs({
      'gmail-sync': () => room.syncGmailMailboxes(),
      'channel-drain': () => room.drainChannelBacklog(),
      'webhook-dispatch': () => room.drainWebhookDeliveries(),
      'land-queue': () => room.refreshLandQueue(),
      'retention': () => room.planRetention()
    });
    try { await room.recordCronTick(outcomes); }
    catch (error) { console.error(`[job-heartbeat] record failed: ${error?.message ?? error}`); }
    const failed = outcomes.filter(outcome => !outcome.ok).map(outcome => outcome.job);
    if (failed.length) throw new Error(`cron jobs failed: ${failed.join(', ')}`);
  }
};
