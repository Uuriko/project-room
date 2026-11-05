import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { ServiceError } from './service-error.mjs';
import { CURRENT_WRITER_FORMAT } from './current-room-format.mjs';

// Target-owned operational fence. Exported source rows can never grant admission
// to a target, and no ordinary SQL writer may clear an interrupted restore.
export const RESTORE_CONTROL_TABLE = 'current_restore_admission';
export const RESTORE_AUDIT_TABLE='current_restore_audit_scratch';
export const RESTORE_AUDIT_VERSION=20,RESTORE_REPORT_VERSION=1;
// Both known native schemas use the same sealed, bounded restore protocol.
// Future writer versions require explicit qualification, never a range check.
export const supportsSealedRestoreSource = version => version === 45 || version === 46;
export const RESTORE_AUDIT_UNIT_BYTES=131072+2048;
export const RESTORE_CONTROL_DEFINITIONS = [[RESTORE_CONTROL_TABLE, `CREATE TABLE IF NOT EXISTS current_restore_admission (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), state TEXT NOT NULL CHECK(state IN ('clear','pending')),
  restore_id TEXT, phase TEXT NOT NULL DEFAULT 'clear' CHECK(phase IN ('clear','loading','coverage','audit_pending')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0), source_seal TEXT, coverage TEXT, latest_receipt TEXT,
  CHECK((state='clear' AND restore_id IS NULL AND phase='clear' AND revision=0 AND source_seal IS NULL AND coverage IS NULL)
    OR (state='pending' AND length(restore_id)>0 AND phase='loading' AND source_seal IS NULL AND coverage IS NULL AND latest_receipt IS NULL)
    OR (state='pending' AND length(restore_id)>0 AND phase IN ('coverage','audit_pending') AND source_seal IS NOT NULL AND coverage IS NOT NULL)))`],
  [RESTORE_AUDIT_TABLE,`CREATE TABLE IF NOT EXISTS current_restore_audit_scratch (
    restore_id TEXT NOT NULL,lane TEXT NOT NULL CHECK(lane IN ('actual','replay','history','report')),room_id TEXT NOT NULL,
    domain TEXT NOT NULL,unit_key TEXT NOT NULL,part INTEGER NOT NULL CHECK(part>=0),
    payload_bytes INTEGER NOT NULL CHECK(payload_bytes BETWEEN 1 AND ${RESTORE_AUDIT_UNIT_BYTES}),payload TEXT NOT NULL,
    PRIMARY KEY(restore_id,lane,room_id,domain,unit_key,part))`]];
