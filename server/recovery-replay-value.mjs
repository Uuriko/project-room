import {Buffer} from 'node:buffer';
import {initialReplayHash,advanceReplayHash,finishReplayHash} from './replay-sha256.mjs';
// One independently admitted reducer/checkpoint value, never a whole room.
// Parts occupy the existing target-owned scratch PK's part column. A caller
// commits the parts, head and replay cursor in the SAME restore transaction.
export const RECOVERY_VALUE_PART_BYTES=64*1024;
const fail=()=>{throw Error('Recovery replay value requires reconciliation');};
const bound=value=>{if(!Number.isSafeInteger(value)||value<1)fail();return value;};
function hash(bytes){let state=initialReplayHash();for(let i=0;i<bytes.length;i+=RECOVERY_VALUE_PART_BYTES)state=advanceReplayHash(state,bytes.subarray(i,i+RECOVERY_VALUE_PART_BYTES));return finishReplayHash(state);}
export function planRecoveryReplayValue(value,maximumBytes){
 bound(maximumBytes);const text=JSON.stringify(value);if(typeof text!=='string')fail();const bytes=Buffer.from(text);if(bytes.length>maximumBytes)fail();
 if(bytes.length <= RECOVERY_VALUE_PART_BYTES)return{rows : 1 , bytes : bytes.length , head : {version : 1 , kind : 'json' , bytes : bytes.length , value} , part(){fail();}};
 const parts=Math.ceil(bytes.length/RECOVERY_VALUE_PART_BYTES),head={version:1,kind:'parts',bytes:bytes.length,parts,sha256:hash(bytes)};
 return{rows:parts+1,bytes:bytes.length,head,part(index){if(!Number.isSafeInteger(index)||index<1||index>parts)fail();return bytes.subarray((index-1)*RECOVERY_VALUE_PART_BYTES,index*RECOVERY_VALUE_PART_BYTES).toString('base64');}};
}
export function readRecoveryReplayValue(scratch,roomId,domain,key,maximumBytes,{admit}={}){
 if(admit!==undefined&&typeof admit!=='function')fail();
 bound(maximumBytes);const head=scratch.get('replay',roomId,domain,key,0);if(head===undefined)return undefined;
 if(head?.version!==1||!Number.isSafeInteger(head.bytes)||head.bytes<1||head.bytes>maximumBytes)fail();
 if(admit)admit(head.bytes);
 if(head.kind==='json'){
  if(Object.keys(head).sort().join(',') !== 'bytes,kind,value,version' || head.bytes > RECOVERY_VALUE_PART_BYTES || Buffer.byteLength(JSON.stringify(head.value)) !== head.bytes)fail();return head.value;
 }
 if(head.kind !== 'parts' || Object.keys(head).sort().join(',') !== 'bytes,kind,parts,sha256,version' || head.bytes <= RECOVERY_VALUE_PART_BYTES || head.parts !== Math.ceil(head.bytes / RECOVERY_VALUE_PART_BYTES) || !/^[a-f0-9]{64}$/.test(head.sha256))fail();
 const bytes=Buffer.alloc(head.bytes);let offset=0;
 for(let part=1;part<=head.parts;part++){
  const encoded=scratch.get('replay',roomId,domain,key,part);if(typeof encoded!=='string'||encoded.length>4*Math.ceil(RECOVERY_VALUE_PART_BYTES/3))fail();const chunk=Buffer.from(encoded,'base64');
  if(chunk.toString('base64')!==encoded||chunk.length!==Math.min(RECOVERY_VALUE_PART_BYTES,head.bytes-offset))fail();bytes.set(chunk,offset);offset+=chunk.length;
 }
 if(offset!==head.bytes||hash(bytes)!==head.sha256)fail();
 return JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes));
}
export function writeRecoveryReplayValue(scratch,roomId,domain,key,plan){
 // Exhaustion never exposes a partial head; the owner checkpoints its earlier
 // independent units and retries this exact value in the next transaction.
 if(!plan||!Number.isSafeInteger(plan.rows)||plan.rows<1)fail();if(scratch.remaining<plan.rows)return false;
 for(let part=1;part<plan.rows;part++)scratch.set('replay',roomId,domain,key,plan.part(part),part);
 scratch.set('replay',roomId,domain,key,plan.head,0);return true;
}
