// Local-only synthetic bootstrap measurement. Never deployed.
import {DurableObject} from 'cloudflare:workers';
import {RoomStore} from '../server/store.mjs';
import {sqliteValueLimit} from '../server/storage-limits.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {DurableDatabase,durableStorage} from './storage.mjs';
import {WITNESS_SCHEMA,captureProjectionWitness,witnessChunk} from '../scripts/prototypes/replay-projection-witness.mjs';
import {initialReplayHash,advanceReplayHash,finishReplayHash,encodeReplayHash,decodeReplayHash} from '../server/replay-sha256.mjs';
// Experimental local upper bound, independent of the production room policy.
const WITNESS_TEST_CEILING_BYTES = 8 * 1024 * 1024;
export class ReplayWitnessRoom extends DurableObject{
  constructor(ctx,env){super(ctx,env);this.ctx=ctx;this.stats={statements:0,rowsRead:0,rowsWritten:0,unknown:0};const fixture=this,originalSql=ctx.storage.sql;const storage=new Proxy(ctx.storage,{get(target,key){if(key==='sql')return {exec(...args){try{return originalSql.exec(...args);}catch(error){fixture.nativeFailure={name:error.name,code:error.code??null,message:error.message,stack:String(error.stack).split('\n').slice(0,6)};throw error;}}};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});this.db=new DurableDatabase(storage,{observeStatement:()=>sample=>{this.stats.statements++;this.stats.rowsRead+=sample.rowsRead??0;this.stats.rowsWritten+=sample.rowsWritten??0;if(sample.rowsRead===null||sample.rowsWritten===null)this.stats.unknown++;}});this.s=new RoomStore(null,{database:this.db,storagePlatform:durableStorage,integrity:"deferred"});this.db.exec(WITNESS_SCHEMA);}
  async fetch(request){const u=new URL(request.url),s=this.s,db=this.db;try{
    if(u.pathname==='/seed'){
      s.initialize(initialRoom());const state=structuredClone(s.room('commons').state);state.room.syntheticPadding='';
      const count=Number(u.searchParams.get('bytes'))-Buffer.byteLength(JSON.stringify(state));if(count<0)throw Error('invalid size');state.room.syntheticPadding='p'.repeat(count);
      s.transaction(()=>{const text=s.storedProjection('commons',state);db.prepare("UPDATE rooms SET projection=? WHERE id='commons'").run(text);});
      return Response.json({seeded:true,...db.prepare("SELECT length(CAST(projection AS BLOB)) AS bytes,sequence AS head FROM rooms WHERE id='commons'").get()});
    }
    if(u.pathname==='/sql-cost'){
      const operations={octet:"octet_length(projection)",cast:"length(CAST(projection AS BLOB))",slice:"length(substr(CAST(projection AS BLOB),1,16384))"};
      const expression=operations[u.searchParams.get('operation')];if(!expression)throw Error('invalid operation');
      const before={...this.stats},start=performance.now();const result=db.prepare(`SELECT ${expression} AS bytes FROM rooms WHERE id='commons'`).get();
      return Response.json({result,wallMs:performance.now()-start,cost:Object.fromEntries(Object.keys(before).map(key=>[key,this.stats[key]-before[key]]))});
    }
    if(u.pathname==='/runtime')return Response.json({storage:sqliteValueLimit(db)});
    if(u.pathname==='/capture'){this.nativeFailure=null;
      const before={...this.stats},original=db.prepare.bind(db);let phase='transaction',result;
      db.prepare=sql=>{if(sql.includes("SELECT ?,'whole'"))phase='whole-copy';else if(sql.startsWith('WITH RECURSIVE'))phase='page-copy';else if(sql.startsWith('INSERT INTO replay_projection_witness'))phase='header-copy';else if(sql.includes('FROM rooms r LEFT JOIN'))phase='admission';return original(sql);};
      try{result=s.transaction(()=>{try{return captureProjectionWitness(db,{captureId:'one-capture',roomId:'commons',expectedHead:2,mode:u.searchParams.get('mode')??'whole',ceilingBytes:Number(u.searchParams.get('ceiling')??WITNESS_TEST_CEILING_BYTES)});}catch(error){error.witnessPhase=phase;throw error;}});}finally{db.prepare=original;}
      const cost=Object.fromEntries(Object.keys(before).map(key=>[key,this.stats[key]-before[key]]));return Response.json({result,cost});
    }
    if(u.pathname==='/slice'){const before={...this.stats},start=performance.now();const chunk=witnessChunk(db,'one-capture',Number(u.searchParams.get('offset')));return Response.json({wallMs:performance.now()-start,cost:Object.fromEntries(Object.keys(before).map(key=>[key,this.stats[key]-before[key]])),bytes:chunk?.byteLength??0,base64:chunk?Buffer.from(chunk).toString('base64'):''});}
    if(u.pathname==='/hash-step'){
      // Fixture KV only exercises portable state across isolate restarts. It
      // does not implement the production checkpoint proof/epoch contract.
      const header=db.prepare("SELECT head,metadata_hash,byte_length FROM replay_projection_witness WHERE capture_id='one-capture' AND unit_kind='header'").get();
      const encoded=await this.ctx.storage.get('portable-hash-state');
      const state=encoded?decodeReplayHash(encoded):initialReplayHash();
      if(state.bytes>header.byte_length)throw Error('hash exceeds captured bytes');
      const bytes=state.bytes===header.byte_length?null:witnessChunk(db,'one-capture',state.bytes);
      const chunk=bytes?new Uint8Array(bytes):new Uint8Array();
      const next=chunk.length?advanceReplayHash(state,chunk):state;
      if(next.bytes>header.byte_length)throw Error('hash exceeds captured bytes');
      await this.ctx.storage.put('portable-hash-state',encodeReplayHash(next));
      const complete=next.bytes===header.byte_length;
      return Response.json({head:header.head,bytes:next.bytes,controlBytes:encodeReplayHash(next).length,complete,matchesIndependentProof:complete?finishReplayHash(next)===header.metadata_hash:null});
    }
    if(u.pathname==='/append'){
      const key=s.issueAccessKey('commons','owner');for(let i=0;i<4;i++)s.command(key,'commons',{id:'later-'+i,type:'message.posted',data:{messageId:'later-'+i,body:'Synthetic later '+i}});
      s.command(key,'commons',{id:'edit-later',type:'message.edited',data:{messageId:'later-0',body:'Edited synthetic append',expectedMessageRevision:0}});
      return Response.json({head:s.headSequence('commons')});
    }
    if(u.pathname==='/state')return Response.json({capture:db.prepare("SELECT head,metadata_hash,byte_length FROM replay_projection_witness WHERE unit_kind='header'").get(),live:db.prepare("SELECT sequence,metadata_hash FROM integrity_room_state WHERE room_id='commons'").get()});
    return new Response('Not found',{status:404});
  }catch(error){return Response.json({error:{code:error.code??'internal',phase:error.witnessPhase??u.pathname,message:String(error.message).slice(0,160),nativeFailure:this.nativeFailure??null}},{status:error.status??500});}}
}
export default{fetch(request,env){return env.ROOM.getByName('witness').fetch(request);}};
