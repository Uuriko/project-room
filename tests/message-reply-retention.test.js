import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {replyFollowUp,MAX_REPLY_REQUESTS} from '../src/reply-requests.js';
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
test('answer retention adds at most one response per admitted request at the existing request cap',t=>{
 const f=setup(t,null);
 for(let i=0;i<MAX_REPLY_REQUESTS;i++){const q=f.request(i);f.answer(i,q);}
 assert.throws(()=>f.request('overflow'),/capacity/);
 for(let i=0;i<8;i++)f.command('owner','message.posted',{messageId:`tail-${i}`,body:`Settled ${i}.`});
 assert.equal(f.store.archiveMessages('commons',{keepNewest:4,dryRun:false}).ok,true);
 const state=f.store.room('commons').state;
 assert.equal(Object.keys(state.replyRequests).length,MAX_REPLY_REQUESTS);
 assert.equal(state.messages.filter(m=>m.id.startsWith('a-')).length,MAX_REPLY_REQUESTS);
 assert.equal(state.messages.length,MAX_REPLY_REQUESTS*2+4,'only request roots, their recorded responses and newest tail');
 assert.ok(replyFollowUp(state,'q-0','owner'));assert.ok(replyFollowUp(state,`q-${MAX_REPLY_REQUESTS-1}`,'owner'));
 assert.equal(f.store.checkMessagesParity().ok,true);
});
