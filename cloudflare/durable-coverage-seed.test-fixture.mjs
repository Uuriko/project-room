import {initialRoom} from '../server/bootstrap.mjs';
import {event,emptyRoomState,replayEvents} from '../src/events.js';
import {CurrentServingRoom} from './current-room-serving.test-fixture.mjs';
import {createBackupReplaySession} from '../server/restore-ndjson.mjs';
import {exportNdjsonText} from '../server/room-export.mjs';
import {setTier} from '../server/autonomy-tiers.mjs';
import {auditRecovery} from '../server/recovery.mjs';
export class DurableCoverageRoom extends CurrentServingRoom {
 async fetch(request){const path=new URL(request.url).pathname;
  if(path==='/__seed-history'){
   const events=[...initialRoom(),event({id:'limit-history',roomId:'commons',actorId:'owner',type:'room.history_visibility_set',data:{historyVisibility:'since_join'}})];
   for(let n=0;n<1000;n++)events.push(event({id:'old-event-'+n,roomId:'commons',actorId:'owner',type:'message.posted',at:'2026-01-01T00:00:00Z',data:{messageId:'old-'+n,body:'Synthetic before join'}}));
   const at='Sun, 01 Nov 2026 12:00:00 GMT'+' '.repeat(160000);events.push(event({id:'large-legal-history-event',roomId:'commons',actorId:'owner',type:'pair.requested',at,data:{pairId:'synthetic-history-pair',displayName:'Synthetic history probe',status:'pending'}}));
   events.push(event({id:'reader-joined',roomId:'commons',actorId:'owner',type:'member.added',at:'2026-02-01T00:00:00Z',data:{memberId:'reader',displayName:'Reader',kind:'agent',permissions:[]}}));
   this.store.initialize(events,{representation:'normalized-current-v1'});await this.ctx.storage.put('owner-key',this.store.issueAccessKey('commons','owner'));await this.ctx.storage.put('reader-key',this.store.issueAccessKey('commons','reader'));return Response.json({count:1000,legalHistoryTimestampBytes:at.length});
  }
  if(path==='/__checkpoint'){const sequence=this.store.headSequence('commons'),events=this.db.prepare('SELECT body FROM events WHERE room_id=? ORDER BY sequence').all('commons').map(row=>JSON.parse(row.body)),state=replayEvents(emptyRoomState(),events);this.store.transaction(()=>this.db.prepare('INSERT INTO projection_checkpoints(room_id,sequence,projection) VALUES(?,?,?)').run('commons',sequence,JSON.stringify(state)));auditRecovery(this.store);return Response.json({sequence,messages:state.messages.length,requests:Object.keys(state.replyRequests??{}).length});}
  if(path==='/__export'){auditRecovery(this.store);return new Response(exportNdjsonText(this.db));}
  if(path==='/__work'){const key=await this.ctx.storage.get('owner-key'),proposal={id:'native-restored-work-proposal',type:'work.proposed',data:{workItemId:'native-restored-work',title:'Preserve useful native work',definitionOfDone:'Exact task and retry survive recovery',accountableMemberId:'owner'}},proposed=this.store.command(key,'commons',proposal),accepted=this.store.command(key,'commons',{id:'native-restored-work-accept',type:'work.accepted',data:{workItemId:'native-restored-work',expectedRevision:0}});setTier(this.db,'commons','reader','t2_standard',{updatedBy:'owner',nowMs:Date.now()});const privateRequest=this.store.command(key,'commons',{id:'native-private-ask',type:'message.posted',data:{messageId:'native-private-question',toMemberId:'reader',requestKind:'reply',workItemId:'native-restored-work',body:'Preserve this synthetic private question'}});return Response.json({proposal,proposed,accepted,privateRequest,capacity:this.db.prepare("SELECT payload FROM current_room_records WHERE room_id='commons' AND domain='workCapacity' AND record_key='native-restored-work'").get()});}
  if(path==='/__key')return Response.json({key:await this.ctx.storage.get('owner-key')});
  if(path==='/__partial'){this.session=createBackupReplaySession(this.store);this.session.writeText(await request.text());return Response.json({pending:this.store.restoreStatus().pending,events:this.db.prepare('SELECT count(*) n FROM events').get().n});}
  return super.fetch(request);
 }
}
export default{fetch(request,env){return env.ROOM.getByName(new URL(request.url).searchParams.get('surface')??'source').fetch(request);}};
