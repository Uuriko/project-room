import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RoomStore} from '../server/store.mjs';
import {createRoomServer} from '../server/http.mjs';
import {seedScopedInbox} from './helpers/scoped-inbox-source.mjs';
import {Bridge} from '../room-acp/src/bridge.mjs';

async function fixture(t, options = {}) {
  const store = new RoomStore(':memory:'), seeded = seedScopedInbox(store);
  const server = createRoomServer({store});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const home = mkdtempSync(join(tmpdir(), 'formal-bridge-'));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); store.close();
    rmSync(home, {recursive:true, force:true});
  });
  const apiBase = `http://127.0.0.1:${server.address().port}`;
  const counts = {prompts:0, sent:[]}, logs = [];
  const connection = {apiBase, roomId:'commons', memberId:'worker', identityId:seeded.identityId,
    credential:seeded.token, hostId:'formal-fixture'};
  const make = (fetchImpl = fetch) => new Bridge({connection, env:{ROOM_ACP_HOME:home}, fetchImpl,
    log:line => logs.push(line), host:{
      session:async () => ({sessionId:'synthetic', created:true}),
      prompt:async (_key, prompt) => {
        counts.prompts++; counts.prompt = prompt;
        return {recorder:{text:options.text ?? JSON.stringify({outcome:'answered', body:'Useful verified answer'}), tools:new Map()},
          stopReason:options.stopReason ?? 'end_turn'};
      }
    }});
  const ready = async bridge => {await bridge.refreshRoom(); await bridge.lease();};
  const read = async (bridge, id = 'dm') => bridge.room.request(`/api/rooms/commons/reply-context?requestMessageId=${id}`);
  const wake = {signalId:'synthetic-formal-wake', messageId:'dm', author:'owner', body:'Please answer'};
  return {store, seeded, home, connection, make, ready, read, wake, counts, logs};
}

test('heartbeat is connected but not listening without a wake poll', async t=>{
 const f=await fixture(t);let polls=0;const bridge=f.make(async(url,options)=>{if(String(url).includes('/agent-wakes/poll'))polls++;return fetch(url,options)});await f.ready(bridge);assert.equal(polls,0);
 const wake=f.store.agentHeartbeats.enqueueWake({agentId:f.seeded.identityId,kind:'dm',roomId:'commons',messageId:'dm'}).signal;
 const presence=await bridge.room.request('/api/rooms/commons/presence');const me=presence.members.find(m=>m.memberId==='worker');
 assert.ok(f.store.agentHeartbeats.pendingWakes(f.seeded.identityId).some(w=>w.signalId===wake.signalId));assert.equal(f.counts.prompts,0);assert.equal(me.presence.status,'online');assert.equal(me.state,'idle');assert.equal(me.watching,false);
 console.log('presence_without_wake_poll',JSON.stringify({state:me.state,watching:me.watching,hostStatus:me.presence.status,polls}));
});
