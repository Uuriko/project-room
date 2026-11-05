import {CurrentServingRoom} from './current-room-serving.test-fixture.mjs';
import {ClaimTarget} from './claim-recovery.test-fixture.mjs';
import {seedHistoricalRedactionSource} from '../tests/helpers/historical-redaction-source.mjs';
import {exportNdjsonText} from '../server/room-export.mjs';
import {auditRecovery} from '../server/recovery.mjs';
export class CharterSource extends CurrentServingRoom{
 async fetch(request){const path=new URL(request.url).pathname;
  if(path==='/__seed'){const f=seedHistoricalRedactionSource(this.store,{beforeCapture:(store,{key})=>store.command(key,'legacy-room',{id:'source-charter',type:'room.charter_updated',data:{expectedRevision:0,purpose:'Finish useful work with preserved ownership',outputs:null,boundaries:null,escalation:null}})});this.store.command(f.key,'legacy-room',{id:'normalized-charter',type:'room.charter_updated',data:{expectedRevision:1,purpose:'Preserve edited normalized instructions',outputs:'Save evidence',boundaries:null,escalation:null}});auditRecovery(this.store);return Response.json(JSON.parse(this.db.prepare("SELECT payload FROM current_room_records WHERE room_id='legacy-room' AND domain='metadata' AND record_key='room'").get().payload).charter);}
  if(path==='/__export')return new Response(exportNdjsonText(this.db));return super.fetch(request);
 }
}
export class CharterTarget extends ClaimTarget{
 async fetch(request){if(new URL(request.url).pathname==='/__charter'){this.store.assertRestoreAdmitted();return Response.json(JSON.parse(this.store.db.prepare("SELECT payload FROM current_room_records WHERE room_id='legacy-room' AND domain='metadata' AND record_key='room'").get().payload).charter);}return super.fetch(request);}
}
export default{fetch(request,env){const headers=new Headers(request.headers);headers.set('Host','room.example.test');headers.set('x-room-visitor-ip','192.0.2.1');return env.ROOM.getByName('target').fetch(new Request(request,{headers}));}};
