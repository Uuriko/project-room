import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {Miniflare} from 'miniflare';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
test('Workers account confirmation reports storage capacity without rotating a session',{timeout:60000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'account-capacity-'));
 const script=(await build({entryPoints:[new URL('./account-confirm-capacity.test-fixture.mjs',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']})).outputFiles[0].text;
 const mf=new Miniflare({script,modules:true,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjectsPersist:dir,durableObjects:{ROOM:{className:'DurableCoverageRoom',useSQLite:true}},bindings:{ROOM_ORIGIN:'https://room.example.test'},serviceBindings:{ASSETS:async()=>new Response('missing',{status:404})}});
 const get=(path,headers={})=>mf.dispatchFetch('https://room.example.test'+path,{headers:{Host:'room.example.test',...headers}});
 try{
  const seed=await get('/__account-seed');assert.equal(seed.status,200);const {token,binding}=await seed.json();const headers={cookie:'__Host-account_session='+token,'x-session-binding':binding};
  assert.equal((await get('/api/account-session',headers)).status,200);
  assert.equal((await get('/__capacity-on')).status,200);
  const error=await get('/api/account-session',headers);assert.equal(error.status,409);assert.equal((await error.json()).error.code,'pilot_limit');assert.equal(error.headers.has('set-cookie'),false);
  const retry=await get('/api/account-session',headers);assert.equal(retry.status,200);assert.equal(retry.headers.has('set-cookie'),false);
 }finally{await mf.dispose();await rm(dir,{recursive:true,force:true});}
});
