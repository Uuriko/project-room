import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { RoomStore } from '../server/store.mjs';
import { createRoomServer } from '../server/http.mjs';
import { edgePublicResponse } from '../cloudflare/edge-public.mjs';
import { mcpOAuthResourceMetadata, configuredMcpOAuthResource, oauthAuthorizationServerMetadata } from '../server/oauth-metadata.mjs';
import { OAUTH_SCOPES, createOAuthProvider } from '../server/oauth-provider.mjs';
import { validateOAuthClient } from '../server/oauth-client-contract.mjs';
const origin = 'https://room.example.test';
const client = { clientId: 'synthetic-agent', name: 'Synthetic agent', redirectUris: ['https://client.example.test/callback'] };
const paths = ['/.well-known/oauth-authorization-server','/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp'];
function read(base, path) {
  return new Promise((resolve,reject) => {
    const req = request(base+path,{headers:{Host:new URL(origin).host}},res=>{
      let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}));
    });req.on('error',reject);req.end();
  });
}
for (const clients of [[],[client]]) test(`edge metadata matches actual Node routes, configured=${clients.length}`, async t => {
  const store = new RoomStore(':memory:');
  const server = createRoomServer({store,origin,mcpOAuthClients:clients});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();});
  const env = {ROOM_ORIGIN:origin,...(clients.length?{ROOM_MCP_OAUTH_CLIENTS:JSON.stringify(clients)}:{})};
  for (const path of [...paths,...paths.map(p=>p+'///')]) {
    const url = new URL(path,origin);
    const edge = await edgePublicResponse(new Request(url),env,url);
    assert.ok(edge,'discovery must be answered at edge');
    const node = await read(`http://127.0.0.1:${server.address().port}`,path);
    assert.equal(edge.status,node.status);assert.equal(await edge.text(),node.body);
    for (const header of ['content-type','cache-control','access-control-allow-origin','content-length'])
      assert.equal(edge.headers.get(header),node.headers[header]??null,header);
  }
  for (const method of ['HEAD','OPTIONS','POST']) {
    const url = new URL(paths[0],origin);
    assert.equal(await edgePublicResponse(new Request(url,{method}),env,url),null,'existing non-GET durable routing preserved');
  }
});
test('pure contract and original provider accept and reject exactly the same static client shapes', () => {
  assert.deepEqual(oauthAuthorizationServerMetadata(origin,null).scopes_supported,[...OAUTH_SCOPES]);
  assert.deepEqual(mcpOAuthResourceMetadata(origin+'/mcp',origin).authorization_servers,[origin]);
  for (const c of [client,{...client,clientId:'bad id'},{...client,name:''},{...client,redirectUris:[]},{...client,redirectUris:['http://external.example/callback']},{...client,redirectUris:['https://client.example/#fragment']}]) {
    let expected;try {createOAuthProvider().registerClient(c);}catch(e){expected={name:e.name,code:e.code,message:e.message};}
    let actual;try {validateOAuthClient(c);}catch(e){actual={name:e.name,code:e.code,message:e.message};}
    assert.deepEqual(actual,expected);
  }
  assert.equal(configuredMcpOAuthResource(origin,[client,client]),origin+'/mcp');
  assert.throws(()=>configuredMcpOAuthResource(origin,[client,{...client,name:'conflicting'}]));
});
test('invalid configuration falls through to original durable error handling instead of advertising a provider',async()=>{
  for(const raw of ['{','null','{}','"abc"',JSON.stringify([{...client,redirectUris:['http://external.example/callback']}])]){
    const url=new URL(paths[0],origin);
    assert.equal(await edgePublicResponse(new Request(url),{ROOM_ORIGIN:origin,ROOM_MCP_OAUTH_CLIENTS:raw},url),null);
  }
});
