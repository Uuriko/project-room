import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {auditRecovery} from '../server/recovery.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
import {withCurrentRoomWriter} from '../server/current-room-repository.mjs';
function setup(t) {
 let now=1000; const s=new RoomStore(':memory:',{now:()=>now});t.after(()=>s.close());
 const es=initialRoom();for(const id of ['alice','bob','other'])es.push(event({roomId:'commons',actorId:'owner',type:'member.added',data:{memberId:id,displayName:id,kind:'agent',permissions:[]}}));
 es.push(event({roomId:'commons',actorId:'alice',type:'message.posted',data:{messageId:'dm',toMemberId:'bob',body:'private'}}));
 s.initialize(es,{representation:'normalized-current-v1'});
 const keys=Object.fromEntries(['owner','alice','bob','other'].map(id=>[id,s.issueAccessKey('commons',id)]));
 s.room=()=>{throw Error('legacy full room hydration');};
 const seed=(id,state='staged',messageId=null)=>s.transaction(()=>withCurrentRoomWriter(s.db,'commons',()=>s.db.prepare("INSERT INTO room_attachments VALUES('commons',?,'alice','f.txt','text/plain',1,?,? ,?,1,2000,?)").run(id,'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb',Buffer.from('a'),state,messageId)));
 return{s,keys,seed,time:v=>now=v};
}
test('normalized expiry clears staged bytes only under the existing guard',t=>{
 const{s,seed,time}=setup(t);seed('staged');seed('committed','committed','dm');time(3000);
 s.transaction(()=>s.roomAttachments.expire('commons',3000));
 assert.deepEqual({...s.db.prepare("SELECT state,bytes FROM room_attachments WHERE id='staged'").get()},{state:'expired',bytes:null});
 assert.equal(s.db.prepare("SELECT state FROM room_attachments WHERE id='committed'").get().state,'committed');
});
test('normalized uploader delete preserves DM privacy and stable retry without full room hydration',t=>{
 const{s,keys,seed}=setup(t);seed('private','committed','dm');
 assert.throws(()=>s.roomAttachments.discard(keys.other,'commons','private'),e=>e.status===404);
 assert.throws(()=>s.roomAttachments.discard(keys.owner,'commons','private'),e=>e.status===404);
 assert.equal(s.roomAttachments.discard(keys.alice,'commons','private').status,'deleted');
 assert.equal(s.roomAttachments.discard(keys.alice,'commons','private').duplicate,true);
 assert.throws(()=>s.roomAttachments.get(keys.other,'commons','private'),e=>e.status===404);
 assert.throws(()=>s.roomAttachments.get(keys.bob,'commons','private'),e=>e.status===410);
});
test('normalized upload and commit retain permission rules and raw old writer refuses',t=>{
 const{s,keys}=setup(t);const file={id:'new',filename:'f.txt',mediaType:'text/plain',data:'YQ=='};
 assert.equal(s.roomAttachments.stage(keys.alice,'commons',file).status,'staged');
 assert.equal(s.roomAttachments.stage(keys.alice,'commons',file).duplicate,true);
 assert.throws(()=>s.roomAttachments.commit(keys.bob,'commons',{id:'new',messageId:'dm'}),e=>e.status===403);
 assert.equal(s.roomAttachments.commit(keys.alice,'commons',{id:'new',messageId:'dm'}).status,'committed');
 assert.equal(s.roomAttachments.commit(keys.alice,'commons',{id:'new',messageId:'dm'}).duplicate,true);
 assert.throws(()=>s.db.prepare("UPDATE room_attachments SET bytes=NULL WHERE id='new'").run(),/unsupported current room writer/);
});
test('attachment changes and immutable admissions roll back together after interrupted save',t=>{
 const{s,keys,seed}=setup(t);seed('fault','committed','dm');
 const before=s.db.prepare('SELECT count(*) n FROM operator_actions').get().n;
 const original=s.db.prepare.bind(s.db);
 s.db.prepare=sql=>{const stmt=original(sql);if(sql.startsWith("UPDATE room_attachments SET state='deleted'")){const run=stmt.run.bind(stmt);stmt.run=(...args)=>{run(...args);throw Error('synthetic interrupted attachment save');};}return stmt;};
 assert.throws(()=>s.roomAttachments.discard(keys.alice,'commons','fault'),/synthetic interrupted/);
 s.db.prepare=original;
 assert.equal(s.db.prepare('SELECT count(*) n FROM operator_actions').get().n,before);
 assert.equal(s.db.prepare("SELECT state FROM room_attachments WHERE id='fault'").get().state,'committed');
 assert.equal(s.db.prepare('SELECT enabled FROM current_room_writer_permit').get().enabled,0);
 assert.equal(s.roomAttachments.discard(keys.alice,'commons','fault').status,'deleted');
});
test('fresh readonly tier still denies normalized file changes',t=>{
 const{s,keys,seed}=setup(t);seed('held');
 s.db.prepare("INSERT INTO agent_autonomy_tiers VALUES('commons','alice','t1_readonly',1,'owner')").run();
 assert.throws(()=>s.roomAttachments.discard(keys.alice,'commons','held'),e=>e.code==='agent_readonly');
 assert.throws(()=>s.roomAttachments.stage(keys.alice,'commons',{id:'new',filename:'f.txt',mediaType:'text/plain',data:'YQ=='}),e=>e.code==='agent_readonly');
 assert.throws(()=>s.roomAttachments.commit(keys.alice,'commons',{id:'held',messageId:'dm'}),e=>e.code==='agent_readonly');
});
import {planAccountDeletion,executeAccountDeletion} from '../server/account-deletion.mjs';
for(const normalized of [false,true])test(`account erasure ${normalized?'clears normalized attachment bytes':'rolls back an attachment storage fault'}`,t=>{
 const s=new RoomStore(':memory:');t.after(()=>s.close());const es=initialRoom();es[0].data.kind='personal';s.initialize(es,normalized?{representation:'normalized-current-v1'}:undefined);
 const key=s.issueAccessKey('commons','owner');s.roomAttachments.stage(key,'commons',{id:'held',filename:'f.txt',mediaType:'text/plain',data:'YQ=='});
 const accountId=s.db.prepare("SELECT account_id FROM member_accounts WHERE room_id='commons' AND member_id='owner'").get().account_id;
 s.initialize(initialRoom('survivor'),{representation:'normalized-current-v1'});const survivorKey=s.issueAccessKey('survivor','owner'),survivorId=s.accountForMember('survivor','owner').id,survivor=s.account(survivorId),survivorCredentials=s.db.prepare("SELECT * FROM credentials WHERE room_id='survivor'").all();
 const {plan}=planAccountDeletion(s,accountId),before=s.db.prepare('SELECT * FROM accounts WHERE id=?').get(accountId);
 assert.ok(plan.rooms.archive.some(r=>r.id==='commons'));
 const prepare=s.db.prepare.bind(s.db);
 if(!normalized)s.db.prepare=sql=>{if(sql.includes("UPDATE room_attachments SET state='deleted', bytes=NULL, filename='purged'"))throw Error('synthetic attachment storage failure');return prepare(sql);};
 if(normalized)executeAccountDeletion(s,plan);else assert.throws(()=>executeAccountDeletion(s,plan),/synthetic attachment storage failure/);
 s.db.prepare=prepare;assert.deepEqual(s.account(survivorId),survivor);assert.deepEqual(s.db.prepare("SELECT * FROM credentials WHERE room_id='survivor'").all(),survivorCredentials);assert.equal(s.authenticate(survivorKey,'survivor').member.id,'owner');
 if(normalized){assert.equal(s.account(accountId).active,false);assert.deepEqual({...s.db.prepare("SELECT state,bytes,filename FROM room_attachments WHERE id='held'").get()},{state:'deleted',bytes:null,filename:'purged'});assert.doesNotThrow(()=>auditRecovery(s));return;}
 assert.deepEqual(s.db.prepare('SELECT * FROM accounts WHERE id=?').get(accountId),before);
 assert.equal(s.db.prepare("SELECT state FROM room_attachments WHERE id='held'").get().state,'staged');
 assert.equal(s.db.prepare("SELECT length(bytes) n FROM room_attachments WHERE id='held'").get().n,1);
});
