import {CurrentServingRoom} from './current-room-serving.test-fixture.mjs';
import {seedRecoveryHistoricalSource} from '../tests/helpers/recovery-historical-source.mjs';
import {createBackupReplaySession} from '../server/restore-ndjson.mjs';
import {exportNdjsonText} from '../server/room-export.mjs';
import {auditRecovery} from '../server/recovery.mjs';
export class DurableCoverageRoom extends CurrentServingRoom{
 async fetch(request){const path=new URL(request.url).pathname;
  if(path==='/__historical'){this.fixture=seedRecoveryHistoricalSource(this.store);return Response.json({head:this.fixture.head,prefix:this.fixture.prefix,post:this.fixture.post,completed:this.fixture.completed,body:this.fixture.body});}
  if(path==='/__key')return Response.json({key:this.fixture.key});
  if(path==='/__export'){auditRecovery(this.store);return new Response(exportNdjsonText(this.db));}
  if(path==='/__partial'){this.session=createBackupReplaySession(this.store);this.session.writeText(await request.text());return Response.json({pending:this.store.restoreStatus().pending,events:this.db.prepare('SELECT count(*) n FROM events').get().n});}
  return super.fetch(request);
 }
}
export default{fetch(request,env){return env.ROOM.getByName(new URL(request.url).searchParams.get('surface')??'source').fetch(request);}};
