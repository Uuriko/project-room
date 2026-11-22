import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

test('actual Native attention and frozen brief preserve bounded progress through private pages and cold reopen', {timeout:60000}, async t => {
 const script=(await build({entryPoints:[fileURLToPath(new URL('./normalized-assistant.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']})).outputFiles[0].text;
 const directory=await mkdtemp(join(tmpdir(),'native-attention-'));
 const create=()=>new Miniflare({modules:true,script,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjectsPersist:directory,durableObjects:{ROOM:{className:'NormalizedAssistantRoom',useSQLite:true}},bindings:{ROOM_ORIGIN:'https://room.example'},serviceBindings:{ASSETS:async()=>new Response('Not found',{status:404})}});
 let mf=create();
 const call=(path,data)=>mf.dispatchFetch('https://room.example'+path,{method:data===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});
 const read=async path=>{
  const response=await call(path);
  assert.equal(response.status,200,await response.clone().text());
  const body=await response.json();
  assert.equal(body.status,200,JSON.stringify(body));
  assert.equal(body.cost.unknown,0);
  assert.equal(body.cost.rowsWritten,0,'attention and brief reads must not acknowledge or mutate state');
  // Synthetic-fixture SQL ceilings include authentication and proof reads.
  // The separate per-page assertion below bounds the actual event window.
  assert.ok(body.cost.rowsRead<=4096,'bounded attention/brief SQL rows');
  assert.ok(body.cost.statements<=512,'bounded attention/brief SQL statements');
  return body;
 };
 const pagePath=c=>'/__brief?'+new URLSearchParams({limit:2,horizon:c.horizon,after:c.after,cursor:c.cursor});
 try{
  assert.equal((await call('/__seed',{terminalRows:0})).status,200);
  const seeded=await call('/__attention-seed',{});
  assert.equal(seeded.status,200);
  const {visibleSequences}=await seeded.json();
  const attention=await read('/__needs-me');
  assert.equal(attention.body.contractVersion,2);
  assert.equal(JSON.stringify(attention.body).includes('PRIVATE OTHER MEMBERS ONLY'),false);
  assert.equal(attention.body.coverage.mode,'native_bounded');
  assert.equal((await(await call('/__proof')).json()).cursors,0);

  let current=await read('/__brief?limit=2'),pages=0,privateEmptyPages=0,cold=false;
  const H=current.body.history.evaluatedThrough,C=current.body.history.cursor,visible=[];
  let after=C;
  const costs=[];
  // A later visible event must not leak into this already-open history walk.
  assert.equal((await call('/__post',{})).status,200);
  for(;pages<40;pages++){
   const page=current.body,history=page.history;
   costs.push(current.cost);
   assert.equal(history.evaluatedThrough,H);
   assert.equal(history.cursor,C);
   assert.equal(JSON.stringify(page).includes('PRIVATE OTHER MEMBERS ONLY'),false);
   assert.equal(JSON.stringify(history).includes('native-ask'),false);
   assert.ok(Number.isSafeInteger(history.examinedThrough));
   assert.ok(history.examinedThrough>=after&&history.examinedThrough<=H);
   // The fixture has dense sequences. One call may examine at most one
   // two-source-event window, even if neither event is visible to the owner.
   assert.ok(history.examinedThrough-after<=2,'brief must retain its bounded source window');
   assert.ok(history.items.length<=2);
   for(const row of history.items){
    assert.ok(row.sequence>after&&row.sequence<=history.examinedThrough);
    assert.ok(!visible.length||row.sequence>visible.at(-1).sequence,'visible history must be ordered without duplicates');
    visible.push(row);
   }
   if(!history.items.length){
    privateEmptyPages++;
    assert.ok(history.examinedThrough>after||!history.hasMore,'empty nonterminal page must make progress');
   }
   if(!history.hasMore){
    assert.equal(history.continuation,null);
    break;
   }
   assert.ok(history.examinedThrough>after,'every nonterminal page must make strict progress');
   const c=history.continuation;
   assert.deepEqual(c,{horizon:H,after:history.examinedThrough,cursor:C});
   after=c.after;
   if(!cold&&!history.items.length){
    // Resume the same private-page continuation warm and cold. Only its
    // public triple and persisted state cross the runtime boundary.
    const warm=await read(pagePath(c));
    await mf.dispose();
    mf=create();
    current=await read(pagePath(c));
    assert.deepEqual(current.body,warm.body);
    cold=true;
   }else current=await read(pagePath(c));
  }
  assert.ok(privateEmptyPages>0,'fixture must exercise private-only pages');
  assert.equal(cold,true);
  assert.ok(pages<40,'walk must terminate');
  assert.equal(current.body.history.hasMore,false);
  assert.equal(current.body.history.examinedThrough,H);
  assert.deepEqual(visible.map(row=>row.sequence),visibleSequences,'deliver the entire visible horizon, including its tail');
  assert.deepEqual(visible.filter(row=>row.event.data.messageId==='visible-tail').map(row=>row.event.data.body),['@Owner visible attention']);
  assert.equal(current.body.current.needsAttention,null);

  const reopened=await read('/__brief?limit=2');
  assert.equal(reopened.body.history.cursor,C,'reading must not move the caught-up marker');
  assert.ok(reopened.body.history.evaluatedThrough>H,'late arrival belongs to a fresh horizon');
  const late=await read(pagePath({horizon:reopened.body.history.evaluatedThrough,after:H,cursor:C}));
  assert.deepEqual(late.body.history.items.map(row=>row.event.data.messageId),['native-ask']);
  const proof=await call('/__proof');
  assert.equal(proof.status,200);
  assert.equal((await proof.json()).cursors,0);
  t.diagnostic('NATIVE_ATTENTION_BRIEF '+JSON.stringify({pages:pages+1,privateEmptyPages,cold:true,visibleEvents:visible.length,firstAttentionCost:attention.cost,maxBriefRowsRead:Math.max(...costs.map(cost=>cost.rowsRead)),maxBriefStatements:Math.max(...costs.map(cost=>cost.statements)),finalBriefCost:current.cost,actualNative:true,clockOnly:true}));
 }finally{
  await mf.dispose();
  await rm(directory,{recursive:true,force:true});
 }
});
