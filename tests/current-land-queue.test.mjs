import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { auditRecovery } from '../server/recovery.mjs';

const github = async url => ({status:200,ok:true,json:async()=>url.includes('/check-runs')
  ? {check_runs:[{status:'completed',conclusion:'success'}]}
  : url.endsWith('/status') ? {state:'success',total_count:1}
  : {title:'Bounded queue',state:'open',merged:false,mergeable:true,mergeable_state:'clean',head:{sha:'a'.repeat(40)}}});

test('native land queue appends receipts atomically, retries and survives cold open without legacy mirrors or room hydration', async t => {
  const dir=mkdtempSync(join(tmpdir(),'native-land-')),path=join(dir,'room.sqlite');
  let store=new RoomStore(path);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  store.initialize(initialRoom('commons'),{representation:'normalized-current-v1'});
  const configure=()=>{store.landQueue.configure({fetchImpl:github});store.room=()=>{throw Error('whole-room read forbidden');};};
  configure();
  const added=await store.landQueue.add('commons','owner',{repo:'acme/demo',prNumber:1,requestId:'add-one'});
  assert.equal(store.landQueue.list('commons','owner').items[0].itemId,added.item.itemId);
  assert.equal(store.workClaims.list('commons').length,0,'native queue must not resurrect legacy board');
  const seq=store.roomAuthority('commons',{memberId:'owner'}).sequence;
  assert.deepEqual(await store.landQueue.add('commons','owner',{repo:'acme/demo',prNumber:1,requestId:'add-one'}),added);
  assert.equal(store.roomAuthority('commons',{memberId:'owner'}).sequence,seq);
  const append=store.appendSideTableEvent.bind(store);
  store.appendSideTableEvent=()=>{throw Error('interrupted receipt save');};
  assert.throws(()=>store.landQueue.reportTip('commons','owner',{itemId:added.item.itemId,sourceRevision:'failed',requestId:'tip-one'}),/interrupted receipt save/);
  assert.equal(store.landQueue.list('commons','owner').items[0].tip,null);
  store.appendSideTableEvent=append;
  const tip=store.landQueue.reportTip('commons','owner',{itemId:added.item.itemId,sourceRevision:'saved',requestId:'tip-one'});
  assert.equal(tip.item.tip.sourceRevision,'saved');
  delete store.room;
  assert.doesNotThrow(()=>auditRecovery(store));
  store.close();store=new RoomStore(path);configure();
  assert.equal(store.landQueue.list('commons','owner').items[0].tip.sourceRevision,'saved');
  const removed=store.landQueue.remove('commons','owner',{itemId:added.item.itemId,requestId:'remove-one'});
  assert.deepEqual(store.landQueue.remove('commons','owner',{itemId:added.item.itemId,requestId:'remove-one'}),removed);
  assert.equal(store.landQueue.list('commons','owner').items.length,0);
  const receipts=store.db.prepare("SELECT json_extract(body,'$.data.changed') changed FROM events WHERE room_id='commons' AND json_extract(body,'$.type')='land.updated' ORDER BY sequence").all().map(r=>JSON.parse(r.changed));
  assert.deepEqual(receipts,[['added'],['tip'],['removed']]);
  delete store.room;
  assert.doesNotThrow(()=>auditRecovery(store));
});
