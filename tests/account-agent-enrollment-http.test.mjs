import test from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {createHash} from 'node:crypto';
import {RoomStore} from '../server/store.mjs';
import {createRoomServer} from '../server/http.mjs';
import {seedAccountAgentEnrollment} from './helpers/account-agent-enrollment-source.mjs';
const origin='https://room.example',resource=origin+'/mcp',callback='https://client.example/callback';
function send(url,{method='GET',headers={},body}={}){return new Promise((resolve,reject)=>{const req=request(url,{method,headers:{Host:'room.example',...headers}},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:res.headers})));});req.on('error',reject);req.end(body);});}
async function fixture(t,enabled){
 const store=new RoomStore(':memory:'),f=seedAccountAgentEnrollment(store),server=createRoomServer({store,origin,accountAgentEnrollmentEnabled:enabled,mcpOAuthClients:[{clientId:'enrollment-fixture',name:'Enrollment fixture',redirectUris:[callback]}]});
 t.after(async()=>{server.closeStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${server.address().port}`,auth=store.authenticateAccountSession(f.slot.token),headers={Cookie:`__Host-account_session=${f.slot.token}`,'X-Project-Room-Auth':'account','X-Session-Binding':f.binding};
 const get=path=>send(base+path,{headers}),post=(path,data,csrf=true)=>send(base+path,{method:'POST',headers:{...headers,Origin:origin,'Content-Type':'application/json',...(csrf?{'X-CSRF-Token':auth.csrf}:{})},body:JSON.stringify(data)});
 return {store,f,base,auth,headers,get,post};
}
test('HTTP enrollment remains off by default, including its choice list',async t=>{
 const q=await fixture(t,false),response=await q.get('/api/rooms/target/agent-connections');assert.equal(response.status,200);assert.deepEqual((await response.json()).existingAgentEnrollment,{available:false,choices:[]});
 const refused=await q.post('/api/rooms/target/agent-connections',q.f.request);assert.equal(refused.status,403);assert.equal(q.store.db.prepare("SELECT count(*) n FROM identity_links WHERE room_id='target'").get().n,0);
});
test('HTTP target account-owned OAuth survives day29/day31 refresh beyond bootstrap expiry after source archive',async t=>{
 const q=await fixture(t,true),response=await q.get('/api/rooms/target/agent-connections');assert.equal(response.status,200);const list=(await response.json()).existingAgentEnrollment;
 assert.equal(list.available,true);assert.equal(list.choices[0].identityId,q.f.identity.identityId);assert.deepEqual(list.profiles.collaborate,['steer','accept_work','complete_work','verify']);
 assert.equal((await q.post('/api/rooms/target/agent-connections',q.f.request,false)).status,403);
 const result=await q.post('/api/rooms/target/agent-connections',q.f.request);assert.equal(result.status,201);assert.equal((await result.json()).enrolledExisting,true);
 const verifier='v'.repeat(43),query={client_id:'enrollment-fixture',redirect_uri:callback,scope:'rooms:read chat:read work:read',code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',resource,state:'preserved-oauth-state'};
 const consent=await q.get('/oauth/authorize?'+new URLSearchParams(query));assert.equal(consent.status,200);const html=await consent.text();
 const options=[...html.matchAll(/<option value="([^"]+)">/g)].map(match=>{try{return JSON.parse(match[1].replaceAll('&quot;','"').replaceAll('&amp;','&'));}catch{return null;}}),target=options.find(binding=>binding?.roomId==='target');assert.ok(target);assert.equal(target.identityId,q.f.identity.identityId);assert.equal(target.principalType,'account-owned-agent');
 const approved=await send(q.base+'/oauth/authorize',{method:'POST',headers:{...q.headers,Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({...query,decision:'allow',csrf_token:q.auth.csrf,agent_binding:JSON.stringify(target)}).toString()});
 assert.equal(approved.status,302);const location=new URL(approved.headers.get('location'));assert.equal(location.searchParams.get('state'),query.state);
 const exchange=await send(q.base+'/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code:location.searchParams.get('code'),client_id:query.client_id,redirect_uri:callback,code_verifier:verifier,resource}).toString()});assert.equal(exchange.status,200);const tokens=await exchange.json();
 q.store.command(q.f.slot.token,'source',{id:'http-archive-source',type:'room.archived',data:{reason:'Synthetic cutover'}},q.f.binding);
 const started=q.store.now(),dayMs=86400000,bootstrap=q.store.db.prepare("SELECT credential_hash,expires_at FROM agent_connections WHERE room_id='target' AND member_id='claude'").get();
 const membershipBefore=q.store.roomAuthority('target',{memberId:'claude'}).members.claude;
 const identitiesBefore=q.store.db.prepare('SELECT * FROM agent_identities').all();
 const enrollmentsBefore=q.store.db.prepare("SELECT request_json,receipt_json FROM agent_connection_operations WHERE room_id='target'").all();
 const originalClock=q.store.now;let current=tokens;
 try{
  for(const day of [29,31]){
   q.store.now=()=>started+day*dayMs;
   assert.equal(q.store.now()>bootstrap.expires_at,day===31,'day31 is beyond the actual target bootstrap credential expiry');
   const refreshed=await send(q.base+'/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',refresh_token:current.refresh_token,client_id:query.client_id,resource}).toString()});assert.equal(refreshed.status,200,`day${day}: ${await refreshed.clone().text()}`);current=await refreshed.json();
   const rpc=await send(q.base+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${current.access_token}`},body:JSON.stringify({jsonrpc:'2.0',id:day,method:'tools/call',params:{name:'room_check_access',arguments:{}}})});assert.equal(rpc.status,200);const body=await rpc.json();
   assert.equal(body.result?.structuredContent.roomId,'target');assert.equal(body.result?.structuredContent.memberId,'claude');assert.equal(body.result?.structuredContent.identityId,q.f.identity.identityId);
   assert.deepEqual(body.result?.structuredContent.permissions,membershipBefore.permissions);
   assert.deepEqual(q.store.db.prepare('SELECT * FROM agent_identities').all(),identitiesBefore);
   assert.deepEqual(q.store.db.prepare("SELECT request_json,receipt_json FROM agent_connection_operations WHERE room_id='target'").all(),enrollmentsBefore);
   assert.equal(q.store.db.prepare("SELECT count(*) n FROM identity_links WHERE room_id='target'").get().n,1);
   assert.equal(q.store.db.prepare("SELECT count(*) n FROM operator_actions WHERE action='account_agent_enrollment_v1'").get().n,1);
  }
  assert.equal(q.store.agentConnections.view(q.store.agentConnections.row('target','claude')).status,'expired','bootstrap really is expired while account-owned OAuth remains authorized');
 }finally{q.store.now=originalClock;}
});
