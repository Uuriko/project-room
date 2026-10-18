// Local reproducible migration comparison. No network, credentials or deployment.
// Each sampled edit is rolled back, keeping the same event head and body.
import { performance } from 'node:perf_hooks';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { event } from '../src/events.js';

const args = process.argv.slice(2);
const modes = args.includes("--without-legacy") ? ["entity", "references"] : ["entity", "references", "legacy"];
const sizes = args.filter(arg => arg !== "--without-legacy").map(Number);
if (!sizes.length) sizes.push(100, 1000);
if (sizes.some(n => !Number.isSafeInteger(n) || n < 10 || n > 100000)) throw new Error('Choose message counts between 10 and 100000');
const percentile = (values, p) => [...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1];
const results=[];
for (const size of sizes) {
 const store=new RoomStore(':memory:',{messageProjectionWindow:8});
 try {
  const events=initialRoom();
  for(let i=0;i<size;i++)events.push(event({id:`seed-${i}`,idempotencyKey:`seed-${i}`,roomId:'commons',actorId:'owner',type:'message.posted',at:new Date(Date.UTC(2026,0,1)+i*1000).toISOString(),data:{messageId:`m-${i}`,body:`Settled record ${i}. ${'content '.repeat(64)}`}}));
  store.initialize(events);store.roomFlood={consume(){}};
  const token=store.issueAccessKey('commons','owner');
  while(!store.backfillMessages({limit:1000}).done){}
  if(!store.checkMessagesParity().ok)throw new Error('Fixture parity failed');
  store.archiveMessages('commons',{keepNewest:8,dryRun:false});
  const replay=store._replayRoom.bind(store),prepare=store.db.prepare.bind(store.db);
  let queries=0,replays=0,profile=null;
  const bytes=value=>Buffer.byteLength(JSON.stringify(value) ?? '');
  store.db.prepare=(...args)=>{
   queries++;const statement=prepare(...args);
   if(!profile)return statement;
   return new Proxy(statement,{get(target,key){
    const method=Reflect.get(target,key,target);
    if(typeof method!=='function')return method;
    return (...bindings)=>{
     profile.boundBytes+=bytes(bindings);
     const result=method.apply(target,bindings);
     if(key==='get'||key==='all'){
      profile.resultBytes+=bytes(result);
      profile.resultRows+=key==='all'?result.length:result===undefined?0:1;
     }
     return result;
    };
   }});
  };
  store._replayRoom=(...args)=>{replays++;return replay(...args);};
  const samples=Object.fromEntries(modes.map(mode=>[mode,[]])),profiles={};
  const rollback=new Error('benchmark rollback');
  for(let i=0;i<15;i++)for(const mode of i%2?modes:[...modes].reverse()) {
   let ms;
   try {store.transaction(()=>{
    store.messageEntityProjection=mode==='references';
    if(mode==='legacy')store.db.prepare("UPDATE messages SET reducer_extras_json=NULL WHERE room_id='commons' AND message_id='m-0'").run();
    queries=0;replays=0;
    profile=i===14?{boundBytes:0,resultBytes:0,resultRows:0}:null;
    const start=performance.now();
    store.command(token,'commons',{id:'measured-edit',type:'message.edited',data:{messageId:'m-0',body:'Corrected record.',expectedMessageRevision:0}});
    ms=performance.now()-start;
    if(profile)profile.projectionBytes=Buffer.byteLength(prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection);
    throw rollback;
   });}catch(error){if(error!==rollback)throw error;}
   if(i===14){profiles[mode]=profile;profile=null;}
   else if(i>=2)samples[mode].push({ms,queries,replays});
  }
  results.push({messages:size,workingSet:store.room('commons').state.messages.length,projectionBytes:Buffer.byteLength(prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection),samples:12,modes:Object.fromEntries(Object.entries(samples).map(([mode,rows])=>[mode,{medianMs:percentile(rows.map(r=>r.ms),.5),p95Ms:percentile(rows.map(r=>r.ms),.95),maxPreparedStatements:Math.max(...rows.map(r=>r.queries)),maxRoomReplays:Math.max(...rows.map(r=>r.replays)),profile:profiles[mode]}]))});
 }finally{store.close();}
}
console.log(JSON.stringify({workload:'one archived edit at a fixed head, alternating modes, two warmups each; rollback cost excluded',runtime:process.version,platform:process.platform,results},null,2));
