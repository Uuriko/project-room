import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';
import {RoomStore}from'../server/store.mjs';import{initialRoom}from'../server/bootstrap.mjs';
import{operatorNormalization}from'../server/operator-normalization.mjs';import{MESSAGE_PROOF_FIELDS,messageProofMatches,projectionDigest}from'../server/write-integrity.mjs';
import{readCurrentMessage}from'../server/current-room-repository.mjs';
function fixture(t,{bodyRefs=false}={}){const dir=mkdtempSync(join(tmpdir(),'adopt-absent-')),path=join(dir,'room.sqlite');let s=new RoomStore(path,{bodiesAtRest:bodyRefs});t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});s.initialize(initialRoom());const key=s.issueAccessKey('commons','owner');
 for(const data of [{messageId:'root',body:bodyRefs?'r'.repeat(2048):'Independent inline root'},{messageId:'reply',replyToId:'root',alsoSendToChannel:true,body:'Public copied reply'}])s.command(key,'commons',{id:'post-'+data.messageId,type:'message.posted',data});
 s.db.prepare('UPDATE messages SET entity_hash=NULL WHERE room_id=?').run('commons');
 return{get s(){return s;},key,reopen(){s.close();s=new RoomStore(path,{bodiesAtRest:bodyRefs});}};}
