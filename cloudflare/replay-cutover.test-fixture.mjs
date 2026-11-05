// Local synthetic qualification only. DDL activation is confined to this fixture.
import {ReplayWitnessRoom} from './replay-projection-witness.test-fixture.mjs';
import * as cutover from '../server/replay-cutover.mjs';
const {replayCutoverSchema,captureReplayWitness,advanceReplayWitness,partitionReplayWitness,readReplayWitnessLeaf}=cutover;
import {applyEvent,event} from '../src/events.js';
import {initialRoom} from '../server/bootstrap.mjs';
import {createHash} from 'node:crypto';
import {MESSAGE_PROOF_SELECT} from '../server/write-integrity.mjs';
export class ReplayCutoverRoom extends ReplayWitnessRoom {
  constructor(ctx,env){
    super(ctx,env);
    if(!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='message_replay_units'").get())this.db.exec(replayCutoverSchema({durable:true}));
  }
  async fetch(request){
    const url=new URL(request.url);
    try{
      if(url.pathname==='/nested-archive-seed'){
        const count=Number(url.searchParams.get('count')),bad=url.searchParams.get('bad')==='1';
        if(![1,1000,24000].includes(count))throw Error('invalid synthetic retained identity count');
        this.s.initialize(initialRoom());const state=structuredClone(this.s.room('commons').state);
        state.messagesArchive={throughSeq:1,count:0,retainedIds:bad?['x'.repeat(201)]:Array.from({length:count},(_,i)=>'retained-'+String(i).padStart(6,'0')+'-'+'x'.repeat(112))};
        this.s.transaction(()=>this.db.prepare("UPDATE rooms SET projection=? WHERE id='commons'").run(this.s.storedProjection('commons',state)));
        const capture=captureReplayWitness(this.s,{roomId:'commons',requestId:'nested-capture',expectedHead:2,reason:'Synthetic nested representation scaling only'});
        return Response.json({capture,count,bad});
      }
      if(url.pathname==='/nested-archive-codec'){
        const before={...this.stats},result=partitionReplayWitness(this.s,{roomId:'commons',generation:url.searchParams.get('generation'),
          expectedBytes:Number(url.searchParams.get('bytes')),requestId:'nested-codec-'+url.searchParams.get('step')});
        return Response.json({result,cost:Object.fromEntries(Object.keys(before).map(k=>[k,this.stats[k]-before[k]]))});
      }
      if(url.pathname==='/nested-archive-census')return Response.json({
        ...this.db.prepare("SELECT count(*) AS count,MAX(payload_bytes) AS maximumLeafBytes FROM message_replay_units WHERE domain='metadata-index'").get(),
        frame:cutover.readReplayWitnessLeaf(this.s,{roomId:'commons',generation:url.searchParams.get('generation'),domain:'metadata-entry',key:JSON.stringify(['messagesArchive','retainedIds'])}).value,
        sample:cutover.readReplayWitnessLeaf(this.s,{roomId:'commons',generation:url.searchParams.get('generation'),domain:'metadata-index',key:JSON.stringify(['messagesArchive','retainedIds',17])}).value});
      if(url.pathname==='/nested-archive-state')return Response.json({
        codec:this.db.prepare("SELECT payload_sha256 FROM message_replay_units WHERE domain='codec'").get().payload_sha256,
        source:this.db.prepare("SELECT sequence,metadata_hash FROM integrity_room_state WHERE room_id='commons'").get()});
      if(url.pathname==='/work-qualification-seed'){
        const count=65;
        this.s.initialize([...initialRoom(),...Array.from({length:count},(_,i)=>event({id:'work-'+i,roomId:'commons',actorId:'owner',
          type:'work.proposed',data:{workItemId:'task-'+String(i).padStart(3,'0'),title:'Task '+i,definitionOfDone:'Save result',mode:'read',accountableMemberId:'owner'}}))]);
        const capture=captureReplayWitness(this.s,{roomId:'commons',requestId:'work-qualification-capture',expectedHead:count+2,reason:'Synthetic complete work defaults qualification'});
        let progress={bytes:0},n=0;
        while(progress.phase!=='witness_verified')progress=advanceReplayWitness(this.s,{roomId:'commons',generation:capture.generation,expectedBytes:progress.bytes,requestId:'work-hash-'+n++});
        progress={bytes:0};n=0;
        while(progress.phase!=='codec_partitioned')progress=partitionReplayWitness(this.s,{roomId:'commons',generation:capture.generation,expectedBytes:progress.bytes,requestId:'work-codec-'+n++});
        return Response.json({capture,count,source:this.db.prepare("SELECT sequence,metadata_hash FROM integrity_room_state WHERE room_id='commons'").get()});
      }
      if(url.pathname==='/work-qualify'){
        const count=Number(url.searchParams.get('count')),before={...this.stats};
        const result=cutover.qualifyReplayHWork(this.s,{roomId:'commons',generation:url.searchParams.get('generation'),expectedWorkCount:count,requestId:'qualify-work-'+count});
        return Response.json({result,cost:Object.fromEntries(Object.keys(before).map(k=>[k,this.stats[k]-before[k]])),
          source:this.db.prepare("SELECT sequence,metadata_hash FROM integrity_room_state WHERE room_id='commons'").get()});
      }
      if(url.pathname==='/h-page-seed'){
        const count=Number(url.searchParams.get('count'));
        if(![1000,17405].includes(count))throw Error('invalid synthetic H member count');
        this.s.initialize([...initialRoom(),...Array.from({length:count},(_,i)=>event({id:'post-'+i,roomId:'commons',actorId:'owner',
          type:'message.posted',at:'2026-01-01T00:00:00.000Z',data:{messageId:'member-'+String(i).padStart(5,'0'),body:'H'}}))]);
        while(!this.s.backfillMessages({limit:200}).done){}
        this.s.checkMessagesParity({roomId:'commons'});
        const capture=captureReplayWitness(this.s,{roomId:'commons',requestId:'h-members',expectedHead:count+2,reason:'Synthetic complete H membership'});
        return Response.json({capture,count});
      }
      if(url.pathname==='/h-page'){
        const before={...this.stats};
        const result=cutover.readReplayHMessagePage(this.s,{roomId:'commons',generation:url.searchParams.get('generation'),
          after:url.searchParams.get('after')??'',limit:16});
        return Response.json({result,cost:Object.fromEntries(Object.keys(before).map(k=>[k,this.stats[k]-before[k]]))});
      }
      if(url.pathname==='/reference-seed'){
        this.s.bodiesAtRest=true;
        this.s.initialize([...initialRoom(),event({id:'ref-work',roomId:'commons',actorId:'owner',type:'work.proposed',
          data:{workItemId:'task',title:'H work',definitionOfDone:'Save result',mode:'read',accountableMemberId:'owner'}}),
          event({id:'ref-post',roomId:'commons',actorId:'owner',type:'message.posted',data:{messageId:'long',body:'Original body '.repeat(80)}})]);
        while(!this.s.backfillMessages({limit:200}).done){}
        this.s.checkMessagesParity({roomId:'commons'});
        return Response.json({capture:captureReplayWitness(this.s,{roomId:'commons',requestId:'reference-capture',expectedHead:4,
          reason:'Synthetic work and body consistency'}),
          work:this.db.prepare("SELECT work_id,revision,digest,body FROM work_entities WHERE room_id='commons'").get(),
          body:this.db.prepare("SELECT sha,body FROM projection_bodies WHERE room_id='commons'").get()});
      }
      if(url.pathname==='/reference-edit'){
        this.s.bodiesAtRest=true;const key=this.s.issueAccessKey('commons','owner'),before={...this.stats};
        this.s.command(key,'commons',{id:'ref-accept',type:'work.accepted',data:{workItemId:'task',expectedRevision:0}});
        this.s.command(key,'commons',{id:'ref-edit',type:'message.edited',data:{messageId:'long',body:'Edited body '.repeat(80),expectedMessageRevision:0}});
        return Response.json({cost:Object.fromEntries(Object.keys(before).map(k=>[k,this.stats[k]-before[k]]))});
      }
      if(url.pathname==='/tail-read')return Response.json(cutover.readReplayTailEvent(this.s,{
        roomId:'commons',generation:url.searchParams.get('generation'),sequence:Number(url.searchParams.get('sequence'))}));
      if(url.pathname==='/tail-fault'){
        this.db.exec("CREATE TRIGGER synthetic_tail_failure BEFORE INSERT ON message_replay_units WHEN NEW.domain='tail-event' BEGIN SELECT RAISE(ABORT,'synthetic prospective binding failure'); END");
        const key=this.s.issueAccessKey('commons','owner');
        this.s.command(key,'commons',{id:'tail-fault',type:'message.posted',data:{messageId:'tail-fault',body:'Must roll back'}});
        return Response.json({unexpected:true});
      }
      if(url.pathname==='/reference-read')return Response.json(cutover.readReplayHReference(this.s,{
        roomId:'commons',generation:url.searchParams.get('generation'),kind:url.searchParams.get('kind'),key:url.searchParams.get('key')}));
      if(url.pathname==='/reference-delete'){
        this.db.exec('DROP TRIGGER IF EXISTS synthetic_tail_failure');
        const key=this.s.issueAccessKey('commons','owner');
        this.s.command(key,'commons',{id:'ref-delete',type:'message.deleted',data:{messageId:'long',expectedMessageRevision:1}});
        return Response.json({remaining:this.db.prepare("SELECT count(*) AS n FROM message_replay_units WHERE generation<>''").get().n});
      }
      if(url.pathname==='/cow-seed'){
        this.s.initialize([...initialRoom(),event({id:'cow-post',roomId:'commons',actorId:'owner',
          type:'message.posted',data:{messageId:'existing',body:'Independent original body'}})]);
        while(!this.s.backfillMessages({limit:200}).done){}
        this.s.checkMessagesParity({roomId:'commons'});
        if(url.searchParams.get('mode')==='baseline')for(const name of
          ['replay_message_before_update','replay_message_before_delete','replay_message_before_insert'])this.db.exec('DROP TRIGGER '+name);
        return Response.json({head:this.s.headSequence('commons')});
      }
      if(url.pathname==='/cow-capture')return Response.json(captureReplayWitness(this.s,{
        roomId:'commons',requestId:'cow-capture',expectedHead:3,reason:'Synthetic first-H row qualification'}));
      if(url.pathname==='/cow-write-cost'){
        const revision=Number(url.searchParams.get('revision'));
        if(![0,1].includes(revision))throw Error('invalid synthetic revision');
        const key=this.s.issueAccessKey('commons','owner'),before={...this.stats};
        this.s.command(key,'commons',{id:'edit-'+revision,type:'message.edited',
          data:{messageId:'existing',body:'Current edit '+revision,expectedMessageRevision:revision}});
        const cost=Object.fromEntries(Object.keys(before).map(k=>[k,this.stats[k]-before[k]]));
        return Response.json({cost,source:this.db.prepare(`SELECT count(*) AS rows,
          coalesce(sum(payload_bytes),0) AS bytes FROM message_replay_units
          WHERE domain IN ('h-message','h-message-absent')`).get()});
      }
      if(url.pathname==='/cow-read')return Response.json(cutover.readReplayHMessage(this.s,{
        roomId:'commons',generation:url.searchParams.get('generation'),messageId:'existing'}));
      if(url.pathname==='/cow-delete'){
        const key=this.s.issueAccessKey('commons','owner');
        this.s.command(key,'commons',{id:'cow-delete',type:'message.deleted',
          data:{messageId:'existing',expectedMessageRevision:2}});
        return Response.json({remaining:this.db.prepare('SELECT count(*) AS n FROM message_replay_units WHERE generation=?')
          .get(url.searchParams.get('generation')).n});
      }
      if(url.pathname==='/cow-state')return Response.json({head:this.s.headSequence('commons'),
        metadataHash:this.db.prepare("SELECT metadata_hash FROM integrity_room_state WHERE room_id='commons'").get().metadata_hash,
        row:this.db.prepare(`SELECT ${MESSAGE_PROOF_SELECT},entity_hash FROM messages
          WHERE room_id='commons' AND message_id='existing'`).get(),
        dependencies:this.db.prepare("SELECT count(*) AS n FROM operator_actions WHERE action='replay_cutover_dependency'").get().n});
      if(url.pathname==='/cow-fault'){
        this.db.exec(`CREATE TRIGGER synthetic_cow_failure BEFORE INSERT ON message_replay_units
          WHEN NEW.domain='h-message' BEGIN SELECT RAISE(ABORT,'synthetic Worker COW storage failure'); END`);
        const key=this.s.issueAccessKey('commons','owner');
        this.s.command(key,'commons',{id:'cow-fault',type:'message.edited',
          data:{messageId:'existing',body:'Must roll back',expectedMessageRevision:0}});
        return Response.json({unexpected:true});
      }
      if(url.pathname==='/seed-codec'){
        this.s.initialize(initialRoom());const state=structuredClone(this.s.room('commons').state);
        const sample=applyEvent(state,event({id:'template',roomId:'commons',actorId:'owner',type:'message.posted',at:'2026-01-01T00:00:00.000Z',data:{messageId:'template',body:'Synthetic Muse-sized body'}})).messages[0];
        state.messages=Array.from({length:17405},(_,i)=>({...sample,id:'m'+i}));
        state.replyRequests=Object.fromEntries(Array.from({length:305},(_,i)=>['request-'+i,{id:'request-'+i,body:'x'.repeat(720)}]));
        this.s.transaction(()=>this.db.prepare("UPDATE rooms SET projection=? WHERE id='commons'").run(this.s.storedProjection('commons',state)));
        return Response.json(this.db.prepare("SELECT octet_length(projection) AS bytes FROM rooms WHERE id='commons'").get());
      }
      if(url.pathname==='/durable-codec')return Response.json(partitionReplayWitness(this.s,{roomId:'commons',generation:url.searchParams.get('generation'),requestId:'codec-'+url.searchParams.get('step'),expectedBytes:Number(url.searchParams.get('bytes'))}));
      if(url.pathname==='/codec-census')return Response.json({
        ...this.db.prepare("SELECT count(*) AS messages,MAX(payload_bytes) AS maxLeafBytes FROM message_replay_units WHERE domain='message'").get(),
        entries:this.db.prepare("SELECT count(*) AS n FROM message_replay_units WHERE domain='metadata-entry' AND json_extract(unit_key,'$[0]')='replyRequests'").get().n,
        maxReceiptBytes:this.db.prepare("SELECT MAX(octet_length(counts_json)) AS n FROM operator_actions WHERE action LIKE 'replay_cutover_%'").get().n});
      if(url.pathname==='/codec-leaf')return Response.json(readReplayWitnessLeaf(this.s,{roomId:'commons',generation:url.searchParams.get('generation'),domain:'metadata-entry',key:JSON.stringify(['replyRequests','request-17'])}));
      if(url.pathname==='/codec-leaf-tamper'){
        const key=JSON.stringify(['replyRequests','request-17']);
        const row=this.db.prepare("SELECT payload FROM message_replay_units WHERE domain='metadata-entry' AND unit_key=?").get(key);
        const value=JSON.parse(new TextDecoder().decode(row.payload));value.body='tampered';const bytes=new TextEncoder().encode(JSON.stringify(value));
        this.db.prepare("UPDATE message_replay_units SET payload=?,payload_bytes=?,payload_sha256=? WHERE domain='metadata-entry' AND unit_key=?").run(bytes,bytes.length,createHash('sha256').update(bytes).digest('hex'),key);
        return Response.json({tampered:true});
      }
      if(url.pathname==='/durable-abandon')return Response.json(cutover.abandonReplayCapture(this.s,{
        roomId:'commons',generation:url.searchParams.get('generation'),requestId:'worker-abandon',reason:'Synthetic explicit abandonment'}));
      if(url.pathname==='/durable-cleanup'){
        const before={...this.stats};
        const result=cutover.cleanupReplayCapture(this.s,{roomId:'commons',generation:url.searchParams.get('generation'),
          expectedDeleted:Number(url.searchParams.get('deleted')),requestId:'cleanup-'+url.searchParams.get('step')});
        return Response.json({result,cost:Object.fromEntries(Object.keys(before).map(k=>[k,this.stats[k]-before[k]]))});
      }
      if(url.pathname==='/lifecycle-census')return Response.json({
        units:this.db.prepare('SELECT count(*) AS n FROM message_replay_units WHERE generation=?').get(url.searchParams.get('generation')).n,
        head:this.s.headSequence('commons'),metadataHash:this.db.prepare("SELECT metadata_hash FROM integrity_room_state WHERE room_id='commons'").get().metadata_hash,
        audit:cutover.auditReplayCutoverRecovery(this.db)});
      if(url.pathname==='/readmit'){cutover.admitReplayCutoverSchema(this.db);return Response.json({admitted:true});}
      if(url.pathname==='/durable-capture')return Response.json(captureReplayWitness(this.s,{roomId:'commons',requestId:'durable-capture',expectedHead:2,reason:'Synthetic durable capture'}));
      if(url.pathname==='/durable-step')return Response.json(advanceReplayWitness(this.s,{roomId:'commons',generation:url.searchParams.get('generation'),requestId:'step-'+url.searchParams.get('step'),expectedBytes:Number(url.searchParams.get('bytes'))}));
      if(url.pathname==='/durable-step-cost'){
        const before={...this.stats},prepare=this.db.prepare.bind(this.db);let definitionBytes=0,schemaDefinitionBindingBytes=0;
        this.db.prepare=sql=>{
          const statement=prepare(sql);if(!sql.includes('FROM sqlite_master'))return statement;
          return new Proxy(statement,{get(target,key){const value=Reflect.get(target,key,target);
            if(key!=='get')return typeof value==='function'?value.bind(target):value;
            return(...args)=>{for(const arg of args)if(typeof arg==='string'&&/^CREATE (?:TABLE|TRIGGER)/.test(arg))schemaDefinitionBindingBytes+=new TextEncoder().encode(arg).length;const row=value.apply(target,args);if(typeof row?.sql==='string')definitionBytes+=new TextEncoder().encode(row.sql).length;return row;};}});
        };
        try{
          const result=advanceReplayWitness(this.s,{roomId:'commons',generation:url.searchParams.get('generation'),requestId:'step-'+url.searchParams.get('step'),expectedBytes:Number(url.searchParams.get('bytes'))});
          return Response.json({result,cost:{...Object.fromEntries(Object.keys(before).map(k=>[k,this.stats[k]-before[k]])),definitionBytes,schemaDefinitionBindingBytes}});
        }finally{this.db.prepare=prepare;}
      }
      if(url.pathname==='/seed-derived'){
        const count=Number(url.searchParams.get('count')),generation=url.searchParams.get('generation');
        if(![0,17405].includes(count)||!/^[a-f0-9]{64}$/.test(generation))throw Error('invalid synthetic unit count');
        this.s.transaction(()=>{const insert=this.db.prepare("INSERT INTO message_replay_units VALUES(?,?,'message',?,1,2,?,?)");
          const digest=createHash('sha256').update('{}').digest('hex');
          for(let i=0;i<count;i++)insert.run('commons',generation,'synthetic-'+i,digest,new Uint8Array([123,125]));});
        return Response.json({count});
      }
      if(url.pathname==='/append-cost'){
        const i=url.searchParams.get('i');if(!/^[0-9]{1,3}$/.test(i))throw Error('invalid synthetic append');
        const original=this.db.prepare.bind(this.db),samples=[];
        this.db.prepare=sql=>{
          const statement=original(sql);if(!sql.startsWith('INSERT INTO events'))return statement;
          return new Proxy(statement,{get:(target,key)=>{
            const value=Reflect.get(target,key,target);if(key!=='run')return typeof value==='function'?value.bind(target):value;
            return(...args)=>{const before={...this.stats};const result=value.apply(target,args);
              samples.push(Object.fromEntries(Object.keys(before).map(k=>[k,this.stats[k]-before[k]])));return result;};
          }});
        };
        try{const key=this.s.issueAccessKey('commons','owner');
          const write=()=>this.s.command(key,'commons',{id:'cost-'+i,type:'message.posted',data:{messageId:'cost-'+i,body:'Synthetic ongoing append'}});
          if(url.searchParams.get('baseline')==='1')this.s.transaction(()=>{
            const trigger=this.db.prepare("SELECT sql FROM sqlite_master WHERE name='replay_source_prefix_insert'").get().sql;
            this.db.exec('DROP TRIGGER replay_source_prefix_insert');write();this.db.exec(trigger);
          });else write();
        }
        finally{this.db.prepare=original;}
        return Response.json({head:this.s.headSequence('commons'),eventStatementCosts:samples});
      }
      return super.fetch(request);
    }catch(error){return Response.json({error:error.code??'internal',message:String(error.message).slice(0,180)},{status:error.status??500});}
  }
}
export default {fetch(request,env){const surface=new URL(request.url).searchParams.get('surface')??'cutover';
  if(!/^(?:cutover|cow-baseline|cow-idle|cow-active|cow-fault|references|h-small|h-large|h-work|archive-small|archive-large|archive-bad)$/.test(surface))return new Response('invalid fixture surface',{status:400});
  return env.ROOM.getByName(surface).fetch(request);}};
