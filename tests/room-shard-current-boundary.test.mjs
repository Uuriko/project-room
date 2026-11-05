import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {readCurrentRoomForAudit} from '../server/current-room-repository.mjs';
import {exportNdjsonText} from '../server/room-export.mjs';
import {copyRoomRows,exportRoomNdjson,restoreRoomNdjson,mirrorRoomIfEnabled,compareRoomHomes,roomHomeDigest} from '../server/room-shard-copy.mjs';
import {tableHome,roomTablesPresent} from '../server/room-shard-tables.mjs';
const refusal=/Normalized room shard transfer requires receipt-closure qualification/;
function pair(t,sourceCurrent,targetCurrent=false){const source=new RoomStore(':memory:'),target=new RoomStore(':memory:');t.after(()=>{source.close();target.close();});source.initialize(initialRoom(),sourceCurrent?{representation:'normalized-current-v1'}:undefined);if(targetCurrent)target.initialize(initialRoom(),{representation:'normalized-current-v1'});source.createAccount('directory-owner','synthetic');return{source,target};}
function snapshot(store){return Object.fromEntries(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name})=>[name,store.db.prepare('SELECT * FROM "'+name+'"').all()]));}
for(const [sourceCurrent,targetCurrent]of [[true,false],[false,true],[true,true]])test('normalized shard copy refuses before any destination write; source='+sourceCurrent+' target='+targetCurrent,t=>{
 const{source,target}=pair(t,sourceCurrent,targetCurrent),beforeSource=snapshot(source),beforeTarget=snapshot(target);let transactions=0;const tx=target.transaction.bind(target);target.transaction=(...args)=>{transactions++;return tx(...args);};
 assert.throws(()=>copyRoomRows(source,target,'commons'),refusal);assert.equal(transactions,0);assert.deepEqual(snapshot(source),beforeSource);assert.deepEqual(snapshot(target),beforeTarget);
 for(const store of [sourceCurrent?source:null,targetCurrent?target:null].filter(Boolean))assert.doesNotThrow(()=>store.readTransaction(()=>readCurrentRoomForAudit(store,'commons')));
});
test('normalized shard export and raw slice restore refuse without copying directory proof or target-local authority',t=>{
 const{source,target}=pair(t,true),before=snapshot(source);assert.throws(()=>exportRoomNdjson(source,'commons'),refusal);assert.deepEqual(snapshot(source),before);
 const directory=mkdtempSync(join(tmpdir(),'shard-current-refusal-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));const filename=join(directory,'uncreated','room.sqlite');
 assert.throws(()=>restoreRoomNdjson(exportNdjsonText(source.db),filename),refusal);assert.equal(existsSync(filename),false);assert.deepEqual(snapshot(source),before);assert.equal(target.db.prepare('SELECT count(*) n FROM operator_actions').get().n,0);
});
test('normalized shard mirror remains off by default and refuses when explicitly enabled',t=>{
 const{source,target}=pair(t,true),before=snapshot(target);assert.deepEqual(mirrorRoomIfEnabled({},source,target,'commons'),{mirrored:false});assert.throws(()=>mirrorRoomIfEnabled({ROOM_PER_ROOM_OBJECTS:'1'},source,target,'commons'),refusal);assert.deepEqual(snapshot(target),before);
});
test('target-local controls have an honest home and are never room-restorable',t=>{
 const{target}=pair(t,false);for(const name of ['current_restore_admission','current_restore_audit_scratch','current_room_writer_permit']){assert.equal(tableHome(name),'local');assert.equal(roomTablesPresent(target.db).has(name),false);}
 for(const name of ['current_room_head','current_room_records','current_room_record_proofs'])assert.equal(tableHome(name),'room');
});

test('legacy digest cannot falsely certify normalized homes',t=>{const{source}=pair(t,true);const before=snapshot(source);assert.throws(()=>roomHomeDigest(source,'commons'),refusal);assert.throws(()=>compareRoomHomes(source,source,'commons'),refusal);assert.deepEqual(snapshot(source),before);});

test('closed marker without normalized head refuses before target work',t=>{const{source,target}=pair(t,false);source.db.prepare("UPDATE rooms SET projection=? WHERE id='commons'").run('{"normalizedCurrent":{"version":1}}');const before=snapshot(target);let calls=0;target.transaction=()=>{calls++;throw Error('target transaction must not run');};assert.throws(()=>copyRoomRows(source,target,'commons'),refusal);assert.equal(calls,0);assert.deepEqual(snapshot(target),before);});
