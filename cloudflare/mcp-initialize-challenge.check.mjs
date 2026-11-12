import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';

// #4974 answered anonymous MCP at the Worker edge. initialize must still get the
// DO door's OAuth challenge on the default route; only ?auth=discovery and the
// store-free calls are answered without a grant.
test('anonymous initialize on /mcp gets the OAuth challenge through the Worker; discovery and tools/list stay open',async t=>{
 const built=await build({stdin:{contents:"export {default,ProjectRoom} from './room.mjs';",resolveDir:fileURLToPath(new URL('.',import.meta.url))},bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']});
 const origin='https://room.example.test';
 const client={clientId:'synthetic-agent',name:'Synthetic agent',redirectUris:['https://client.example.test/callback']};
 const mf=new Miniflare({modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjects:{ROOM:{className:'ProjectRoom',useSQLite:true}},bindings: { ROOM_ORIGIN: origin, ROOM_MCP_OAUTH_CLIENTS: JSON.stringify([client]) }});
 t.after(()=>mf.dispose());
 const rpc=(method,id='1')=>JSON.stringify({jsonrpc:'2.0',id,method,params:method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'check',version:'1'}}:{}});
 const post=(path,body,headers={})=>mf.dispatchFetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream','cf-connecting-ip':'198.51.100.9',...headers},body});
 for(const headers of [{},{Authorization:'Bearer'},{Authorization:'Bearer '}]){
  const response=await post('/mcp',rpc('initialize'),headers);
  assert.equal(response.status,401,JSON.stringify(headers));
  assert.match(response.headers.get('www-authenticate')??'',/resource_metadata=/,JSON.stringify(headers));
  await response.arrayBuffer();
 }
 const discovery=await post('/mcp?auth=discovery',rpc('initialize'));
 assert.equal(discovery.status,200);
 assert.equal((await discovery.json()).result?.serverInfo?.name?.length>0,true);
 const listed=await post('/mcp',rpc('tools/list','2'));
 assert.equal(listed.status,200);
 assert.ok(Array.isArray((await listed.json()).result?.tools));
});