export const RESTORE_CONTROL_GUARDS = [RESTORE_CONTROL_TABLE,RESTORE_AUDIT_TABLE].flatMap(table=>['INSERT','UPDATE','DELETE'].map(operation => {
  const name=table+'_'+operation.toLowerCase();
  return [name,`CREATE TRIGGER IF NOT EXISTS ${name} BEFORE ${operation} ON ${table} BEGIN
    SELECT RAISE(ABORT,'unsupported restore admission mutation: durable-coverage-v1:${CURRENT_WRITER_FORMAT}:audit-scratch-${RESTORE_AUDIT_VERSION}:report-${RESTORE_REPORT_VERSION}'); END`];
}));
export const RESTORE_CONTROL_SCHEMA=RESTORE_CONTROL_DEFINITIONS.map(([,sql])=>sql).join(';\n')+`;
INSERT INTO current_restore_admission(singleton,state,restore_id) SELECT 1,'clear',NULL WHERE NOT EXISTS(SELECT 1 FROM current_restore_admission);`;
const scopes=new WeakSet();
const normalize=sql=>sql?.trim().replace(/;$/,'').replace(/IF NOT EXISTS /g,'').replace(/\s+/g,' ');
export function restorePending(db) {
  const row=db.prepare('SELECT state,restore_id FROM current_restore_admission WHERE singleton=1').get();
  if(!row || (row.state!=='clear' && row.state!=='pending') || (row.state==='clear' && row.restore_id!==null)
    || (row.state==='pending' && !row.restore_id)) throw Error('Restore admission requires reconciliation');
  return row.state==='pending';
}
const admittedSchemas=new WeakMap();
export function verifyRestoreControl(db) {
  const expected=[...RESTORE_CONTROL_DEFINITIONS,...RESTORE_CONTROL_GUARDS];
  let rows=admittedSchemas.get(db);
  if(rows) {
    const actual=db.prepare('SELECT rowid,name,sql FROM sqlite_master WHERE rowid IN ('+rows.map(()=>'?').join(',')+') ORDER BY rowid').all(...rows.map(row=>row.rowid));
    if(actual.length===rows.length && actual.every((row,i)=>row.rowid===rows[i].rowid&&row.name===rows[i].name&&row.sql===rows[i].sql))return;
    // VACUUM can relocate catalog rows without changing any definition.
    // A cache miss must revalidate the complete expected schema by name.
    admittedSchemas.delete(db);
  }
  rows=db.prepare('SELECT rowid,name,sql FROM sqlite_master WHERE name IN ('+expected.map(()=>'?').join(',')+') ORDER BY rowid').all(...expected.map(([name])=>name));
  if(rows.length!==expected.length || expected.some(([name,sql])=>normalize(rows.find(row=>row.name===name)?.sql)!==normalize(sql)))
    throw Error('Restore admission schema requires reconciliation');
  admittedSchemas.set(db,rows);
}
export function assertRestoreAdmitted(db) {
  if(scopes.has(db))return;
  verifyRestoreControl(db);
  if(!scopes.has(db) && restorePending(db)) throw new ServiceError(503,'restore_incomplete','Backup restore has not completed its independent recovery census');
}
export const inRestoreContext=db=>scopes.has(db);
export function withRestoreTransaction(store,operation) {
  const nested=scopes.has(store.db); scopes.add(store.db);
  try { return store.transaction(()=>{const value=operation();if(value?.then)throw Error('Restore must remain synchronous');return value;}); }
  finally { if(!nested)scopes.delete(store.db); }
}
export function withExactRestoreGuards(db,definitions,operation) {
  if(!db.isTransaction || !scopes.has(db))throw Error('Exact restore guards require a synchronous privileged restore transaction');
  const verify=message=>{
    const rows=db.prepare('SELECT name,sql FROM sqlite_master WHERE name IN ('+definitions.map(()=>'?').join(',')+')').all(...definitions.map(([name])=>name));
    if(rows.length!==definitions.length)throw Error(message);
    for(const [name,sql] of definitions)if(normalize(rows.find(row=>row.name===name)?.sql)!==normalize(sql))throw Error(message+': '+name);
  };
  verify('Restore guard requires reconciliation');
  admittedSchemas.delete(db);
  for(const [name] of definitions)db.exec('DROP TRIGGER '+name);
  try { return operation(); }
  finally {
    for(const [,sql] of definitions)db.exec(sql);
    verify('Restore guard reinstall failed');
  }
}
function setRestoreState(db,state,id,receipt=null) {
  withExactRestoreGuards(db,RESTORE_CONTROL_GUARDS.filter(([name])=>name.startsWith(RESTORE_CONTROL_TABLE+'_')),()=>db.prepare('UPDATE current_restore_admission SET state=?,restore_id=?,phase=?,revision=0,source_seal=NULL,coverage=NULL,latest_receipt=? WHERE singleton=1').run(state,id,state==='clear'?'clear':'loading',receipt===null?null:JSON.stringify(receipt)));
}
export function beginRestore(store) {
  return withRestoreTransaction(store,()=>{
    if(restorePending(store.db))throw Error('An incomplete backup restore already requires operator recovery');
    if(store.db.prepare('SELECT 1 FROM rooms LIMIT 1').get())throw Error('Refusing to replay into a non-empty store');
    const id='restore_'+randomUUID();setRestoreState(store.db,'pending',id);return id;
  });
}
export function completeRestore(db,receipt=null) {
  if(!restorePending(db))throw Error('Restore has no pending census');
  if(db.prepare('SELECT phase FROM current_restore_admission WHERE singleton=1').get().phase==='coverage')throw Error('Restore coverage has not completed');
  setRestoreState(db,'clear',null,receipt);
}

