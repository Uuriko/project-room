// CX5-FIX desired-contract regressions for the scoped-listener repair.
//
// These pin the REPAIRED contracts that Codex's independent CX5 review
// (issue #3299, comment 6178462740) specified, replacing the three
// current-behavior characterizations in his portable evidence file:
//   1. The exact credential standard setup saves (a rak_ API key bound to
//      one room by its mcp:room: scope) reaches a documented supported
//      listener — AgentWakeClient + the REST heartbeat/poll/ack surface —
//      through genuinely scoped authorization, without exposing a pri_
//      owner secret.
//   2. Room-scoped activity cannot advertise or suppress availability in
//      another room after membership changes: wake-status attributes per
//      room, and pushTargets' offline gate reads identity-level presence.
//   3. HTTP receiving is separable from execution admission, and ack is
//      lease-fenced: observation (poll) stays non-consuming for every
//      host, while a queue under a live listener lease drains only with
//      its fencing token. Native execution over HTTP is NOT claimed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
import { connectRoom } from '../client/agent-setup.mjs';
import { readAgentConnection } from '../client/agent-connection.mjs';
import { openSetupJournal, atomicPrivateJson } from '../client/setup-journal.mjs';
import { AgentWakeClient } from '../client/agent-wake.mjs';

async function fixture(t) {
  const store = new RoomStore(':memory:'), root = mkdtempSync(join(tmpdir(), 'scoped-contract-'));
  for (const id of ['commons', 'annex']) store.initialize(initialRoom(id));
  const owners = Object.fromEntries(['commons', 'annex'].map(id => [id, store.issueAccessKey(id, 'owner')]));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); store.close(); rmSync(root, { recursive: true, force: true });
  });
  const invite = store.invites.create(owners.commons, 'commons', { profile: 'chat', displayName: 'Peer' });
  const setup = await connectRoom({ origin, directory: join(root, 'private'), name: 'Peer', accept: true, target: invite.code });
  const connection = readAgentConnection(setup.configDirectory);
  const request = async (path, token, body) => {
    const response = await fetch(origin + path, { method: body ? 'POST' : 'GET', headers: {
      Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json', Origin: origin } : {})
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, value: await response.json() };
  };
  const addMember = (name, roomId, memberId) => {
    const identity = store.identities.create(name);
    store.identities.link(owners[roomId], roomId, { identityId: identity.identityId, memberId, displayName: name, permissions: [] });
    return identity;
  };
  return { store, owners, setup, connection, request, addMember, origin };
}


test('default wait owns reception; losing the lease exposes no pointers and cannot ack', async t => {
 const f=await fixture(t), a=new AgentWakeClient({connection:f.connection}), b=new AgentWakeClient({connection:f.connection});
 const signal=f.store.agentHeartbeats.enqueueWake({agentId:f.setup.identityId,kind:'mention',roomId:'commons',messageId:'lease-pointer'}).signal;
 assert.ok((await a.wait({hostId:'first',cadenceSeconds:60,waitMs:0})).pendingWakes.some(x=>x.signalId===signal.signalId));
 const loser=await b.wait({hostId:'second',cadenceSeconds:60,waitMs:0});
 assert.deepEqual(loser.pendingWakes,[]);
 assert.equal(loser.status,'listener_contended');
 await assert.rejects(b.ack({signalIds:[signal.signalId]}),e=>e.status===409);
 const raw=await f.request('/api/agent-heartbeats/ack',f.connection.token,{signalIds:[signal.signalId]});
 assert.equal(raw.status,409);
 assert.deepEqual((await a.ack({signalIds:[signal.signalId]})).acknowledged,[signal.signalId]);
});

for (const flavor of ['poll','channel','channel-attention']) test(`actual ${flavor} adapters respect contention and recover after owner expiry`,{timeout:15000}, async t=>{
 const mode=flavor==='poll'?'poll':'channel';
 const f=await fixture(t), {spawn}=await import('node:child_process');
 if(flavor==='channel-attention'){
  const journal=openSetupJournal(join(f.setup.configDirectory,'../..'));const secret=journal.read().secret;journal.close();
  atomicPrivateJson(join(f.setup.configDirectory,'connection.json'),{...f.connection,token:secret});
 }
 const peers=[];
 t.after(async()=>{for(const p of peers) await p.stop();});
 const peer=host=>{
  const child=spawn(process.execPath,[new URL('../scripts/room-listen.mjs',import.meta.url).pathname,'--mode',mode,'--host',host,'--cadence-seconds','60'],{env:{...process.env,ROOM_AGENT_CONFIG:f.setup.configDirectory},stdio:['pipe','pipe','pipe']});
  let output='',errors='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>errors+=b);
  const closed=new Promise(resolve=>child.once('close',resolve));
  const p={child,read:()=>output,errors:()=>errors,stop:async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await closed;}};peers.push(p);
  if(mode==='channel') child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'lease-test',version:'1'}}})+'\n'+JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  return p;
 };
 const until=async predicate=>{for(let i=0;i<150;i++){if(predicate())return;await new Promise(r=>setTimeout(r,40));}assert.fail('adapter condition not reached');};
 const signal=f.store.agentHeartbeats.enqueueWake({agentId:f.setup.identityId,kind:'mention',roomId:'commons',messageId:'process-lease-pointer'}).signal;
 f.store.dmConsents.request('commons','owner',f.connection.memberId,'Synthetic request');
 f.store.dmConsents.decide('commons',f.connection.memberId,'owner','approve');
 f.store.command(f.owners.commons,'commons',{id:crypto.randomUUID(),type:'message.posted',data:{messageId:'real-attention',body:'Please respond',toMemberId:f.connection.memberId,requestKind:'reply'}});
 const first=peer('process-first');await until(()=>first.read().includes(signal.signalId));
 if(flavor==='channel-attention') assert.ok(first.read().includes('startup_attention'),'fixture must exercise actual addressed attention');
 let contended=false;const acquire=f.store.agentHeartbeats.acquireListenerLease.bind(f.store.agentHeartbeats);
 f.store.agentHeartbeats.acquireListenerLease=args=>{const result=acquire(args);if(args.listenerId.endsWith('process-second')&&!result.acquired)contended=true;return result;};
 const second=peer('process-second');await until(()=>contended||second.read().includes(signal.signalId));
 await new Promise(r=>setTimeout(r,100));
 assert.equal(second.read().includes(signal.signalId),false,'contended process must not dispatch queued pointer');
 if(mode==='channel') assert.equal(second.read().includes('\"method\":\"notifications/claude/channel\"'),false,'contended process must not emit startup attention either');
 await first.stop();
 f.store.db.prepare('UPDATE agent_wake_listener_leases SET lease_expires_at=0 WHERE agent_id=?').run(f.setup.identityId);
 await until(()=>second.read().includes(signal.signalId));
 assert.equal(first.errors(),'');assert.equal(second.errors(),'');
 assert.ok(f.store.agentHeartbeats.pendingWakes(f.setup.identityId,{roomId:'commons'}).some(x=>x.signalId===signal.signalId),'delivery never acknowledges');
});

