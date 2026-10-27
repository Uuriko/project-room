import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
test('Worker SQLite cursor pagination has linear scan cost and preserves archived output',async()=>{
 const bundled=await build({entryPoints:[fileURLToPath(new URL('./message-query-cursor.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']});
 const mf=new Miniflare({modules:true,script:bundled.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjects:{ROOM:{className:'MessageCursorRoom',useSQLite:true}}});
 try{
  const response=await mf.dispatchFetch('http://localhost/');assert.equal(response.status,200,await response.clone().text());
  const {result:r,expected,rowsRead,statements,measures}=await response.json();
  assert.deepEqual(r.ascending,expected);assert.deepEqual(r.descending,[...expected].reverse());
  assert.deepEqual(r.after,expected.slice(256));assert.deepEqual(r.before,expected.slice(0,256).reverse());
  const visible=m=>!m.deletedAt&&(!m.toMemberId||m.authorId==='viewer'||m.toMemberId==='viewer');
  assert.deepEqual(r.visible,expected.filter(m=>!m.toMemberId||m.authorId==='viewer'||m.toMemberId==='viewer'));
  const first=new Map();for(const m of expected){const time=Date.parse(m.createdAt);if(!first.has(m.authorId)||time<first.get(m.authorId))first.set(m.authorId,time);}
  assert.deepEqual(new Map(r.first),first);
  assert.deepEqual(r.recent,expected.filter(visible).slice(-100));assert.equal(r.count,expected.filter(visible).length);
  console.log(JSON.stringify({rowsRead,statements,messages:expected.length,measures}));
  assert.ok(rowsRead<expected.length*50,`cursor scans must remain linear: ${rowsRead} rows for ${expected.length} messages`);
 }finally{await mf.dispose();}
});
