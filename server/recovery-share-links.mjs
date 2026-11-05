import {Buffer} from 'node:buffer';
import {validId,EVENT_TYPES} from '../src/events.js';
import {assertShareLinkUsage,assertShareLinkJoinEvidence,assertShareLinkRedemption,shareLinkAgentPrefix} from './share-link-evidence.mjs';
import {inRestoreContext,restoreProgress,RESTORE_AUDIT_VERSION} from './restore-admission.mjs';
import {verifyRestoreFreeze} from './writer-fence.mjs';
import {recoveryInvitationSummary} from './recovery-invitation-continuation.mjs';
const LIMIT=4*1024*1024,fail=()=>{throw Error('Recovery share links require operator reconciliation');},consumed=new WeakMap();
export const initialRecoveryShareLinks=()=>({version:1,stage:'links',after:null,currentLink:null,agentAfter:null,usage:0,links:0,agentRows:0,joins:0,redemptions:0,reason:null});
export function validateRecoveryShareLinks(c){if(!c||Object.keys(c).sort().join(',')!==Object.keys(initialRecoveryShareLinks()).sort().join(',')||c.version!==1||!['links','agents','joins','redemptions','complete','deferred'].includes(c.stage)||!(c.after===null||Number.isSafeInteger(c.after))||!['usage','links','agentRows','joins','redemptions'].every(k=>Number.isSafeInteger(c[k])&&c[k]>=0)||c.currentLink!==null&&!validId(c.currentLink)||c.agentAfter!==null&&(typeof c.agentAfter!=='string'||Buffer.byteLength(c.agentAfter)>1024)||((c.stage==='agents')!==(c.currentLink!==null))||(c.stage!=='agents'&&c.agentAfter!==null)||((c.stage==='deferred')!==['share_link_glob_grammar','share_link_rowid_grammar'].includes(c.reason)))fail();}
const quote=s=>'"'+s.replaceAll('"','""')+'"';
function entry(seal,name){const e=seal.tables.find(t=>t.name===name);if(!e||!Number.isSafeInteger(e.maxRowBytes)||e.maxRowBytes<0||!Array.isArray(e.columns)||e.columns.some(c=>!/^[_a-zA-Z][_a-zA-Z0-9]*$/.test(c)))fail();return e;}
function scalar(db,e,where,args,order='rowid'){const row=db.prepare(`SELECT CAST(rowid AS TEXT) rawRowid,${e.columns.map(c=>`coalesce(length(CAST(${quote(c)} AS BLOB)),0)`).join('+')}+4096 bytes FROM ${quote(e.name)} WHERE ${where} ORDER BY ${order} LIMIT 1`).get(...args);if(!row)return row;const rowid=Number(row.rawRowid);return{...row,rowid:Number.isSafeInteger(rowid)?rowid:null};}
function bytes(row,e){if(!row)return 0;if(!Number.isSafeInteger(row.rowid) || !Number.isSafeInteger(row.bytes) || row.bytes < 4096 || row.bytes > e.maxRowBytes + e.columns.length * 32 + 4096)fail();return row.bytes;}
function authority(store,id,sealId){const db=store.db;if(!db.isTransaction || !inRestoreContext(db))fail();const state=restoreProgress(db);if(state.state !== 'pending' || state.phase !== 'audit_pending' || state.restore_id !== id || state.seal?.id !== sealId || state.seal.auditVersion !== RESTORE_AUDIT_VERSION)fail();const summary=recoveryInvitationSummary(state.progress?.audit?.invitations);if(summary.invitations !== entry(state.seal,'membership_invitations').expected.rows || summary.journalEntries !== entry(state.seal,'membership_invitation_journal').expected.rows || state.progress.audit.invitations.orphanRows !== summary.journalEntries || state.progress.audit.invitations.auditEntries !== entry(state.seal,'membership_invitation_events').expected.rows || state.progress.audit.version !== RESTORE_AUDIT_VERSION)fail();return state;}
function completeCounts(c,seal){if(c.stage!=='complete'||c.links!==entry(seal,'share_links').expected.rows||c.joins!==entry(seal,'share_link_joins').expected.rows||c.redemptions!==entry(seal,'share_link_join_redemptions').expected.rows)fail();}
function access(db,seal,link){if(db.prepare('SELECT 1 FROM development_co_owner_links WHERE link_id=?').get(link.id))return'co_owner';try{if(!seal.inventory.includes('share_link_access'))return'guest';const e=entry(seal,'share_link_access'),s=scalar(db,e,'link_id=?',[link.id]);bytes(s,e);return s?db.prepare('SELECT access FROM share_link_access WHERE rowid=?').get(s.rowid).access??'guest':'guest';}catch(error){if(/no such table/i.test(error?.message??''))return'guest';throw error;}}
export function advanceRecoveryShareLinks(store,_scratch,id,previous,sourceSeal,{maxUnits=32}={}){
 validateRecoveryShareLinks(previous);if(!Number.isInteger(maxUnits)||maxUnits<1||maxUnits>32)fail();const state=authority(store,id,sourceSeal?.id);if(state.progress.audit.stage!=='share_links'||JSON.stringify(state.progress.audit.shareLinks)!==JSON.stringify(previous))fail();const seal=state.seal,db=store.db,c={...previous},links=entry(seal,'share_links'),joins=entry(seal,'share_link_joins'),events=entry(seal,'events'),invitations=entry(seal,'membership_invitations'),redemptions=entry(seal,'share_link_join_redemptions');let units=0,inputBytes=0;
 const admit=n=>{if(!Number.isSafeInteger(n)||n<0)fail();if(units&&inputBytes+n>LIMIT)return false;inputBytes+=n;return true;};
 while(units<maxUnits&&inputBytes<LIMIT&&!['complete','deferred'].includes(c.stage)){
  if(c.stage==='links'){
   const s=scalar(db,links,c.after===null?'1':'rowid>?',c.after===null?[]:[c.after]);if(!s){c.after=null;c.stage='joins';continue;}if(s.rowid===null){c.stage='deferred';c.reason='share_link_rowid_grammar';break;}if(!admit(bytes(s,links)))break;const row=db.prepare('SELECT * FROM share_links WHERE rowid=?').get(s.rowid);
   if(!validId(row.id)||!Number.isInteger(row.max_joins)||row.max_joins<1||row.max_joins>25){c.stage='deferred';c.reason='share_link_glob_grammar';break;}
   const humans=db.prepare('SELECT count(*) n FROM (SELECT 1 FROM share_link_joins WHERE link_id=? LIMIT 26)').get(row.id).n;assertShareLinkUsage(humans,row.max_joins);c.usage=humans;c.after=s.rowid;c.currentLink=row.id;c.agentAfter=null;c.stage='agents';units++;continue;
  }
  if(c.stage==='agents'){
   const ls=scalar(db,links,'id=?',[c.currentLink]);if(!ls)fail();const reserve=bytes(ls,links);if(!admit(reserve))break;const link=db.prepare('SELECT * FROM share_links WHERE rowid=?').get(ls.rowid),prefix=shareLinkAgentPrefix(link),upper=prefix.slice(0,-1)+'`';
   // Literal ASCII link IDs make this an exact indexed source interval, not
   // SQL filtering before LIMIT. Prefix itself is included on the first page.
   const s=c.agentAfter===null?scalar(db,events,'id>=? AND id<?',[prefix,upper],'id'):scalar(db,events,'id>? AND id<?',[c.agentAfter,upper],'id');
   if(!s){c.links++;c.currentLink=null;c.agentAfter=null;c.usage=0;c.stage='links';continue;}if(s.rowid===null){c.currentLink=null;c.agentAfter=null;c.stage='deferred';c.reason='share_link_rowid_grammar';break;}if(!admit(bytes(s,events)))break;
   const row=db.prepare("SELECT id,room_id,json_extract(body,'$.type') type FROM events WHERE rowid=?").get(s.rowid);if(row.room_id === link.room_id && row.type === EVENT_TYPES.MEMBER_ADDED)c.usage++;assertShareLinkUsage(c.usage,link.max_joins);c.agentAfter=row.id;c.agentRows++;units++;continue;
  }
  if(c.stage==='joins'){
   const s=scalar(db,joins,c.after===null?'1':'rowid>?',c.after===null?[]:[c.after]);if(!s){c.after=null;c.stage='redemptions';continue;}if(s.rowid===null){c.stage='deferred';c.reason='share_link_rowid_grammar';break;}if(!admit(bytes(s,joins)))break;const row=db.prepare('SELECT * FROM share_link_joins WHERE rowid=?').get(s.rowid),ls=scalar(db,links,'id=?',[row.link_id]),is=scalar(db,invitations,'id=?',[row.invitation_id]);
   const accessMaximum=seal.tables.find(t=>t.name==='share_link_access')?.maxRowBytes??0;if(!admit(bytes(ls,links)+bytes(is,invitations)+accessMaximum+8192))break;
   const link=ls?db.prepare('SELECT * FROM share_links WHERE rowid=?').get(ls.rowid):undefined,record=is?db.prepare('SELECT * FROM membership_invitations WHERE rowid=?').get(is.rowid):undefined;if(!record)fail();
   // The earlier complete independent invitation phase proved this exact
   // mutable projection against its journal/membership in the frozen source.
   assertShareLinkJoinEvidence(row,link,record,()=>access(db,seal,link));c.after=s.rowid;c.joins++;units++;continue;
  }
  const s=scalar(db,redemptions,c.after===null?'1':'rowid>?',c.after===null?[]:[c.after]);if(!s){c.stage='complete';completeCounts(c,seal);break;}if(s.rowid===null){c.stage='deferred';c.reason='share_link_rowid_grammar';break;}if(!admit(bytes(s,redemptions)))break;const row=db.prepare('SELECT * FROM share_link_join_redemptions WHERE rowid=?').get(s.rowid);assertShareLinkRedemption(()=>Boolean(db.prepare('SELECT 1 FROM share_links WHERE id=?').get(row.link_id)),()=>Boolean(db.prepare('SELECT 1 FROM accounts WHERE id=?').get(row.account_id)));c.after=s.rowid;c.redemptions++;units++;
 }
 return{cursor:c,units,bytes:inputBytes,done:['complete','deferred'].includes(c.stage)};
}
// Only this completed, persisted, still-frozen target source can replace the
// corresponding component. No caller-supplied boolean or portable certificate.
export function withCompletedRecoveryShareLinks(store,id,sealId,operation){const state=authority(store,id,sealId),c=state.progress?.audit?.shareLinks;validateRecoveryShareLinks(c);if(state.progress.audit.stage!=='full_audit_pending')fail();if(c.stage==='deferred')return operation();completeCounts(c,state.seal);verifyRestoreFreeze(store.db,state.seal.inventory);const before=consumed.get(store.db);consumed.set(store.db,{id,sealId,revision:state.revision,cursor:JSON.stringify(c)});try{const result=operation();if(result?.then)fail();return result;}finally{if(before)consumed.set(store.db,before);else consumed.delete(store.db);}}
export function verifyShareLinksForRecovery(store){const permit=consumed.get(store.db);if(!permit)return store.shareLinks.verify();const state=authority(store,permit.id,permit.sealId);if(state.revision!==permit.revision||state.progress.audit.stage!=='full_audit_pending'||JSON.stringify(state.progress.audit.shareLinks)!==permit.cursor)fail();completeCounts(state.progress.audit.shareLinks,state.seal);}
