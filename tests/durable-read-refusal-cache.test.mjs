import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {ServiceError} from '../server/service-error.mjs';
import {DurableDatabase,durableStorage} from '../cloudflare/storage.mjs';
import {createDoContext} from './helpers/do-storage-emulator.mjs';

test('typed read-only404 retains committed runtime admission; DDL attempt and unknown failures invalidate it',()=>{
 const ctx=createDoContext(),db=new DurableDatabase(ctx.storage),store=new RoomStore(null,{database:db,storagePlatform:durableStorage});
 const exec=ctx.storage.sql.exec.bind(ctx.storage.sql);let catalog=0;
 ctx.storage.sql.exec=(sql,...args)=>{if(/sqlite_master/.test(sql)&&!/rowid IN/.test(sql))catalog++;return exec(sql,...args);};
 try{
  store.readTransaction(()=>db.prepare('SELECT 1').get());catalog=0;
  for(let i=0;i<2;i++)assert.throws(()=>store.readTransaction(()=>{throw new ServiceError(404,'message_not_found','Hidden or missing');}),error=>error.status===404);
  store.readTransaction(()=>db.prepare('SELECT 1').get());assert.equal(catalog,0,'unchanged expected absence must not repeat catalog scans');
  assert.throws(()=>store.readTransaction(()=>{db.prepare('CREATE TABLE transient_refusal_control(id TEXT)').get();throw new ServiceError(404,'missing','Missing after DDL');}),error=>error.status===404);
  catalog=0;store.readTransaction(()=>db.prepare('SELECT 1').get());assert.ok(catalog>0,'DDL before typed404 must invalidate runtime admission even with zero rowsWritten');
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='transient_refusal_control'").get(),undefined,'transaction rollback preserves DDL');
  assert.throws(()=>store.readTransaction(()=>{throw Error('unknown storage failure');}),/unknown storage failure/);
  catalog=0;store.readTransaction(()=>db.prepare('SELECT 1').get());assert.ok(catalog>0,'untyped failures still invalidate');
 }finally{store.close();ctx.storage.close();}
});