// Bounded operational metadata, never a source row or an imported grant.
export const RESTORE_PROGRESS_MAX_BYTES=1024*1024;
export function restoreProgress(db) {
  verifyRestoreControl(db);
  const scalar=db.prepare('SELECT length(CAST(source_seal AS BLOB)) AS seal_bytes,length(CAST(coverage AS BLOB)) AS coverage_bytes,length(CAST(latest_receipt AS BLOB)) AS receipt_bytes FROM current_restore_admission WHERE singleton=1').get();
  if(!scalar||Object.values(scalar).some(value=>value!==null&&(!Number.isSafeInteger(value)||value<0||value>RESTORE_PROGRESS_MAX_BYTES)))throw Error('Restore progress scalar bytes require reconciliation');
  const row=db.prepare('SELECT state,restore_id,phase,revision,source_seal,coverage,latest_receipt FROM current_restore_admission WHERE singleton=1').get();
  if(!Number.isSafeInteger(row.revision)||row.revision<0)throw Error('Restore progress revision requires reconciliation');
  return {...row,seal:row.source_seal===null?null:JSON.parse(row.source_seal),progress:row.coverage===null?null:JSON.parse(row.coverage),latest:row.latest_receipt===null?null:JSON.parse(row.latest_receipt)};
}
export function checkpointRestore(db,{restoreId,expectedRevision,phase,seal,progress,latest}) {
  if(!db.isTransaction||!scopes.has(db))throw Error('Restore checkpoint requires its privileged transaction');
  const before=restoreProgress(db);
  if(before.state!=='pending'||before.restore_id!==restoreId||before.revision!==expectedRevision)throw Error('Restore checkpoint is stale');
  if(!['coverage','audit_pending'].includes(phase)||(before.phase==='audit_pending'&&phase!=='audit_pending'))throw Error('Invalid restore checkpoint phase');
  if(before.phase!=='loading'&&JSON.stringify(before.seal)!==JSON.stringify(seal))throw Error('Restore source seal cannot change');
  const encoded=[seal,progress,latest].map(value=>value===null?null:JSON.stringify(value));
  if(encoded.some(value=>value!==null&&Buffer.byteLength(value)>RESTORE_PROGRESS_MAX_BYTES))throw Error('Restore progress exceeds its code-owned metadata bound');
  withExactRestoreGuards(db,RESTORE_CONTROL_GUARDS.filter(([name])=>name.startsWith(RESTORE_CONTROL_TABLE+'_')),()=>db.prepare("UPDATE current_restore_admission SET phase=?,revision=revision+1,source_seal=?,coverage=?,latest_receipt=? WHERE singleton=1 AND state='pending' AND restore_id=? AND revision=?").run(phase,...encoded,restoreId,expectedRevision));
  const after=restoreProgress(db);if(after.revision!==expectedRevision+1)throw Error('Restore checkpoint did not advance atomically');
  return after;
}

