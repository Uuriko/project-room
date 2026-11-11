// Witness-first experiment only. Not imported by service code or a migration.
// The captured independent proof is preserved; a new self-hash is not authority.
export const BOOTSTRAP_CEILING = 8 * 1024 * 1024;
export const WITNESS_SLICE = 16 * 1024;
export const WITNESS_SCHEMA = `CREATE TABLE IF NOT EXISTS replay_projection_witness (
  capture_id TEXT NOT NULL, unit_kind TEXT NOT NULL, part INTEGER NOT NULL,
  room_id TEXT, head INTEGER, event_id TEXT, metadata_hash TEXT, content_hash TEXT,
  byte_length INTEGER, ceiling_bytes INTEGER, capture_mode TEXT, projection BLOB NOT NULL,
  PRIMARY KEY(capture_id,unit_kind,part)
)`;
export function captureProjectionWitness ( db , { captureId , roomId , expectedHead , ceilingBytes = BOOTSTRAP_CEILING , mode = 'whole' } ) {
  if (!['split','whole'].includes(mode)) throw Error('invalid witness mode');
  if (!db.isTransaction) throw Error('witness capture requires writer transaction');
  if (![captureId,roomId].every(x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(x))
    || !Number.isSafeInteger(expectedHead)||expectedHead<1
    || ! Number . isSafeInteger ( ceilingBytes ) || ceilingBytes < 1 || ceilingBytes > BOOTSTRAP_CEILING ) throw Error ( 'invalid witness input' ) ;
  const old=db.prepare(`SELECT
    CASE WHEN capture_mode IN ('split','whole') THEN capture_mode END AS capture_mode,
    CASE WHEN typeof(room_id)='text' AND octet_length(room_id)<=64 THEN room_id END AS room_id,
    CASE WHEN typeof(head)='integer' AND head BETWEEN 1 AND 9007199254740991 THEN head END AS head,
    CASE WHEN typeof(byte_length)='integer' AND byte_length BETWEEN 1 AND 8388608 THEN byte_length END AS byte_length,
    CASE WHEN typeof(ceiling_bytes)='integer' AND ceiling_bytes BETWEEN 1 AND 8388608 THEN ceiling_bytes END AS ceiling_bytes
    FROM replay_projection_witness WHERE capture_id=? AND unit_kind='header' AND part=0`).get(captureId);
  if (old) {
    if (old.capture_mode!==mode||old.room_id!==roomId||old.head!==expectedHead||old.ceiling_bytes!==ceilingBytes||old.byte_length===null) throw Error('witness intent conflict');
    return {room_id:old.room_id,head:old.head,byte_length:old.byte_length,duplicate:true};
  }
  const row=db.prepare(`SELECT
    CASE WHEN typeof(r.sequence)='integer' AND r.sequence BETWEEN 1 AND 9007199254740991 THEN r.sequence END AS head,
    CASE WHEN typeof(r.projection)='text' THEN octet_length(r.projection) END AS bytes,
    CASE WHEN typeof(p.sequence)='integer' AND p.sequence=r.sequence
      AND typeof(p.metadata_hash)='text' AND octet_length(p.metadata_hash)=64
      AND typeof(p.projection_hash)='text' AND octet_length(p.projection_hash)=64
      THEN 1 ELSE 0 END AS proved,
    CASE WHEN typeof(e.id)='text' AND octet_length(e.id) BETWEEN 1 AND 200 THEN 1 ELSE 0 END AS anchored
    FROM rooms r LEFT JOIN integrity_room_state p ON p.room_id=r.id
    LEFT JOIN events e ON e.room_id=r.id AND e.sequence=r.sequence WHERE r.id=?`).get(roomId);
  if (!row||row.head!==expectedHead) throw Error('witness head changed');
  if (!Number.isSafeInteger(row.bytes)||row.bytes>ceilingBytes) throw Error('witness byte ceiling');
  if (row.proved!==1||row.anchored!==1) throw Error('independent witness proof required');
  db.prepare(`INSERT INTO replay_projection_witness
    SELECT ?,'header',0,r.id,r.sequence,e.id,p.metadata_hash,p.projection_hash,
      octet_length(r.projection),?,?,CAST('' AS BLOB)
    FROM rooms r JOIN integrity_room_state p ON p.room_id=r.id
    JOIN events e ON e.room_id=r.id AND e.sequence=r.sequence WHERE r.id=?`).run(captureId,ceilingBytes,mode,roomId);
  if (mode==='whole') {
    db.prepare(`INSERT INTO replay_projection_witness(capture_id,unit_kind,part,projection)
      SELECT ?,'whole',0,CAST(projection AS BLOB) FROM rooms WHERE id=?`).run(captureId,roomId);
  } else db.prepare(`WITH RECURSIVE slices(part,offset) AS (
    VALUES(0,0) UNION ALL SELECT part+1,offset+? FROM slices WHERE offset+?<?
  ) INSERT INTO replay_projection_witness(capture_id,unit_kind,part,projection)
    SELECT ?,'page',part,substr(CAST(r.projection AS BLOB),offset+1,?)
    FROM rooms r CROSS JOIN slices WHERE r.id=?`)
    .run(WITNESS_SLICE,WITNESS_SLICE,row.bytes,captureId,WITNESS_SLICE,roomId);
  return {room_id:roomId,head:row.head,byte_length:row.bytes,duplicate:false};
}
export function witnessChunk(db,captureId,offset) {
  if (typeof captureId!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(captureId)
    ||!Number.isSafeInteger(offset)||offset<0||offset>BOOTSTRAP_CEILING) throw Error('invalid witness slice');
  if (offset%WITNESS_SLICE!==0) throw Error('unaligned witness slice');
  const whole=db.prepare(`SELECT substr(projection,?,?) AS chunk FROM replay_projection_witness
    WHERE capture_id=? AND unit_kind='whole' AND part=0 AND typeof(projection)='blob'
    AND length(projection)<=?`).get(offset+1,WITNESS_SLICE,captureId,BOOTSTRAP_CEILING)?.chunk;
  if (whole) return whole;
  return db.prepare(`SELECT projection AS chunk FROM replay_projection_witness
    WHERE capture_id=? AND unit_kind='page' AND part=?
      AND typeof(projection)='blob' AND length(projection)<=?`).get(captureId,offset/WITNESS_SLICE,WITNESS_SLICE)?.chunk??null;
}
