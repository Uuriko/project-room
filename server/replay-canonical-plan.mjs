// Explicit operator planning only. This describes current write-proof authority;
// it never certifies old history or rewrites the historical integrity baseline.
import {createHash} from 'node:crypto';
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export function canonicalCurrentProofPlan(roomId,tuple){
 if(typeof roomId!=='string'||Buffer.byteLength(roomId)<1||Buffer.byteLength(roomId)>200
   ||!Number.isSafeInteger(tuple?.head)||tuple.head<1||tuple.message_authority_type!=='object'
   ||!digest(tuple.metadata_hash)||!Number.isSafeInteger(tuple.historical_checkpoint_sequence)
   ||tuple.historical_checkpoint_sequence<1||tuple.historical_checkpoint_sequence>=tuple.head||!digest(tuple.content_hash))
  throw Error('Explicit current-write-proof plan requires a stale canonical checkpoint and current metadata proof');
 const plan={version:1,roomId,expectedHead:tuple.head,contentBasis:'current-write-proofs',metadataHash:tuple.metadata_hash,
  historicalCheckpoint:{sequence:tuple.historical_checkpoint_sequence,contentHash:tuple.content_hash},
  checkpointComparison:'unavailable-stale',historyProvenance:'unknown',certified:false,
  proofLimits:['Qualifies complete current membership and existing code-owned row and metadata write proofs.',
   'The computed current digest is not compared with the stale historical checkpoint.',
   'Does not defend against a database administrator replacing both data and write proofs.',
   'Preserves the original historical checkpoint; never certifies or adopts old history.']};
 return {...plan,planHash:createHash('sha256').update(JSON.stringify(plan)).digest('hex')};
}
export function planCanonicalReplayCapture(store,{roomId,expectedHead}={}){
 return store.readTransaction(()=>{
  const tuple=store.db.prepare(`SELECT r.sequence AS head,p.metadata_hash,
    p.sequence AS historical_checkpoint_sequence,p.projection_hash AS content_hash,
    CASE WHEN json_valid(r.projection) THEN json_type(r.projection,'$.messageAuthority') END AS message_authority_type
    FROM rooms r LEFT JOIN integrity_room_state p ON p.room_id=r.id WHERE r.id=?`).get(roomId);
  if(tuple?.head!==expectedHead)throw Error('Replay current-proof plan head changed');
  return canonicalCurrentProofPlan(roomId,tuple);
 });
}
