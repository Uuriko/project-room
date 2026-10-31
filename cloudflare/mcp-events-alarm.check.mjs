// Actual workerd alarms and production outbox manager. Authorization and I/O
// are deterministic fixture boundaries; probe reads never rearm an alarm.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const source = `
import { ProjectRoom } from './cloudflare/room.mjs';
import { createMcpEventSubscriptions } from './server/mcp-event-subscriptions.mjs';
export class Probe extends ProjectRoom {
 constructor(ctx,env) { super(ctx,env); this.store.nativeMcpEventsEnabled=true; this.allowed=true;this.posts=[];this.failures=0;
 const getAlarm=ctx.storage.getAlarm.bind(ctx.storage),setAlarm=ctx.storage.setAlarm.bind(ctx.storage);
 ctx.storage.getAlarm=async()=>this.staleAlarm?Date.now()-86400000:getAlarm();
 ctx.storage.setAlarm=async when=>{this.staleAlarm=false;return setAlarm(when);};
 this.principal={principalType:'invited-agent',familyId:'family',resource:'https://room.example/mcp',roomId:'commons',identityId:'ai_probe',memberId:'agent',scopes:['chat:read']};
 this.manager=createMcpEventSubscriptions({store:this.store,authorize:()=>this.allowed,
 dnsResolvers:{lookup:async()=>[{address:'93.184.216.34',family:4}]},transport:async(_url,_addresses,{body})=>{
 const data=JSON.parse(body);if(data.type==='verification')return{status:200,text:async()=>JSON.stringify({challenge:data.challenge})};
 this.posts.push(data.eventId);return {status:this.failures-->0?500:204,text:async()=>''};}}); }
 async drainMcpEvents(){return this.manager.drain({limit:1});}
 async fetch(request){const path=new URL(request.url).pathname;
 if(path==='/seed'){
 const mode=new URL(request.url).searchParams.get('mode'); this.failures=mode==='retry'?1:0;this.staleAlarm=mode==='stale-alarm';
 await this.manager.subscribe({principal:this.principal,name:'room.requested',arguments:{roomId:'commons',memberId:'agent'},delivery:{mode:'webhook',url:'https://8.8.8.8/wake',secret:'whsec_'+Buffer.alloc(32,7).toString('base64')}});
 for(let i=0;i<(mode==='backlog'?2:1);i++)this.manager.enqueueRequested({roomId:'commons',memberId:'agent',messageId:'message',eventId:'event_'+i});
 if(mode==='lease')this.store.db.prepare("UPDATE mcp_event_outbox SET state='leased',lease='crashed',lease_until=?,attempts=1").run(Date.now()+1500);
 if(mode==='revoke')this.allowed=false;
 if(mode==='disabled')this.store.nativeMcpEventsEnabled=false;
 await super.fetch(new Request('https://room.example/api/health'));return Response.json({seeded:true});}
 if(path==='/state')return Response.json({posts:this.posts,alarmAt:await this.ctx.storage.getAlarm(),rows:this.store.db.prepare('SELECT event_id,state,attempts,next_at,lease_until FROM mcp_event_outbox').all()});
 return super.fetch(request); }
}
export default {fetch(request,env){return env.ROOM.get(env.ROOM.idFromName('probe')).fetch(request);}};
`;
async function start(){
 const bundled=await build({stdin:{contents:source,resolveDir:root,sourcefile:'native-alarm-probe.mjs'},bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']});
 return new Miniflare({modules:true,script:bundled.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjects:{ROOM:{className:'Probe',useSQLite:true}},kvNamespaces:['ROOM_BACKUPS_KV'],bindings:{ROOM_ORIGIN:'https://room.example',ROOM_MAINTENANCE:'0',ROOM_GMAIL_ENABLED:'0'}});
}
const read=async(mf,path)=>{const response=await mf.dispatchFetch('https://room.example'+path);const text=await response.text();assert.equal(response.status,200,text);return JSON.parse(text);};
for(const mode of ['backlog','retry','lease','revoke','stale-alarm'])test('native outbox alarm '+mode+' progresses without another write', {timeout:30000},async()=>{
 const mf=await start();try{
 await read(mf,'/seed?mode='+mode);
 let state;const until=Date.now()+15000;
 do{state=await read(mf,'/state');if(state.rows.length&&state.rows.every(row=>['delivered','dead'].includes(row.state)))break;await new Promise(resolve=>setTimeout(resolve,100));}while(Date.now()<until);
 assert.ok(state.rows.every(row=>row.state===(mode==='revoke'?'dead':'delivered')),JSON.stringify(state));
 assert.equal(state.rows.length,mode==='backlog'?2:1);
 assert.equal(state.posts.length,mode==='revoke'?0:mode==='backlog'||mode==='retry'?2:1);
 if(mode==='retry')assert.equal(new Set(state.posts).size,1,'retry preserves event ID');
 if(mode==='lease')assert.equal(state.rows[0].attempts,2,'expired lease is reclaimed');
 }finally{await mf.dispose();}
});

// Removing operator configuration preserves pending rows without a hot loop.
test('disabled native runtime does not schedule stale outbox deliveries', {timeout:30000},async()=>{
 const mf=await start();try{
 await read(mf,'/seed?mode=disabled');
 await new Promise(resolve=>setTimeout(resolve,1500));
 const state=await read(mf,'/state');
 assert.deepEqual(state.posts,[]);
 assert.equal(state.rows[0].state,'pending');
 assert.ok(state.alarmAt===null || state.alarmAt>Date.now()+5000,JSON.stringify(state));
 }finally{await mf.dispose();}
});
