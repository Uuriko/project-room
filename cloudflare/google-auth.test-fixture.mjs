// Local-only fixture representing a deployed v35 database predating PKCE persistence.
import entry, { ProjectRoom } from './room.mjs';
import { RoomStore } from '../server/store.mjs';
import { DurableDatabase, durableStorage } from './storage.mjs';
export class GoogleTestRoom extends ProjectRoom {
 constructor(ctx, env) {
  if (env.LEGACY_OAUTH_SCHEMA) {
   new RoomStore(null, { database: new DurableDatabase(ctx.storage), storagePlatform: durableStorage });
   // The open above stamps the current DDL. Dropping the PKCE table makes
   // that stamp a lie, so clear it and let the room open install the table.
   ctx.storage.sql.exec('DROP TABLE oauth_pending_states');
   ctx.storage.sql.exec('DELETE FROM room_schema_stamp');
  }
  super(ctx, env);
 }
}
export default entry;
