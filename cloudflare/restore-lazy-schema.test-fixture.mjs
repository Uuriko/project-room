// Synthetic SQLite restore qualification only; never deploy this entry point.
import { DurableObject } from 'cloudflare:workers';
import { createHash } from 'node:crypto';
import { RoomStore } from '../server/store.mjs';
import { DurableDatabase, durableStorage } from './storage.mjs';
import { exportNdjsonText } from '../server/room-export.mjs';
import { createBackupReplaySession } from '../server/restore-ndjson.mjs';
import { seedLazyRestoreStore, lazyRestoreRows } from '../tests/helpers/lazy-restore-fixture.mjs';
const digest=store=>createHash('sha256').update(JSON.stringify(lazyRestoreRows(store))).digest('hex');
export class LazyRestoreProbe extends DurableObject {
  constructor(ctx,env){super(ctx,env);this.store=new RoomStore(null,{database:new DurableDatabase(ctx.storage),storagePlatform:durableStorage});}
  async fetch(request){
    const url=new URL(request.url),store=this.store;
    if(url.pathname==='/seed'){
      seedLazyRestoreStore(store);
      if(url.searchParams.get('unknown')==='1')store.db.exec("CREATE TABLE unrecognized_restore_table(id TEXT); INSERT INTO unrecognized_restore_table VALUES('fixture')");
      return new Response(exportNdjsonText(store.db),{headers:{'X-Fixture-Digest':digest(store)}});
    }
    const session=createBackupReplaySession(store);
    try{
      const text=await request.text();for(let i=0;i<text.length;i+=733)session.writeText(text.slice(i,i+733));
      const result=session.finish();return Response.json({verified:result.verified,contentVerification:result.contentVerification,auditOk:result.audit.ok,digest:digest(store)});
    }catch(error){session.abort();return Response.json({unknownRejected:error.message==='Export names a table this store does not have'},{status:422});}
  }
}
export default{fetch(request,env){const url=new URL(request.url);return env.ROOM.getByName(url.searchParams.get('id')??'target').fetch(request);}};
