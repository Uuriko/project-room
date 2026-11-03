import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('actual Native HTTP discussion has bounded source reads at1k/5k; private-only history never enters pagination',{timeout:120000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'native-current-discussion-')),script=(await build({entryPoints:[new URL('./current-work-discussion-native.test-fixture.mjs',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']})).outputFiles[0].text;
 const create=()=>new Miniflare({script,modules:true,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjectsPersist:dir,durableObjects:{ROOM:{className:'CurrentWorkDiscussionRoom',useSQLite:true}}});let mf=create();
 const call=async(surface,path)=>{const r=await mf.dispatchFetch('http://localhost'+path+(path.includes('?')?'&':'?')+'surface='+surface),body=await r.json();assert.equal(r.status,200,JSON.stringify(body));if(body.status!==undefined)assert.equal(body.status,200,JSON.stringify(body));return body;};
 const costs=[];try{for(const n of [1000,5000]){
  const surface='n'+n,seed=await call(surface,'/seed?n='+n),first=await call(surface,'/read');
  assert.deepEqual(first.page.discussion.items.map(row=>row.message.id),['source']);assert.equal(first.page.discussion.hasMore,true);
  let cursor=first.page.discussion.nextCursor;
  for(let i=0;i<3;i++){const next=await call(surface,'/read?cursor='+cursor);assert.deepEqual(next.page.discussion.items,[]);assert.equal(next.page.discussion.hasMore,true);assert.notEqual(next.page.discussion.nextCursor,cursor);cursor=next.page.discussion.nextCursor;}
  const warm=await call(surface,'/read');assert.equal(warm.cost.unknown,0);costs.push({n,kind:'public-unrelated',...warm.cost});
  const tail=await call(surface,'/read?since='+(seed.sequence-1));assert.deepEqual(tail.page.discussion.items.map(row=>row.message.id),['linked']);assert.equal(tail.page.discussion.hasMore,false);
  const hidden='hidden'+n;await call(hidden,'/seed?n='+n+'&hidden=1');const privatePage=await call(hidden,'/read');assert.deepEqual(privatePage.page.discussion.items.map(row=>row.message.id),['source','linked']);assert.equal(privatePage.page.discussion.hasMore,false);assert.equal(JSON.stringify(privatePage.page).includes('PRIVATE-'),false);costs.push({n,kind:'private-unrelated',...privatePage.cost});
  await mf.dispose();mf=create();const cold=await call(surface,'/read');assert.deepEqual(cold.page.discussion.items.map(row=>row.message.id),['source']);
 }
 const historical=await call('historical','/seed-historical');
 let page=await call('historical','/read?since='+historical.since);assert.deepEqual(page.page.discussion.items.map(row=>row.message.id),['cjk']);assert.equal(page.page.discussion.hasMore,true);
 const openingCost=page.cost;assert.ok(!JSON.stringify(page.page).includes('界'));assert.equal(page.cost.unknown,0);
 page=await call('historical','/read?cursor='+page.page.discussion.nextCursor);assert.deepEqual(page.page.discussion.items.map(row=>row.message.id),['control']);assert.equal(page.page.discussion.hasMore,true);assert.equal(page.cost.unknown,0);
 page=await call('historical','/read?cursor='+page.page.discussion.nextCursor);assert.deepEqual(page.page.discussion.items.map(row=>row.message.id),['tail']);assert.equal(page.page.discussion.hasMore,false);assert.equal(JSON.stringify(page.page).includes('Current private'),false);
 await mf.dispose();mf=create();const historicalCold=await call('historical','/read?since='+historical.since);assert.deepEqual(historicalCold.page.discussion.items.map(row=>row.message.id),['cjk']);
 t.diagnostic(JSON.stringify({historicalOpeningCost:openingCost,rawHistoricalTextReturned:false,rawPrefixBytes:65536,oneLegalFirstAtom:true}));
 t.diagnostic(JSON.stringify({costs,completeUnrelatedEnumeration:false,sourceLimit:4,historySizes:[1000,5000],localClockNotCPU:true}));
 assert.equal(costs[0].rowsRead,costs[2].rowsRead);assert.equal(costs[1].rowsRead,costs[3].rowsRead);
 }finally{await mf.dispose();await rm(dir,{recursive:true,force:true});}
});