// Only target-owned reducer working values; imported source rows cannot seed it.
export function withRestoreAuditRows(db,restoreId,operation){
 if(!db.isTransaction||!scopes.has(db))throw Error('Restore scratch requires its privileged transaction');
 verifyRestoreControl(db);
 const state=db.prepare('SELECT state,restore_id,phase FROM current_restore_admission WHERE singleton=1').get();
 if(state?.state!=='pending'||state.restore_id!==restoreId||state.phase!=='audit_pending')throw Error('Restore scratch authority differs');
 const guards = RESTORE_CONTROL_GUARDS.filter(([name]) => name.startsWith(RESTORE_AUDIT_TABLE + '_')) , pending = [] , pendingByKey = new Map();let pendingBytes = 0 , active = true;
 const assertActive=()=>{if(!active||!db.isTransaction||!scopes.has(db))throw Error('Restore scratch scope expired');};
 const identity=(lane,roomId,domain,key,part)=>JSON.stringify([lane,roomId,domain,key,part]);
 const read = (lane , roomId , domain , key , part = 0) => {assertActive();const queued = pendingByKey.get(identity(lane , roomId , domain , key , part));if(queued)return queued[7];const scalar = db.prepare('SELECT payload_bytes,length(CAST(payload AS BLOB)) bytes FROM current_restore_audit_scratch WHERE restore_id=? AND lane=? AND room_id=? AND domain=? AND unit_key=? AND part=?').get(restoreId , lane , roomId , domain , key , part);if(!scalar)return undefined;if(scalar.bytes !== scalar.payload_bytes || scalar.bytes < 1 || scalar.bytes > RESTORE_AUDIT_UNIT_BYTES)throw Error('Restore scratch representation changed');return db.prepare('SELECT payload FROM current_restore_audit_scratch WHERE restore_id=? AND lane=? AND room_id=? AND domain=? AND unit_key=? AND part=?').get(restoreId , lane , roomId , domain , key , part).payload;};
 let result;try{result = operation({nextKey(lane,roomId,domain,after){
   assertActive();if(!['actual','replay','history','report'].includes(lane)||[roomId,domain,after].some(value=>typeof value!=='string'))throw Error('Invalid restore scratch ordered read');
   const row=db.prepare('SELECT unit_key FROM current_restore_audit_scratch WHERE restore_id=? AND lane=? AND room_id=? AND domain=? AND part=0 AND unit_key>? ORDER BY unit_key LIMIT 1').get(restoreId,lane,roomId,domain,after);
   let key=row?.unit_key;for(const held of pending)if(held[1]===lane&&held[2]===roomId&&held[3]===domain&&held[5]===0&&held[4]>after&&(key===undefined||held[4]<key))key=held[4];return key;
  },get remaining(){assertActive();return 128 - pending.length;} , get(lane , roomId , domain , key , part = 0){const payload = read(lane , roomId , domain , key , part);return payload === undefined?undefined : JSON.parse(payload);} , ensure(lane , roomId , domain , key , value , part = 0){const actual = read(lane , roomId , domain , key , part) , expected = JSON.stringify(value);if(actual !== undefined){if(actual !== expected)throw Error('Restore scratch independent value differs');return false;}this.put(lane , roomId , domain , key , value , part);return true;} , set(lane , roomId , domain , key , value , part = 0){assertActive();const queued = pendingByKey.get(identity(lane , roomId , domain , key , part));if(queued){const payload = JSON.stringify(value) , bytes = Buffer.byteLength(payload);if(bytes < 1 || bytes > RESTORE_AUDIT_UNIT_BYTES || pendingBytes - queued[6] + bytes > 4 * 1024 * 1024 + RESTORE_AUDIT_UNIT_BYTES)throw Error('Restore scratch unit exceeds admitted representation');pendingBytes += bytes - queued[6];queued[6] = bytes;queued[7] = payload;queued[8] = true;}else{this.put(lane , roomId , domain , key , value , part);pendingByKey.get(identity(lane , roomId , domain , key , part))[8] = true;}} , deletePage(limit){assertActive();return withExactRestoreGuards(db , guards , () => {
   let deleted=0;while(deleted<limit){const row=db.prepare('SELECT rowid,restore_id FROM current_restore_audit_scratch ORDER BY rowid LIMIT 1').get();if(!row)break;if(row.restore_id!==restoreId)throw Error('Restore scratch ownership differs');db.prepare('DELETE FROM current_restore_audit_scratch WHERE rowid=? AND restore_id=?').run(row.rowid,restoreId);deleted++;}
   return {deleted,done:!db.prepare('SELECT 1 FROM current_restore_audit_scratch LIMIT 1').get()};
  });},put(lane,roomId,domain,key,value,part=0){
   assertActive();const payload=JSON.stringify(value),bytes=Buffer.byteLength(payload);
   if(bytes < 1 || bytes > RESTORE_AUDIT_UNIT_BYTES || pending.length >= 128 || pendingBytes + bytes > 4 * 1024 * 1024 + RESTORE_AUDIT_UNIT_BYTES)throw Error('Restore scratch unit exceeds admitted representation');
   const row=[restoreId,lane,roomId,domain,key,part,bytes,payload];pending.push(row);pendingByKey.set(identity(lane,roomId,domain,key,part),row);pendingBytes+=bytes;
  }});}finally{active=false;}
 if(result?.then)throw Error('Restore scratch must remain synchronous');
 if(pending.length)withExactRestoreGuards(db,guards,()=>{const insert=db.prepare('INSERT INTO current_restore_audit_scratch(restore_id,lane,room_id,domain,unit_key,part,payload_bytes,payload) VALUES(?,?,?,?,?,?,?,?)');const update=db.prepare('INSERT INTO current_restore_audit_scratch(restore_id,lane,room_id,domain,unit_key,part,payload_bytes,payload) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(restore_id,lane,room_id,domain,unit_key,part) DO UPDATE SET payload_bytes=excluded.payload_bytes,payload=excluded.payload');for(const row of pending)(row[8]?update:insert).run(...row.slice(0,8));});
 return result;
}

// Publication is immutable; only its target-owned cleanup sidecar advances.
export function checkpointRestoreCleanup(db,before,cleanup){
 if(!db.isTransaction||!scopes.has(db))throw Error('Restore cleanup requires its privileged transaction');
 const state=restoreProgress(db);if(state.state!=='clear'||JSON.stringify(state.latest)!==JSON.stringify(before))throw Error('Restore cleanup checkpoint is stale');
 const latest={...before,cleanup},encoded=JSON.stringify(latest);if(Buffer.byteLength(encoded)>RESTORE_PROGRESS_MAX_BYTES)throw Error('Restore cleanup receipt exceeds admitted bound');
 withExactRestoreGuards(db,RESTORE_CONTROL_GUARDS.filter(([name])=>name===RESTORE_CONTROL_TABLE+'_update'),()=>db.prepare("UPDATE current_restore_admission SET latest_receipt=? WHERE singleton=1 AND state='clear'").run(encoded));
 if(JSON.stringify(restoreProgress(db).latest)!==encoded)throw Error('Restore cleanup receipt did not persist atomically');
}
