import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rmSync} from 'node:fs';
import {createAcceptanceFixture} from '../scripts/acceptance-fixture.mjs';
import {createRoomServer} from '../server/http.mjs';
import {RoomAgentClient} from '../client/room-agent.mjs';

test('agent discovery pages only current recipient metadata and rejects foreign or revoked cursors',async t=>{
  const f=createAcceptanceFixture(),account=f.store.accountForMember('commons','owner'),slot=f.store.createAccountSessionSlot();
  const auth=f.store.loginAccountSession(slot.token,f.store.issueAccountAccessKey(account.id),0),apply=r=>f.store.inbox.apply(slot.token,r,auth.sessionBinding);
  apply({action:'source.save',requestId:'source',sourceId:'source',expectedRevision:0,data:{adapter:'synthetic',sender:'PRIVATE SENDER',recipient:'owner',subject:'PRIVATE SUBJECT',paragraphs:['PRIVATE BODY']}});
  const share=memberId=>apply({action:'source.grant',requestId:randomUUID(),sourceId:'source',sourceRevision:1,roomId:'commons',paragraphs:[0],memberIds:[memberId],
    audienceVersion:f.store.inbox.shareContext(slot.token,'source','commons',auth.sessionBinding).audienceVersion}).receipt.grantId;
  const ids=Array.from({length:28},()=>share('producer')),foreign=share('reviewer'),sequence=f.store.room('commons').sequence;
  const server=createRoomServer({store:f.store});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{server.closeStreams();server.closeAllConnections();await new Promise(r=>server.close(r));f.store.close();rmSync(f.directory,{recursive:true,force:true});});
  const origin=`http://127.0.0.1:${server.address().port}`,url=origin+'/api/rooms/commons/private-context';
  const get=(suffix='',token=f.keys.producer)=>fetch(url+suffix,{headers:{Authorization:'Bearer '+token}});
  const response=await get();assert.equal(response.status,200);assert.ok(response.headers.get('cache-control').includes('no-store'));
  const page=await response.json();assert.equal(page.shares.length,25);assert.equal(page.next,ids[3]);
  const config={origin,roomId:'commons',memberId:'producer',token:f.keys.producer},client=new RoomAgentClient(config);
  assert.deepEqual(await client.privateContexts(),page);
  assert.equal((await client.privateContexts({before:page.next})).shares.length,3);
  for(const patch of [{viewerId:'reviewer'},{roomId:'other'},{body:'unwanted private body'},{next:ids[0]},
    {shares:[page.shares[0],page.shares[0]]},{shares:[{...page.shares[0],sourceId:'secret'}]},
    {shares:[{...page.shares[0],permissions:['read','write']}]},{shares:[{...page.shares[0],expiresAt:1}]}]){
    const bad=new RoomAgentClient({...config,fetchImpl:async(url,options)=>url.includes('/private-context')?Response.json({...page,...patch}):fetch(url,options)});
    await assert.rejects(bad.privateContexts(),{code:'invalid_response'});
  }
  await assert.rejects(client.privateContexts({before:'../other'}),{code:'invalid_private_context'});
  await assert.rejects(client.privateContexts({sourceId:'source'}),{code:'invalid_private_context'});
  assert.deepEqual(page.shares.map(g=>g.grantId),ids.slice(3).reverse());
  assert.ok(!JSON.stringify(page).includes('PRIVATE'));assert.ok(!JSON.stringify(page).includes(foreign));
  for(const g of page.shares)assert.deepEqual(Object.keys(g).sort(),['expiresAt','grantId','permissions']);
  const second=await(await get('?before='+page.next)).json();assert.deepEqual(second.shares.map(g=>g.grantId),ids.slice(0,3).reverse());assert.equal(second.next,null);
  assert.equal((await get('?before='+foreign)).status,404);
  assert.equal((await get('?before='+page.next+'&before='+page.next)).status,422);
  assert.equal((await get('?sourceId=source')).status,422);
  assert.equal((await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+f.keys.producer}})).status,405);
  assert.equal((await get('',f.keys.guest)).status,403);
  apply({action:'grant.revoke',requestId:'revoke',sourceId:'source',grantId:page.next});
  assert.equal((await get('?before='+page.next)).status,404);
  assert.ok(!(await(await get()).json()).shares.some(g=>g.grantId===page.next));
  assert.equal(f.store.room('commons').sequence,sequence);
  f.store.command(f.keys.owner,'commons',{id:randomUUID(),type:'member.access_changed',data:{memberId:'producer',expectedMemberRevision:0,active:true,permissions:[]}});
  assert.deepEqual((await(await get()).json()).shares,[]);
  const fresh=share('producer'),grant=f.store.inbox.readGrant(f.keys.producer,'commons',fresh),now=f.store.now;
  assert.equal((await(await get()).json()).shares[0].grantId,fresh);
  f.store.now=()=>grant.expiresAt;
  try{const key=f.store.issueAccessKey('commons','producer');assert.deepEqual(f.store.inbox.listPrivateContexts(key,'commons').shares,[]);}finally{f.store.now=now;}
  f.store.command(f.keys.owner,'commons',{id:randomUUID(),type:'member.access_changed',data:{memberId:'owner',expectedMemberRevision:0,active:true,permissions:['manage_members']}});
  assert.deepEqual(f.store.inbox.listPrivateContexts(f.store.issueAccessKey('commons','producer'),'commons').shares,[]);
});
