import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync} from 'node:fs';
import {request} from 'node:http';
import {createServer as reserveServer} from 'node:net';
import {deploymentConfig} from '../server/deployment.mjs';
import {createRoomServer} from '../server/http.mjs';
import {RoomStore} from '../server/store.mjs';
import {discoveryDoc,ROOM_ORIGIN} from '../server/agent-discovery.mjs';
import {instanceDiscoveryBody,instanceCardSignatureState} from '../server/node-discovery-origin.mjs';

const read = (origin,path,headers={}) => new Promise((resolve,reject)=>{
 const r=request(origin+path,{headers},res=>{let body='';res.setEncoding('utf8');res.on('data',x=>body+=x);res.on('end',()=>resolve({status:res.statusCode,body,headers:res.headers}));});r.on('error',reject);r.end();
});
test('two simultaneous Node hosts keep discovery instance-local without request-header influence',async()=>{
 const dir=mkdtempSync('/tmp/jill-instance-origin-test-');const hosts=[];
 try{
  for(const label of ['alpha','beta']) {
   const reserve=reserveServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
   const origin=deploymentConfig({ROOM_ORIGIN:`http://127.0.0.1:${port}`}).origin;
   const store=new RoomStore(`${dir}/${label}.sqlite`);const server=createRoomServer({store,origin});
   await new Promise(r=>server.listen(port,'127.0.0.1',r)); hosts.push({store,server,origin});
  }
  for(const {origin} of hosts){
   const cardReply=await read(origin,'/.well-known/agent.json');assert.equal(cardReply.status,200);
   const card=JSON.parse(cardReply.body);assert.equal(card.base_url,origin);assert.equal(card.url,origin);
   for(const value of Object.values(card.endpoints)) assert.ok(value.startsWith(origin+'/'),value);
   assert.equal(card.signed,false);assert.ok(card.unsignedReason);assert.equal(card.signatures,undefined);assert.equal(card.cardSignature,undefined);
   assert.equal(card.capabilities.extensions[0].uri,ROOM_ORIGIN+'/extensions/work-receipt/v1');
   assert.equal((await read(origin,'/.well-known/agent-card.json')).body,cardReply.body);
   const ardReply=await read(origin,'/.well-known/ard.json');
   const catalog=JSON.parse(ardReply.body);
   assert.equal(catalog.host.identifier,origin);
   assert.ok(!ardReply.body.includes('urn:air:room.trydemigod.com:'));
   const agentEntry=catalog.entries.find(entry=>entry.type==='application/a2a-agent-card+json');
   assert.equal(agentEntry.metadata.signed,false);assert.equal(agentEntry.metadata.signatureKeyId,undefined);
   assert.match(agentEntry.description,/Unsigned/);assert.equal(agentEntry.url,origin+'/.well-known/agent-card.json');
   assert.equal((await read(origin,'/.well-known/ai-catalog.json')).body,ardReply.body);
   assert.ok(!ardReply.body.includes(hosts.find(h=>h.origin!==origin).origin));
   assert.deepEqual(JSON.parse((await read(origin,'/.well-known/jwks.json')).body),{keys:[]});
   const mcp=await read(origin,'/.well-known/mcp.json');assert.equal(JSON.parse(mcp.body).url,origin+'/mcp');assert.equal(mcp.headers['access-control-allow-origin'],'*');
   const llms=await read(origin,'/llms.txt');assert.ok(llms.body.includes(origin+'/mcp'));assert.ok(!llms.body.includes(ROOM_ORIGIN+'/mcp'));
   const skill=await read(origin,'/SKILL.md');const index=JSON.parse((await read(origin,'/.well-known/agent-skills/index.json')).body);
   assert.equal(index.skills[0].digest,'sha256:'+createHash('sha256').update(skill.body).digest('hex'));
   assert.equal((await read(origin,'/room/llms.txt')).body,llms.body);
   const spoof=await read(origin,'/.well-known/agent.json',{host:'attacker.example'});assert.equal(spoof.status,403);
   const forwarded=await read(origin,'/.well-known/agent.json',{'x-forwarded-host':'attacker.example','x-forwarded-proto':'https',forwarded:'host=attacker.example;proto=https'});
   assert.equal(forwarded.body,cardReply.body);
   assert.equal(JSON.parse((await read(origin,'/.well-known/oauth-authorization-server')).body).issuer,origin);
   assert.ok(!cardReply.body.includes(hosts.find(h=>h.origin!==origin).origin));
  }
 }finally{for(const {server,store} of hosts){server.closeStreams();server.closeAllConnections();await new Promise(r=>server.close(r));store.close();}}
});
test('hosted bytes remain exact; production cannot use an unsigned custom-origin card',()=>{
 for(const path of ['/llms.txt','/.well-known/agent.json','/.well-known/mcp.json','/SKILL.md','/.well-known/ard.json','/.well-known/ai-catalog.json','/.well-known/jwks.json']){const doc=discoveryDoc(path);assert.equal(instanceDiscoveryBody(doc,ROOM_ORIGIN),doc.body);}
 assert.equal(instanceCardSignatureState('https://private.example').signed,false);
 const dir=mkdtempSync('/tmp/jill-instance-prod-test-');const store=new RoomStore(`${dir}/room.sqlite`);
 try{assert.throws(()=>createRoomServer({store,origin:'https://private.example',production:true}),/Refusing to boot/);}finally{store.close();}
 assert.throws(()=>instanceDiscoveryBody(discoveryDoc('/llms.txt'),'https://evil.example/path'),/configured HTTP/);
});
