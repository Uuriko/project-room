import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {Miniflare} from 'miniflare';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {fileURLToPath} from 'node:url';
test('production Native account-created room exports JSONL/HTML and archived history after cold restart',{timeout:120000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'normalized-export-native-')),script=(await build({entryPoints:[fileURLToPath(new URL('./normalized-owner-export.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']})).outputFiles[0].text;
 const create=()=>new Miniflare({modules:true,script,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjectsPersist:directory,durableObjects:{ROOM:{className:'NormalizedExportRoom',useSQLite:true}},bindings:{ROOM_ORIGIN:'https://room.example'},serviceBindings:{ASSETS:async()=>new Response('Not found',{status:404})}});let mf=create();
 const call=(path,opts)=>mf.dispatchFetch('https://room.example'+path,opts);
 try{
  const seed=await call('/__seed');assert.equal(seed.status,200,await seed.clone().text());const {owner}=await seed.json(),headers={Authorization:'Bearer '+owner};
  for(const format of ['jsonl','html']){const r=await call('/api/rooms/native-export/export?format='+format,{headers}),text=await r.text();assert.equal(r.status,200,text);assert.match(text,/Saved public result 24/);assert.doesNotMatch(text,/Saved public result 0/);assert.ok(text.length>0);}
  await mf.dispose();mf=create();
  const archived=await call('/api/rooms/native-export/commands',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({id:'archive-export',type:'room.archived',data:{}})});assert.equal(archived.status,201,await archived.clone().text());
  await mf.dispose();mf=create();
  const a=await call('/api/rooms/native-export/export',{headers}),text=await a.text();assert.equal(a.status,200,text);assert.match(text,/room.archived/);
  const b=await call('/api/rooms/native-export/export',{headers});assert.equal(b.status,200);assert.equal(await b.text(),text,'archived export appends no audit event');
 }finally{await mf.dispose();await rm(directory,{recursive:true,force:true});}
});
