import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {requestNotices} from '../client/request-notices.mjs';
import {validateReplyRead} from '../client/reply-actions.mjs';
import {replyFollowUp} from '../src/reply-requests.js';
import {setTier} from '../server/autonomy-tiers.mjs';

function setup(t,window=4){
 const directory=mkdtempSync(join(tmpdir(),'reply-retention-')),path=join(directory,'room.sqlite');
 const options={maintainMessageCertification:true,messageProjectionWindow:window};
 let store=new RoomStore(path,options);store.initialize(initialRoom());store.roomFlood={consume(){}};
 const keys={owner:store.issueAccessKey('commons','owner')};
 const command=(who,type,data)=>store.command(keys[who],'commons',{id:crypto.randomUUID(),type,data});
 for(const [memberId,kind] of [['agent','agent'],['outsider','human']]){
  command('owner','member.added',{memberId,displayName:memberId,kind,permissions:kind==='agent'?['accept_work','complete_work']:[]});
  keys[memberId]=store.issueAccessKey('commons',memberId);
 }
 setTier(store.db,'commons','agent','t2_standard',{updatedBy:'owner',nowMs:Date.now()});
 for(const [a,b] of [['owner','agent'],['agent','owner']]){store.dmConsents.request('commons',a,b,'fixture');store.dmConsents.decide('commons',b,a,'approve');}
 while(!store.backfillMessages({limit:1000}).done){};assert.equal(store.checkMessagesParity().ok,true);
 t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 const request=id=>command('owner','message.posted',{messageId:`q-${id}`,body:'Please report the current result.',toMemberId:'agent',requestKind:'reply'});
 return {get store(){return store;},keys,command,request,
  answer:(id,q)=>command('agent','message.posted',{messageId:`a-${id}`,body:'The result is ready.',responseToRequestId:`q-${id}`,expectedRequestRevision:0,responseOutcome:'answered',contextEventId:q.event.id,contextSequence:q.sequence,replyToId:`q-${id}`,toMemberId:'owner',workItemId:null}),
  reopen:()=>{store.close();store=new RoomStore(path,options);store.roomFlood={consume(){}};}};
}
test('answered request follow-up survives automatic archival and reopen without expanding visibility',t=>{
 const f=setup(t),q=f.request('one');f.answer('one',q);
 assert.ok(replyFollowUp(f.store.room('commons').state,'q-one','owner'));
 for(let i=0;i<20;i++)f.command('owner','message.posted',{messageId:`settled-${i}`,body:`Settled ${i}.`});
 assert.ok(replyFollowUp(f.store.room('commons').state,'q-one','owner'));
 assert.equal(replyFollowUp(f.store.room('commons').state,'q-one','outsider'),null);
 assert.throws(()=>f.store.replyRequests.selected(f.keys.outsider,'commons','q-one'),/not found|participant|visible|access/i);
 f.reopen();
 assert.ok(replyFollowUp(f.store.room('commons').state,'q-one','owner'));
 assert.equal(f.store.checkMessagesParity().ok,true);
 f.command('agent','message.deleted',{messageId:'a-one',expectedMessageRevision:0});
 assert.equal(replyFollowUp(f.store.room('commons').state,'q-one','owner'),null,'retention never restores a deleted answer');
 assert.equal(f.store.room('commons').state.messages.find(m=>m.id==='a-one').body,null);
 f.reopen();assert.equal(replyFollowUp(f.store.room('commons').state,'q-one','owner'),null);
});
test('legacy room accepts requests beyond 500 and preserves reads and answer retention',t=>{
 const f=setup(t,null), prior=500;
 for(let i=0;i<prior;i++){const q=f.request(i);f.answer(i,q);}
 const data={messageId:'q-500',body:'Please report the current result.',toMemberId:'agent',requestKind:'reply'};
 const command={id:'request-after-500',type:'message.posted',data};
 const opened=f.store.command(f.keys.owner,'commons',command);
 const retry=f.store.command(f.keys.owner,'commons',command);
 assert.equal(retry.sequence,opened.sequence);
 assert.equal(retry.duplicate,true);
 assert.equal(f.store.replyRequests.selected(f.keys.agent,'commons',data.messageId).page.items[0].sequence,opened.sequence);
 const args={direction:'outgoing',status:'all'};
 const listed=f.store.replyRequests.list(f.keys.owner,'commons',args);
 assert.equal(validateReplyRead(listed,{name:'room_list_requests',args,roomId:'commons'}).requests.length,prior+1);
 const notices=requestNotices({roomId:'commons',viewerId:'agent',state:f.store.room('commons').state});
 assert.equal(notices.get(JSON.stringify(['request',data.messageId])).payload.condition,'reply_requested');
 f.answer(prior,opened);
 for(let i=0;i<8;i++)f.command('owner','message.posted',{messageId:`tail-${i}`,body:`Settled ${i}.`});
 assert.equal(f.store.archiveMessages('commons',{keepNewest:4,dryRun:false}).ok,true);
 const state=f.store.room('commons').state;
 assert.equal(Object.keys(state.replyRequests).length,prior+1);
 assert.equal(state.messages.filter(m=>m.id.startsWith('a-')).length,prior+1);
 assert.equal(state.messages.length,(prior+1)*2+4,'only request roots, their recorded responses and newest tail');
 assert.ok(replyFollowUp(state,'q-0','owner'));assert.ok(replyFollowUp(state,`q-${prior}`,'owner'));
 assert.equal(f.store.checkMessagesParity().ok,true);
 f.reopen();
 assert.equal(f.store.replyRequests.selected(f.keys.agent,'commons',data.messageId).request.status,'answered');
 assert.ok(replyFollowUp(f.store.room('commons').state,'q-0','owner'));
});
