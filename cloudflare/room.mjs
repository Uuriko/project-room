import { httpServerHandler } from 'cloudflare:node';
import { isIP } from 'node:net';
import { AsyncLocalStorage } from 'node:async_hooks';
import { RoomStore } from '../server/store.mjs';
import { createRoomServer } from '../server/http.mjs';
import { DurableDatabase, durableStorage } from './storage.mjs';
import { bootstrapRoom } from './bootstrap.mjs';
import { maintenanceEnabled, maintenanceResponse } from '../server/maintenance.mjs';

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
}

export default {
  async fetch(request, env) {
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
  }
};
