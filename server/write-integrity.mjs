// Proofs change only with code-owned writes, in the same transaction as data.
// They detect unregistered mutation; this is not a defense against a database
// administrator who can replace both data and proofs.
import { createHash } from 'node:crypto';
import { hasMessageAuthority } from './message-authority.mjs';
const protocols = new WeakMap();
const replacements = new WeakMap();
const frames = new WeakMap();
export const projectionDigest = text => createHash('sha256').update(text).digest('hex');
export function configureWriteIntegrity(db, verifyLegacy) { protocols.set(db, verifyLegacy); }
export function assertProjectionWrite(db, roomId) {
  const verifyLegacy = protocols.get(db);
  if (!verifyLegacy || replacements.get(db)?.has(roomId)) return;
  if (!db.isTransaction) throw Error('Projection proof requires the write transaction');
  const row = db.prepare('SELECT sequence,projection FROM rooms WHERE id=?').get(roomId);
  if (!row) return;
  const proof = db.prepare('SELECT sequence,projection_hash,metadata_hash FROM integrity_room_state WHERE room_id=?').get(roomId);
  if (proof?.metadata_hash ? projectionDigest(row.projection) !== proof.metadata_hash : !verifyLegacy(roomId,row,proof))
    throw Error('projection_corrupt: stored metadata does not match its write proof');
}
// Only the owner-authorized, fully replayed import path may replace missing
// or corrupted old proof. Scope is one room and the surrounding transaction.
export function withVerifiedRoomReconstruction(db,roomId,operation) {
  if (!db.isTransaction) throw Error('History replacement requires its write transaction');
  let active=replacements.get(db);if(!active){active=new Set();replacements.set(db,active);}
  const previous=active.has(roomId);active.add(roomId);
  try{return operation();}finally{if(!previous)active.delete(roomId);}
}
export function beginWriteProofFrame(db) {
  let stack=frames.get(db);if(!stack){stack=[];frames.set(db,stack);}stack.push(new Map());
}
export function endWriteProofFrame(db,committed) {
  const stack=frames.get(db),current=stack?.pop();
  if (!committed || !current || !stack.length) return;
  const parent=stack.at(-1);
  for(const [roomId,hashes] of current) {
    const target=parent.get(roomId) ?? new Set();for(const hash of hashes)target.add(hash);parent.set(roomId,target);
  }
}
export function recordProjectionWrite(db, roomId, projection) {
  if (!protocols.has(db)) return;
  const current=frames.get(db)?.at(-1);
  if(!current)throw Error('Projection proof requires its transaction frame');
  const hashes=current.get(roomId) ?? new Set();hashes.add(projectionDigest(projection));current.set(roomId,hashes);
}
// Serialization is a candidate, not proof of persistence. Publish only bytes
// observed in rooms after a real write, and forget candidates at the boundary.
export function publishProjectionWrites(db,roomId=null) {
  if(!protocols.has(db))return;
  const stack=frames.get(db) ?? [];
  const ids=roomId===null ? new Set(stack.flatMap(frame=>[...frame.keys()])) : [roomId];
  for(const id of ids) {
    if(!stack.some(frame=>frame.has(id)))continue;
    const row=db.prepare('SELECT projection FROM rooms WHERE id=?').get(id);if(!row)continue;
    const hash=projectionDigest(row.projection);
    if(stack.some(frame=>frame.get(id)?.has(hash)))
      db.prepare('UPDATE integrity_room_state SET metadata_hash=? WHERE room_id=?').run(hash,id);
  }
}
export const MESSAGE_PROOF_FIELDS = Object.freeze(['message_id','seq','channel_id','thread_root_id','reply_to_id','to_member_id',
  'work_item_id','author_id','body','created_at','edited_at','deleted_at','reactions_json','pinned','record_json','reducer_extras_json']);
