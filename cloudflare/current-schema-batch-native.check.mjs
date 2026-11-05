import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {fileURLToPath} from 'node:url';
test('production Native audit schema cold/warm exact validation physical comparison',async()=>{
 const root=fileURLToPath(new URL('..',import.meta.url)),directory=await mkdtemp(join(tmpdir(),'schema-batch-')),archive=join(directory,'baseline');
 await mkdir(archive);
 const source=execFileSync('git',['archive','2dbf1f547','server','src','client','strings','cloudflare'],{cwd:root,maxBuffer:64*1024*1024});
 execFileSync('tar',['-x','-C',archive],{input:source});
 const results={};
 try {
  for(const variant of ['baseline','candidate']) {
   const target=variant==='baseline'?join(archive,'server/current-room-repository.mjs'):resolve(root,'server/current-room-repository.mjs');
   const fixture=fileURLToPath(new URL('./current-schema-batch-native.test-fixture.mjs',import.meta.url));
   const built=await build({entryPoints:[fixture],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*'],plugins:[{name:'verifier',setup(b){
    b.onResolve({filter:/^\.\.\/server\/current-room-repository\.mjs$/},args=>args.importer===fixture?{path:target}:undefined);
    // A historical verifier must inspect its own installed guard protocol.
    // Pairing it with the current constructor creates an invalid mixed runtime.
    if(variant==='baseline')b.onResolve({filter:/^\.\/(room|storage)\.mjs$/},args=>args.importer===fixture?{path:join(archive,'cloudflare',args.path.slice(2))}:undefined);
   }}]});
   const create=()=>new Miniflare({durableObjectsPersist:join(directory,variant),modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjects:{ROOM:{className:'SchemaBatchRoom',useSQLite:true}},bindings:{ROOM_ORIGIN:'https://room.example.test'},serviceBindings:{ASSETS:()=>new Response('not found',{status:404})}});
   let mf=create();
   const call=async path=>{const response=await mf.dispatchFetch('http://localhost'+path),body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body;};
   try {
    const cold=await call('/verify'),warm=await call('/verify');
    await mf.dispose();mf=create();const restarted=await call('/verify');
    results[variant]={cold,warm,restarted};
    for(const value of [cold,warm,restarted]){assert.equal(value.rowsWritten,0);assert.equal(value.unknown,0);assert.equal(value.permits,1);}
    if(variant==='candidate') {
     assert.equal(cold.catalog.length,1);assert.match(cold.catalog[0],/WHERE name IN/);
     assert.equal(warm.catalog.length,1);assert.match(warm.catalog[0],/WHERE rowid IN/);
     assert.match(restarted.catalog[0],/WHERE name IN/);
     assert.equal((await call('/tamper')).protected,true);
     assert.equal((await call('/unknown')).protected,true);
    }else assert.ok(cold.catalog.length>10);
   }finally{await mf.dispose();}
  }
  assert.ok(results.candidate.cold.rowsRead<results.baseline.cold.rowsRead);
  assert.ok(results.candidate.warm.rowsRead<results.candidate.cold.rowsRead);
  console.log('CURRENT_SCHEMA_NATIVE '+JSON.stringify(results));
 }finally{await rm(directory,{recursive:true,force:true});}
});
