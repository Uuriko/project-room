import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {RoomStore} from '../server/store.mjs';import {initialRoom} from '../server/bootstrap.mjs';import {event} from '../src/events.js';
import {operatorNormalization} from '../server/operator-normalization.mjs';
import {readCurrentMessage,withCurrentRoomWriter} from '../server/current-room-repository.mjs';
import {materializeCurrentMessageRows} from '../server/messages-store.mjs';import {auditRecovery} from '../server/recovery.mjs';
function seed(t,{edited=false,archived=false}={}){
 const directory=mkdtempSync(join(tmpdir(),'adopt-copy-')),path=join(directory,'room.sqlite');let store=new RoomStore(path);t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 const events=initialRoom(),append=(id,type,data)=>events.push(event({roomId:'commons',actorId:'owner',id,type,data}));
 for(let i=0;i<5;i++)append('prefix-'+i,'message.posted',{messageId:'prefix-'+i,body:'Old disposable history '+i});
 append('root','message.posted',{messageId:'root',body:'Thread root'});
 append('reply','message.posted',{messageId:'reply',replyToId:'root',alsoSendToChannel:true,body:'Public channel copy'});
 if(edited)append('edit-copy','message.edited',{messageId:'reply:channel',expectedMessageRevision:0,body:'Current independently edited copy'});
 store.initialize(events);const key=store.issueAccessKey('commons','owner');
 if(archived){while(!store.backfillMessages({limit:200}).done){}store.checkMessagesParity({roomId:'commons'});store.archiveMessages('commons',{keepNewest:2,dryRun:false});}
 const plan=operatorNormalization(store,{roomId:'commons',discardLegacyAssignments:true}),input={roomId:'commons',discardLegacyAssignments:true,planHash:plan.planHash,requestId:'adopt-copy',reason:'Synthetic derived-copy adoption'};
 return{get store(){return store;},key,input,parentSequence:events.findIndex(e=>e.id==='reply')+1,reopen(){store.close();store=new RoomStore(path);}};
}
for(const edited of [false,true])for(const archived of [false,true])test(`adopt legal derived public copy with exact parent sequence; cold+oracle (edited=${edited}, archived=${archived})`,t=>{
 const f=seed(t,{edited,archived}),before=f.store.room('commons').state.messages.find(m=>m.id==='reply:channel');
 if(edited)assert.throws(()=>auditRecovery(f.store),/Reply request history requires operator reconciliation/,'existing reply audit cannot replay edits of derived copies, before adoption too');
 const result=operatorNormalization(f.store,f.input,true);assert.equal(result.accountsAndConnectionsPreserved,true);assert.equal(result.certified,false);
 f.reopen();const copy=readCurrentMessage(f.store.db,'commons','reply:channel');assert.equal(copy.row.seq,f.parentSequence);assert.equal(copy.value.body,before.body);assert.equal(copy.value.replyToId,null);assert.equal(copy.value.toMemberId,null);
 assert.equal(operatorNormalization(f.store,f.input,true).duplicate,true);
 if(edited)assert.throws(()=>auditRecovery(f.store),/Reply request history requires operator reconciliation/,'preserve and expose the preexisting oracle defect');else assert.equal(auditRecovery(f.store).rooms,1);
 const command={id:'after-copy',type:'message.posted',data:{messageId:'after-copy',body:'Useful next result'}};f.store.command(f.key,'commons',command);assert.equal(f.store.command(f.key,'commons',command).duplicate,true);
});
test('derived-copy materialization and adoption receipt roll back together on interrupted proof save',t=>{
 const f=seed(t),prepare=f.store.db.prepare.bind(f.store.db),room=prepare("SELECT * FROM rooms WHERE id='commons'").get();
 f.store.db.prepare=sql=>{const statement=prepare(sql);if(!sql.startsWith('INSERT INTO current_room_record_proofs VALUES'))return statement;return new Proxy(statement,{get(target,key){if(key==='run')return(...args)=>{target.run(...args);throw Error('synthetic interrupted adoption proof');};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});};
 assert.throws(()=>operatorNormalization(f.store,f.input,true),/synthetic interrupted/);f.store.db.prepare=prepare;
 assert.deepEqual(prepare("SELECT * FROM rooms WHERE id='commons'").get(),room);assert.equal(prepare('SELECT count(*) n FROM messages').get().n,0);assert.equal(prepare('SELECT count(*) n FROM current_room_head').get().n,0);
 assert.equal(operatorNormalization(f.store,f.input,true).duplicate,false);
});
for(const kind of ['not-enabled','private','wrong-body','wrong-author','wrong-time','wrong-channel','nested-lookalike'])test('reject hostile derived-copy lookalike: '+kind,t=>{
 const f=seed(t),state=structuredClone(f.store.room('commons').state),copy=state.messages.find(m=>m.id==='reply:channel');
 // Synthetic source fault, not a production mutation bypass. Only the source
 // supplied to the materializer changes; the journal remains independently real.
 if(kind==='not-enabled'||kind==='private'){
  const source=f.store.db.prepare("SELECT body FROM events WHERE room_id='commons' AND id='reply'").get(),posting=JSON.parse(source.body);
  if(kind==='not-enabled')posting.data.alsoSendToChannel=false;else posting.data.toMemberId='owner';
  f.store.db.prepare("UPDATE events SET body=? WHERE room_id='commons' AND id='reply'").run(JSON.stringify(posting));
 }else if(kind==='wrong-body')copy.body='Unrelated forged text';else if(kind==='wrong-author')copy.authorId='other';else if(kind==='wrong-time')copy.createdAt='2000-01-01T00:00:00Z';else if(kind==='wrong-channel')copy.channelId='other';else copy.id='reply:channel:channel';
 assert.throws(()=>f.store.transaction(()=>withCurrentRoomWriter(f.store.db,'commons',()=>materializeCurrentMessageRows(f.store.db,'commons',state))),/Missing original message posting sequence|derived channel copy/);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM messages').get().n,0);
});
