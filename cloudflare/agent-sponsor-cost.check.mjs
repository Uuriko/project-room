import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
test('Native sponsorship approval does not scan or rewrite large unrelated token history',{timeout:60000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'sponsor-token-cost-'));
 const script=(await build({entryPoints:[fileURLToPath(new URL('./agent-sponsor-transfer-native.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']})).outputFiles[0].text;
 const origin='https://room.example',callback='https://claude.ai/api/mcp/auth_callback',resource=origin+'/mcp';
 const client={clientId:'project-room-claude',name:'Claude',redirectUris:[callback],preferredRoomId:'commons',preferredMemberId:'claude'},costs=[];
 try{for(const rows of [0,4096]){
  const mf=new Miniflare({modules:true,script,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjectsPersist:join(directory,String(rows)),durableObjects:{ROOM:{className:'AgentAdoptionRoom',useSQLite:true}},bindings:{ROOM_ORIGIN:origin,ROOM_MCP_OAUTH_CLIENTS: JSON.stringify([client])},serviceBindings:{ASSETS:async()=>new Response('Not found',{status:404})}});
  const call=(path,options)=>mf.dispatchFetch(origin+path,options),json=async(path,options)=>{const response=await call(path,options);assert.equal(response.status,200,await response.clone().text());return response.json();};
  try{
   const seed=await json('/__seed'),headers={Cookie:`__Host-account_session=${seed.slot}`};
   const query={client_id:client.clientId,redirect_uri:callback,scope:'rooms:read chat:read',code_challenge:createHash('sha256').update('v'.repeat(43)).digest('base64url'),code_challenge_method:'S256',resource,state:'cost-state'};
   const consent=await call('/oauth/authorize?'+new URLSearchParams(query),{headers});assert.equal(consent.status,200);
   const requestId=/name="adoption_request_id" value="([^"]+)"/.exec(await consent.text())[1];
   const requested=await call('/oauth/authorize',{method:'POST',redirect:'manual',headers:{...headers,Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({...query,csrf_token:seed.csrf,decision:'request-adoption',adoption_request_id:requestId})});assert.equal(requested.status,303);
   const noise=await json('/__token-noise?rows='+rows),before=await json('/__token-facts');
   const approved=await json('/__approve');assert.equal(approved.status,'approved');
   assert.deepEqual(await json('/__token-facts'),before,'all seven token/grant tables retain exact cell bytes');
   const facts=await json('/__facts');assert.equal(facts.agent.accountableHumanId,'john');assert.equal(facts.agent.id,'claude');
   costs.push({additionalUnrelatedRows:noise.additionalUnrelatedRows,...approved.cost});
  }finally{await mf.dispose();}
 }
 console.log('SPONSOR_APPROVAL_COST '+JSON.stringify({actualNative:true,costs,tokenTableBytesUnchanged:true,measure:'DurableDatabase adapter physical rows around AccessRequests.decide; fixture creation and digest scans excluded',clockOnly:true}));
 assert.ok(costs[0].rowsRead>0);assert.ok(costs[1].rowsRead<=costs[0].rowsRead+64,'adding 28672 unrelated rows must not add a proportional approval scan');
 }finally{await rm(directory,{recursive:true,force:true});}
});
