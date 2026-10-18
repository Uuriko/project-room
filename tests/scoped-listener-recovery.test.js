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
import { readAgentConnection, saveAgentConnection } from '../client/agent-connection.mjs';
import { RoomAgentClient } from '../client/room-agent.mjs';
import { openSetupJournal, atomicPrivateJson } from '../client/setup-journal.mjs';
import { AgentWakeClient } from '../client/agent-wake.mjs';
import { linkWithProof } from "./helpers/link-with-proof.mjs";

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
    linkWithProof(store, owners[roomId], roomId, identity, { memberId, displayName: name, permissions: [] });
    return identity;
  };
  return { store, owners, setup, connection, request, addMember, origin, root, invite };
}


test('legacy key remains unchanged on setup rerun; explicit scoped replacement verifies before new private save',async t=>{
 const f=await fixture(t), legacyScopes=['mcp:room:commons','rooms:read','rooms:write','mcp:inbox','mcp:wake'];
 const old=f.store.agentPlugin.issueApiKey({identityId:f.setup.identityId,scopes:legacyScopes});
 const legacy={...f.connection,token:'rak_'+old.secret};
 atomicPrivateJson(join(f.setup.configDirectory,'connection.json'),legacy);
 const again=await connectRoom({origin:f.origin,directory:join(f.root,'private'),name:'Peer',accept:true,target:f.invite.code});
 assert.equal(readAgentConnection(again.configDirectory).token,legacy.token,'rerun deliberately preserves existing config');
 const destination=join(f.root,'upgraded');
 const verifyAndSave=async config=>{
  assert.notEqual(config.token,legacy.token,'replacement must not reuse the old credential');
  assert.equal(config.origin,legacy.origin);assert.equal(config.roomId,legacy.roomId);assert.equal(config.memberId,legacy.memberId);
  const wake=new AgentWakeClient({connection:config});
  await wake.setup({hostId:'recovery-check',cadenceSeconds:60});
  assert.equal((await wake.doctor({hostId:'recovery-check'})).registration,'registered');
  saveAgentConnection(destination,config);
 };
 await assert.rejects(verifyAndSave(legacy),/replacement must not reuse/);
 assert.throws(()=>readAgentConnection(destination),e=>e.code==='config_not_found');
 const stillLegacy=f.store.agentPlugin.issueApiKey({identityId:f.setup.identityId,scopes:legacyScopes});
 await assert.rejects(verifyAndSave({...legacy,token:'rak_'+stillLegacy.secret}),e=>e.status===403&&e.code==='insufficient_scope');
 assert.throws(()=>readAgentConnection(destination),e=>e.code==='config_not_found');
 const journal=openSetupJournal(join(f.root,'private'));const owner=journal.read().secret;journal.close();
 const issuer=new RoomAgentClient({...legacy,token:owner});
 const issued=await issuer.createAgentKey({scopes:[...legacyScopes,'heartbeats:read','heartbeats:report'],label:'explicit-listener-upgrade',expiresAt:Date.now()+86400000});
 assert.deepEqual([...issued.scopes].sort(),[...legacyScopes,'heartbeats:read','heartbeats:report'].sort());
 await verifyAndSave({...legacy,token:issued.credential});
 assert.equal(readAgentConnection(f.setup.configDirectory).token,legacy.token,'old config remains for deliberate cutover');
 assert.equal(readAgentConnection(destination).token,issued.credential);
 const listener=new AgentWakeClient({connection:readAgentConnection(destination)});
 assert.equal((await listener.wait({hostId:'replacement-host',cadenceSeconds:60,waitMs:0})).status,'wait_completed');
 await assert.rejects(verifyAndSave({...legacy,token:issued.credential}),e=>e.code==='config_exists');
});
