import {CurrentServingRoom} from './current-room-serving.test-fixture.mjs';
import {ProjectRoom} from './room.mjs';
import {seedRecoveryReminderSource} from '../tests/helpers/recovery-reminder-source.mjs';
import {recoveryWorkLifecycle} from '../tests/helpers/recovery-work-lifecycle.mjs';
import {auditRecovery} from '../server/recovery.mjs';
import {seedRecoveryClaimSource} from '../tests/helpers/recovery-claim-source.mjs';
import {createBackupReplaySession} from '../server/restore-ndjson.mjs';
import {exportNdjsonText} from '../server/room-export.mjs';
import {restoreProgress,withRestoreTransaction,withRestoreAuditRows} from '../server/restore-admission.mjs';
import {readRecoveryReplayValue} from '../server/recovery-replay-value.mjs';
export class ClaimSource extends CurrentServingRoom{
 async fetch(request){const path=new URL(request.url).pathname;
  if(path==='/__reminders'){const f=seedRecoveryReminderSource(this.store);return Response.json({receipts:f.receipts,rows:f.reminders,expected:this.db.prepare('SELECT * FROM private_reminders ORDER BY room_id,member_id,work_item_id').all()});}
  if(path==='/__lifecycle'){const f=recoveryWorkLifecycle();this.store.initialize(f.history,{representation:'normalized-current-v1'});auditRecovery(this.store);return Response.json({head:f.history.length,workItems:Object.keys(f.state.workItems).length,expected:f.state.workItems.main});}
  if(path==='/__seed')return Response.json(seedRecoveryClaimSource(this.store));
  if(path==='/__export')return new Response(exportNdjsonText(this.db));
  return super.fetch(request);
 }
}
export class ClaimTarget extends ProjectRoom{
 async fetch(request){const path=new URL(request.url).pathname;
  if(path==='/__reminders'){this.store.assertRestoreAdmitted();return Response.json(this.store.db.prepare('SELECT * FROM private_reminders ORDER BY room_id,member_id,work_item_id').all());}
  if(path==='/__partial'){this.session=createBackupReplaySession(this.store);this.session.writeText(await request.text());return Response.json({pending:this.store.restoreStatus().pending,events:this.store.db.prepare('SELECT count(*) n FROM events').get().n});}
  if(path==='/__folded'){const state=restoreProgress(this.store.db);return Response.json(withRestoreTransaction(this.store,()=>withRestoreAuditRows(this.store.db,state.restore_id,scratch=>readRecoveryReplayValue(scratch,'commons','workItems',new URL(request.url).searchParams.get('workItemId')??'target',4*1024*1024))));}
  return super.fetch(request);
 }
}
export default{fetch(request,env){const u=new URL(request.url),surface=u.searchParams.get('surface')??'target';u.searchParams.delete('surface');const headers=new Headers(request.headers);headers.set('Host','room.example.test');headers.set('x-room-visitor-ip','192.0.2.1');const options={method:request.method,headers};if(!['GET','HEAD'].includes(request.method))options.body=request.body;return env.ROOM.getByName(surface).fetch(new Request(u,options));}};
