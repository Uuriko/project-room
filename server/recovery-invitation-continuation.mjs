import {Buffer} from 'node:buffer';
import {validId} from '../src/events.js';
import {replayInvitationJournal} from './journal.mjs';
import {assertInvitationJournalProjection,assertInvitationMembershipEvidence} from './invitation-evidence.mjs';
import {inRestoreContext,restoreProgress} from './restore-admission.mjs';
import {isCurrentRoom,withCurrentAuditUnits} from './current-room-repository.mjs';
const QUANTUM=4*1024*1024,fail=()=>{throw Error('Recovery invitation audit requires operator reconciliation');};
export const initialRecoveryInvitations=()=>({version:1,stage:'orphans',journalAfter:0,after:'',current:null,before:0,invitations:0,legacyBaselines:0,journalEntries:0,auditEntries:0,orphanRows:0,historyRows:0});
export function validateRecoveryInvitations(p){
 if(!p||Object.keys(p).sort().join(',')!==Object.keys(initialRecoveryInvitations()).sort().join(',')||p.version!==1||!['orphans','records','self_left','complete'].includes(p.stage)||typeof p.after!=='string'||Buffer.byteLength(p.after)>200||p.current!==null&&!validId(p.current)||!['journalAfter','before','invitations','legacyBaselines','journalEntries','auditEntries','orphanRows','historyRows'].every(k=>Number.isSafeInteger(p[k])&&p[k]>=0))fail();
 if((p.stage==='self_left')!==(p.current!==null)||p.stage!=='self_left'&&p.before!==0)fail();
}
const quote=name=>'"'+name.replaceAll('"','""')+'"';
// The existing source seal supplies exact code-owned column inventory and byte
// maxima. Only scalars cross the SQL boundary before a payload is admitted.
function tableEntry(seal,name){const e=seal.tables.find(t=>t.name===name);if(!e||!Number.isSafeInteger(e.maxRowBytes)||e.maxRowBytes<0||!Array.isArray(e.columns)||e.columns.some(c=>!/^[_A-Za-z][_A-Za-z0-9]*$/.test(c)))fail();return e;}
function scalar(db,e,where,args,order='rowid',limit=1){const sizes=e.columns.map(c=>`coalesce(length(CAST(${quote(c)} AS BLOB)),0)`).join('+');return db.prepare(`SELECT rowid,(${sizes})+4096 bytes FROM ${quote(e.name)} WHERE ${where} ORDER BY ${order} LIMIT ${limit}`).all(...args);}
function inputBytes(rows,e){let n=0;for(const row of rows){if(!Number.isSafeInteger(row.rowid)||!Number.isSafeInteger(row.bytes)||row.bytes<4096||row.bytes > e.maxRowBytes + e.columns.length * 32 + 4096)fail();n+=row.bytes;}return n;}
function contextBytes(db,record,seal){
 if(!isCurrentRoom(db,record.room_id)){
  const maximum=tableEntry(seal,'rooms').maxRowBytes,row=db.prepare('SELECT length(CAST(projection AS BLOB)) bytes FROM rooms WHERE id=?').get(record.room_id);
  if(!row||!Number.isSafeInteger(row.bytes)||row.bytes<1||row.bytes>maximum)fail();return row.bytes+4096;
 }
 const head=db.prepare("SELECT length(CAST(h.counts_json AS BLOB)) bytes,length(CAST(a.counts_json AS BLOB)) receipt_bytes FROM current_room_head h LEFT JOIN operator_actions a ON a.id=h.receipt_id WHERE h.room_id=?").get(record.room_id);
 const member=db.prepare("SELECT r.payload_bytes,(SELECT length(CAST(a.counts_json AS BLOB)) FROM operator_actions a WHERE a.id=p.receipt_id) receipt_bytes FROM current_room_record_proofs p LEFT JOIN current_room_records r ON r.room_id=p.room_id AND r.domain=p.domain AND r.record_key=p.record_key WHERE p.room_id=? AND p.domain='members' AND p.record_key=?").get(record.room_id,record.intended_member_id);
 const values=[head?.bytes,head?.receipt_bytes,member?.payload_bytes??0,member?.receipt_bytes??0];if(values.some(n=>!Number.isSafeInteger(n)||n<0))fail();return values.reduce((a,b)=>a+b,0)+16384;
}
function membershipContext(store,record){
 const db=store.db;
 if(isCurrentRoom(db,record.room_id))return withCurrentAuditUnits(store,record.room_id,reader=>({sequence:reader.head?.sequence,member:reader.record('members',record.intended_member_id)}));
 // Same original selected member. SQLite still tokenizes the admitted legacy
 // projection atom; this does not claim strict CPU bounds for that operation.
 // JSON.parse of the original extracted members object keeps the LAST
 // duplicate key. A direct json_extract(member path) would pick the first.
 const row=db.prepare("SELECT sequence,(SELECT json_quote(value) FROM json_each(rooms.projection,'$.members') WHERE CAST(key AS TEXT)=? ORDER BY id DESC LIMIT 1) member FROM rooms WHERE id=?").get(record.intended_member_id,record.room_id);
 return{sequence:row?.sequence,member:row?.member?JSON.parse(row.member):undefined};
}
export function advanceRecoveryInvitations(store,_scratch,restoreId,previous,sourceSeal,{maxUnits=32}={}){
 validateRecoveryInvitations(previous);if(!Number.isInteger(maxUnits)||maxUnits<1||maxUnits>32)fail();
 const db=store.db;if(!db.isTransaction||!inRestoreContext(db))fail();const admission=restoreProgress(db);
 if(admission.state!=='pending'||admission.phase!=='audit_pending'||admission.restore_id!==restoreId||admission.seal?.id!==sourceSeal?.id)fail();
 const seal=admission.seal,p={...previous},records=tableEntry(seal,'membership_invitations'),journals=tableEntry(seal,'membership_invitation_journal'),audits=tableEntry(seal,'membership_invitation_events'),events=tableEntry(seal,'events');let units=0,bytes=0,bundle=null;
 const admit=n=>{if(!Number.isSafeInteger(n)||n<0||!Number.isSafeInteger(bytes+n))fail();if(units&&bytes+n>QUANTUM)return false;bytes+=n;return true;};
 function load(id){
  const rs=scalar(db,records,'id=?',[id]),js=scalar(db,journals,'invitation_id=?',[id],'sequence',3),as=scalar(db,audits,'invitation_id=?',[id],'sequence',3);
  if(rs.length!==1||js.length>2||as.length>2)fail();const n=inputBytes(rs,records)+inputBytes(js,journals)+inputBytes(as,audits);if(!admit(n))return null;
  const record=db.prepare('SELECT * FROM membership_invitations WHERE rowid=?').get(rs[0].rowid),journal=js.map(r=>db.prepare('SELECT * FROM membership_invitation_journal WHERE rowid=?').get(r.rowid)),audit=as.map(r=>db.prepare('SELECT * FROM membership_invitation_events WHERE rowid=?').get(r.rowid)),replayed=replayInvitationJournal(journal);assertInvitationJournalProjection(record,audit,replayed);
  if(record.status!=='accepted')return{record,replayed,audit};
  const linkedScalar=scalar(db,events,'id=?',[record.joined_event_id]);if(linkedScalar.length!==1)fail();
  const bindingEntry=tableEntry(seal,'member_accounts'),bs=scalar(db,bindingEntry,'room_id=? AND member_id=?',[record.room_id,record.intended_member_id]);
  if(!admit(inputBytes(linkedScalar,events)+inputBytes(bs,bindingEntry)+contextBytes(db,record,seal)+4096))return null;
  const linked=db.prepare('SELECT id,sequence,body,room_id FROM events WHERE rowid=?').get(linkedScalar[0].rowid),binding=bs.length?db.prepare('SELECT account_id,origin FROM member_accounts WHERE rowid=?').get(bs[0].rowid):undefined,context=membershipContext(store,record),account=db.prepare('SELECT active FROM accounts WHERE id=?').get(record.intended_account_id),rebound=Boolean(db.prepare('SELECT 1 FROM member_accounts WHERE room_id=? AND account_id=? AND member_id<>?').get(record.room_id,record.intended_account_id,record.intended_member_id));
  return{record,replayed,audit,linked,binding,context,account,rebound};
 }
 function finish(value,left=false){
  if(value.record.status==='accepted'){
   const retiredInvitee=!value.binding&&(value.account?.active===0||left&&value.rebound);
   assertInvitationMembershipEvidence(value.record,value.linked,value.binding,{sequence:value.context.sequence,state:{members:{[value.record.intended_member_id]:value.context.member}}},{retiredInvitee});
  }
  p.invitations++;p.legacyBaselines+=Number(value.replayed.legacyBaseline);p.journalEntries+=value.replayed.journalSequence;p.auditEntries+=value.audit.length;p.after=value.record.id;p.current=null;p.before=0;p.stage='records';bundle=null;
 }
 while(units<maxUnits&&bytes<QUANTUM&&p.stage!=='complete'){
  if(p.stage==='orphans'){
   const row=db.prepare('SELECT rowid,length(CAST(invitation_id AS BLOB)) bytes,EXISTS(SELECT 1 FROM membership_invitations i WHERE i.id=j.invitation_id) present FROM membership_invitation_journal j WHERE rowid>? ORDER BY rowid LIMIT 1').get(p.journalAfter);
   if(!row){if(p.orphanRows!==journals.expected.rows)fail();p.stage='records';continue;}if(!Number.isSafeInteger(row.bytes)||row.bytes<1||row.bytes>200||row.present!==1)fail();if(!admit(row.bytes+4096))break;p.orphanRows++;p.journalAfter=row.rowid;units++;continue;
  }
  if(p.stage==='records'){
   const row=db.prepare('SELECT rowid,length(CAST(id AS BLOB)) bytes FROM membership_invitations WHERE id>? ORDER BY id LIMIT 1').get(p.after);
   if(!row){if(p.invitations!==records.expected.rows||p.journalEntries!==journals.expected.rows||p.auditEntries!==audits.expected.rows)fail();p.stage='complete';break;}if(!Number.isSafeInteger(row.bytes)||row.bytes<1||row.bytes>200)fail();if(!admit(row.bytes+256))break;
   const id=db.prepare('SELECT id FROM membership_invitations WHERE rowid=?').get(row.rowid).id;if(!validId(id))fail();bundle=load(id);if(!bundle)break;
   if(bundle.record.status==='accepted'&&!bundle.binding&&bundle.context.member?.active===false){p.current=id;p.before=bundle.context.sequence+1;p.stage='self_left';}else finish(bundle);units++;continue;
  }
  bundle??=load(p.current);if(!bundle)break;
  const rows=scalar(db,events,'room_id=? AND sequence<?',[bundle.record.room_id,p.before],'sequence DESC');
  if(!rows.length){finish(bundle,false);units++;continue;}if(!admit(inputBytes(rows,events)))break;
  // Match the original SQL candidate predicate BEFORE JSON.parse. SQLite
  // chooses first duplicate keys; JSON.parse chooses last values for the
  // selected event's active/actor check. Neither grammar is interchangeable.
  const row=db.prepare("SELECT sequence,body,(json_extract(body,'$.type')='member.access_changed' AND json_extract(body,'$.data.memberId')=?) eligible FROM events WHERE rowid=?").get(bundle.record.intended_member_id,rows[0].rowid);p.before=row.sequence;p.historyRows++;units++;
  if(row.eligible===1){const e=JSON.parse(row.body);finish(bundle,e?.data?.active===false&&e.actorId===bundle.record.intended_member_id);}
 }
 return{cursor:p,units,bytes,done:p.stage==='complete'};
}

export function recoveryInvitationSummary(cursor){validateRecoveryInvitations(cursor);if(cursor.stage!=='complete')fail();return{consistent:true,invitations:cursor.invitations,legacyBaselines:cursor.legacyBaselines,journalEntries:cursor.journalEntries};}
