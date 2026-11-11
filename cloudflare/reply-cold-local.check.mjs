import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {Miniflare} from 'miniflare';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
test('diagnostic: local Worker request cursor after cold restart',{timeout:60000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'reply-native-cold-'));
 const script=(await build({entryPoints:[new URL('./reply-cold-local.test-fixture.mjs',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']})).outputFiles[0].text;
 const create=()=>new Miniflare({script,modules:true,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjectsPersist:dir,durableObjects:{ROOM:{className:'DurableCoverageRoom',useSQLite:true}},bindings:{ROOM_ORIGIN:'https://room.example.test'},serviceBindings:{ASSETS:async()=>new Response('missing',{status:404})}});let mf=create();
 const get=(path,token)=>mf.dispatchFetch('https://room.example.test'+path,{headers:{Host:'room.example.test',...(token?{Authorization:'Bearer '+token}:{})}});
 try{
  const seed=await get('/__reply-seed');assert.equal(seed.status,200);const {token}=await seed.json();
  const url='/api/rooms/commons/reply-requests?direction=incoming&status=open&limit=1';
  const first=await get(url,token);assert.equal(first.status,200);const page=await first.json();assert.ok(page.page.nextCursor);
  const warm=await get(url+'&cursor='+encodeURIComponent(page.page.nextCursor),token);assert.equal(warm.status,200);const warmPage=await warm.json();assert.notDeepEqual(warmPage.requests.map(x=>x.id),page.requests.map(x=>x.id));
  await mf.dispose();mf=create();
  const resumed=await get(url+'&cursor='+encodeURIComponent(page.page.nextCursor),token),failure=await resumed.json();
  assert.equal(failure.error.code,'invalid_reply_cursor');
  assert.match(failure.error.message,/service restart can expire/);
  assert.match(failure.error.message,/reconcile earlier pages and checkpoints/);
  assert.match(failure.error.message,/do not answer from partial context/);
  const mcp=await mf.dispatchFetch('https://room.example.test/mcp',{method:'POST',headers:{Host:'room.example.test',Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'cold',method:'tools/call',params:{name:'room_list_requests',arguments:{roomId:'commons',direction:'incoming',status:'open',limit:1,cursor:page.page.nextCursor}}})});
  const mcpBody=await mcp.json();assert.equal(mcpBody.result?.isError,true);const details=mcpBody.result.structuredContent;
  assert.equal(details.code,'invalid_reply_cursor');assert.match(details.message,/reconcile earlier pages and checkpoints/);
  const restart=await get(url,token);assert.equal(restart.status,200);const fresh=await restart.json();assert.deepEqual(fresh.requests.map(x=>x.id),page.requests.map(x=>x.id));
  t.diagnostic(JSON.stringify({resumedStatus:resumed.status,code:failure.error.code,restartingFromFirstPageWorks:true}));
 }finally{await mf.dispose();await rm(dir,{recursive:true,force:true});}
});
