import {Buffer} from 'node:buffer';
import {validId,WORK_REVISION_TYPES} from '../src/events.js';
import {WORK_HELP_UPDATED,helpFromEvent,workHelpContext} from '../src/work-help.js';
import {HELP_OFFER_OPENED,HELP_OFFER_UPDATED,MAX_HELP_OFFERS,validateHelpOfferRecord,helpOfferIdentity,helpOfferIsCurrent,helpOfferAvailabilityFromCounts,helpOfferContextFromSelection,helpOfferFromQualifiedFacts} from '../src/help-offers.js';
import {advanceWorkHelpMembers,advanceWorkHelpWork,workHelpAuditWorkFacts,workHelpAuditMemberFacts,workHelpAuditValue,workHelpAuditHelp} from './work-help.mjs';
import {inRestoreContext,restoreProgress,RESTORE_AUDIT_UNIT_BYTES} from './restore-admission.mjs';
import {initialRecoveryProjectionScan,scanRecoveryProjectionChunk,decodeRecoveryProjectionSpan,recoveryProjectionFrame,REPLAY_CODEC_INPUT_BYTES} from './replay-projection-codec.mjs';
const QUANTUM=4*1024*1024,offerTypes=new Set([HELP_OFFER_OPENED,HELP_OFFER_UPDATED]);
const fail=()=>{throw Error('Recovery work-help history requires reconciliation');};
const own=(v,k)=>v!=null&&Object.hasOwn(v,k);
const raw=v=>v instanceof Uint8Array?v:v instanceof ArrayBuffer?new Uint8Array(v):fail();
export const initialRecoveryWorkHelp=()=>({version:1,stage:'basis',checkpoint:null,scan:null,checkpointOffers:false,checkpointChecked:false,discoverSequence:0,relevant:0,sequence:0,room:null,helps:0,offers:0,offerChecks:0,checkpointRecords:0,offersPresent:false,expansion:null,comparison:null,reason:null});
export function validateRecoveryWorkHelp(p){
 if(!p||Object.keys(p).sort().join(',')!==Object.keys(initialRecoveryWorkHelp()).sort().join(',')||p.version!==1||!['basis','checkpoint','discover','events','offers','compare','complete','deferred'].includes(p.stage)||!['discoverSequence','relevant','sequence','helps','offers','offerChecks','checkpointRecords'].every(k=>Number.isSafeInteger(p[k])&&p[k]>=0)||p.offers>MAX_HELP_OFFERS||typeof p.offersPresent!=='boolean'||typeof p.checkpointOffers!=='boolean'||typeof p.checkpointChecked!=='boolean'||(p.reason!==null&&(typeof p.reason!=='string'||p.reason.length>128))||((p.stage==='deferred')!==(p.reason!==null)))fail();
 if(p.checkpoint!==null&&(!Number.isSafeInteger(p.checkpoint.sequence)||p.checkpoint.sequence<0||!Number.isSafeInteger(p.checkpoint.bytes)||p.checkpoint.bytes<2))fail();
 if(p.scan!==null)scanRecoveryProjectionChunk(p.scan,new Uint8Array());
 if(p.room!==null&&(!validId(p.room.id)||!validId(p.room.ownerId)))fail();
 if(p.expansion!==null){const x=p.expansion;if(Object.keys(x).sort().join(',')!=='after,count,existingOfferId,pendingForViewer,pendingForWork,selectedOfferId'||typeof x.after!=='string'||Buffer.byteLength(x.after)>200||!['count','pendingForWork','pendingForViewer'].every(k=>Number.isSafeInteger(x[k])&&x[k]>=0&&x[k]<=MAX_HELP_OFFERS)||!['existingOfferId','selectedOfferId'].every(k=>x[k]===null||validId(x[k])))fail();}
 if(p.comparison!==null){const c=p.comparison;if(Object.keys(c).sort().join(',')!=='after,helps,offers,stage,target'||!['checkpoint','current'].includes(c.target)||!['work','offers','members'].includes(c.stage)||typeof c.after!=='string'||Buffer.byteLength(c.after)>200||!['helps','offers'].every(k=>Number.isSafeInteger(c[k])&&c[k]>=0))fail();}
 if((p.stage==='offers')!==(p.expansion!==null)||(p.stage==='compare')!==(p.comparison!==null)||Buffer.byteLength(JSON.stringify(p))>RESTORE_AUDIT_UNIT_BYTES)fail();
}
// Same frozen target scratch and source admission; no new certificate or store.
export function advanceRecoveryWorkHelp(store,scratch,restoreId,roomId,previous,seal,{maxUnits=32}={}){
 validateRecoveryWorkHelp(previous);if(!Number.isSafeInteger(maxUnits)||maxUnits<1||maxUnits>32)fail();const p=structuredClone(previous),db=store.db;let units=0,bytes=0;
 if(!db.isTransaction||!inRestoreContext(db))fail();const admitted=restoreProgress(db);
 if(admitted.state!=='pending'||admitted.restore_id!==restoreId||admitted.phase!=='audit_pending'||seal?.id!==admitted.seal?.id)fail();
 const eventMax=admitted.seal.tables.find(t=>t.name==='events')?.maxRowBytes,checkpointMax=admitted.seal.tables.find(t=>t.name==='projection_checkpoints')?.maxRowBytes;
 if(!Number.isSafeInteger(eventMax)||eventMax<0||!Number.isSafeInteger(checkpointMax)||checkpointMax<0)fail();
 const head=db.prepare('SELECT sequence FROM rooms WHERE id=?').get(roomId);if(!Number.isSafeInteger(head?.sequence)||head.sequence<0)fail();
 const pause=Symbol('work-help quantum'),queuedSizes=new Map();
 const identity=(lane,domain,key)=>JSON.stringify([lane,domain,key]);
 const admit=n=>{if(!Number.isSafeInteger(n)||n<0||!Number.isSafeInteger(bytes+n))fail();if(units&&bytes+n>QUANTUM)throw pause;bytes+=n;};
 const get=(domain,key,{lane='history'}={})=>{
  if(typeof key!=='string')return undefined;
  const queued=queuedSizes.get(identity(lane,domain,key));if(queued!==undefined){admit(queued+256);return scratch.get(lane,roomId,domain,key);}
  const scalar=db.prepare('SELECT payload_bytes,length(CAST(payload AS BLOB)) bytes FROM current_restore_audit_scratch WHERE restore_id=? AND lane=? AND room_id=? AND domain=? AND unit_key=? AND part=0').get(restoreId,lane,roomId,domain,key);
  admit(256);if(!scalar)return undefined;if(scalar.bytes !== scalar.payload_bytes || !Number.isSafeInteger(scalar.bytes) || scalar.bytes < 1 || scalar.bytes > RESTORE_AUDIT_UNIT_BYTES)fail();admit(scalar.bytes);return scratch.get(lane,roomId,domain,key);
 };
 const set=(domain,key,value)=>{const n=Buffer.byteLength(JSON.stringify(value));if(n<1||n>RESTORE_AUDIT_UNIT_BYTES)fail();scratch.set('history',roomId,domain,key,value);queuedSizes.set(identity('history',domain,key),n);};
 const eventRow=sequence=>{
  const scalar=db.prepare('SELECT rowid,sequence,length(CAST(body AS BLOB)) bytes FROM events WHERE room_id=? AND sequence=?').get(roomId,sequence);
  if(!scalar)return null;if(!Number.isSafeInteger(scalar.bytes)||scalar.bytes<1||scalar.bytes>eventMax||scalar.sequence!==sequence)fail();admit(scalar.bytes+4096);
  const row=db.prepare('SELECT sequence,body FROM events WHERE rowid=?').get(scalar.rowid);return{sequence:row.sequence,event:JSON.parse(row.body)};
 };
 const stateFor=(work,ids=[])=>{
  const members=Object.create(null);for(const id of new Set([...ids,work?.accountableMemberId]))if(typeof id==='string'){const value=get('helpMember',id);if(value!==undefined)members[id]=value;}
  return{room:p.room&&{...p.room},members,workItems:work?{[work.id]:work}:{}};
 };
 const startCompare=target=>{p.stage='compare';p.comparison={target,stage:'work',after:'',helps:0,offers:0};};
 const advanceSequence=sequence=>{p.sequence=sequence;if(p.checkpoint&&!p.checkpointChecked&&p.sequence===p.checkpoint.sequence)startCompare('checkpoint');};
 const nextActual=(domain,after)=>scratch.nextKey('actual',roomId,domain,after);
 const nextExpected=(domain,after)=>scratch.nextKey('history',roomId,domain,after);
 const compareParticipantDomain=target=>target==='checkpoint'?'helpCpParticipant':'helpCurrentParticipant';
 try{
  while(units < maxUnits && bytes < QUANTUM && scratch.remaining >= 8 && !['complete','deferred'].includes(p.stage)){
   if(p.stage==='basis'){
    const checkpoint=db.prepare('SELECT sequence,length(CAST(projection AS BLOB)) bytes FROM projection_checkpoints WHERE room_id=?').get(roomId);
    if(checkpoint){if(!Number.isSafeInteger(checkpoint.sequence)||checkpoint.sequence<0||checkpoint.sequence>head.sequence||!Number.isSafeInteger(checkpoint.bytes)||checkpoint.bytes<2||checkpoint.bytes>checkpointMax)fail();p.checkpoint={sequence:checkpoint.sequence,bytes:checkpoint.bytes};p.scan=initialRecoveryProjectionScan(checkpoint.bytes);p.stage='checkpoint';}
    else{p.checkpointChecked=true;p.stage='discover';}units++;continue;
   }
   if(p.stage==='checkpoint'){
    const cp=p.checkpoint,length=Math.min(REPLAY_CODEC_INPUT_BYTES,cp.bytes-p.scan.offset);if(length<1)fail();admit(length+4096);
    const input=raw(db.prepare('SELECT substr(CAST(projection AS BLOB),?,?) bytes FROM projection_checkpoints WHERE room_id=?').get(p.scan.offset+1,length,roomId).bytes);
    let step;try{step=scanRecoveryProjectionChunk(p.scan,input,{maximumRecords:1});}catch(error){if(error.message==='unsupported or corrupt replay projection codec'){p.stage='deferred';p.scan=null;p.reason='checkpoint_shape_requires_original_oracle';break;}throw error;}
    const record=step.records[0];
    if(record){
     let domain=null,key=null,value,decoded;
     if(['metadata-map','metadata-array'].includes(record.kind)){
      try{recoveryProjectionFrame(record,cp.bytes);}catch(error){if(error.message!=='unsupported or corrupt replay projection codec')throw error;p.stage='deferred';p.scan=null;p.reason='checkpoint_shape_requires_original_oracle';break;}
     }else{
      // Validate even discarded leaves with the ORIGINAL codec decoder. Never
      // ask SQLite to parse/materialize the entire checkpoint in one json_valid.
      admit(record.length);const input=raw(db.prepare('SELECT substr(CAST(projection AS BLOB),?,?) bytes FROM projection_checkpoints WHERE room_id=?').get(record.offset+1,record.length,roomId).bytes);
      try{decoded=decodeRecoveryProjectionSpan(input,record,cp.bytes);}catch(error){if(error instanceof SyntaxError)fail();if(error.message!=='unsupported or corrupt replay projection codec')throw error;p.stage='deferred';p.scan=null;p.reason='checkpoint_shape_requires_original_oracle';break;}
     }
     if(record.kind==='metadata-entry'&&['workItems','members','helpOffers'].includes(record.key)){
      value=decoded;key=record.entryKey;
      if(record.key==='workItems'){const help=workHelpAuditHelp(value);if(help!==undefined){domain='helpCpWork';value={...workHelpAuditWorkFacts(value),helpWanted:help};}}
      else if(record.key==='members'){domain='helpCpMember';value=workHelpAuditMemberFacts(value);}
      else domain='helpCpOffer';
     }else if(record.kind==='metadata'&&record.key==='room'){
      domain='helpCpMetadata';key='room';value={id:decoded?.id,ownerId:decoded?.ownerId};
     }else if(record.kind==='metadata'&&['workItems','members','helpOffers'].includes(record.key)){
      p.stage='deferred';p.scan=null;p.reason='checkpoint_map_shape_requires_original_oracle';break;
     }
     if(domain){const encoded=JSON.stringify(value);if(Buffer.byteLength(encoded)>RESTORE_AUDIT_UNIT_BYTES){p.stage='deferred';p.scan=null;p.reason='checkpoint_help_atom_requires_original_oracle';break;}set(domain,key,value);}
    }
    if(record)p.checkpointRecords++;p.scan=step.state;units++;
    if(p.scan.phase==='done'&&p.scan.offset===cp.bytes){p.checkpointOffers=p.scan.keys.includes('helpOffers');p.scan=null;p.stage='discover';}continue;
   }
   if(p.stage==='discover'){
    const row=eventRow(p.discoverSequence+1);
    if(!row){if(p.discoverSequence!==head.sequence)fail();if(!p.relevant){startCompare(p.checkpoint?'checkpoint':'current');}else if(p.checkpoint?.sequence===0){startCompare('checkpoint');}else p.stage='events';continue;}
    const e=row.event;if(e.type === WORK_HELP_UPDATED || offerTypes.has(e.type)){if(!validId(e.data.workItemId))fail();const seen=get('helpRelevant',e.data.workItemId);if(seen===undefined){set('helpRelevant',e.data.workItemId,true);p.relevant++;}else if(seen!==true)fail();}
    p.discoverSequence=row.sequence;units++;continue;
   }
   if(p.stage==='events'){
    const row=eventRow(p.sequence+1);if(!row){if(p.sequence!==head.sequence||!p.checkpointChecked)fail();startCompare('current');continue;}
    const e=row.event,d=e.data,relevant=typeof d.workItemId==='string'&&get('helpRelevant',d.workItemId)===true;
    if(offerTypes.has(e.type)&&relevant){set('helpExpansion','current',{sequence:row.sequence,event:{id:e.id,actorId:e.actorId,roomId:e.roomId,type:e.type,at:e.at,data:e.data}});p.stage='offers';p.expansion={after:'',count:0,pendingForWork:0,pendingForViewer:0,existingOfferId:null,selectedOfferId:null};continue;}
    const memberIds=['member.added','member.joined_via_invitation','member.access_changed'].includes(e.type)?[d.memberId]:e.type==='ownership.transferred'?[d.toMemberId,p.room?.ownerId]:[];
    const previousWork=relevant?get('helpWork',d.workItemId):undefined,state=stateFor(previousWork,[...memberIds,e.actorId]);
    advanceWorkHelpMembers(state,e);let work=previousWork;
    if(relevant)work=advanceWorkHelpWork(work,e);
    const priorHelp=own(work,'helpWanted');if(e.type===WORK_HELP_UPDATED&&relevant){state.workItems[d.workItemId]=work;work.helpWanted=helpFromEvent(state,e);}
    // All reads and validation precede this atom's first persisted scratch effect.
    p.room=state.room;for(const id of new Set(memberIds))if(typeof id==='string'&&own(state.members,id))set('helpMember',id,state.members[id]);
    if(relevant&&(e.type==='work.proposed'||WORK_REVISION_TYPES.includes(e.type)||e.type===WORK_HELP_UPDATED)){set('helpWork',d.workItemId,work);if(!priorHelp&&own(work,'helpWanted'))p.helps++;}
    advanceSequence(row.sequence);units++;continue;
   }
   if(p.stage==='offers'){
    const staged=get('helpExpansion','current');if(staged?.sequence!==p.sequence+1||!offerTypes.has(staged.event?.type))fail();const row={sequence:staged.sequence},e=staged.event,d=e.data,x=p.expansion;
    const key=nextExpected('helpOffer',x.after);
    if(key!==undefined){
     const offer=get('helpOffer',key);if(!offer)fail();const work=get('helpWork',offer.workItemId),state=stateFor(work,[offer.offererId]);
     validateHelpOfferRecord(state,key,offer);
     const identity=get('helpIdentity',helpOfferIdentity(offer));if(identity!==offer.id)fail();
     if(offer.status==='selected'&&get('helpSelected',offer.workItemId)!==offer.id)fail();
     const target=get('helpWork',d.workItemId),targetState=stateFor(target,[e.actorId]),help=workHelpContext(targetState,d.workItemId,e.actorId,e.at);
     const active=offer.status==='offered'&&helpOfferIsCurrent(state,offer,e.at);
     if(offer.workItemId===d.workItemId&&offer.invitation.eventId===help.eventId&&offer.offererId===e.actorId){if(x.existingOfferId!==null)fail();x.existingOfferId=offer.id;}
     if(offer.status==='selected'&&offer.workItemId===d.workItemId){if(x.selectedOfferId!==null)fail();x.selectedOfferId=offer.id;}
     if(active){if(offer.workItemId===d.workItemId)x.pendingForWork++;if(offer.offererId===e.actorId)x.pendingForViewer++;}
     x.count++;p.offerChecks++;if(x.count>MAX_HELP_OFFERS)fail();x.after=key;units++;continue;
    }
    if(x.count!==p.offers)fail();
    const work=get('helpWork',d.workItemId),prior=get('helpOffer',d.offerId),state=stateFor(work,[e.actorId,prior?.offererId]);
    const selected=get('helpSelected',d.workItemId);if((selected??null)!==x.selectedOfferId)fail();
    const facts={retained:x.count,existingOfferId:x.existingOfferId,selectedOfferId:x.selectedOfferId,pendingForWork:x.pendingForWork,pendingForViewer:x.pendingForViewer};
    const offer=helpOfferFromQualifiedFacts(state,e,{prior:prior??null,availability:()=>helpOfferAvailabilityFromCounts(state,d.workItemId,e.actorId,e.at,facts),context:value=>helpOfferContextFromSelection(state,value,e.actorId,e.at,x.selectedOfferId)});
    const identityKey=helpOfferIdentity(offer),identity=get('helpIdentity',identityKey);
    if(e.type===HELP_OFFER_OPENED?identity!==undefined:identity!==offer.id)fail();
    if(e.type===HELP_OFFER_OPENED){set('helpIdentity',identityKey,offer.id);p.offers++;}if(p.offers>MAX_HELP_OFFERS)fail();
    if(offer.status==='selected')set('helpSelected',offer.workItemId,offer.id);else if(prior?.status==='selected')set('helpSelected',offer.workItemId,null);
    set('helpOffer',offer.id,offer);p.offersPresent=true;p.expansion=null;p.stage='events';advanceSequence(row.sequence);units++;continue;
   }
   if(p.stage==='compare'){
    const c=p.comparison,target=c.target,cp=target==='checkpoint',participantDomain=compareParticipantDomain(target);
    if(c.stage==='work'){
     const domain=cp?'helpCpWork':'workBody',key=cp?nextExpected(domain,c.after):nextActual(domain,c.after);
     if(key!==undefined){const actual=get(domain,key,{lane:cp?'history':'actual'}),expected=get('helpWork',key),help=workHelpAuditHelp(actual),wanted=workHelpAuditHelp(expected);workHelpAuditValue(help,wanted);
      if(help!==undefined){workHelpAuditValue(workHelpAuditWorkFacts(actual),workHelpAuditWorkFacts(expected));set(participantDomain,expected.accountableMemberId,true);c.helps++;}c.after=key;units++;continue;}
     if(c.helps!==p.helps)fail();
     if(!cp&&get('metadata','helpOffers',{lane:'actual'})!==undefined)fail();
     const shape=cp?p.checkpointOffers:get('shape','helpOffers',{lane:'actual'})!==undefined;if(shape!==p.offersPresent)fail();
     c.stage='offers';c.after='';continue;
    }
    if(c.stage==='offers'){
     const domain=cp?'helpCpOffer':'helpOffers',key=cp?nextExpected(domain,c.after):nextActual(domain,c.after);
     if(key!==undefined){const actual=get(domain,key,{lane:cp?'history':'actual'}),expected=get('helpOffer',key);workHelpAuditValue(actual,expected);if(p.helps)set(participantDomain,expected.offererId,true);c.offers++;c.after=key;units++;continue;}
     if(c.offers!==p.offers)fail();if(p.helps){const room=get(cp?'helpCpMetadata':'metadata','room',{lane:cp?'history':'actual'});if(room?.id!==p.room?.id||room?.ownerId!==p.room?.ownerId)fail();set(participantDomain,p.room.ownerId,true);}c.stage='members';c.after='';continue;
    }
    const key=p.helps?nextExpected(participantDomain,c.after):undefined;
    if(key!==undefined){const actual=get(cp?'helpCpMember':'members',key,{lane:cp?'history':'actual'}),expected=get('helpMember',key);workHelpAuditValue(workHelpAuditMemberFacts(actual),workHelpAuditMemberFacts(expected));c.after=key;units++;continue;}
    p.comparison=null;if(cp){p.checkpointChecked=true;if(p.relevant)p.stage='events';else startCompare('current');}else p.stage='complete';units++;
   }
  }
 }catch(error){if(error!==pause)throw error;}
 validateRecoveryWorkHelp(p);return{cursor:p,units,bytes,done:['complete','deferred'].includes(p.stage)};
}
