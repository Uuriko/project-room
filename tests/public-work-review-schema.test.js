import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';

function fixture(t) {
  const directory=mkdtempSync(join(tmpdir(),'public-review-schema-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const filename=join(directory,'room.sqlite');
  const store=new RoomStore(filename), platform=store.storagePlatform;
  store.close(); return {filename,platform};
}
function inspect(filename,fn) {
  const db=new DatabaseSync(filename);
  try {return fn(db);} finally {db.close();}
}
const catalog=db=>db.prepare('SELECT name,type,sql FROM sqlite_master ORDER BY name').all().map(row=>({...row}));
const reviewTables=db=>db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('public_work_reviews','public_work_review_requests') ORDER BY name").all().map(row=>row.name);

for(const readOnly of [false,true]) for(const [label,damage] of [
  ['review absent','DROP TABLE public_work_reviews'],
  ['journal absent','DROP TABLE public_work_review_requests'],
  ['review malformed','DROP TABLE public_work_reviews; CREATE TABLE public_work_reviews(receipt_id TEXT PRIMARY KEY)'],
  ['journal malformed','DROP TABLE public_work_review_requests; CREATE TABLE public_work_review_requests(request_id TEXT PRIMARY KEY)'],
]) test(`partial or malformed ${label} is refused on ${readOnly?'read-only':'writable'} startup without repair`,t=>{
  const {filename}=fixture(t);
  const before=inspect(filename,db=>{db.exec(damage);return catalog(db);});
  assert.throws(()=>{const unexpected=new RoomStore(filename,{readOnly});unexpected.close();},/review.*schema.*reconciliation/i);
  assert.deepEqual(inspect(filename,catalog),before);
});

test('read-only pre-review database remains byte-identical and review tables stay absent',t=>{
  const {filename}=fixture(t);
  const before=inspect(filename,db=>{db.exec('DROP TABLE public_work_reviews; DROP TABLE public_work_review_requests');return catalog(db);});
  const bytes=readFileSync(filename);
  const store=new RoomStore(filename,{readOnly:true});
  try {assert.equal(store.publicWorkReviews.verifySchema({allowAbsent:true}),false);assert.deepEqual(reviewTables(store.db),[]);}
  finally {store.close();}
  assert.deepEqual(readFileSync(filename),bytes);assert.deepEqual(inspect(filename,catalog),before);
});

test('both review tables install atomically and a failed startup commit rolls both back',t=>{
  const {filename,platform}=fixture(t);
  const before=inspect(filename,db=>{db.exec('DROP TABLE public_work_reviews; DROP TABLE public_work_review_requests');return catalog(db);});
  let observedBoth=false;
  const storagePlatform={...platform,transaction(db,fn,readOnly){
    const outermost=!db.isTransaction;
    return platform.transaction(db,()=>{
      const value=fn();
      if(!readOnly&&outermost){assert.deepEqual(reviewTables(db),['public_work_review_requests','public_work_reviews']);observedBoth=true;throw new Error('fixture refuses review startup commit');}
      return value;
    },readOnly);
  }};
  assert.throws(()=>new RoomStore(filename,{storagePlatform}),/fixture refuses review startup commit/);
  assert.equal(observedBoth,true);assert.deepEqual(inspect(filename,catalog),before);
  const reopened=new RoomStore(filename);
  try {assert.equal(reopened.publicWorkReviews.verifySchema(),true);assert.deepEqual(reviewTables(reopened.db),['public_work_review_requests','public_work_reviews']);}
  finally {reopened.close();}
});
