import {isDeepStrictEqual} from 'node:util';
import {prepareClaimOverlap,matchClaimOverlap} from '../src/claim-overlap.js';
import {initialReplayHash,advanceReplayHash,finishReplayHash} from './replay-sha256.mjs';
import {initialRecoveryCheckpointSeed,validateRecoveryCheckpointSeed,advanceRecoveryCheckpointSeed} from './recovery-checkpoint-seed.mjs';
import {validateRecoveryHistoryEntry} from './recovery-history-entry.mjs';
import {savedHistoricalReplayCheckpoint,HISTORICAL_REPLAY_MAX_INPUT_BYTES} from './historical-replay-contract.mjs';
import {applyRecoveryReplayStep} from './recovery-replay-step.mjs';
import {planRecoveryReplayValue,readRecoveryReplayValue,writeRecoveryReplayValue} from './recovery-replay-value.mjs';
// Transitional independent fold over the frozen original source. Unsupported
// dependency/basis plans remain explicit and the original FULL oracle remains
// required for every room, including a room whose addressed fold completes.
const historicalDigest=bytes=>finishReplayHash(advanceReplayHash(initialReplayHash(),bytes));
export const initialRecoveryReplay=()=>({version:3,checkpoint:null,expansion:null,stage:'basis',sequence:0,counts:{members:0,channels:0,workItems:0,replyRequests:0,messages:0,replyRequestsPresent:false},reason:null});
export function validateRecoveryReplay(cursor){
 if(!cursor||Object.keys(cursor).sort().join(',')!=='checkpoint,counts,expansion,reason,sequence,stage,version'||cursor.version!==3||!['basis','checkpoint','events','complete','deferred'].includes(cursor.stage)||!Number.isSafeInteger(cursor.sequence)||cursor.sequence<0||!cursor.counts||Object.keys(cursor.counts).sort().join(',')!=='channels,members,messages,replyRequests,replyRequestsPresent,workItems'||!['members','channels','messages','workItems','replyRequests'].every(key=>Number.isSafeInteger(cursor.counts[key])&&cursor.counts[key]>=0)||typeof cursor.counts.replyRequestsPresent!=='boolean'||cursor.reason!==null&&(typeof cursor.reason!=='string'||cursor.reason.length>128)||((cursor.stage==='deferred')!==(cursor.reason!==null)))throw Error('Recovery replay cursor requires reconciliation');
 if(cursor.expansion!==null){const e=cursor.expansion;if(!e||Object.keys(e).sort().join(',')!=='after,eventId,found,sequence,stage'||!['scan','ready'].includes(e.stage)||typeof e.after!=='string'||e.after.length>18||e.after!==''&&!/^(0:[0-9]{10}|1:[0-9]{16})$/.test(e.after)||typeof e.eventId!=='string'||!e.eventId||!Number.isSafeInteger(e.sequence)||e.sequence!==cursor.sequence+1||!Number.isSafeInteger(e.found)||e.found<0||e.found>10||cursor.stage!=='events')throw Error('Recovery claim scan requires reconciliation');}
 if(cursor.checkpoint!==null)validateRecoveryCheckpointSeed(cursor.checkpoint);
 if(cursor.stage==='checkpoint'&&cursor.checkpoint===null)throw Error('Recovery checkpoint cursor missing');
}
export function advanceRecoveryReplay(db,scratch,roomId,previous,seal){
 validateRecoveryReplay(previous);const cursor=structuredClone(previous);let units=0,bytes=0,historical=null;
 const defer=reason=>{cursor.stage='deferred';cursor.expansion=null;cursor.reason=reason;return{cursor,units,bytes,done:true};};
 const events=seal?.tables?.find(table=>table.name==='events'),checkpoint=seal?.tables?.find(table=>table.name==='projection_checkpoints');
 if(!events||!Number.isSafeInteger(events.maxRowBytes)||events.maxRowBytes<0)throw Error('Recovery replay source admission differs');
 const maximumValueBytes=4096+9*[events,checkpoint].filter(Boolean).reduce((sum,table)=>sum+table.maxRowBytes*table.expected.rows,0);if(!Number.isSafeInteger(maximumValueBytes)||maximumValueBytes<1)throw Error('Recovery replay source budget differs');
 const head=db.prepare('SELECT sequence FROM rooms WHERE id=?').get(roomId);if(!Number.isSafeInteger(head?.sequence)||head.sequence<0)throw Error('Recovery replay head differs');
 if(cursor.stage==='basis'){
  const held=db.prepare('SELECT sequence,length(CAST(projection AS BLOB)) bytes FROM projection_checkpoints WHERE room_id=?').get(roomId);
  if(!held||held.sequence===0){
   // Existing exact64event/256KiB historical proof takes precedence atzero.
   const saved=savedHistoricalReplayCheckpoint(db,roomId,head.sequence);historical=saved;if(saved){const bytes=new TextEncoder().encode(saved.json);cursor.checkpoint=initialRecoveryCheckpointSeed(saved.sequence,bytes.length,{sourceKind:'historical',sourceDigest:historicalDigest(bytes)});cursor.stage='checkpoint';}
  }
  if(cursor.stage==='checkpoint'){/* Exact saved proof takes precedence over a zero checkpoint. */}
  else if(held){if(!Number.isSafeInteger(held.sequence)||held.sequence<0||held.sequence>head.sequence||!Number.isSafeInteger(held.bytes)||held.bytes<2||held.bytes>(checkpoint?.maxRowBytes??0))throw Error('Recovery checkpoint source admission differs');cursor.checkpoint=initialRecoveryCheckpointSeed(held.sequence,held.bytes);cursor.stage='checkpoint';}
  else cursor.stage='events';
 }
 let historicalBytes=null;if(cursor.checkpoint?.sourceKind==='historical'){const saved=historical??savedHistoricalReplayCheckpoint(db,roomId,head.sequence);if(!saved||saved.sequence!==cursor.checkpoint.sequence||typeof saved.json!=='string')throw Error('Saved recovery basis requires reconciliation');historicalBytes=new TextEncoder().encode(saved.json);if(historicalDigest(historicalBytes)!==cursor.checkpoint.sourceDigest)throw Error('Saved recovery basis changed');bytes=HISTORICAL_REPLAY_MAX_INPUT_BYTES;}
 if(cursor.stage==='checkpoint'){const result=advanceRecoveryCheckpointSeed(db,scratch,roomId,cursor.checkpoint,maximumValueBytes,historicalBytes);cursor.checkpoint=result.cursor;units=result.units;bytes+=result.bytes;if(result.cursor.stage==='deferred')return defer(result.cursor.reason);if(result.cursor.stage==='complete'){cursor.sequence=result.cursor.sequence;cursor.counts=result.cursor.counts;cursor.stage='events';}return{cursor,units,bytes,done:false};}
 if(['complete','deferred'].includes(cursor.stage))return{cursor,units,bytes,done:true};
 while(units<128){
  const scalar=db.prepare('SELECT rowid,sequence,length(CAST(body AS BLOB)) bytes FROM events WHERE room_id=? AND sequence>? ORDER BY sequence LIMIT 1').get(roomId,cursor.sequence);
  if(!scalar){if(cursor.sequence!==head.sequence)throw Error('Recovery replay tail differs');cursor.stage='complete';return{cursor,units,bytes,done:true};}
  if(!Number.isSafeInteger(scalar.bytes)||scalar.bytes<1||scalar.bytes>events.maxRowBytes)throw Error('Recovery replay event bytes differ');
  if(bytes+scalar.bytes>4*1024*1024&&!units)return defer('replay_atom_requires_staging');
  if(units&&bytes+scalar.bytes>4*1024*1024)break;
  const row=db.prepare('SELECT sequence,id,body FROM events WHERE rowid=?').get(scalar.rowid),incoming=validateRecoveryHistoryEntry(row,cursor.sequence+1,roomId);
  let readBytes=0,result,claimOverlaps;const budget=Symbol('replay_atom_byte_admission');
  const read=(domain,key)=>readRecoveryReplayValue(scratch,roomId,domain,key,maximumValueBytes,{admit(size){if(bytes+scalar.bytes+readBytes+size>4*1024*1024)throw budget;readBytes+=size;}});
  if(incoming.type==='claim.acquired'){
   if(cursor.expansion===null){cursor.expansion={stage:'scan',sequence:row.sequence,eventId:incoming.id,after:'',found:0};return{cursor,units,bytes:bytes+scalar.bytes,done:false};}
   const expansion=cursor.expansion;if(expansion.sequence!==row.sequence||expansion.eventId!==incoming.id)throw Error('Recovery claim source changed');
   let target,query;
   try{target=read('workItems',incoming.data.workItemId);query=prepareClaimOverlap(target?.id,incoming.data.repository,incoming.data.paths,incoming.at);
    while(expansion.stage==='scan'&&units<128){
     const key=scratch.nextKey('replay',roomId,'workOrder',expansion.after);if(key===undefined){expansion.stage='ready';break;}if(!/^(0:[0-9]{10}|1:[0-9]{16})$/.test(key))throw Error('Recovery work order changed');
     const id=read('workOrder',key);if(typeof id!=='string')throw Error('Recovery work order differs');const other=read('workItems',id);if(other===undefined)throw Error('Recovery ordered work missing');
     const match=matchClaimOverlap(query,other);if(match){const plan=planRecoveryReplayValue(match,maximumValueBytes);if(plan.rows > scratch.remaining || bytes + scalar.bytes + readBytes + plan.bytes > 4 * 1024 * 1024){if(units)return{cursor,units,bytes:bytes+readBytes+scalar.bytes,done:false};return defer('replay_atom_requires_staging');}if(!writeRecoveryReplayValue(scratch,roomId,'claimOverlap',JSON.stringify([incoming.id,expansion.found]),plan))throw Error('Recovery claim scan admission changed');expansion.found++;bytes+=plan.bytes;}
     expansion.after=key;units++;if(expansion.found===10)expansion.stage='ready';
    }
    if(expansion.stage!=='ready'||units===128)return{cursor,units,bytes:bytes+readBytes+scalar.bytes,done:false};
    const found=[];for(let index=0;index<expansion.found;index++){const match=read('claimOverlap',JSON.stringify([incoming.id,index]));if(match===undefined)throw Error('Recovery claim overlap missing');found.push(match);}
    claimOverlaps=(workItemId,repository,paths,at)=>{if(workItemId!==target?.id||repository!==incoming.data.repository||at!==incoming.at||!isDeepStrictEqual(paths,incoming.data.paths))throw Error('Recovery claim dependency differs');return structuredClone(found);};
   }catch(error){if(error!==budget)throw error;if(units)return{cursor,units,bytes:bytes+readBytes+scalar.bytes,done:false};return defer('replay_atom_requires_staging');}
  }else if(cursor.expansion!==null)throw Error('Recovery claim event differs');

  try{result=applyRecoveryReplayStep(read,incoming,cursor.counts,{claimOverlaps});}
  catch(error){if(error!==budget)throw error;if(units)break;return defer('replay_atom_requires_staging');}
  if(!result.supported)return defer(result.reason);
  const plans=result.patches.map(patch=>({...patch,plan:planRecoveryReplayValue(patch.value,maximumValueBytes)})),rows=plans.reduce((sum,patch)=>sum+patch.plan.rows,0),cost=scalar.bytes+readBytes+plans.reduce((sum,patch)=>sum+patch.plan.bytes,0);
  if(rows>scratch.remaining||bytes+cost>4*1024*1024){if(units)break;return defer('replay_atom_requires_staging');}
  for(const patch of plans)if(!writeRecoveryReplayValue(scratch,roomId,patch.domain,patch.key,patch.plan))throw Error('Recovery replay atom admission changed');
  cursor.sequence=row.sequence;cursor.counts=result.counts;cursor.expansion=null;units++;bytes+=cost;
 }
 return{cursor,units,bytes,done:false};
}
