import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { connectRoom } from '../client/agent-setup.mjs';
import { readAgentConnection } from '../client/agent-connection.mjs';
import { AgentWakeClient } from '../client/agent-wake.mjs';
const fixture = `
import entry, { ProjectRoom } from './room.mjs';
import { AgentRooms } from '../server/agent-rooms.mjs';
export class ScopedTestRoom extends ProjectRoom {
 async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === '/__fixture/setup') {
   const owner = this.store.identities.create('Synthetic owner');
   new AgentRooms(this.store).create(owner.secret,{roomId:'scoped-room',title:'Scoped test',purpose:'Disposable Worker proof'});
   const invite = this.store.invites.create(owner.secret,'scoped-room',{profile:'chat',displayName:'Worker peer'});
   return Response.json({invite:invite.code});
  }
  if (path === '/__fixture/signal') {
   const {identityId} = await request.json();
   return Response.json(this.store.agentHeartbeats.enqueueWake({agentId:identityId,kind:'mention',roomId:'scoped-room',messageId:'worker-pointer'}));
  }
  return super.fetch(request);
 }
}
export default entry;`;
test('actual Worker supports setup-saved scoped credential and explicit lease-fenced ack', { timeout:60000 }, async () => {
 const root = await mkdtemp(join(tmpdir(),'scoped-worker-'));
 const bundled = await build({stdin:{contents:fixture,resolveDir:process.cwd(),sourcefile:'scoped-fixture.mjs'},bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']});
 const origin='https://room.example.test';
 const worker=new Miniflare({modules:true,script:bundled.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjects:{ROOM:{className:'ScopedTestRoom',useSQLite:true}},bindings:{ROOM_ORIGIN:origin}});
 const fetchImpl=(url,options)=>worker.dispatchFetch(url,options);
 const post=(path,body,token)=>fetchImpl(origin+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
 try {
  const f=await (await post('/__fixture/setup',{})).json();
  const setup=await connectRoom({origin,directory:join(root,'connection'),target:f.invite,name:'Worker peer',accept:true,fetchImpl});
  assert.equal(setup.status,'connected');
  const connection=readAgentConnection(setup.configDirectory);
  assert.match(connection.token,/^rak_/);
  const client=new AgentWakeClient({connection,fetchImpl});
  const registered=await client.setup({hostId:'worker-scoped',cadenceSeconds:60,listener:true});
  assert.equal(registered.listener.acquired,true);
  const queued=await (await post('/__fixture/signal',{identityId:setup.identityId})).json();
  const waited=await client.wait({hostId:'worker-scoped',cadenceSeconds:60,waitMs:0});
  assert.ok(waited.pendingWakes.some(row=>row.signalId===queued.signal.signalId));
  assert.equal((await post('/api/agent-heartbeats/ack',{signalIds:[queued.signal.signalId]},connection.token)).status,409);
  assert.deepEqual((await client.ack({signalIds:[queued.signal.signalId]})).acknowledged,[queued.signal.signalId]);
 } finally {await worker.dispose();await rm(root,{recursive:true,force:true});}
});
