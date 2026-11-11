import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createOperatorPurge } from '../server/operator-purge.mjs';
const tick=s=>s.verifyRoomIntegrity({yieldBetween:async()=>{}});
function fixture(t){const s=new RoomStore(':memory:');t.after(()=>s.close());s.initialize(initialRoom('alpha'));return s;}
function purge(s,id){const p=createOperatorPurge(s),plan=p.plan({targets:[{kind:'room',id}],reason:'Synthetic integrity qualification'},crypto.randomUUID());return p.execute({planId:plan.planId,confirmToken:plan.confirmToken},crypto.randomUUID());}
function corrupt(s,id){const row=s.db.prepare('SELECT projection FROM rooms WHERE id=?').get(id);const next=row.projection.replace('Commons','Xommons');assert.notEqual(next,row.projection);s.db.prepare('UPDATE rooms SET projection=? WHERE id=?').run(next,id);}
test('new room after highest-rowid purge is legitimate without relying on rowid monotonicity',async t=>{
 const s=fixture(t);s.initialize(initialRoom('last'));await tick(s);await tick(s);purge(s,'last');
 s.initialize(initialRoom('new-room'));const result=await tick(s);
 assert.equal(result.baselineUnverifiable,undefined);assert.equal(result.verified,1);assert.deepEqual(s.integrityFailures(),[]);
});
test('purging one room cannot replace the content baseline of a corrupt survivor',async t=>{
 const s=fixture(t);s.initialize(initialRoom('last'));await tick(s);await tick(s);
 const before=s.readIntegritySnapshot();corrupt(s,'alpha');purge(s,'last');
 assert.equal(s.readIntegritySnapshot(),before,'purge preserves the previously trusted baseline');
 const result=await tick(s);assert.equal(result.verified,0);assert.ok(s.integrityFailures().some(f=>f.recordId==='alpha'&&f.step==='projection_content'));
});
test('aggregate and per-room baseline publication roll back as one unit',async t=>{
 const s=fixture(t);await tick(s);await tick(s);const before=s.readIntegritySnapshot();s.initialize(initialRoom('beta'));
 const remember=s.rememberIntegrityRoomState;s.rememberIntegrityRoomState=()=>{throw Error('injected baseline state failure');};
 await assert.rejects(tick(s),/injected baseline state failure/);s.rememberIntegrityRoomState=remember;
 assert.equal(s.readIntegritySnapshot(),before,'aggregate cannot publish without its per-room proof');
 assert.equal((await tick(s)).verified,1);
});
test('canonical message bytes are covered when room metadata has no message array',async t=>{
 const s=fixture(t),key=s.issueAccessKey('alpha','owner');s.command(key,'alpha',{id:'post',type:'message.posted',data:{messageId:'m',body:'First body'}});
 while(!s.backfillMessages({limit:1000}).done){}s.checkMessagesParity({roomId:'alpha'});s.migrateMessageAuthority('alpha');await tick(s);await tick(s);
 const before=s.integrityChecksum().text;
 s.db.prepare("UPDATE messages SET body='Other body',record_json=json_set(record_json,'$.body','Other body') WHERE room_id='alpha' AND message_id='m'").run();
 assert.notEqual(s.integrityChecksum().text,before,'equal-length canonical payload change must change content proof');
 const result=await tick(s);assert.equal(result.verified,0);assert.ok(s.integrityFailures().some(f=>f.recordId==='alpha'&&f.step==='projection_content'));
});

test('a failed new-room transaction cannot leave proof behind for the next room with that ID',async t=>{
 const s=fixture(t);await tick(s);await tick(s);
 assert.throws(()=>s.transaction(()=>{s.initialize(initialRoom('retry'));throw Error('abort creation');}),/abort creation/);
 assert.equal(s.db.prepare("SELECT 1 FROM integrity_room_state WHERE room_id='retry'").get(),undefined);
 s.initialize(initialRoom('retry'));assert.equal((await tick(s)).verified,1);
});
test('verified canonical conversion and reversal refresh only their own representation proof',async t=>{
 const s=fixture(t),key=s.issueAccessKey('alpha','owner');s.command(key,'alpha',{id:'post',type:'message.posted',data:{messageId:'m',body:'Original'}});
 while(!s.backfillMessages({limit:1000}).done){}s.checkMessagesParity({roomId:'alpha'});await tick(s);await tick(s);
 s.migrateMessageAuthority('alpha');assert.equal((await tick(s)).verified,1);assert.deepEqual(s.integrityFailures(),[]);
 s.migrateMessageAuthority('alpha',{reverse:true});assert.equal((await tick(s)).verified,1);assert.deepEqual(s.integrityFailures(),[]);
});

