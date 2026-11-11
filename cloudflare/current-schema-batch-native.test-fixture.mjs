import assert from 'node:assert/strict';
import {ProjectRoom} from './room.mjs';
import {verifyCurrentRoomSchema,invalidateCurrentRoomSchema} from '../server/current-room-repository.mjs';
import {durableStorage} from './storage.mjs';
export class SchemaBatchRoom extends ProjectRoom {
 async fetch(request) {
  const db=this.store.db,path=new URL(request.url).pathname;
  try {
   if(path==='/tamper') {
    verifyCurrentRoomSchema(db);
    const name='current_room_guard_messages_insert',original=db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(name).sql;
    db.exec('DROP TRIGGER '+name);
    db.exec(original.replace('unsupported current room writer','changed current room writer'));
    assert.throws(()=>verifyCurrentRoomSchema(db),/schema requires reconciliation/);
    invalidateCurrentRoomSchema(db);
    assert.throws(()=>verifyCurrentRoomSchema(db),/schema requires reconciliation/);
    db.exec('DROP TRIGGER '+name);db.exec(original);invalidateCurrentRoomSchema(db);
    verifyCurrentRoomSchema(db);
    return Response.json({protected:true});
   }
   if(path==='/unknown') {
    db.exec('CREATE TRIGGER writer_v999_unknown_insert BEFORE INSERT ON accounts BEGIN SELECT 1; END');
    assert.throws(()=>durableStorage.verifyWriterFence(db),/operator reconciliation/);
    db.exec('DROP TRIGGER writer_v999_unknown_insert');
    return Response.json({protected:true});
   }
   const before=db.observeStatement,prepare=db.prepare.bind(db),metrics={statements:0,rowsRead:0,rowsWritten:0,unknown:0,catalog:[],returnedSqlBytes:0,permits:0};
   db.observeStatement=()=>sample=>{metrics.statements++;for(const key of ['rowsRead','rowsWritten'])if(sample[key]===null)metrics.unknown++;else metrics[key]+=sample[key];};
   db.prepare=sql=>{
    const statement=prepare(sql);
    if(sql.includes('sqlite_master')) {
     metrics.catalog.push(sql);
     for(const method of ['get','all']) {
      const invoke=statement[method].bind(statement);
      statement[method]=(...args)=>{const result=invoke(...args);for(const row of Array.isArray(result)?result:[result])if(row?.sql)metrics.returnedSqlBytes+=new TextEncoder().encode(row.sql).length;return result;};
     }
    }
    if(sql.includes('SELECT singleton,enabled,room_id,receipt_id FROM current_room_writer_permit'))metrics.permits++;
    return statement;
   };
   try {verifyCurrentRoomSchema(db);}finally{db.observeStatement=before;db.prepare=prepare;}
   return Response.json(metrics);
  }catch(error){return Response.json({message:error.message,stack:error.stack},{status:500});}
 }
}
export default {fetch(request,env){return env.ROOM.getByName('schema-batch').fetch(request);}};
