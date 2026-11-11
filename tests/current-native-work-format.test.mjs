import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,symlinkSync,realpathSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {execFileSync} from 'node:child_process';import {pathToFileURL} from 'node:url';
import {CURRENT_ROOM_GUARDS} from '../server/current-room-repository.mjs';import {initialRoom} from '../server/bootstrap.mjs';
test('actual privacy-aware old45 reader and writer refuse the native capacity format before mutation',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'current-native-old45-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const archive=execFileSync('git',['archive','a75c9e0bf','server','src','client','strings','package.json'],{maxBuffer:64*1024*1024});execFileSync('tar',['-x','-C',directory],{input:archive});symlinkSync(realpathSync(new URL('../node_modules',import.meta.url)),join(directory,'node_modules'),'dir');
 const {RoomStore:OldStore}=await import(pathToFileURL(join(directory,'server/store.mjs')).href),path=join(directory,'store.sqlite'),old=new OldStore(path);t.after(()=>old.close());old.initialize(initialRoom(),{representation:'normalized-current-v1'});const key=old.issueAccessKey('commons','owner');
 old.command(key,'commons',{id:'proposed',type:'work.proposed',data:{workItemId:'task',title:'Saved task',definitionOfDone:'Saved evidence',accountableMemberId:'owner'}});assert.equal(old.currentOverview('commons','owner').workWindow.total,1);
 const start=CURRENT_ROOM_GUARDS.indexOf('CREATE TRIGGER IF NOT EXISTS current_room_permit_update '),end=CURRENT_ROOM_GUARDS.indexOf('\nCREATE TRIGGER',start);assert.ok(start>=0&&end>start);
 old.transaction(()=>{old.db.exec('DROP TRIGGER current_room_permit_update');old.db.exec(CURRENT_ROOM_GUARDS.slice(start,end));});
 const snapshot=()=>JSON.stringify(Object.fromEntries(['rooms','events','commands','work_entities','work_claims','current_room_head','current_room_records','current_room_record_proofs','operator_actions'].map(table=>[table,old.db.prepare('SELECT * FROM '+table).all()]))),before=snapshot();
 assert.throws(()=>old.currentOverview('commons','owner'),/current_room_corrupt|serving schema/);
 assert.throws(()=>old.command(key,'commons',{id:'old-accept',type:'work.accepted',data:{workItemId:'task',expectedRevision:0}}),/current_room_corrupt|serving schema|unsupported current room permit/);assert.equal(snapshot(),before);
 assert.throws(()=>{const cold=new OldStore(path);try{cold.currentOverview('commons','owner');}finally{cold.close();}},/current_room_corrupt|serving schema|schema requires/);assert.equal(snapshot(),before);
});
