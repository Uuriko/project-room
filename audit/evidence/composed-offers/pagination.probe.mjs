import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {RoomStore} from '../../../server/store.mjs';
import {initialRoom} from '../../../server/bootstrap.mjs';
import {PublicWorkClaims,publicWorkClaimsSchema} from '../../../server/public-work-claims.mjs';
import {publicWorkClaimFenceSchema} from '../../../server/public-work-claim-fence.mjs';
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


test('funded first page retains continuation and volunteer auto-claim only takes unpaid second page',t=>{
 const f=fixture(t),[agent]=f.identities;f.store.initialize(initialRoom('overflow'));f.store.bountyEscrow.ensureGenesis('commons');
 for(let n=0;n<100;n++)f.enable('paid-'+String(n).padStart(3,'0'),['files/'+n],{kind:'work_trade',unit:'credit',amountMinor:'1'});
 f.enable('volunteer-last',['files/unpaid'],{kind:'unpaid'},'main','overflow');
 const first=f.service().match(agent.secret,{reward:'volunteer',autoClaim:true,requestId:'first'});
 assert.equal(first.inspected,100);assert.deepEqual(first.recommendations,[]);assert.equal(first.claim,null);assert.equal(first.hasMore,true);assert.equal(first.nextCursor,'paid-099');assert.equal(first.reasonCode,undefined);
 const input={reward:'volunteer',autoClaim:true,requestId:'second',after:first.nextCursor};const second=f.service().match(agent.secret,input);
 assert.equal(second.claim.task.taskId,'volunteer-last');assert.equal(second.claim.task.reward.kind,'unpaid');assert.equal(second.inspected,1);assert.equal(second.hasMore,false);assert.equal(second.nextCursor,null);
 assert.deepEqual(f.service().match(agent.secret,input),second);
 for(let n=0;n<100;n++)assert.equal(f.service().read('paid-'+String(n).padStart(3,'0')).claim.state,'unclaimed');
 for(const reward of ['cash','work_trade']){const result=f.service().match(agent.secret,{reward,autoClaim:true,requestId:'unsupported-'+reward});assert.equal(result.claim,null);assert.deepEqual(result.recommendations,[]);}
 console.log(JSON.stringify({first:{inspected:first.inspected,cursor:first.nextCursor,claim:first.claim},second:{inspected:second.inspected,claimed:second.claim.task.taskId},paidUnclaimed:100,replay:'identical',unsupported:'no claims'}));
});
