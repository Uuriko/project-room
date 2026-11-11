import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {Miniflare} from 'miniflare';import {fileURLToPath} from 'node:url';
test('worker reports remaining wake-poll window',{timeout:60000},async()=>{
 const script=(await build({entryPoints:[fileURLToPath(new URL('./wake-retry-worker.fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']})).outputFiles[0].text;
 const mf=new Miniflare({modules:true,script,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjects:{ROOM:{className:'RetryHintRoom',useSQLite:true}},bindings:{ROOM_ORIGIN:'https://room.example'},serviceBindings:{ASSETS:async()=>new Response('not found',{status:404})}});
 try{
  const call=(path,options)=>mf.dispatchFetch('https://room.example'+path,options);let seed=await call('/__seed');assert.equal(seed.status,200,await seed.clone().text());const {secret}=await seed.json();
  const auth={Authorization:'Bearer '+secret};const heartbeat=await call('/api/agent-heartbeats',{method:'POST',headers:{...auth,Origin:'https://room.example','Content-Type':'application/json'},body:JSON.stringify({hostId:'probe',mode:'wakeable',cadenceSeconds:30,listenerLease:{roomId:'retry-room'}})});assert.equal(heartbeat.status,200,await heartbeat.clone().text());
  for(let i=0;i<30;i++){let r=await call('/api/agent-wakes/poll?hostId=probe&waitMs=0',{headers:auth});assert.equal(r.status,200,await r.clone().text());}
  await call('/__advance?ms=50000');const blocked=await call('/api/agent-wakes/poll?hostId=probe&waitMs=0',{headers:auth});const retry=Number(blocked.headers.get('retry-after'));
  assert.equal(blocked.status,429);console.log(JSON.stringify({status:blocked.status,retryAfterSeconds:retry}));assert.ok(retry>=9&&retry<=10);
  await call('/__advance?ms=61000');const restored=await call('/api/agent-wakes/poll?hostId=probe&waitMs=0',{headers:auth});assert.equal(restored.status,200,await restored.text());
 }finally{await mf.dispose();}
});
