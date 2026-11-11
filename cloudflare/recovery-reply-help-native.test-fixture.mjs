import {CurrentServingRoom} from './current-room-serving.test-fixture.mjs';
import {ClaimTarget} from './claim-recovery.test-fixture.mjs';
import {seedRecoveryReplyHelpSource} from '../tests/helpers/recovery-reply-help-source.mjs';
import {exportNdjsonText} from '../server/room-export.mjs';
import {readCurrentRoomForAudit} from '../server/current-room-repository.mjs';
import {exactReplyAuditMessage} from '../server/recovery-reply-rules.mjs';
export class ReplyHelpSource extends CurrentServingRoom{
 async fetch(request){const path=new URL(request.url).pathname;if(path==='/__seed')return Response.json(seedRecoveryReplyHelpSource(this.store));if(path==='/__export')return new Response(exportNdjsonText(this.db));return super.fetch(request);}
}
export class ReplyHelpTarget extends ClaimTarget{
 async fetch(request){if(new URL(request.url).pathname==='/__facts'){this.store.assertRestoreAdmitted();const state=this.store.readTransaction(()=>readCurrentRoomForAudit(this.store,'legacy-room')).state;return Response.json({rooms:this.store.db.prepare('SELECT count(*) n FROM rooms').get().n,requests:state.replyRequests,messages:state.messages.map(exactReplyAuditMessage),offers:state.helpOffers,ownerId:state.room.ownerId,historyProvenance:'unknown',certified:false});}return super.fetch(request);}
}
export default{fetch(request,env){const headers=new Headers(request.headers);headers.set('Host','room.example.test');headers.set('x-room-visitor-ip','192.0.2.1');return env.ROOM.getByName('target').fetch(new Request(request,{headers}));}};
