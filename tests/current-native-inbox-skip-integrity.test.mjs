import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
import {readCurrentNativeInbox} from '../server/current-native-inbox.mjs';
import {withCurrentRoomWriter} from '../server/current-room-repository.mjs';
// Raw storage corruption: writes bypass every proof update, as a damaged or
// tampered database would.
const raw=(s,sql,...args)=>s.transaction(()=>withCurrentRoomWriter(s.db,'commons',()=>s.db.prepare(sql).run(...args)));

// The skip may only remove empty pages. For every tampering below, catch-up
// with skipUnaddressed must surface exactly what the full verified reader
// surfaces, or fail with the same error. It must never complete without an
// addressed event that the full reader would deliver or reject.
function build(path=':memory:'){
 const events=initialRoom(),add=(type,data,actorId='owner')=>events.push(event({roomId:'commons',actorId,type,data}));
 for(const id of ['worker','other'])add('member.added',{memberId:id,displayName:id,kind:'agent',permissions:[]});
 const after=events.length;
 add('message.posted',{messageId:'own',body:'Worker asks'},'worker');
 for(let i=0;i<30;i++)add('message.posted',{messageId:'noise-'+i,body:'Unrelated '+i});
 add('message.posted',{messageId:'secret',body:'Not for worker',toMemberId:'other'});
 add('message.posted',{messageId:'dm',body:'For worker',toMemberId:'worker'},'other');
 for(let i=0;i<20;i++)add('message.posted',{messageId:'more-'+i,body:'More '+i},'other');
 add('message.posted',{messageId:'reply',body:'Answer',replyToId:'own'},'other');
 add('work.proposed',{workItemId:'big',title:'Big',definitionOfDone:'Saved',accountableMemberId:'other'});
 for(let i=0;i<10;i++)add('message.posted',{messageId:'tail-'+i,body:'Tail '+i});
 const s=new RoomStore(path);s.initialize(events,{representation:'normalized-current-v1'});
 // Pad one non-message event past the skip's per-event byte bound.
 raw(s,"UPDATE events SET body=json_set(body,'$.data.pad',?) WHERE room_id='commons' AND json_extract(body,'$.data.workItemId')='big'",'x'.repeat(6000));
 return {s,after};
}
function drain(s,key,after,skipUnaddressed){
 const ids=[];let cursor=after,calls=0,skipped=0,examined=0;
 try{
  for(;calls<60;){
   const page=readCurrentNativeInbox(s,key,'commons',{limit:20,after:cursor,skipUnaddressed});calls++;
   for(const x of [...page.directMessages,...page.directMentions,...page.replies])ids.push(x.messageId);
   skipped+=page.coverage.conversation.skippedUnaddressed??0;examined+=page.coverage.conversation.examined;
   if(!page.cursor.hasMore)return {ids:[...new Set(ids)].sort(),calls,skipped,examined,complete:true};
   assert.ok(page.cursor.after>cursor,'cursor must advance');cursor=page.cursor.after;
  }
  return {ids:[...new Set(ids)].sort(),calls,skipped,examined,complete:false};
 }catch(error){return {error:error.code??String(error.message).slice(0,60),ids:[...new Set(ids)].sort()};}
}
function parity(t,tamper,check=()=>{}){
 const {s,after}=build();t.after(()=>s.close());
 const key=s.issueAccessKey('commons','worker');tamper(s);
 const full=drain(s,key,after,false),fast=drain(s,key,after,true);
 // Same failure, if any. Without a failure, exactly the same items. With one,
 // the skip may reach it later, so it may have delivered more first, never less.
 assert.equal(fast.error,full.error);
 if(full.error===undefined)assert.deepEqual(fast.ids,full.ids);
 else assert.ok(full.ids.every(id=>fast.ids.includes(id)),`fast ${fast.ids} must include full ${full.ids}`);
 check(full,fast);
 return {full,fast};
}
const eventSeq=(s,messageId)=>s.db.prepare("SELECT sequence FROM events WHERE room_id='commons' AND json_extract(body,'$.data.messageId')=?").get(messageId).sequence;
const eventId=(s,messageId)=>s.db.prepare("SELECT id FROM events WHERE room_id='commons' AND json_extract(body,'$.data.messageId')=?").get(messageId).id;

