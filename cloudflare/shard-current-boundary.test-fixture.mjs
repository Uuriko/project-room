import {RoomShard} from './room-shard.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {copyRoomRows,exportRoomNdjson,compareRoomHomes} from '../server/room-shard-copy.mjs';
import {readCurrentRoomForAudit} from '../server/current-room-repository.mjs';
import {restoreProgress} from '../server/restore-admission.mjs';
export class ShardBoundaryRoom extends RoomShard{
 async fetch(){
  if(!this.store)return Response.json({enabled:false});
  const store=this.store,db=store.db;store.initialize(initialRoom(),{representation:'normalized-current-v1'});
  const read=()=>store.readTransaction(()=>readCurrentRoomForAudit(store,'commons')),before=read(),control=restoreProgress(db);let writes=0,transactions=0,unknown=0;
  const original=db.observeStatement,tx=store.transaction.bind(store);db.observeStatement=()=>sample=>{if(sample.rowsWritten===null)unknown++;else writes+=sample.rowsWritten;};store.transaction=(...args)=>{transactions++;return tx(...args);};
  const refused=[];try{for(const operation of [()=>copyRoomRows(store,store,'commons'),()=>exportRoomNdjson(store,'commons'),()=>compareRoomHomes(store,store,'commons')]){try{operation();refused.push(false);}catch(error){refused.push(/Normalized room shard transfer requires receipt-closure qualification/.test(error.message));}}}finally{store.transaction=tx;db.observeStatement=original;}
  return Response.json({enabled:true,refused,writes,transactions,unknown,unchanged:JSON.stringify(before)===JSON.stringify(read()),controlUnchanged:JSON.stringify(control)===JSON.stringify(restoreProgress(db))});
 }
}
export default{fetch(request,env){return env.ROOM_SHARD.getByName('synthetic-boundary').fetch(request);}};
