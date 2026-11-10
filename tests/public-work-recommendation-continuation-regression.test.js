import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { PublicWorkClaims, publicWorkClaimsSchema } from '../server/public-work-claims.mjs';
import { publicWorkClaimFenceSchema, verifyPublicWorkClaimFence } from '../server/public-work-claim-fence.mjs';
import { unpublishPublic } from '../server/legal-store.mjs';

// Real store/identity/offer/lease boundary; registration/HTTP/workerd keepers
// independently own transport and old-writer fencing. No registry doubles.
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'public-work-domain-')), file = join(dir, 'room.sqlite');
  let clock = Date.now(), store = new RoomStore(file, { now: () => clock });
  store.initialize(initialRoom());
  store.db.exec(publicWorkClaimsSchema); store.db.exec(publicWorkClaimFenceSchema);
  const identities = [store.identities.create('First worker'), store.identities.create('Second worker')];
  const service = () => new PublicWorkClaims(store);
  const enable = (id, files = ['src/shared.js'], reward = { kind: 'unpaid' }, reference = 'main', roomId = 'commons') => {
    const input = { requestId: `create-${id}`, offerId: id, reviewerMemberIds: ['owner'],
      terms: { kind: 'task', title: id, summary: 'Public result', acceptanceCriteria: ['Deliver the declared change'],
        repositoryUrl: 'https://github.com/Example/Project', reward, approvalPolicy: { mode: 'human' } } };
    store.projectOffers.create(roomId, 'owner', input);
    store.projectOffers.transition(roomId, 'owner', id, 'publish', { requestId: `publish-${id}`, expectedRevision: 1 });
    return service().enable(roomId, 'owner', id, { requestId: `enable-${id}`, expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: reference, files });
  };
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { get store() { return store; }, service, identities, enable,
    tick(ms) { clock += ms; }, reopen() { store.close(); store = new RoomStore(file, { now: () => clock }); } };
}
const claim = (requestId, extra = {}) => ({ requestId, expectedTermsVersion: 1, ...extra });
const owned = (requestId, generation, extra = {}) => ({ ...claim(requestId), generation, ...extra });
const code = expected => error => error.code === expected;

// Reproduction: a ranked page must not declare completion while its scanned candidates remain hidden.
test('recommendation pagination reaches every candidate within one scan page', t => {
 const f = fixture(t);
 f.enable('a-docs', ['a']); f.enable('b-typescript', ['b']); f.enable('c-third', ['c']);
 const seen = new Set(); let after;
 for (let i = 0; i < 10; i++) {
  const page = f.service().match(null, {cursorVersion:2,skills:['typescript'],limit:1,...(after ? {after} : {})});
  assert.equal(page.cursorVersion,2);
  for (const entry of page.recommendations) { assert.ok(!seen.has(entry.task.taskId), 'duplicate task'); seen.add(entry.task.taskId); }
  if (!page.hasMore) break;
  assert.ok(page.nextCursor, 'continuation must include a cursor');
  after = page.nextCursor;
 }
 assert.deepEqual([...seen].sort(), ['a-docs','b-typescript','c-third']);
});

test('recommendation continuation rejects changed selection and changed claim state', t => {
 const f = fixture(t), [worker] = f.identities;
 f.enable('a-first', ['a']); f.enable('b-second', ['b']); f.enable('c-third', ['c']);
 const first = f.service().match(null, {cursorVersion:2,skills:['typescript'],limit:1});
 assert.equal(first.hasMore,true);
 assert.throws(() => f.service().match(null,{cursorVersion:2,skills:['docs'],limit:1,after:first.nextCursor}), e=>e.code==='stale_recommendation_cursor');
 assert.throws(() => f.service().match(null,{cursorVersion:2,skills:['typescript'],limit:2,after:first.nextCursor}), e=>e.code==='stale_recommendation_cursor');
 f.service().act('c-third',worker.secret,'claim',claim('hold-third'));
 assert.throws(() => f.service().match(null,{cursorVersion:2,skills:['typescript'],limit:1,after:first.nextCursor}), e=>e.code==='stale_recommendation_cursor');
});

test('legacy source cursor remains valid and malformed continuations fail closed', t => {
 const f = fixture(t); f.enable('a-first',['a']); f.enable('b-second',['b']); f.enable('c-third',['c']);
 const result = f.service().match(null,{after:'a-first',limit:5});
 assert.deepEqual(result.recommendations.map(x=>x.task.taskId),['b-second','c-third']);
 for (const cursor of ['~bad','~e30','~'+ 'a'.repeat(1025)])
  assert.throws(()=>f.service().match(null,{after:cursor}),e=>e.code==='invalid_public_work');
});

test('recommendations continue through ranked remainders and subsequent source pages', t => {
 const f = fixture(t); f.store.initialize(initialRoom('annex'));
 for(let i=0;i<103;i++){const id=`work-${String(i).padStart(3,'0')}`;f.enable(id,[`file-${i}.js`],{kind:'unpaid'},'main',i<100?'commons':'annex');}
 const seen=new Set();let after;let pages=0;
 do {
  const page=f.service().match(null,{cursorVersion:2,limit:5,...(after?{after}:{})});
  for(const entry of page.recommendations){assert.ok(!seen.has(entry.task.taskId));seen.add(entry.task.taskId);}
  after=page.hasMore?page.nextCursor:null;assert.ok(++pages<30);
 } while(after);
 assert.equal(seen.size,103);
});


test('legacy callers retain bare cursor format and opt-in is echoed', t => {
 const f=fixture(t); f.enable('a-one',['a']); f.enable('b-two',['b']);
 const legacy=f.service().match(null,{limit:1});
 assert.equal(legacy.hasMore,false); assert.equal(legacy.nextCursor,null); assert.equal(legacy.cursorVersion,undefined);
 const v2=f.service().match(null,{limit:1,cursorVersion:2});
 assert.equal(v2.hasMore,true);assert.equal(v2.cursorVersion,2);assert.match(v2.nextCursor,/^~/);
 assert.throws(()=>f.service().match(null,{limit:1,after:v2.nextCursor}), e=>e.code==='invalid_public_work');
});


test('rejects invalid cursors and combining version 2 pagination with auto-claim', t => {
 const f = fixture(t);
 for (const after of [null, 1, '']) {
  assert.throws(() => f.service().match(null, {after}), e => e.code === 'invalid_public_work');
 }
 assert.throws(() => f.service().match(null, {cursorVersion:2, autoClaim:true}), e => e.code === 'invalid_public_work');
});
