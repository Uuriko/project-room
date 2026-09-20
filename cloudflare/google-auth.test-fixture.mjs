// Local-only fixture representing a deployed v35 database predating PKCE persistence.
import { GoogleSignIn } from '../server/google-oauth.mjs';
import entry, { ProjectRoom } from './room.mjs';
import { RoomStore } from '../server/store.mjs';
import { DurableDatabase, durableStorage } from './storage.mjs';
export class GoogleTestRoom extends ProjectRoom {
 async fetch(request) {
  if (new URL(request.url).pathname === "/__verify") {
   const { token, jwk } = await request.json();
   const google = new GoogleSignIn({ clientId: "123-example.apps.googleusercontent.com", clientSecret: "synthetic-secret", redirectUri: "https://room.example.test/api/auth/google/callback", fetchImpl: async () => Response.json({keys: [jwk]}) });
   try { return Response.json(await google.verifyIdToken(token)); } catch (error) { return Response.json({error: error.message}, {status: 500}); }
  }
  return super.fetch(request);
 }
 constructor(ctx, env) {
  if (env.LEGACY_OAUTH_SCHEMA) {
   new RoomStore(null, { database: new DurableDatabase(ctx.storage), storagePlatform: durableStorage });
   ctx.storage.sql.exec('DROP TABLE oauth_pending_states');
  }
  super(ctx, env);
 }
}
export default entry;
