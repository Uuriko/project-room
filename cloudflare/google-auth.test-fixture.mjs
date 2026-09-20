// Local-only fixture representing a deployed v35 database predating PKCE persistence.
import entry, { ProjectRoom } from './room.mjs';
import { RoomStore } from '../server/store.mjs';
import { DurableDatabase, durableStorage } from './storage.mjs';
export class GoogleTestRoom extends ProjectRoom {
 constructor(ctx, env) {
  if (env.LEGACY_OAUTH_SCHEMA) {
   new RoomStore(null, { database: new DurableDatabase(ctx.storage), storagePlatform: durableStorage });
   ctx.storage.sql.exec('DROP TABLE oauth_pending_states');
  }
  super(ctx, env);
 }
}
export default entry;
