import {Buffer} from 'node:buffer';
import {initialCharterAudit,advanceCharterAudit} from '../src/room-charter.js';
import {RESTORE_AUDIT_UNIT_BYTES} from './restore-admission.mjs';
const fail=()=>{throw Error('Recovery room instructions require reconciliation');};
const canonical=value=>value&&typeof value==='object'?JSON.stringify(Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]]))):JSON.stringify(value);
export const initialRecoveryCharter=()=>({version:1,stage:'events',sequence:0,facts:initialCharterAudit(),atCheckpoint:null});
export function validateRecoveryCharter(p){
 if(!p||Object.keys(p).sort().join(',')!=='atCheckpoint,facts,sequence,stage,version'||p.version!==1||!['events','compare','complete'].includes(p.stage)||!Number.isSafeInteger(p.sequence)||p.sequence<0||!p.facts||Object.keys(p.facts).sort().join(',')!=='current,ownerId'||p.facts.ownerId!==null&&(typeof p.facts.ownerId!=='string'||Buffer.byteLength(p.facts.ownerId)>128)||Buffer.byteLength(JSON.stringify(p))>RESTORE_AUDIT_UNIT_BYTES)fail();
}
export function advanceRecoveryCharter(store,scratch,restoreId,roomId,previous,seal){
 validateRecoveryCharter(previous);const p={...previous,facts:{...previous.facts}},db=store.db;let units=0,bytes=0;
 const maximum=seal?.tables?.find(t=>t.name==='events')?.maxRowBytes;
 if(!Number.isSafeInteger(maximum)||maximum<0)fail();
 const checkpoint=db.prepare('SELECT sequence,length(CAST(projection AS BLOB)) bytes FROM projection_checkpoints WHERE room_id=?').get(roomId);
 const memberDomain='charterMember';
 const members={has:key=>typeof key==='string'&&scratch.get('history',roomId,memberDomain,key)!==undefined,get:key=>typeof key==='string'?scratch.get('history',roomId,memberDomain,key):undefined,set:(key,value)=>scratch.set('history',roomId,memberDomain,key,value)};
 while(p.stage==='events'&&units<32&&scratch.remaining>=2){
  const scalar=db.prepare('SELECT rowid,sequence,length(CAST(body AS BLOB)) bytes FROM events WHERE room_id=? AND sequence>? ORDER BY sequence LIMIT 1').get(roomId,p.sequence);
  if(!scalar){p.stage='compare';break;}
  if(!Number.isSafeInteger(scalar.bytes)||scalar.bytes<1||scalar.bytes>maximum||scalar.sequence!==p.sequence+1)fail();
  if(units&&bytes+scalar.bytes+4096>4*1024*1024)break;
  const row=db.prepare('SELECT body FROM events WHERE rowid=?').get(scalar.rowid);advanceCharterAudit(p.facts,JSON.parse(row.body),members,roomId);
  if(checkpoint&&scalar.sequence<=checkpoint.sequence)p.atCheckpoint=p.facts.current;
  p.sequence=scalar.sequence;units++;bytes+=scalar.bytes+4096;
 }
 if(p.stage==='compare'){
  const scalar=db.prepare("SELECT payload_bytes,length(CAST(payload AS BLOB)) bytes FROM current_restore_audit_scratch WHERE restore_id=? AND lane='actual' AND room_id=? AND domain='metadata' AND unit_key='room' AND part=0").get(restoreId,roomId);
  if(!scalar || scalar.bytes !== scalar.payload_bytes || !Number.isSafeInteger(scalar.bytes) || scalar.bytes < 1 || scalar.bytes > RESTORE_AUDIT_UNIT_BYTES)fail();
  const estimate=scalar.bytes+(checkpoint?.bytes??0)+4096;
  if(!Number.isSafeInteger(estimate)||estimate<0)fail();
  if(units&&bytes+estimate>4*1024*1024)return{cursor:p,units,bytes,done:false};
  const actual=scratch.get('actual',roomId,'metadata','room');
  if(p.facts.ownerId!==actual?.ownerId||canonical(actual.charter??null)!==canonical(p.facts.current))fail();
  if(checkpoint){
   const entry=seal.tables.find(t=>t.name==='projection_checkpoints');if(!entry||checkpoint.bytes>entry.maxRowBytes)fail();
   const saved=db.prepare("SELECT json_extract(projection,'$.room.charter') charter FROM projection_checkpoints WHERE room_id=?").get(roomId);
   if(canonical(saved.charter===null?null:JSON.parse(saved.charter))!==canonical(p.atCheckpoint))fail();
  }
  p.stage='complete';units++;bytes+=estimate;
 }
 return{cursor:p,units,bytes,done:p.stage==='complete'};
}
