import { DurableObject } from 'cloudflare:workers';
import { RoomStore } from '../server/store.mjs';
import { messageProjectionArmingFromEnv } from '../server/message-entity-projection.mjs';
import { DurableDatabase, durableStorage } from './storage.mjs';
import { perRoomObjectsEnabled } from '../server/room-shard-flag.mjs';

// One room's bytes. invite-only-pilot stays the directory. Storage opens
// only when ROOM_PER_ROOM_OBJECTS is exactly "1", so a default deploy does
// not create a shard schema. This object does not arm the pilot alarm and
// does not run room-backup or directory store-growth.
export class RoomShard extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.state = ctx;
    this.env = env;
    this.store = null;
    if (!perRoomObjectsEnabled(env)) return;
    this.store = new RoomStore(null, {
      database: new DurableDatabase(ctx.storage),
      storagePlatform: durableStorage,
      integrity: 'deferred',
      bodiesAtRest: env.ROOM_BODIES_AT_REST === '1',
      // Message entity projection arming (default OFF; empty when unset).
      ...messageProjectionArmingFromEnv(env),
    });
  }

  async fetch() {
    return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }
}
