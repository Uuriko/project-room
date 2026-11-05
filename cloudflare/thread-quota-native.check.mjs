import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {Miniflare} from 'miniflare';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
test('Native aggregate thread quota is typed413 across cold restart, selected and small reads remain200',{timeout:60000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'native-thread-quota-')),script=(await build({entryPoints:[new URL('./thread-quota-native.test-fixture.mjs',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']})).outputFiles[0].text;
 const create=()=>new Miniflare({script,modules:true,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjectsPersist:dir,durableObjects:{ROOM:{className:'DurableCoverageRoom',useSQLite:true}},bindings:{ROOM_ORIGIN:'https://room.example.test'},serviceBindings:{ASSETS:async()=>new Response('missing',{status:404})}});let mf=create();
 const call=async(path,key)=>{const r=await mf.dispatchFetch('https://room.example.test'+path,{headers:{Host:'room.example.test',Origin:'https://room.example.test',...(key?{Authorization:'Bearer '+key}:{})}});return{status:r.status,body:await r.json()};};
 try{const seed=await call('/__quota-seed');assert.equal(seed.status,200,JSON.stringify(seed));const key=seed.body.key;
 for(let cold=0;cold<2;cold++){
  if(cold){await mf.dispose();mf=create();}
  assert.equal((await call('/api/rooms/commons/messages/quota-root/thread?view=message',key)).status,200);
  const full=await call('/api/rooms/commons/messages/quota-root/thread',key);assert.equal(full.status,413,JSON.stringify(full));assert.equal(full.body.error.code,'current_thread_too_large');
  assert.equal((await call('/api/rooms/commons/messages/small-root/thread',key)).status,200);
 }
 }finally{await mf.dispose();await rm(dir,{recursive:true,force:true});}
});
