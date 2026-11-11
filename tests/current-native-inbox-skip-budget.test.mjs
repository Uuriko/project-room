import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
import {readCurrentNativeInbox} from '../server/current-native-inbox.mjs';
import {withCurrentReadContext,chargeCurrentReadBudget} from '../server/current-room-repository.mjs';
function fixture(t,addressedFirst){
 const s=new RoomStore(':memory:');t.after(()=>s.close());const events=initialRoom(),add=(type,data)=>events.push(event({roomId:'commons',actorId:'owner',type,data}));
 for(const id of ['worker','other'])add('member.added',{memberId:id,displayName:id,kind:'agent',permissions:[]});
 const after=events.length,dm=()=>add('message.posted',{messageId:'addressed',body:'Useful private ask',toMemberId:'worker'});
 if(addressedFirst)dm();for(let i=0;i<63;i++)add('message.posted',{messageId:'noise-'+i,body:'x'.repeat(3800)});if(!addressedFirst)dm();
 s.initialize(events,{representation:'normalized-current-v1'});s.room=()=>{throw Error('whole-room hydration')};return{s,key:s.issueAccessKey('commons','worker'),after};
}
for(const first of [true,false])test(`legal near-4KiB noise keeps catch-up readable with addressed item ${first?'first':'last'}`,t=>{
 const{s,key,after}=fixture(t,first);
 const full=readCurrentNativeInbox(s,key,'commons',{after,limit:20,skipUnaddressed:false});
 assert.ok(full.cursor.after>after);
 const found=[];let cursor=after;
 for(let n=0;n<30;n++){
  const p=readCurrentNativeInbox(s,key,'commons',{after:cursor,limit:20,skipUnaddressed:true});found.push(...p.directMessages.map(x=>x.messageId));
  if(!p.cursor.hasMore){assert.deepEqual(found,['addressed']);return;}
  assert.ok(p.cursor.after>cursor);cursor=p.cursor.after;
 }
 assert.fail('catch-up failed to complete');
});

for(const maxRecords of [200,512])test(`skip preserves baseline success in nested ${maxRecords}-record contexts`,t=>{
 const {s,key,after}=fixture(t,true);let successes=0;
 for(const precharged of [0,20,50,100,140]){
  const run=skip=>{try{return {page:s.readTransaction(()=>withCurrentReadContext(s.db,'commons',b=>{
   chargeCurrentReadBudget(b,4096,precharged);
   return readCurrentNativeInbox(s,key,'commons',{after,limit:20,skipUnaddressed:skip});
  },{maxRecords}))};}catch(error){return {code:error.code};}};
  const full=run(false),optimized=run(true);
  if(full.page){successes++;assert.ok(optimized.page,JSON.stringify({precharged,error:optimized.code}));assert.deepEqual(optimized.page.directMessages,full.page.directMessages);assert.ok(optimized.page.cursor.after>=full.page.cursor.after);}
  else assert.equal(optimized.code,full.code);
 }
 assert.ok(successes>0);
});
test('catch-up continuation rechecks revoked membership and never acknowledges attention',t=>{
 const {s,key,after}=fixture(t,false),owner=s.issueAccessKey('commons','owner');
 const page=s.agentInbox(key,'commons',{after,limit:20});assert.equal(page.attention.acknowledges,false);assert.equal(page.cursor.hasMore,true);
 s.command(owner,'commons',{id:'remove-worker',type:'member.access_changed',data:{memberId:'worker',active:false,expectedMemberRevision:0,permissions:[]}});
 for(const skipUnaddressed of [false,true])assert.throws(()=>readCurrentNativeInbox(s,key,'commons',{after:page.cursor.after,skipUnaddressed}),error=>[401,403].includes(error.status));
});
