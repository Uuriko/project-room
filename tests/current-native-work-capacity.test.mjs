import test from 'node:test';import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';import {initialRoom} from '../server/bootstrap.mjs';
import {currentWorkCapacity} from '../server/current-work-capacity.mjs';
import {boardClaimForWorkItem} from '../server/work-item-board.mjs';
import {countsTowardOpenCap,STALE_UNCLAIMED_DAYS} from '../server/work-claims.mjs';
import {readWorkItem} from '../server/work-repository.mjs';
import {textVersion} from '../server/text-results.mjs';
import {auditRecovery} from '../server/recovery.mjs';
const epoch=Date.parse('2026-01-01T00:00:00Z'),day=86400000;
test('native capacity index equals shared board cap semantics at dormancy and lease boundaries',()=>{
 for(const state of ['proposed','accepted','working','blocked','completed','superseded'])for(const leaseDays of [null,1,30]) {
  const item={id:'sample',title:'Task',definitionOfDone:'Saved',state,mode:'read',revision:1,createdAt:new Date(epoch).toISOString(),updatedAt:new Date(epoch).toISOString(),accountableMemberId:'owner',
   ...(leaseDays===null?{}:{claim:{status:'active',holderId:'owner',expiresAt:new Date(epoch+leaseDays*day).toISOString(),paths:[]}})};
  const capacity=currentWorkCapacity(item);
  for(const at of [epoch,epoch+STALE_UNCLAIMED_DAYS*day-1,epoch+STALE_UNCLAIMED_DAYS*day,epoch+30*day-1,epoch+30*day]) {
   const mapped=boardClaimForWorkItem(item,null,{nowMs:at}),expected=countsTowardOpenCap(mapped,at);
   assert.equal(capacity.open&&(capacity.until===null||capacity.until>at),expected,JSON.stringify({state,leaseDays,at,capacity}));
  }
 }
});
function fixture(t){const s=new RoomStore(':memory:');t.after(()=>s.close());let at=epoch;s.now=()=>at;s.initialize(initialRoom(),{representation:'normalized-current-v1'});const key=s.issueAccessKey('commons','owner',30*day);let serial=0;
 const send=(type,data,id='native-'+(++serial))=>s.command(key,'commons',{id,type,data});
 for(const id of ['a','b','c'])send('work.proposed',{workItemId:id,title:'Useful '+id,definitionOfDone:'Saved result',mode:'read',accountableMemberId:'owner'});
 s.room=()=>{throw Error('whole-room hydration');};s.workClaims.list=()=>{throw Error('whole legacy board scan');};s.workClaims.set=()=>{throw Error('legacy mirror write');};
 const snapshot=()=>JSON.stringify(Object.fromEntries(['rooms','events','commands','current_room_records','current_room_record_proofs','current_room_head','operator_actions','work_entities','work_claims'].map(table=>[table,s.db.prepare('SELECT * FROM '+table).all()])));
 return {s,send,key,setClock:value=>{at=value;},item:id=>readWorkItem(s.db,'commons',id),snapshot};
}
test('native accept retains room capacity and config changes atomically without mirror scans or writes',t=>{
 const f=fixture(t);f.s.workClaims.configure('commons',{maxOpenClaims:1});
 const command={workItemId:'a',expectedRevision:0};f.send('work.accepted',command,'accept-a');
 const before=f.snapshot();assert.throws(()=>f.send('work.accepted',{workItemId:'b',expectedRevision:0}),e=>e.code==='work_board_full');assert.equal(f.snapshot(),before);
 f.s.workClaims.configure('commons',{maxOpenClaims:2});f.send('work.accepted',{workItemId:'b',expectedRevision:0});
 const retryBefore=f.snapshot();assert.equal(f.send('work.accepted',command,'accept-a').duplicate,true);assert.equal(f.snapshot(),retryBefore);
 f.s.workClaims.configure('commons',{maxOpenClaims:1});f.send('work.started',{workItemId:'a',expectedRevision:f.item('a').revision});
 const body='Native saved result',post=f.send('message.posted',{messageId:'result',workItemId:'a',body});
 f.send('work.completed',{workItemId:'a',expectedRevision:f.item('a').revision,evidenceKind:'room_text',evidenceMessageId:'result',evidenceMessageEventId:post.event.id,evidenceVersion:textVersion(body),previousCompletionEventId:null,producerId:'owner',summary:'Saved',nextAction:'Review'});
 assert.equal(f.s.db.prepare('SELECT count(*) n FROM work_claims').get().n,0);assert.doesNotThrow(()=>auditRecovery(f.s));
});
test('dormant accepted work stops counting exactly at the shared current boundary',t=>{
 const f=fixture(t);f.s.workClaims.configure('commons',{maxOpenClaims:1});f.send('work.accepted',{workItemId:'a',expectedRevision:0});
 f.setClock(epoch+STALE_UNCLAIMED_DAYS*day-1);assert.throws(()=>f.send('work.accepted',{workItemId:'b',expectedRevision:0}),e=>e.code==='work_board_full');
 f.setClock(epoch+STALE_UNCLAIMED_DAYS*day);assert.doesNotThrow(()=>f.send('work.accepted',{workItemId:'b',expectedRevision:0}));
 assert.doesNotThrow(()=>auditRecovery(f.s));
});