export const MESSAGE_PROOF_SELECT = MESSAGE_PROOF_FIELDS.join(',');
export function messageProofHash(row) {
  return projectionDigest(JSON.stringify(MESSAGE_PROOF_FIELDS.map(key=>row[key] ?? null)));
}
export function messageProofMatches(row) { return typeof row?.entity_hash==='string' && row.entity_hash===messageProofHash(row); }
export function assertMessageWrite(db,roomId,messageId) {
  if (!protocols.has(db)) return;
  const row=db.prepare(`SELECT ${MESSAGE_PROOF_SELECT},entity_hash FROM messages WHERE room_id=? AND message_id=?`).get(roomId,messageId);
  if (row?.entity_hash && !messageProofMatches(row)) throw Error('projection_corrupt: message does not match its write proof');
  if (row && !row.entity_hash && !replacements.get(db)?.has(roomId)
    && db.prepare("SELECT json_type(projection,'$.messageAuthority') AS authority FROM rooms WHERE id=?").get(roomId)?.authority)
    throw Error('projection_corrupt: message write proof requires migration');
}
// Call only after a trusted reducer/replay/erasure has written its result.
export function recordMessageWrite(db,roomId,messageId) {
  if (!protocols.has(db)) return;
  const row=db.prepare(`SELECT ${MESSAGE_PROOF_SELECT} FROM messages WHERE room_id=? AND message_id=?`).get(roomId,messageId);
  if (row) db.prepare('UPDATE messages SET entity_hash=? WHERE room_id=? AND message_id=?').run(messageProofHash(row),roomId,messageId);
}
// One traversal can validate independent write proofs and reproduce the exact
// existing v2 content digest. Streaming bounds memory, not total scan CPU.
function scanServingContent(db,roomId,sequence,projection,{verify,hashContent}) {
  const hash=hashContent ? createHash('sha256').update(roomId).update('\0').update(String(sequence)).update('\0').update(projection ?? '') : null;
  const state=JSON.parse(projection);
  let drift=false;
  if(verify) {
    const proof=db.prepare('SELECT metadata_hash FROM integrity_room_state WHERE room_id=?').get(roomId);
    drift=Boolean(proof?.metadata_hash && proof.metadata_hash!==projectionDigest(projection));
    if(drift && !hash)return {drift};
  }
  if(hasMessageAuthority(state)) {
    hash?.update('\0canonical-messages-v1\0');
    const archive=state.messagesArchive,retained=new Set(archive?.retainedIds ?? []);
    let count=0,visible=0;
    for(const row of db.prepare(`SELECT ${MESSAGE_PROOF_SELECT},entity_hash FROM messages WHERE room_id=? ORDER BY message_id`).iterate(roomId)) {
      if(verify && !messageProofMatches(row)){drift=true;if(!hash)return {drift};}
      if(hash) {
        const text=JSON.stringify(MESSAGE_PROOF_FIELDS.map(key=>row[key]));
        hash.update(String(Buffer.byteLength(text))).update(':').update(text);
      }
      count++;
      if(!archive || row.seq>archive.throughSeq || retained.has(row.message_id))visible++;
    }
    if(verify && (visible!==state.messageAuthority.count || count!==state.messageAuthority.count+(archive?.count ?? 0)))drift=true;
    if(drift && !hash)return {drift};
  }
  const references=state.workItems ?? {};
  if(Object.values(references).some(record=>record?._workEntity===1)) {
    hash?.update('\0canonical-work-v1\0');
    const seen=new Set();
    for(const row of db.prepare('SELECT work_id,revision,digest,body FROM work_entities WHERE room_id=? ORDER BY work_id').iterate(roomId)) {
      if(hash) {
        const text=JSON.stringify(Object.values(row));
        hash.update(String(Buffer.byteLength(text))).update(':').update(text);
      }
      const reference=references[row.work_id];
      if(!verify || reference?._workEntity!==1)continue;
      seen.add(row.work_id);
      if(reference.digest!==row.digest || reference.revision!==row.revision || projectionDigest(row.body)!==row.digest){drift=true;if(!hash)return {drift};}
    }
    if(verify && Object.entries(references).some(([id,record])=>record?._workEntity===1&&!seen.has(id)))drift=true;
  }
  return {drift,...(hash ? {hash:hash.digest('hex')} : {})};
}
export function projectionContentHash(db,roomId,sequence,projection) {
  return scanServingContent(db,roomId,sequence,projection,{verify:false,hashContent:true}).hash;
}
export function servingContentProof(db,roomId,sequence,projection) {
  return scanServingContent(db,roomId,sequence,projection,{verify:protocols.has(db),hashContent:true});
}
export function servingProofDrift(db,roomId,projection) {
  return protocols.has(db) && scanServingContent(db,roomId,null,projection,{verify:true,hashContent:false}).drift;
}

// Call only for a genuine older schema, or an explicitly attested legacy
// restore after its byte/count/FK checks. This establishes future protection,
// never historical verification. The caller owns the write transaction.
export function bootstrapLegacyWriteProofs(db) {
  if (!db.isTransaction) throw Error('Legacy write proofs require their write transaction');
  const insert = db.prepare(`INSERT OR IGNORE INTO integrity_room_state(room_id,sequence,projection_bytes) VALUES(?,?,?)`);
  const update = db.prepare('UPDATE integrity_room_state SET metadata_hash=? WHERE room_id=? AND metadata_hash IS NULL');
  let added = 0;
  for (const row of db.prepare('SELECT id,sequence,projection,LENGTH(projection) AS bytes FROM rooms').iterate()) {
    const proof = db.prepare('SELECT sequence,projection_hash,metadata_hash FROM integrity_room_state WHERE room_id=?').get(row.id);
    const hash = projectionDigest(row.projection);
    if (proof?.metadata_hash) {
      if (proof.metadata_hash !== hash) throw Error('projection_corrupt: stored metadata does not match its write proof');
      continue;
    }
    // A current metadata proof already covers legitimate writes after an
    // older historical baseline. Consult that baseline only when bootstrapping.
    if (proof?.projection_hash && (proof.sequence !== row.sequence
      || projectionContentHash(db,row.id,row.sequence,row.projection) !== proof.projection_hash))
      throw Error('projection_corrupt: legacy content does not match its baseline');
    insert.run(row.id,row.sequence,row.bytes);
    update.run(hash,row.id);
    added++;
  }
  return added;
}
