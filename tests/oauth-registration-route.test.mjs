import test from 'node:test';import assert from 'node:assert/strict';import {request} from 'node:http';import {fileURLToPath} from 'node:url';
import {RoomStore} from '../server/store.mjs';import {initialRoom} from '../server/bootstrap.mjs';import {createRoomServer} from '../server/http.mjs';import {createOAuthProvider} from '../server/oauth-provider.mjs';
import {ROUTES} from '../server/routes/table.mjs';import {extractLegacyRoutes,loadRouteSources} from '../scripts/routes-inventory.mjs';import {openApiGateProblems} from '../scripts/openapi-gen.mjs';
const client={clientId:'registration-contract-test',name:'Configured MCP client',redirectUris:['https://client.example/callback']};
async function fixture(t,{enabled=true}={}){
 const store=new RoomStore(':memory:');store.initialize(initialRoom());const server=createRoomServer({store,origin:'https://room.example',mcpOAuthClients:enabled?[client]:[]});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{server.closeStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();});
 const call=(data,method='POST')=>new Promise((resolve,reject)=>{const req=request(`http://127.0.0.1:${server.address().port}/oauth/register`,{method,headers:{Host:'room.example','Content-Type':'application/json'}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:JSON.parse(Buffer.concat(chunks).toString())}));});req.on('error',reject);req.end(data===undefined?undefined:JSON.stringify(data));});
 return{store,call};
}
test('registration is documented exactly once as a modern public metadata route, never RT0 legacy',()=>{
 const root=fileURLToPath(new URL('..',import.meta.url));const rows=ROUTES.filter(row=>row.path==='/oauth/register');assert.equal(rows.length,1);assert.equal(rows[0].method,'POST');assert.equal(rows[0].auth,'none');assert.equal(rows[0].scope,'worker');assert.equal(rows[0].capability,null);assert.deepEqual(rows[0].events,[]);
 assert.equal(extractLegacyRoutes(loadRouteSources(root)).some(row=>row.path==='/oauth/register'),false);assert.deepEqual(openApiGateProblems(root),[]);
});
test('configured public DCR preserves exact callback admission and returns metadata without a grant',async t=>{
 const{store,call}=await fixture(t),before=Object.fromEntries(['credentials','agent_identities','member_accounts','oauth_provider_access_tokens','oauth_provider_refresh_tokens'].map(table=>[table,store.db.prepare('SELECT count(*) n FROM '+table).get().n]));
 const created=await call({client_name:'Hosted test client',redirect_uris:[client.redirectUris[0],client.redirectUris[0]],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']});
 assert.equal(created.status,201);assert.equal(created.headers['cache-control'],'no-store');assert.match(created.body.client_id,/^mcp_dcr_/);assert.deepEqual(created.body.redirect_uris,client.redirectUris);assert.equal(created.body.client_secret,undefined);assert.equal(created.body.access_token,undefined);
 assert.deepEqual(Object.fromEntries(Object.keys(before).map(table=>[table,store.db.prepare('SELECT count(*) n FROM '+table).get().n])),before);
 for(const data of [{redirect_uris:['https://client.example.attacker.invalid/callback']},{redirect_uris:Array(6).fill(client.redirectUris[0])},{redirect_uris:client.redirectUris,token_endpoint_auth_method:'client_secret_post'},{redirect_uris:client.redirectUris,grant_types:['client_credentials']}])assert.equal((await call(data)).status,400);
});
test('registration is unavailable without configured OAuth and modern wrong-method contract remains405',async t=>{
 const{call}=await fixture(t,{enabled:false});assert.equal((await call({redirect_uris:client.redirectUris})).status,404);const wrong=await call(undefined,'GET');assert.equal(wrong.status,405);assert.equal(wrong.headers.allow,'POST');
});
test('registration refuses the existing1024-entry registry cap without adding a client',async t=>{
 const{store,call}=await fixture(t),provider=createOAuthProvider({db:store.db}),n=store.db.prepare('SELECT count(*) n FROM oauth_provider_clients').get().n;
 for(let i=n;i<1024;i++)provider.registerClient({clientId:'bounded-test-'+i,name:'Bounded registry fixture',redirectUris:client.redirectUris});
 const response=await call({redirect_uris:client.redirectUris});assert.equal(response.status,503);assert.equal(response.body.error,'temporarily_unavailable');assert.equal(store.db.prepare('SELECT count(*) n FROM oauth_provider_clients').get().n,1024);
});
test('registration rate admission still happens before malformed metadata can create clients',async t=>{
 const{store,call}=await fixture(t),before=store.db.prepare('SELECT count(*) n FROM oauth_provider_clients').get().n;
 for(let i=0;i<20;i++)assert.equal((await call({redirect_uris:[]})).status,400);assert.equal((await call({redirect_uris:client.redirectUris})).status,429);assert.equal(store.db.prepare('SELECT count(*) n FROM oauth_provider_clients').get().n,before);
});
