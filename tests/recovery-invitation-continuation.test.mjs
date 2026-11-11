import test from 'node:test';import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {exportNdjsonText} from '../server/room-export.mjs';
import {operatorRestoreResponse} from '../server/restore-ndjson.mjs';
import {restoreProgress,withRestoreTransaction,withRestoreAuditRows} from '../server/restore-admission.mjs';
import {initialRecoveryInvitations,advanceRecoveryInvitations} from '../server/recovery-invitation-continuation.mjs';
import {seedRecoveryInvitationSource,seedRecoveryInvitationRecords,rebindRecoveryInvitee} from './helpers/recovery-invitation-source.mjs';
const credential='synthetic-independent-invitation-restore';
async function post(store,body){const r=await operatorRestoreResponse(new Request('https://room.example/api/operator/restore',{method:'POST',headers:{authorization:'Bearer '+credential,...(typeof body==='string'?{}:{'content-type':'application/json'})},body:typeof body==='string'?body:JSON.stringify(body)}),credential,store);return{status:r.status,body:await r.json()};}
async function fixture(t,options){const source=new RoomStore(':memory:');t.after(()=>source.close());let seeded;if(options?.legacy){source.initialize(initialRoom());seeded=seedRecoveryInvitationRecords(source,'commons');seeded.expected=source.verifyInvitationAudit();if(options.duplicateLegacy){const row=source.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get(),member=seeded.issued[0].member;source.transaction(()=>source.db.prepare("UPDATE rooms SET projection=? WHERE id='commons'").run(row.projection.replace(JSON.stringify(member)+':',JSON.stringify(member)+':{"id":"wrong-first"},'+JSON.stringify(member)+':')));assert.equal(source.verifyInvitationAudit().consistent,true);}}else seeded=seedRecoveryInvitationSource(source,options);const store=new RoomStore(':memory:');t.after(()=>store.close());let response=await post(store,exportNdjsonText(source.db)),n=0;
 while(restoreProgress(store.db).phase!=='audit_pending'){assert.equal(response.status,202,JSON.stringify(response.body));response=await post(store,{restoreId:response.body.restoreId,sourceSeal:response.body.sourceSeal,expectedRevision:response.body.revision,requestId:'invite-prepare-'+n++});assert.ok(n<150);}
 const state=restoreProgress(store.db),step=(p,options)=>withRestoreTransaction(store,()=>withRestoreAuditRows(store.db,state.restore_id,scratch=>advanceRecoveryInvitations(store,scratch,state.restore_id,p,state.seal,options)));return{source,store,seeded,state,step};}