test('lease takeover during a held response suppresses the stale page and stale ack', async t=>{
 const f=await fixture(t);let release, entered;
 const gate=new Promise(r=>release=r), started=new Promise(r=>entered=r);
 const first=new AgentWakeClient({connection:f.connection,fetchImpl:async(url,options)=>{
  const response=await fetch(url,options);
  if(String(url).includes('/api/agent-wakes/poll')){entered();await gate;}
  return response;
 }});
 const signal=f.store.agentHeartbeats.enqueueWake({agentId:f.setup.identityId,kind:'mention',roomId:'commons',messageId:'held-page'}).signal;
 const old=first.wait({hostId:'old',cadenceSeconds:60,waitMs:0});await started;
 f.store.db.prepare('UPDATE agent_wake_listener_leases SET lease_expires_at=0 WHERE agent_id=?').run(f.setup.identityId);
 const next=new AgentWakeClient({connection:f.connection});
 assert.ok((await next.wait({hostId:'new',cadenceSeconds:60,waitMs:0})).pendingWakes.some(x=>x.signalId===signal.signalId));
 release();assert.deepEqual((await old).pendingWakes,[]);
 await assert.rejects(first.ack({signalIds:[signal.signalId]}),e=>e.status===409);
 assert.deepEqual((await next.ack({signalIds:[signal.signalId]})).acknowledged,[signal.signalId]);
});

test('separate CLI-style ack resumes the same host lease without storing its token',async t=>{
 const f=await fixture(t),a=new AgentWakeClient({connection:f.connection});
 const signal=f.store.agentHeartbeats.enqueueWake({agentId:f.setup.identityId,kind:'mention',roomId:'commons',messageId:'cli-ack'}).signal;
 await a.wait({hostId:'cli-host',cadenceSeconds:300,waitMs:0});
 const ack=new AgentWakeClient({connection:f.connection});
 assert.deepEqual((await ack.ack({hostId:'cli-host',signalIds:[signal.signalId]})).acknowledged,[signal.signalId]);
});
