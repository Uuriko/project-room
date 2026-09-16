import { httpServerHandler } from 'cloudflare:node';
import { isIP } from 'node:net';
import { AsyncLocalStorage } from 'node:async_hooks';
import { RoomStore } from '../server/store.mjs';
import { createRoomServer } from '../server/http.mjs';
import { ChannelWebhookInbox } from '../server/channel-import.mjs';
import { DurableDatabase, durableStorage } from './storage.mjs';
import { bootstrapRoom } from './bootstrap.mjs';
import { maintenanceEnabled, maintenanceResponse } from '../server/maintenance.mjs';
import { isEdgeDoorUrl, EDGE_DOOR_HOSTS } from '../deploy/agent-discovery.mjs';
// E1 — email inbound (Worker email() handler). These must come after the
// imports above: server/channel-adapters/index.mjs has a module-init order
// constraint and is only safely evaluated after store.mjs/http.mjs.
import { routeInboundEmail, emailRoutingLimits, emailRoutingRejections, connectionAddresses, routingKey } from '../server/email-routing-inbound.mjs';
import { emailConnection } from '../server/email-envelope.mjs';
import { isEmailProfile } from '../server/channel-connection.mjs';

function roomOrigin(env) {
  const origin = new URL(env.ROOM_ORIGIN);
  if (origin.protocol !== 'https:' || origin.origin !== env.ROOM_ORIGIN) throw new Error('Exact HTTPS Room origin required');
  return origin;
}

// One pilot workspace per object, not one object per member. Account/session
// ownership currently spans rooms, so splitting by room would break that contract.
export class ProjectRoom {
  constructor(ctx, env) {
    this.env = env;
    this.requestSignals = new AsyncLocalStorage();
    const origin = roomOrigin(env);
    this.paused = maintenanceEnabled(env.ROOM_MAINTENANCE);
    if (this.paused) return;
    this.store = new RoomStore(null, { database: new DurableDatabase(ctx.storage), storagePlatform: durableStorage });
    bootstrapRoom(this.store, env);
    this.server = createRoomServer({ store: this.store, origin: env.ROOM_ORIGIN, assetRoot: origin, serviceMode: 'cloudflare-staging',
      // Verified provider webhook updates are journaled in the Durable Object's
      // SQLite (pending_channel_updates), so they survive eviction and restart.
      channelWebhooks: new ChannelWebhookInbox(this.store),
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
    // guard 403s anything that is not ROOM_ORIGIN. Prefix preserved.
    if (isEdgeDoorUrl(request.url)) {
      const inbound = new URL(request.url);
      request = new Request(new URL(inbound.pathname + inbound.search, roomOrigin(env).origin), request);
    } else if (EDGE_DOOR_HOSTS.includes(new URL(request.url).hostname)) {
      // The /room* route also catches /rooms, /roommates and similar lookalikes
      // (an exact pattern would drop /room?ref= query strings). Those are simply
      // not pages here: answer 404, not the 403 meant for a spoofed Host.
      return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
    }
    const url = new URL(request.url);
    // Never derive the trusted origin from a caller-controlled Host header.
    if (url.origin !== roomOrigin(env).origin) return new Response('Unexpected host', { status: 403 });
    if (maintenanceEnabled(env.ROOM_MAINTENANCE)) return maintenanceResponse(request);
    const address = request.headers.get('CF-Connecting-IP');
    if (!address || !isIP(address)) return new Response('Visitor address unavailable', { status: 403 });
    const headers = new Headers(request.headers);
    // Worker Request.url is the external authority. The Node bridge needs it
    // explicitly; a local runtime's transport Host can be a loopback address.
    headers.set('Host', url.host);
    headers.set('X-Room-Visitor-IP', address);
    headers.delete('X-Real-IP');
    headers.delete('X-Forwarded-For');
    return env.ROOM.getByName('invite-only-pilot').fetch(new Request(request, { headers }));
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
  }
};
