import {supportsSealedRestoreSource} from './restore-admission.mjs';
import {REPLAY_SKIPPED_TABLES,isExportSecretColumn} from './room-export.mjs';
// Loader-produced result facts. This is part of the existing source seal,
// never an imported grant or an operator-supplied verification certificate.
const fail=()=>{throw Error('Restore result metadata requires reconciliation');};
const ident=/^[A-Za-z_][A-Za-z0-9_]*$/;
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===keys.sort().join(',');
const count=value=>Number.isSafeInteger(value)&&value>=0;
export function validateRestoreResultMetadata(value,seal){
 if(!exact(value,['version','tables','contentVerification','writeProofs','skippedTables','sanitizedCells','transport','resumed'])||value.version!==1||!count(value.tables)||value.contentVerification!=='full'||typeof value.resumed!=='boolean')fail();
 if(!exact(value.writeProofs,['sourceSchemaVersion','metadataProofsAdded','historicalVerification'])||(!supportsSealedRestoreSource(value.writeProofs.sourceSchemaVersion)||value.writeProofs.sourceSchemaVersion!==seal.sourceSchemaVersion)||value.writeProofs.metadataProofsAdded!==0||value.writeProofs.historicalVerification!=='unchanged')fail();
 const dictionary=(object,visit,allowed=key=>seal.inventory.includes(key))=>{if(!object||typeof object!=='object'||Array.isArray(object))fail();for(const [key,entry]of Object.entries(object)){if(!ident.test(key)||!allowed(key))fail();visit(key,entry);}};
 dictionary(value.skippedTables,(_table,n)=>{if(!count(n))fail();},key=>key.startsWith('_cf_')||REPLAY_SKIPPED_TABLES.includes(key)||key==='public_work_claim_writer_permit');
 dictionary(value.sanitizedCells,(table,columns)=>{if(!columns||typeof columns!=='object'||Array.isArray(columns))fail();const known=seal.tables.find(t=>t.name===table)?.columns;for(const [column,n]of Object.entries(columns))if(!ident.test(column)||!known?.includes(column)||(!isExportSecretColumn(table,column)&&!(table==='mcp_event_subscriptions'&&column==='state'))||!count(n))fail();});
 const transport=value.transport;if(!exact(transport,['kind','key','bytes'])||!count(transport.bytes)||transport.bytes<1||!['request-body','kv-backup'].includes(transport.kind))fail();
 if(transport.kind==='request-body'?transport.key!==null:typeof transport.key!=='string'||!/^room-backups\/\d{4}-\d{2}-\d{2}\.ndjson$/.test(transport.key))fail();
 return value;
}
export function restoreResultFields(seal){const value=validateRestoreResultMetadata(seal.resultMetadata,seal);return{contentVerification:value.contentVerification,writeProofs:value.writeProofs,tables:value.tables,skippedTables:value.skippedTables,sanitizedCells:value.sanitizedCells,...(value.resumed?{resumed:true}:{}),...(value.transport.kind==='kv-backup'?{source:'kv-backup',key:value.transport.key,bytes:value.transport.bytes}:{})};}
