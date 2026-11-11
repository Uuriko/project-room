import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
import {withCurrentRoomWriter} from '../server/current-room-repository.mjs';
import {configureInboxSkipDiagnostics,readInboxSkipDiagnostics,recordInboxSkipStop,INBOX_SKIP_STOP_REASONS} from '../server/inbox-skip-diagnostics.mjs';

const now=1793740000000,at=new Date(now).toISOString();
function fixture(t,{mode='window',body='alpha',recipient='other'}={}){
 const s=new RoomStore(':memory:',{now:()=>now});t.after(()=>s.close());
 const events=initialRoom().map((e,i)=>({...e,id:'initial-'+i,at}));
 const add=(type,data,actorId='owner')=>events.push(event({id:'event-'+events.length,at,roomId:'commons',actorId,type,data}));
 for(const id of ['worker','other','third'])add('member.added',{memberId:id,displayName:id,kind:'agent',permissions:[]});
 add('message.posted',{messageId:'parent',body:'Earlier source'},'other');
 const after=events.length;
 add('message.posted',{messageId:'useful',body:'Useful private ask',toMemberId:'worker'});
 for(let i=0;i<3;i++)add('message.posted',{messageId:'first-'+i,body,toMemberId:recipient});
 if(mode==='addressed')add('message.posted',{messageId:'tail',body:'Next useful ask',toMemberId:'worker'});
 else if(mode==='row_bound')add('message.posted',{messageId:'tail',body:'x'.repeat(5000)});
 else if(mode==='parent_unverified')add('message.posted',{messageId:'tail',body:'Unrelated reply',replyToId:'parent'});
 else for(let i=0;i<(mode==='budget'?64:2);i++)add('message.posted',{messageId:'tail-'+i,body,toMemberId:recipient});
 s.initialize(events,{representation:'normalized-current-v1'});const key=s.issueAccessKey('commons','worker');
 if(mode==='parent_unverified')s.transaction(()=>withCurrentRoomWriter(s.db,'commons',()=>s.db.prepare("DELETE FROM current_room_records WHERE room_id='commons' AND domain='messageWitness' AND record_key='parent'").run()));
 if(mode==='error')s.transaction(()=>withCurrentRoomWriter(s.db,'commons',()=>s.db.prepare("UPDATE current_room_records SET payload=json_set(payload,'$.entityHash','damaged') WHERE room_id='commons' AND domain='messageWitness' AND record_key='tail-0'").run()));
 s.room=()=>{throw Error('whole-room hydration');};
 return{s,read:()=>s.agentInbox(key,'commons',{after,limit:20})};
}

test('private aggregate cadence has fixed fields, rejects labels and separates database lifetimes',()=>{
 const db={},other={},logs=[];configureInboxSkipDiagnostics(db,{emit:entry=>logs.push(entry)});
 for(let i=0;i<63;i++)recordInboxSkipStop(db,INBOX_SKIP_STOP_REASONS[i%6]);
 assert.deepEqual(logs,[]);recordInboxSkipStop(db,'error');assert.equal(logs.length,1);
 assert.deepEqual(Object.keys(logs[0]),['event','version','attempts','stops']);
 assert.deepEqual(Object.keys(logs[0].stops),INBOX_SKIP_STOP_REASONS);assert.equal(logs[0].attempts,64);
 assert.equal(Object.values(logs[0].stops).reduce((a,b)=>a+b,0),64);
 recordInboxSkipStop(db,'private-room-id');assert.equal(readInboxSkipDiagnostics(db).attempts,64);
 assert.deepEqual(readInboxSkipDiagnostics(other),{attempts:0,stops:Object.fromEntries(INBOX_SKIP_STOP_REASONS.map(k=>[k,0]))});
 for(let i=0;i<10000;i++)recordInboxSkipStop(db,'window');
 assert.equal(logs.length,Math.floor(10064/64));assert.equal(readInboxSkipDiagnostics(db).attempts,10064);
 assert.ok(logs.every(entry=>JSON.stringify(entry).length<256));
});

test('diagnostics and a throwing private observer cannot change inbox bytes or write storage',t=>{
 const {s,read}=fixture(t),logs=[];
 configureInboxSkipDiagnostics(s.db,{enabled:false,emit:()=>{throw Error('disabled observer');}});
 const expected=JSON.stringify(read()),before=s.db.prepare('SELECT total_changes() n').get().n;
 configureInboxSkipDiagnostics(s.db,{emit:entry=>{logs.push(entry);throw Error('operator sink failed');}});
 for(let i=0;i<64;i++)assert.equal(JSON.stringify(read()),expected);
 assert.equal(s.db.prepare('SELECT total_changes() n').get().n,before);
 assert.equal(logs.length,1);assert.equal(logs[0].attempts,64);assert.equal(logs[0].stops.window,64);
 assert.doesNotMatch(expected,/stopReason|parent_unverified|room.inbox_skip_stops/);
});

test('equivalent hidden same-shape bodies and routing preserve exact reader and aggregate bytes',t=>{
 const left=fixture(t,{body:'alpha',recipient:'other'}),right=fixture(t,{body:'bravo',recipient:'third'}),a=[],b=[];
 configureInboxSkipDiagnostics(left.s.db,{emit:x=>a.push(JSON.stringify(x))});
 configureInboxSkipDiagnostics(right.s.db,{emit:x=>b.push(JSON.stringify(x))});
 for(let i=0;i<64;i++)assert.equal(JSON.stringify(left.read()),JSON.stringify(right.read()));
 assert.deepEqual(a,b);assert.equal(a.length,1);
 assert.doesNotMatch(a[0],/alpha|bravo|other|third|commons|worker|event-|tail-|useful/);
});

for(const mode of INBOX_SKIP_STOP_REASONS)test('actual bounded skip records only aggregate '+mode,t=>{
 const {s,read}=fixture(t,{mode});configureInboxSkipDiagnostics(s.db,{emit:()=>{}});
 const result=read();assert.deepEqual(result.directMessages.map(x=>x.messageId),['useful']);
 const observed=readInboxSkipDiagnostics(s.db);assert.equal(observed.attempts,1);assert.equal(observed.stops[mode],1,JSON.stringify(observed));
 assert.equal(Object.values(observed.stops).reduce((a,b)=>a+b,0),1);
});
