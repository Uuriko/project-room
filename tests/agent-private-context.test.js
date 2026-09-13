import test from 'node:test';
import assert from 'node:assert/strict';
import {rmSync} from 'node:fs';
import {createAcceptanceFixture} from '../scripts/acceptance-fixture.mjs';
import {createRoomServer} from '../server/http.mjs';
import {RoomAgentClient} from '../client/room-agent.mjs';

test('agent private context reads only the selected recipient share and rechecks revocation',async t=>{
  const f=createAcceptanceFixture(),account=f.store.accountForMember('commons','owner'),slot=f.store.createAccountSessionSlot();
  const auth=f.store.loginAccountSession(slot.token,f.store.issueAccountAccessKey(account.id),0),apply=r=>f.store.inbox.apply(slot.token,r,auth.sessionBinding);
  apply({action:'source.save',requestId:'source',sourceId:'source',expectedRevision:0,data:{adapter:'synthetic',sender:'private sender',recipient:'owner',subject:'private subject',paragraphs:['Chosen context','Not shared']}});
  const grant=apply({action:'source.grant',requestId:'share',sourceId:'source',sourceRevision:1,roomId:'commons',paragraphs:[0],memberIds:['producer'],
    audienceVersion:f.store.inbox.shareContext(slot.token,'source','commons',auth.sessionBinding).audienceVersion}).receipt.grantId;
  const server=createRoomServer({store:f.store});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{server.closeStreams();server.closeAllConnections();await new Promise(r=>server.close(r));f.store.close();rmSync(f.directory,{recursive:true,force:true});});
  const origin=`http://127.0.0.1:${server.address().port}`,config={origin,roomId:'commons',memberId:'producer',token:f.keys.producer};
  const client=new RoomAgentClient(config),sequence=f.store.room('commons').sequence;
  const value=await client.privateContext(grant);assert.equal(value.body,'Shared sample excerpt\n\nChosen context');
  assert.equal(f.store.room('commons').sequence,sequence);assert.ok(!JSON.stringify(value).includes('private sender'));
  await assert.rejects(new RoomAgentClient({...config,memberId:'reviewer',token:f.keys.reviewer}).privateContext(grant),{status:404});
  for(const patch of [{viewerId:'reviewer'},{roomId:'other'},{grantId:'other'},{permissions:['read','write']},{expiresAt:1},{body:'\ud800'},{sourceId:'private'}]){
    const bad=new RoomAgentClient({...config,fetchImpl:async(url,options)=>url.includes('/private-context/')?Response.json({...value,...patch}):fetch(url,options)});
    await assert.rejects(bad.privateContext(grant),{code:'invalid_response'});
  }
  apply({action:'grant.revoke',requestId:'revoke',sourceId:'source',grantId:grant});
  await assert.rejects(client.privateContext(grant),{status:404});
  await assert.rejects(client.privateContext('../other'),{code:'invalid_private_context'});
});