test('baseline: same items as the full reader, fewer calls, honest accounting',t=>{
 parity(t,()=>{},(full,fast)=>{
  assert.deepEqual(full.ids,['dm','reply']);assert.equal(fast.complete,true);
  assert.ok(fast.calls<full.calls,`fast ${fast.calls} vs full ${full.calls}`);assert.ok(fast.skipped>0);
  assert.ok(fast.examined<full.examined,'skipped events are not counted as examined');
 });
});
test('DM recipient changed only in the messages projection is not silently skipped',t=>{
 parity(t,s=>raw(s,"UPDATE messages SET to_member_id='other' WHERE room_id='commons' AND message_id='dm'"));
});
test('DM recipient changed only in the event log is not silently skipped',t=>{
 parity(t,s=>raw(s,"UPDATE events SET body=json_set(body,'$.data.toMemberId','other') WHERE room_id='commons' AND sequence=?",eventSeq(s,'dm')));
});
test('parent author changed in the messages projection does not hide a reply',t=>{
 parity(t,s=>raw(s,"UPDATE messages SET author_id='other' WHERE room_id='commons' AND message_id='own'"));
});
test('reply target changed in the event log does not hide a reply',t=>{
 parity(t,s=>raw(s,"UPDATE events SET body=json_set(body,'$.data.replyToId','noise-0') WHERE room_id='commons' AND sequence=?",eventSeq(s,'reply')));
});
test('tampered protected witness header fails the same way as the full reader',t=>{
 parity(t,s=>raw(s,"UPDATE current_room_records SET payload=replace(payload,'\"to_member_id\":\"worker\"','\"to_member_id\":\"other\"') WHERE room_id='commons' AND domain='messageWitness' AND record_key='dm'"));
});
test('missing witness record fails the same way as the full reader',t=>{
 parity(t,s=>raw(s,"DELETE FROM current_room_records WHERE room_id='commons' AND domain='messageWitness' AND record_key='dm'"));
});
test('mention state removed or moved: same result as the full reader (shared pre-existing trust)',t=>{
 const {s,after}=build();t.after(()=>s.close());const key=s.issueAccessKey('commons','worker');
 s.command(s.issueAccessKey('commons','owner'),'commons',{id:'ping',type:'message.posted',data:{messageId:'ping',body:'@worker please look'}});
 const id=eventId(s,'ping');
 assert.deepEqual(drain(s,key,after,true).ids,drain(s,key,after,false).ids);
 assert.ok(drain(s,key,after,true).ids.includes('ping'));
 raw(s,"UPDATE mention_states SET mentioned_member_id='other' WHERE room_id='commons' AND message_event_id=?",id);
 assert.deepEqual(drain(s,key,after,true).ids,drain(s,key,after,false).ids);
 raw(s,"DELETE FROM mention_states WHERE room_id='commons' AND message_event_id=?",id);
 assert.deepEqual(drain(s,key,after,true).ids,drain(s,key,after,false).ids);
});
test('private messages to others and oversized events never change the result',t=>{
 parity(t,()=>{},(full,fast)=>{assert.equal(fast.ids.includes('secret'),false);assert.equal(full.ids.includes('secret'),false);});
});
test('cold restart: a file store reopened mid catch-up continues with the same result',t=>{
 const dir=mkdtempSync(join(tmpdir(),'inbox-skip-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const path=join(dir,'room.db');let {s,after}=build(path);const key=s.issueAccessKey('commons','worker');
 const first=readCurrentNativeInbox(s,key,'commons',{limit:20,after,skipUnaddressed:true});s.close();
 s=new RoomStore(path);t.after(()=>s.close());
 const rest=drain(s,key,first.cursor.after,true),full=drain(s,key,after,false);
 const ids=[...new Set([...first.directMessages,...first.replies].map(x=>x.messageId).concat(rest.ids))].sort();
 assert.deepEqual(ids,full.ids);
});
for(const corruptIndex of [3,5])test(`optional skip preserves a verified DM before corrupt witness ${corruptIndex}`,t=>{
 const s=new RoomStore(':memory:');t.after(()=>s.close());
 const events=initialRoom(),add=(messageId,toMemberId)=>events.push(event({roomId:'commons',actorId:'owner',type:'message.posted',data:{messageId,body:messageId,...(toMemberId?{toMemberId}:{})}}));
 events.push(event({roomId:'commons',actorId:'owner',type:'member.added',data:{memberId:'worker',displayName:'Worker',kind:'agent',permissions:[]}}));
 const after=events.length;add('useful-dm','worker');for(let i=0;i<6;i++)add('later-'+i);
 s.initialize(events,{representation:'normalized-current-v1'});const key=s.issueAccessKey('commons','worker');
 raw(s,"UPDATE current_room_records SET payload=json_set(payload,'$.entityHash','corrupt') WHERE room_id='commons' AND domain='messageWitness' AND record_key=?",'later-'+corruptIndex);
 const full=readCurrentNativeInbox(s,key,'commons',{after,skipUnaddressed:false});
 assert.deepEqual(full.directMessages.map(x=>x.messageId),['useful-dm']);
 const fast=readCurrentNativeInbox(s,key,'commons',{after,skipUnaddressed:true});
 assert.deepEqual(fast.directMessages,full.directMessages);assert.equal(fast.cursor.after,full.cursor.after+corruptIndex-3);assert.equal(fast.cursor.hasMore,true);assert.equal(fast.coverage.conversation.skippedUnaddressed,corruptIndex-3);
 const fails=skipUnaddressed=>{try{readCurrentNativeInbox(s,key,'commons',{after:fast.cursor.after,skipUnaddressed});assert.fail('verified corruption must refuse');}catch(error){assert.match(error.message,/current_room_corrupt/);return error.message;}};
 assert.equal(fails(true),fails(false));
});