const request=(s,mode=true)=>{const selection={roomId:'commons',discardLegacyAssignments:true,...(mode?{adoptAbsentInlineProofs:true}:{})},plan=operatorNormalization(s,selection);return{...selection,planHash:plan.planHash,requestId:'explicit-absent-adopt',reason:'Synthetic prospective proof adoption'};};
const refused=(fn,kind)=>assert.throws(fn,e=>e.code==='normalization_failed'&&e.message.includes('normalization_'+kind));
const snapshot=s=>JSON.stringify(Object.fromEntries(['rooms','messages','current_room_records','current_room_record_proofs','current_room_head','credentials','events','operator_actions'].map(table=>[table,s.db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()])));
for(const bodyRefs of [false,true])test(`explicit inline NULL proof adoption preserves serving fields, cold auth and exact retry (bodyRefs=${bodyRefs})`,t=>{
 const f=fixture(t,{bodyRefs}),before=f.s.db.prepare('SELECT * FROM messages ORDER BY message_id').all(),credentials=f.s.db.prepare('SELECT * FROM credentials ORDER BY hash').all();
 refused(()=>operatorNormalization(f.s,request(f.s,false),true),'message_proof_missing');
 const input=request(f.s),result=operatorNormalization(f.s,input,true);assert.equal(result.historyProvenance,'unknown');assert.equal(result.certified,false);assert.equal(result.adoptAbsentInlineProofs,true);
 const after=f.s.db.prepare('SELECT * FROM messages ORDER BY message_id').all();assert.ok(after.every(messageProofMatches));for(let i=0;i<after.length;i++)for(const field of MESSAGE_PROOF_FIELDS)assert.equal(after[i][field],before[i][field],field);
 assert.deepEqual(f.s.db.prepare('SELECT * FROM credentials ORDER BY hash').all(),credentials);
 f.reopen();assert.equal(operatorNormalization(f.s,input,true).duplicate,true);assert.equal(readCurrentMessage(f.s.db,'commons','reply:channel').value.body,'Public copied reply');
 const command={id:'new-post',type:'message.posted',data:{messageId:'new-post',body:'Next useful result'}};f.s.command(f.key,'commons',command);assert.equal(f.s.command(f.key,'commons',command).duplicate,true);
});
for(const field of MESSAGE_PROOF_FIELDS)test('absent proof cannot repair changed '+field,t=>{
 const f=fixture(t),row=f.s.db.prepare("SELECT * FROM messages WHERE message_id='root'").get();const value=field==='seq'?row.seq+1:field==='pinned'?1:field==='record_json'||field==='reducer_extras_json'||field==='reactions_json'?'{"untrusted":true}':'synthetic-changed';
 assert.notEqual(value,row[field],'fixture must actually change '+field);f.s.db.prepare('UPDATE messages SET '+field+'=? WHERE room_id=? AND message_id=?').run(value,'commons','root');const before=snapshot(f.s);
 refused(()=>operatorNormalization(f.s,request(f.s),true),field==='message_id'?'absent_proof_source_unavailable':'absent_proof_fields_mismatch');assert.equal(snapshot(f.s),before);
});
for(const hash of ['', 'bad', '0'.repeat(64)])test('non-null invalid proof never becomes adoption authority '+hash.length,t=>{const f=fixture(t);f.s.db.prepare("UPDATE messages SET entity_hash=? WHERE message_id='root'").run(hash);const before=snapshot(f.s);refused(()=>operatorNormalization(f.s,request(f.s),true),'message_proof_mismatch');assert.equal(snapshot(f.s),before);});
for(const field of ['record_json','reducer_extras_json'])test('shadowed JSON keys refused in '+field,t=>{
 const f=fixture(t);
 if(field==='reducer_extras_json'){f.s.command(f.key,'commons',{id:'edit-for-extras',type:'message.edited',data:{messageId:'root',body:'Current edited root',expectedMessageRevision:0}});f.s.db.prepare("UPDATE messages SET entity_hash=NULL WHERE message_id='root'").run();}
 const row=f.s.db.prepare('SELECT '+field+' AS value FROM messages WHERE message_id=?').get('root'),key=field==='record_json'?'id':'editHistory';
 const value='{'+JSON.stringify(key)+':null,'+row.value.slice(1);
 assert.deepEqual(JSON.parse(value),JSON.parse(row.value),'JSON.parse alone must hide this duplicated field');
 f.s.db.prepare('UPDATE messages SET '+field+'=? WHERE message_id=?').run(value,'root');const before=snapshot(f.s);refused(()=>operatorNormalization(f.s,request(f.s),true),'absent_proof_fields_mismatch');assert.equal(snapshot(f.s),before);
});
test('uncovered archived-side NULL row cannot certify itself',t=>{const f=fixture(t),row=f.s.db.prepare("SELECT * FROM messages WHERE message_id='root'").get();f.s.db.prepare('INSERT INTO messages(room_id,'+MESSAGE_PROOF_FIELDS.join(',')+',entity_hash) VALUES('+Array(MESSAGE_PROOF_FIELDS.length+2).fill('?').join(',')+')').run('commons',...MESSAGE_PROOF_FIELDS.map(field=>field==='message_id'?'uncovered-archived-row':row[field]),null);const before=snapshot(f.s);refused(()=>operatorNormalization(f.s,request(f.s),true),'absent_proof_source_unavailable');assert.equal(snapshot(f.s),before);});
test('a corrupt proved neighbor prevents all missing-proof writes',t=>{const f=fixture(t);f.s.db.prepare("UPDATE messages SET entity_hash=? WHERE message_id='reply'").run('0'.repeat(64));const before=snapshot(f.s);refused(()=>operatorNormalization(f.s,request(f.s),true),'message_proof_mismatch');assert.equal(snapshot(f.s),before);});
test('missing body reference refuses without log replay or proof replacement',t=>{const f=fixture(t,{bodyRefs:true});f.s.db.prepare('UPDATE projection_bodies SET body=?').run('not-the-hashed-body');const before=snapshot(f.s);refused(()=>operatorNormalization(f.s,request(f.s),true),'absent_proof_source_unavailable');assert.equal(snapshot(f.s),before);});
test('proof adoption and normalized publication roll back atomically on proof save fault',t=>{const f=fixture(t),input=request(f.s),before=snapshot(f.s),prepare=f.s.db.prepare.bind(f.s.db);f.s.db.prepare=sql=>{const statement=prepare(sql);if(!sql.startsWith('INSERT INTO current_room_record_proofs VALUES'))return statement;return new Proxy(statement,{get(target,key){if(key==='run')return(...args)=>{target.run(...args);throw Error('synthetic interrupted publication');};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});};assert.throws(()=>operatorNormalization(f.s,input,true),/synthetic interrupted/);f.s.db.prepare=prepare;assert.equal(snapshot(f.s),before);assert.equal(operatorNormalization(f.s,input,true).duplicate,false);});
test('a real archived message missing its proof has no inline adoption authority',t=>{
 const s=new RoomStore(':memory:');t.after(()=>s.close());s.initialize(initialRoom());const key=s.issueAccessKey('commons','owner');for(let i=0;i<5;i++)s.command(key,'commons',{id:'archive-post-'+i,type:'message.posted',data:{messageId:'archive-post-'+i,body:'Archived useful result '+i}});
 while(!s.backfillMessages({limit:200}).done){}s.checkMessagesParity({roomId:'commons'});s.archiveMessages('commons',{keepNewest:1,dryRun:false});assert.ok(s.room('commons').state.messagesArchive.count>0);
 s.db.prepare('UPDATE messages SET entity_hash=NULL WHERE message_id=?').run('archive-post-0');const before=snapshot(s);refused(()=>operatorNormalization(s,request(s),true),'absent_proof_source_unavailable');assert.equal(snapshot(s),before);
});
for(const kind of ['entity','authority','duplicate-projection'])test('independent source cannot be circular or shadowed: '+kind,t=>{
 const f=fixture(t),row=f.s.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get();let raw=JSON.parse(row.projection);
 if(kind==='entity')raw.messages=raw.messages.map(message=>({id:message.id,_entity:1}));else if(kind==='authority')raw.messageAuthority={version:1,count:raw.messages.length};
 let text=JSON.stringify(raw);if(kind==='duplicate-projection')text=text.replace('"messages":','"messages":[],"messages":');
 // Explicit synthetic independent-source fault: even a matching metadata hash
 // must not let a circular entity reference or duplicate field authorize rows.
 f.s.db.prepare("UPDATE rooms SET projection=? WHERE id='commons'").run(text);f.s.db.prepare("UPDATE integrity_room_state SET metadata_hash=? WHERE room_id='commons'").run(projectionDigest(text));
 const before=snapshot(f.s);assert.throws(()=>operatorNormalization(f.s,request(f.s),true));assert.equal(snapshot(f.s),before);
});
