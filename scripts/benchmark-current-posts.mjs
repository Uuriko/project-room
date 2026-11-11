// Synthetic local scaling qualification. No production reads or mutations.
// Measures committed ordinary commands, not SQL inserts or rolled-back posts.
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';

const check=process.argv.includes('--check');
const sizes=process.argv.slice(2).filter(arg=>arg!=='--check').map(Number);
if(!sizes.length)sizes.push(1000,50000);
if(sizes.some(n=>!Number.isSafeInteger(n)||n<1||n>100000))throw Error('Choose history counts from 1 to 100000');
const percentile=(values,p)=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1];
const results=[];
for(const size of sizes){
 const store=new RoomStore(':memory:');
 try{
  const seed=initialRoom(),setupStart=performance.now();
  for(let i=0;i<size;i++)seed.push(event({id:`seed-${String(i).padStart(6,'0')}`,idempotencyKey:`seed-${String(i).padStart(6,'0')}`,roomId:'commons',actorId:'owner',type:'message.posted',at:new Date(Date.UTC(2026,0,1)+i*1000).toISOString(),data:{messageId:`message-${String(i).padStart(6,'0')}`,body:'Existing useful context. '.repeat(8)}}));
  store.initialize(seed,{representation:'normalized-current-v1'});
  const token=store.issueAccessKey('commons','owner');
  const carrier=store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection;
  assert.equal(JSON.parse(carrier).normalizedCurrent.version,1);
  const setupMs=performance.now()-setupStart;
  store.room=()=>{throw Error('Whole-room hydration in normalized post');};
  store.roomFlood={consume(){}}; // Exclude synthetic burst admission, not storage work.
  const prepare=store.db.prepare.bind(store.db);let active=null;
  store.db.prepare=(sql)=>{
   const statement=prepare(sql);
   return new Proxy(statement,{get(target,key){const method=Reflect.get(target,key,target);if(typeof method!=='function')return method;
    return(...args)=>{if(active&&key==='run'&&/\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)){
     active.writeStatements++;active.boundWriteBytes+=Buffer.byteLength(JSON.stringify(args,(_k,v)=>typeof v==='bigint'?String(v):v));
     if(/\b(?:UPDATE|DELETE)\s+(?:FROM\s+)?["`]?events\b/i.test(sql))throw Error('Post attempted to rewrite history');
    }return method.apply(target,args);};}});
  };
  const samples=[];
  for(let i=0;i<23;i++){
   active={writeStatements:0,boundWriteBytes:0};const start=performance.now();
   const result=store.command(token,'commons',{id:`bench-${String(i).padStart(4,'0')}`,type:'message.posted',data:{messageId:`bench-${String(i).padStart(4,'0')}`,body:'One fixed-size useful update.'}});
   const ms=performance.now()-start,profile=active;active=null;assert.equal(result.duplicate,false);
   if(i>=3)samples.push({ms,...profile});
  }
  const finalCarrier=JSON.parse(store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection);
  assert.deepEqual(Object.keys(finalCarrier),['normalizedCurrent'],'only the small head marker belongs in the carrier');
  assert.deepEqual(Object.keys(finalCarrier.normalizedCurrent).sort(),['headHash','headRevision','version']);
  assert.equal(finalCarrier.normalizedCurrent.version,1);
  assert.equal(finalCarrier.normalizedCurrent.headHash.length,64);
  assert.equal(store.db.prepare("SELECT count(*) n FROM events WHERE room_id='commons'").get().n,seed.length+23);
  results.push({historyEvents:size,setupMs,samples:samples.length,medianMs:percentile(samples.map(s=>s.ms),.5),p95Ms:percentile(samples.map(s=>s.ms),.95),maximumBoundWriteBytes:Math.max(...samples.map(s=>s.boundWriteBytes)),maximumWriteStatements:Math.max(...samples.map(s=>s.writeStatements)),carrierBytes:Buffer.byteLength(carrier)});
 }finally{store.close();}
}
const ratio=results.length>1?results.at(-1).medianMs/results[0].medianMs:null;
console.log(JSON.stringify({runtime:process.version,platform:process.platform,workload:'normalized committed posts; fixed body; three warmups and twenty samples; in-memory SQLite; SQL bound bytes are not physical disk or Cloudflare billing bytes',results,medianLatencyRatio:ratio,targetUnder2x:ratio===null?null:ratio<2},null,2));
if(check){
 assert.deepEqual(sizes,[1000,50000],'CI qualification requires the specified 1k/50k workload');
 assert.ok(ratio<2,'50k post median must be less than twice the 1k median');
 assert.equal(results[1].maximumWriteStatements,results[0].maximumWriteStatements,'history growth must not add SQL write statements');
 assert.ok(results[1].maximumBoundWriteBytes<=results[0].maximumBoundWriteBytes*1.1,'fixed-size post write bindings must stay flat, allowing wider numeric sequences');
}
