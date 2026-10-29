import entry,{HttpTestRoom} from './http-worker.test-fixture.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
export class ReplyColdRoom extends HttpTestRoom {
 async fetch(request){
 if(new URL(request.url).pathname!=='/__test-cold')return super.fetch(request);
 try { const s=this.store;s.initialize(initialRoom());s.maintainMessageCertification=true;s.messageProjectionWindow=100;s.messageEntityProjection=true;s.roomFlood={consume(){}};
 const owner=s.issueAccessKey('commons','owner');let n=0;const cmd=(type,data)=>s.command(owner,'commons',{id:'command-'+(++n),type,data});
 cmd('member.added',{memberId:'reader',displayName:'Reader',kind:'human',permissions:[]});const reader=s.issueAccessKey('commons','reader');s.dmConsents.request('commons','owner','reader','Test');s.dmConsents.decide('commons','reader','owner','approve');
 for(let i=0;i<10;i++)cmd('message.posted',{messageId:'other-'+i,body:'Unrelated'+ 'x'.repeat(1000)});
 cmd('message.posted',{messageId:'ask',body:'Selected question',toMemberId:'reader',requestKind:'reply'});
 while(!s.backfillMessages({limit:1000}).done){}s.checkMessagesParity();cmd('message.posted',{messageId:'tail',body:'Tail'});
 s._dropProjectionCache();const raw=JSON.parse(s.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection);if(!raw.messages.some(m=>m._entity===1))throw Error('no entities');
 s.room=()=>{throw Error('full hydration');};const result=s.replyRequests.selected(reader,'commons','ask');
 s.db.prepare("UPDATE messages SET body='1',record_json=json_set(record_json,'$.body',json('true')) WHERE room_id='commons' AND message_id='other-0'").run();let refused=false;try{s.replyRequests.selected(reader,'commons','ask')}catch(e){refused=e.message.includes('projection_corrupt')}
 return Response.json({body:result.page.items[0].message.body,basis:!!result.current.answerBasis,refused}); }catch(e){return Response.json({error:e.message,stack:e.stack},{status:500});}
 }
}
export default entry;
