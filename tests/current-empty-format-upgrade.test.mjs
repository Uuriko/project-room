import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,symlinkSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
const prior='8e65a6e73ae191ffa7fc89c2e88fa382ad2ac000';
async function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'current-format-upgrade-')),old=join(dir,'old');mkdirSync(old);
 execFileSync('tar',['-xf','-','-C',old],{input:execFileSync('git',['archive','--format=tar',prior,'server','src','client','strings','package.json','cloudflare/room-backup.mjs'],{maxBuffer:64*1024*1024})});
 symlinkSync(realpathSync('node_modules'),join(old,'node_modules'));
 const {RoomStore:OldStore}=await import(pathToFileURL(join(old,'server/store.mjs'))),file=join(dir,'room.sqlite'),store=new OldStore(file);
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return {store,file};
}
test('genuine format5 empty normalized namespace upgrades without changing legacy rooms, accounts or credentials',async t=>{
 const {store,file}=await fixture(t);store.initialize(initialRoom(),{representation:null});store.createAccount('kept-account');
 const key=store.issueAccessKey('commons','owner'),accountKey=store.issueAccountAccessKey('kept-account');
 const slot=store.createAccountSessionSlot(),login=store.loginAccountSession(slot.token,accountKey,0);
 const saved=store.db.prepare('SELECT * FROM credentials ORDER BY hash').all(),accountCredentials=store.db.prepare('SELECT * FROM account_credentials ORDER BY hash').all();
 const current=new RoomStore(file);t.after(()=>current.close());assert.equal(current.restoreStatus().pending,false);
 assert.equal(current.authenticate(key,'commons').member.id,'owner');assert.equal(current.authenticateAccountSession(slot.token,null,login.sessionBinding).account.id,'kept-account');assert.deepEqual(current.db.prepare('SELECT * FROM account_credentials ORDER BY hash').all(),accountCredentials);assert.deepEqual(current.db.prepare('SELECT * FROM credentials ORDER BY hash').all(),saved);
 assert.ok(current.db.prepare('SELECT 1 FROM accounts WHERE id=?').get('kept-account'));
 assert.equal(current.db.prepare('SELECT count(*) n FROM current_room_head').get().n,0);
});

import {upgradeUnusedCurrentFormat5} from '../server/current-room-repository.mjs';
function rawTransaction(store,fn){store.db.exec('BEGIN IMMEDIATE');try{const value=fn();store.db.exec('COMMIT');return value;}catch(error){store.db.exec('ROLLBACK');throw error;}}
const schema=db=>db.prepare("SELECT name,sql FROM sqlite_master WHERE name LIKE 'current_%' ORDER BY name").all();
test('unused format transition refuses populated normalized state without altering it',async t=>{
 const {store}=await fixture(t);store.initialize(initialRoom(),{representation:'normalized-current-v1'});
 const before=schema(store.db),head=store.db.prepare('SELECT * FROM current_room_head').all();
 assert.throws(()=>rawTransaction(store,()=>upgradeUnusedCurrentFormat5(store.db)),/Populated previous current format/);
 assert.deepEqual(schema(store.db),before);assert.deepEqual(store.db.prepare('SELECT * FROM current_room_head').all(),head);
});
test('unused format transition refuses unknown guard drift without normalizing it',async t=>{
 const {store}=await fixture(t);store.db.exec('DROP TRIGGER current_restore_admission_delete');
 store.db.exec("CREATE TRIGGER current_restore_admission_delete BEFORE DELETE ON current_restore_admission BEGIN SELECT RAISE(ABORT,'different'); END");
 const before=schema(store.db);assert.throws(()=>rawTransaction(store,()=>upgradeUnusedCurrentFormat5(store.db)),/schema requires reconciliation/);assert.deepEqual(schema(store.db),before);
});
test('unused format transition rolls all trigger changes back after interrupted installation',async t=>{
 const {store}=await fixture(t),before=schema(store.db),exec=store.db.exec.bind(store.db);let fired=false;
 store.db.exec=sql=>{if(sql.startsWith('CREATE TRIGGER IF NOT EXISTS current_restore_admission_update')&&sql.includes('native-work-6')){fired=true;throw Error('synthetic interrupted install');}return exec(sql);};
 try{assert.throws(()=>rawTransaction(store,()=>upgradeUnusedCurrentFormat5(store.db)),/synthetic interrupted install/);}finally{store.db.exec=exec;}
 assert.equal(fired,true);assert.deepEqual(schema(store.db),before);
 assert.equal(rawTransaction(store,()=>upgradeUnusedCurrentFormat5(store.db)),true);
 assert.equal(rawTransaction(store,()=>upgradeUnusedCurrentFormat5(store.db)),false);
});
test('unused format transition refuses pending restore and preserves its continuation',async t=>{
 const {store}=await fixture(t);
 // Build the pending state under the real old code-owned guard protocol.
 const oldGuards=store.db.prepare("SELECT name,sql FROM sqlite_master WHERE name LIKE 'current_restore_admission_%' AND type='trigger'").all();
 store.transaction(()=>{for(const row of oldGuards)store.db.exec('DROP TRIGGER '+row.name);store.db.prepare("UPDATE current_restore_admission SET state='pending',restore_id='held',phase='loading'").run();for(const row of oldGuards)store.db.exec(row.sql);});
 const before=store.db.prepare('SELECT * FROM current_restore_admission').all(),catalog=schema(store.db);
 assert.throws(()=>rawTransaction(store,()=>upgradeUnusedCurrentFormat5(store.db)),/unfinished authority/);
 assert.deepEqual(store.db.prepare('SELECT * FROM current_restore_admission').all(),before);assert.deepEqual(schema(store.db),catalog);
});