test('canonical work payloads are covered independently of their metadata reference',async t=>{
 const s=fixture(t),key=s.issueAccessKey('alpha','owner');s.command(key,'alpha',{id:'propose',type:'work.proposed',data:{workItemId:'w',title:'Work',definitionOfDone:'Evidence',mode:'read',accountableMemberId:'owner'}});
 await tick(s);await tick(s);const before=s.integrityChecksum().text;
 s.db.prepare("UPDATE work_entities SET body=replace(body,'Evidence','Tampered') WHERE room_id='alpha' AND work_id='w'").run();
 assert.notEqual(s.integrityChecksum().text,before);
 const result=await tick(s);assert.equal(result.verified,0);assert.ok(s.integrityFailures().some(f=>f.recordId==='alpha'&&f.step==='projection_content'));
});

test('purge then recreation of the same room ID establishes fresh scoped proof',async t=>{
 const s=fixture(t);s.initialize(initialRoom('repeat'));await tick(s);await tick(s);
 const old=s.db.prepare("SELECT projection_hash AS hash FROM integrity_room_state WHERE room_id='repeat'").get().hash;
 purge(s,'repeat');const replacement=initialRoom('repeat');replacement[0].data.title='Recreated room';s.initialize(replacement);
 const created=s.db.prepare("SELECT projection_hash AS hash FROM integrity_room_state WHERE room_id='repeat'").get().hash;
 assert.notEqual(created,old);assert.equal((await tick(s)).verified,1);assert.deepEqual(s.integrityFailures(),[]);
});

test('an unrelated valid event cannot certify earlier metadata corruption',async t=>{
 const s=fixture(t);await tick(s);await tick(s);corrupt(s,'alpha');const key=s.issueAccessKey('alpha','owner');
 try{s.command(key,'alpha',{id:'unrelated',type:'member.added',data:{memberId:'reader',displayName:'Reader',kind:'human',permissions:[]}});}catch(error){assert.match(error.message,/projection_corrupt|content|integrity/i);}
 const result=await tick(s);assert.equal(result.verified,0);assert.ok(s.integrityFailures().some(f=>f.recordId==='alpha'&&f.step==='projection_content'));
});
test('editing another canonical message cannot certify earlier payload corruption',async t=>{
 const s=fixture(t),key=s.issueAccessKey('alpha','owner');for(const id of ['first','second'])s.command(key,'alpha',{id,type:'message.posted',data:{messageId:id,body:'Original body'}});
 while(!s.backfillMessages({limit:1000}).done){}s.checkMessagesParity({roomId:'alpha'});s.migrateMessageAuthority('alpha');await tick(s);await tick(s);
 const original=s.db.prepare("SELECT body,record_json FROM messages WHERE room_id='alpha' AND message_id='first'").get();
 s.db.prepare("UPDATE messages SET body='Tampered body',record_json=json_set(record_json,'$.body','Tampered body') WHERE room_id='alpha' AND message_id='first'").run();
 try{s.command(key,'alpha',{id:'edit-other',type:'message.edited',data:{messageId:'second',body:'Valid edit',expectedMessageRevision:0}});}catch(error){assert.match(error.message,/projection_corrupt|content|integrity/i);}
 const result=await tick(s);assert.equal(result.verified,0);assert.ok(s.integrityFailures().some(f=>f.recordId==='alpha'&&f.step==='projection_content'));
 // Repair the independent damaged leaf without undoing the unrelated edit.
 s.db.prepare("UPDATE messages SET body=?,record_json=? WHERE room_id='alpha' AND message_id='first'").run(original.body,original.record_json);
 const repaired=await tick(s);assert.equal(repaired.matched || repaired.verified,1);
 assert.equal(s.integrityFailures().some(f=>f.recordId==='alpha'&&f.step==='projection_content'),false);
 assert.equal(s.room('alpha').state.messages.find(m=>m.id==='second').body,'Valid edit');
});

for (const target of ['retained','archived']) test(`canonical ${target} deletion cannot be adopted after an unrelated edit`,async t=>{
 const s=fixture(t),key=s.issueAccessKey('alpha','owner');
 for(const id of ['archived','retained','edit'])s.command(key,'alpha',{id,type:'message.posted',data:{messageId:id,body:id}});
 while(!s.backfillMessages({limit:1000}).done){}s.checkMessagesParity({roomId:'alpha'});
 s.archiveMessages('alpha',{keepNewest:2,dryRun:false});s.checkMessagesParity({roomId:'alpha'});s.migrateMessageAuthority('alpha');await tick(s);await tick(s);
 s.db.prepare("DELETE FROM messages WHERE room_id='alpha' AND message_id=?").run(target);
 s.command(key,'alpha',{id:'unrelated-edit',type:'message.edited',data:{messageId:'edit',body:'Changed',expectedMessageRevision:0}});
 const result=await tick(s);assert.equal(result.verified,0);
 assert.ok(s.integrityFailures().some(f=>f.recordId==='alpha'&&f.step==='projection_content'));
});
