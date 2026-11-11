import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
test('shipped Gmail sanitizer safely handles discarded iframe nesting in workerd',async()=>{
 const bundle=await build({entryPoints:[fileURLToPath(new URL('./gmail-sanitizer.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']});
 const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat']});
 try{const response=await mf.dispatchFetch('http://localhost/');assert.equal(response.status,200,await response.clone().text());assert.deepEqual(await response.json(),{bounded:true,readable:true,scriptRemoved:true,linkProtected:true});}finally{await mf.dispose();}
});
