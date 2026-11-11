// Isolated synthetic qualification only; never deployed.
import { DurableObject } from 'cloudflare:workers';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { event } from '../src/events.js';
import { createOperatorRoutes } from '../server/operator-routes.mjs';
import { DurableDatabase, durableStorage } from './storage.mjs';
export class SelectedParityRoom extends DurableObject {
  constructor(ctx,env) {super(ctx,env);this.db=new DurableDatabase(ctx.storage);this.store=new RoomStore(null,{database:this.db,storagePlatform:durableStorage});}
  async fetch(request) {
    const s=this.store,db=this.db,url=new URL(request.url);
    if(url.pathname==='/seed') {
      s.initialize([...initialRoom('commons'),event({type:'message.posted',actorId:'owner',roomId:'commons',id:'synthetic-event',at:'2026-11-01T00:00:00.000Z',data:{messageId:'synthetic-message',body:'PRIVATE_WORKER_CONTENT'}})]);
      while(!s.backfillMessages({limit:64}).done){ /* setup only */ }
      s.checkMessagesParity({roomId:'commons'});return Response.json({head:s.headSequence('commons')});
    }
    if(url.pathname==='/corrupt') {db.exec("UPDATE messages SET body='PRIVATE_CORRUPT'");return Response.json({changed:true});}
    const before=db.writeStatements;
    s.room=()=>{throw Error('Forbidden room/recovery read');};s.checkMessagesParity=()=>{throw Error('Forbidden certifier');};
    let result;
    const routes=createOperatorRoutes({store:s,rate:()=>{},body:async()=>{throw Error('No body');},json:(res,status,body)=>{result={status,body};},reject:(status,code)=>{throw Object.assign(new Error('Refused'),{status,code});}});
    try {
      const handled=await routes({method:request.method,headers:Object.fromEntries(request.headers)},{setHeader(){}},{url,remoteAddress:'synthetic',requestId:'synthetic'});
      if(!handled)result={status:404,body:{error:{code:'not_found'}}};
    } catch(error) {result={status:error.status??500,body:{error:{code:error.code??'internal'}}};}
    return Response.json({...result,writes:db.writeStatements-before});
  }
}
export default {fetch(request,env){return env.ROOM.getByName('selected-parity').fetch(request);}};
