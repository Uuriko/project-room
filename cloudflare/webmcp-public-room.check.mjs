import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('local Worker serves WebMCP page and enforces current public visibility',{timeout:60000},async()=>{
  const script=(await build({entryPoints:[new URL('./webmcp-public-room.test-fixture.mjs',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']})).outputFiles[0].text;
  const dir=await mkdtemp(join(tmpdir(),'webmcp-native-'));
  const create=()=>new Miniflare({script,modules:true,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjectsPersist:dir,durableObjects:{ROOM:{className:'DurableCoverageRoom',useSQLite:true}},bindings:{ROOM_ORIGIN:'https://room.example.test'},serviceBindings:{ASSETS:async()=>new Response('missing',{status:404})}});
  let mf=create();
  const get=path=>mf.dispatchFetch('https://room.example.test'+path,{headers:{Host:'room.example.test'}});
  try {
    assert.equal((await get('/__webmcp-seed')).status,200);
    let page=await get('/r/webmcp-fixture'); assert.equal(page.status,200);
    const html=await page.text(), scriptBody=html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(scriptBody); assert.match(scriptBody,/document\.modelContext/);
    const hash=createHash('sha256').update(scriptBody).digest('base64');
    assert.ok(page.headers.get('content-security-policy').includes("'sha256-"+hash+"'"));
    assert.match(page.headers.get('content-security-policy'),/connect-src 'self'/);
    assert.equal(page.headers.get('cache-control'),'no-store');
    let json=await get('/r/webmcp-fixture.json'); assert.equal(json.status,200);
    assert.equal(json.headers.get('cache-control'),'no-store');
    let body=await json.json(); assert.deepEqual(body.tasks.map(x=>x.id),['public-task']); assert.equal(JSON.stringify(body).includes('private-task'),false);
    await mf.dispose(); mf=create();
    json=await get('/r/webmcp-fixture.json'); assert.equal(json.status,200); body=await json.json(); assert.deepEqual(body.tasks.map(x=>x.id),['public-task']);
    assert.equal((await get('/__webmcp-unpublish')).status,200);
    assert.equal((await get('/r/webmcp-fixture.json')).status,404);
    assert.equal((await get('/r/webmcp-fixture')).status,404);
  } finally {await mf.dispose(); await rm(dir,{recursive:true,force:true});}
});
