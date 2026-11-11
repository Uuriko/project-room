import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {RoomStore} from '../server/store.mjs';import {initialRoom} from '../server/bootstrap.mjs';
import {operatorNormalization} from '../server/operator-normalization.mjs';
import {auditRecovery} from '../server/recovery.mjs';
import {readCurrentMessage} from '../server/current-room-repository.mjs';
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'operator-direct-adopt-')),path=join(dir,'room.sqlite');let store=new RoomStore(path);store.initialize(initialRoom());const key=store.issueAccessKey('commons','owner');t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return {get store(){return store;},key,reopen(){store.close();store=new RoomStore(path);}};}
function adopt(store,discardLegacyAssignments=true){const plan=operatorNormalization(store,{roomId:'commons',discardLegacyAssignments});const input={roomId:'commons',discardLegacyAssignments,planHash:plan.planHash,requestId:'adopt-current-state',reason:'Synthetic explicit one-time adoption qualification'};return {input,result:operatorNormalization(store,input,true)};}
test('one-time operator adoption preserves current content and authority; cold post/work/retry uses small carrier',t=>{
 const f=fixture(t),s=f.store;
 s.command(f.key,'commons',{id:'source-post',type:'message.posted',data:{messageId:'source-post',body:'Saved useful message'}});
 s.command(f.key,'commons',{id:'source-task',type:'work.proposed',data:{workItemId:'task',title:'Useful existing task',definitionOfDone:'Save useful result',accountableMemberId:'owner',mode:'read'}});
 s.command(f.key,'commons',{id:'source-accept',type:'work.accepted',data:{workItemId:'task',expectedRevision:0}});
 const before=structuredClone(s.room('commons').state),credentials=s.db.prepare('SELECT * FROM credentials ORDER BY hash').all(),events=s.db.prepare('SELECT * FROM events ORDER BY sequence').all();
 const {input,result}=adopt(s);assert.equal(result.representation,'normalized-current-v1');assert.ok(result.projectionBytes<512);assert.deepEqual(s.db.prepare('SELECT * FROM credentials ORDER BY hash').all(),credentials);assert.deepEqual(s.db.prepare('SELECT * FROM events ORDER BY sequence').all(),events);
 assert.deepEqual(s.roomAuthority('commons').members,before.members);
 assert.equal(operatorNormalization(s,input,true).duplicate,true);
 f.reopen();const current=f.store;current.room=()=>{throw Error('unexpected full-room hydration');};
 const command={id:'fresh-post',type:'message.posted',data:{messageId:'fresh-post',body:'Fresh useful work'}};current.command(f.key,'commons',command);assert.equal(current.command(f.key,'commons',command).duplicate,true);
 current.command(f.key,'commons',{id:'start-task',type:'work.started',data:{workItemId:'task',expectedRevision:1}});
 assert.ok(current.db.prepare("SELECT octet_length(projection) bytes FROM rooms WHERE id='commons'").get().bytes<512);
});
test('failed adoption rolls back room/content/authority and exact retry succeeds',t=>{
 const {store:s,key}=fixture(t);s.command(key,'commons',{id:'post',type:'message.posted',data:{messageId:'post',body:'Unchanged'}});
 const plan=operatorNormalization(s,{roomId:'commons',discardLegacyAssignments:true}),request={roomId:'commons',discardLegacyAssignments:true,planHash:plan.planHash,requestId:'fault-adopt',reason:'Synthetic save fault'};
 const original=s.db.prepare.bind(s.db),before=s.db.prepare("SELECT * FROM rooms WHERE id='commons'").get();let fired=false;
 s.db.prepare=sql=>{const statement=original(sql);if(!/^INSERT INTO current_room_record_proofs VALUES/.test(sql))return statement;return new Proxy(statement,{get(target,name){if(name!=='run'){const value=Reflect.get(target,name,target);return typeof value==='function'?value.bind(target):value;}return(...args)=>{target.run(...args);fired=true;throw Error('injected initial proof save fault');};}});};
 assert.throws(()=>operatorNormalization(s,request,true),error=>error.status===500&&error.code==='normalization_failed'&&/entity_materialization: injected initial proof/.test(error.message));s.db.prepare=original;assert.equal(fired,true);assert.deepEqual(s.db.prepare("SELECT * FROM rooms WHERE id='commons'").get(),before);assert.equal(s.db.prepare('SELECT count(*) n FROM current_room_head').get().n,0);assert.equal(operatorNormalization(s,request,true).representation,'normalized-current-v1');
});
test('adopted archived canonical room passes unchanged independent full recovery oracle',t=>{
 const {store:s,key}=fixture(t);for(let i=0;i<8;i++)s.command(key,'commons',{id:'p'+i,type:'message.posted',data:{messageId:'p'+i,body:'Original '+i}});
 while(!s.backfillMessages({limit:200}).done){};s.checkMessagesParity({roomId:'commons'});
 // Existing public archive path, without manufacturing a target proof.
 s.archiveMessages('commons',{keepNewest:2,dryRun:false});
 adopt(s);assert.equal(auditRecovery(s).rooms,1);
});

for(const archived of [false,true])test(`adoption materializes erased reducer extras without restoring deleted text (archived=${archived})`,t=>{
 const f=fixture(t),s=f.store;
 s.command(f.key,'commons',{id:'deleted-post',type:'message.posted',data:{messageId:'deleted-post',body:'Private text to erase'}});
 s.command(f.key,'commons',{id:'deleted-edit',type:'message.edited',data:{messageId:'deleted-post',body:'Another erased version',expectedMessageRevision:0}});
 s.command(f.key,'commons',{id:'deleted-delete',type:'message.deleted',data:{messageId:'deleted-post',expectedMessageRevision:1}});
 assert.equal(s.db.prepare("SELECT reducer_extras_json FROM messages WHERE message_id='deleted-post'").get().reducer_extras_json,null);
 if(archived){s.command(f.key,'commons',{id:'later',type:'message.posted',data:{messageId:'later',body:'Retained'}});while(!s.backfillMessages({limit:200}).done){}s.checkMessagesParity({roomId:'commons'});s.archiveMessages('commons',{keepNewest:1,dryRun:false});}
 adopt(s);f.reopen();const message=f.store.readTransaction(()=>readCurrentMessage(f.store.db,'commons','deleted-post').value);
 assert.equal(message.body,null);assert.deepEqual(message.editHistory,[]);assert.equal(message.deletedBy,'owner');assert.equal(auditRecovery(f.store).rooms,1);
});
