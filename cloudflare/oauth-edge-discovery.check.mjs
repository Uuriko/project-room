import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { oauthAuthorizationServerMetadata, mcpOAuthResourceMetadata } from '../server/oauth-metadata.mjs';
const origin='https://room.example.test';
const client={clientId:'synthetic-agent',name:'Synthetic agent',redirectUris:['https://client.example.test/callback']};
const paths=['/.well-known/oauth-authorization-server','/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp'];
test('actual Worker discovery survives throwing and hanging Room with canonical and entry configuration parity',async t=>{
  const bundle=await build({entryPoints:[fileURLToPath(new URL('./oauth-edge-discovery.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']});
  const receipts=[];
  const config=JSON.parse(readFileSync(new URL('./wrangler.jsonc',import.meta.url),'utf8'));
  for(const fault of ['throw','hang']) await t.test(fault,async()=>{
  // Distinct Worker instances model the two deployments. No provider data is
  // inferred across doors: each uses only the configuration passed to it.
  for(const [door,vars] of [['canonical',config.env.production.vars],['entry',config.vars]])for(const configured of ['as-configured',false,true]){
    const rawClients=configured==='as-configured'?(vars.ROOM_MCP_OAUTH_CLIENTS||''):configured?JSON.stringify([client]):'';
    const active=rawClients?JSON.parse(rawClients).length>0:false;
    const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],bindings:{...vars,ROOM_ORIGIN:origin,ROOM_MCP_OAUTH_CLIENTS:rawClients}});
    try{
      for(const path of paths){
        const start=Date.now();
        const response=await mf.dispatchFetch(origin+path+'?fault='+fault,{headers:{'CF-Connecting-IP':'192.0.2.10'}});
        assert.equal(response.headers.get('X-Test-Room-Calls'),'0');
        const resource=active?origin+'/mcp':null;
        assert.equal(response.status,path===paths[0]||active?200:404);
        assert.deepEqual(await response.json(),path===paths[0]?oauthAuthorizationServerMetadata(origin,resource):active?mcpOAuthResourceMetadata(resource,origin):{error:'not_found'});
        assert.equal(response.headers.get('cache-control'),'no-store');
        assert.equal(response.headers.get('access-control-allow-origin'),path===paths[0]||active?'*':null);
        receipts.push({door,configured,fault,path,roomCalls:0,elapsedMs:Date.now()-start});
      }
      for(const path of ['/oauth/register','/oauth/authorize','/oauth/token','/oauth/revoke','/mcp']){
        const response=await mf.dispatchFetch(origin+path,{method:'POST',headers:{'CF-Connecting-IP':'192.0.2.10'}});
        assert.equal(response.status,503);assert.equal(response.headers.get('X-Test-Room-Calls'),'1','stateful route still calls Room');
      }
      const denied=await mf.dispatchFetch('https://untrusted.example/.well-known/oauth-authorization-server');
      assert.equal(denied.status,403);assert.equal(denied.headers.get('X-Test-Room-Calls'),'0');
    }finally{await mf.dispose();}
  }
  });
  console.log(JSON.stringify({metadataRequests:receipts.length,metadataRoomCalls:0,receipts}));
});