function drive(f,p=initialRecoveryInvitations()){for(let n=0;n<1000;n++){if(p.stage==='complete')return p;const r=f.step(p);assert.ok(r.units<=32);assert.ok(r.bytes<=4*1024*1024);p=r.cursor;}throw Error('Invitation progress stalled');}
test('independent invitation phase proves pending/revoked/accepted journal and protected membership without full lists',async t=>{
 const f=await fixture(t),prepare=f.store.db.prepare.bind(f.store.db);f.store.room=()=>{throw Error('whole room hydration');};
 f.store.db.prepare=sql=>{assert.notEqual(sql,'SELECT id FROM membership_invitations ORDER BY id');assert.ok(!/SELECT \* FROM membership_invitation(?:_journal|_events)s? WHERE invitation_id=/.test(sql));return prepare(sql);};
 try{const p=drive(f);assert.equal(p.invitations,3);assert.equal(p.journalEntries,5);assert.equal(p.auditEntries,5);assert.equal(p.orphanRows,5);assert.equal(p.legacyBaselines,0);}finally{f.store.db.prepare=prepare;}
 assert.equal(f.seeded.expected.consistent,true);
});
function corrupt(f,table,operation){
 const db=f.store.db;db.exec('PRAGMA foreign_keys=OFF');
 try{withRestoreTransaction(f.store,()=>{const defs=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name=?").all(table);for(const row of defs)db.exec('DROP TRIGGER "'+row.name.replaceAll('"','""')+'"');operation(db);for(const row of defs)db.exec(row.sql);});}finally{db.exec('PRAGMA foreign_keys=ON');}
}
for(const defect of ['journal-checksum','record','audit','binding','joined-event','protected-member','third-entry','orphan'])test('independent invitation phase refuses '+defect,async t=>{
 const f=await fixture(t),id=f.seeded.issued[0].id;
 if(defect==='journal-checksum')corrupt(f,'membership_invitation_journal',db=>db.prepare('UPDATE membership_invitation_journal SET checksum=? WHERE invitation_id=? AND sequence=2').run('0'.repeat(64),id));
 if(defect==='record')corrupt(f,'membership_invitations',db=>db.prepare('UPDATE membership_invitations SET intended_display_name=? WHERE id=?').run('Substituted human',id));
 if(defect==='audit')corrupt(f,'membership_invitation_events',db=>db.prepare('UPDATE membership_invitation_events SET actor_member_id=? WHERE invitation_id=? AND sequence=2').run('wrong-human',id));
 if(defect==='binding')corrupt(f,'member_accounts',db=>db.prepare('UPDATE member_accounts SET origin=? WHERE room_id=? AND member_id=?').run('local-provisioning','legacy-room',f.seeded.issued[0].member));
 if(defect==='joined-event')corrupt(f,'events',db=>{const row=db.prepare('SELECT e.id,e.body FROM events e JOIN membership_invitations i ON i.joined_event_id=e.id WHERE i.id=?').get(id),entry=JSON.parse(row.body);entry.data.displayName='Substituted human';db.prepare('UPDATE events SET body=? WHERE id=?').run(JSON.stringify(entry),row.id);});
 if(defect==='protected-member')corrupt(f,'current_room_records',db=>{const row=db.prepare("SELECT payload FROM current_room_records WHERE room_id='legacy-room' AND domain='members' AND record_key=?").get(f.seeded.issued[0].member),member=JSON.parse(row.payload);member.displayName='Substituted human';const value=JSON.stringify(member);db.prepare("UPDATE current_room_records SET payload=?,payload_bytes=? WHERE room_id='legacy-room' AND domain='members' AND record_key=?").run(value,Buffer.byteLength(value),f.seeded.issued[0].member);});
 if(defect==='third-entry')corrupt(f,'membership_invitation_journal',db=>db.prepare('INSERT INTO membership_invitation_journal SELECT invitation_id,3,body,checksum FROM membership_invitation_journal WHERE invitation_id=? AND sequence=2').run(id));
 if(defect==='orphan')corrupt(f,'membership_invitation_journal',db=>db.prepare('UPDATE membership_invitation_journal SET invitation_id=? WHERE invitation_id=?').run('missing-invitation',id));
 assert.throws(()=>drive(f),/reconciliation|differs|consistency|current_room_corrupt/);
});
test('authority and sealed byte admission precede source payload reads',async t=>{
 const f=await fixture(t),prepare=f.store.db.prepare.bind(f.store.db);let payloads=0;
 f.store.db.prepare=sql=>{if(sql.startsWith('SELECT * FROM membership_'))payloads++;const stmt=prepare(sql),all=stmt.all.bind(stmt);if(sql.includes(' bytes FROM "membership_invitations"'))stmt.all=(...args)=>all(...args).map(row=>({...row,bytes:Number.MAX_SAFE_INTEGER}));return stmt;};
 try{
  assert.throws(()=>advanceRecoveryInvitations(f.store,{},f.state.restore_id,initialRecoveryInvitations(),f.state.seal),/reconciliation/);
  assert.throws(()=>withRestoreTransaction(f.store,()=>advanceRecoveryInvitations(f.store,{},'wrong',initialRecoveryInvitations(),f.state.seal)),/reconciliation/);
  assert.throws(()=>withRestoreTransaction(f.store,()=>advanceRecoveryInvitations(f.store,{},f.state.restore_id,initialRecoveryInvitations(),{...f.state.seal,id:'wrong'})),/reconciliation/);
  assert.throws(()=>drive(f),/reconciliation/);
 }finally{f.store.db.prepare=prepare;}
 assert.equal(payloads,0);
});
for(const scenario of ['deleted','rebound'])test('original retired-invitee evidence remains exact: '+scenario,async t=>{
 const {executeAccountDeletion,planAccountDeletion}=await import('../server/account-deletion.mjs');
 const f=await fixture(t,{beforeCapture(s,{issued,owner,key}){
  const first=issued[0];
  if(scenario==='deleted')executeAccountDeletion(s,planAccountDeletion(s,first.account).plan);
  else{
   rebindRecoveryInvitee(s,{issued,owner});
  }
  const clock=s.now;let offset=0;s.now=()=>clock()+offset;
  for(let i=0;i<40;i++){offset+=3000;s.command(key,'legacy-room',{id:'later-history-'+i,type:'message.posted',data:{messageId:'later-history-'+i,body:'Later unrelated history '+i}});}
 }});
 const p=drive(f);assert.equal(p.invitations,f.seeded.expected.invitations);assert.equal(p.journalEntries,f.seeded.expected.journalEntries);assert.ok(p.historyRows>=40,'latest matching self-left evidence requires honest bounded continuation');
});
test('legacy selected membership matches original last-duplicate semantics without returning the full members map',async t=>{
 const f=await fixture(t,{legacy:true,duplicateLegacy:true});
 const p=drive(f);assert.equal(p.invitations,3);
 const original=withRestoreTransaction(f.store,()=>f.store.verifyInvitationAudit());assert.equal(original.invitations,p.invitations);assert.equal(original.journalEntries,p.journalEntries);
});

test('legal large invitation set advances a bounded global orphan window before record validation',async t=>{const f=await fixture(t,{pending:70}),first=f.step(initialRecoveryInvitations());assert.equal(first.units,32);assert.equal(first.cursor.orphanRows,32);assert.equal(first.cursor.stage,'orphans');assert.ok(first.bytes<=4*1024*1024);const final=drive(f,first.cursor);assert.equal(final.invitations,72);assert.equal(final.journalEntries,74);});

for(const [name,keys,originalAccepts] of [
 ['type-first-unrelated','"type":"message.posted","type":"member.access_changed"',true],
 ['type-first-matching','"type":"member.access_changed","type":"message.posted"',false],
 ['member-first-unrelated','"type":"member.access_changed"',true],
 ['member-first-matching','"type":"member.access_changed"',false],
])test('self-left candidate selection preserves SQLite first-key eligibility: '+name,async t=>{
 const f=await fixture(t,{beforeCapture(s,context){rebindRecoveryInvitee(s,context);s.command(context.key,'legacy-room',{id:'duplicate-eligibility-source',type:'message.posted',data:{messageId:'duplicate-eligibility-source',body:'Source padding '.repeat(100)}});}}),member=f.seeded.issued[0].member;
 const data=name==='member-first-unrelated'?`{"memberId":"unrelated","memberId":${JSON.stringify(member)},"active":false}`:name==='member-first-matching'?`{"memberId":${JSON.stringify(member)},"memberId":"unrelated","active":false}`:`{"memberId":${JSON.stringify(member)},"active":false}`;
 // Controlled private-audit grammar parity, not a full-source/admission claim:
 // retain all source facts except one later event's duplicate-key body.
 corrupt(f,'events',db=>{const row=db.prepare("SELECT id FROM events WHERE room_id='legacy-room' AND json_extract(body,'$.data.messageId')='duplicate-eligibility-source'").get();db.prepare('UPDATE events SET body=? WHERE id=?').run(`{${keys},"data":${data},"actorId":"owner"}`,row.id);});
 const original=()=>withRestoreTransaction(f.store,()=>f.store.verifyInvitationAudit());
 if(originalAccepts){assert.equal(original().consistent,true);assert.equal(drive(f).invitations,f.seeded.expected.invitations);}
 else{assert.throws(original,/reconciliation/);assert.throws(()=>drive(f),/reconciliation|differs/);}
});
