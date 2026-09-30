import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

// Provisioning and fault routes belong only to this disposable fixture. All
// storage, claim, identity, hashing and lease writes use the production services.
const fixture = `
import entry, { ProjectRoom } from './room.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createWork } from '../server/work-claims.mjs';
import { createDurableWorkClaimRegistry } from '../server/work-claim-sqlite.mjs';
import { withPublicWorkClaimWriter, verifyPublicWorkClaimFence } from '../server/public-work-claim-fence.mjs';
export class PublicClaimTestRoom extends ProjectRoom {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const input = path.startsWith('/__fixture/') && request.method === 'POST' ? await request.json() : {};
    try {
      if (path === '/__fixture/setup') {
        this.store.initialize(initialRoom());
        const offerId = 'worker-public-task';
        this.store.projectOffers.create('commons','owner',{requestId:'create',offerId,reviewerMemberIds:['owner'],terms:{kind:'task',title:'Worker public task',summary:'Disposable lifecycle proof',acceptanceCriteria:['Provide a public artifact'],repositoryUrl:'https://github.com/Uuriko/project-room',reward:{kind:'unpaid'},approvalPolicy:{mode:'human'}}});
        this.store.projectOffers.transition('commons','owner',offerId,'publish',{requestId:'publish',expectedRevision:1});
        const task=this.store.publicWorkClaims.enable('commons','owner',offerId,{requestId:'enable',expectedRevision:2,expectedTermsVersion:1,repositoryRef:'main',files:['src/public-task.js']});
        const identity=this.store.identities.create('Outside worker agent');
        return Response.json({task,identity});
      }
      if (path === '/__fixture/action') return Response.json(this.store.publicWorkClaims.act('worker-public-task',input.secret,input.action,input.body));
      if (path === '/__fixture/state') return Response.json({
        tasks:this.store.publicWorkClaims.list(),
        receipts:this.store.db.prepare('SELECT * FROM public_work_receipts ORDER BY receipt_id').all(),
        requests:this.store.db.prepare('SELECT * FROM public_work_requests ORDER BY request_id').all(),
        permit:this.store.db.prepare('SELECT enabled FROM public_work_claim_writer_permit').get().enabled,
        balances:this.store.bountyEscrow.balances('commons','owner'),
        members:Object.keys(this.store.room('commons').state.members),
        validFence:verifyPublicWorkClaimFence(this.store.db)
      });
      if (path === '/__fixture/receipt') return Response.json({receipt:this.store.publicWorkClaims.receipt(input.receiptId),artifact:this.store.publicWorkClaims.artifact(input.receiptId)});
      if (path === '/__fixture/fault') {
        withPublicWorkClaimWriter(this.store,()=>{
          const task=this.store.publicWorkClaims.read('worker-public-task');
          const item=this.store.workClaims.get(task.namespaceId,task.taskId);
          this.store.workClaims.set(task.namespaceId,{...item,title:'Uncommitted change'});
          throw new Error('Injected failure');
        });
      }
      if (path === '/__fixture/legacy-writer') {
        const registry=createDurableWorkClaimRegistry(this.store.db);
        registry.set('commons',createWork({id:'private-worker',title:'Private writer retained'}));
        const task=this.store.publicWorkClaims.read('worker-public-task');
        registry.set(task.namespaceId,createWork({id:'forbidden-worker',title:'No public permit'}));
      }
      return super.fetch(request);
    } catch(error) { return Response.json({error:{message:error.message,code:error.code??null}},{status:error.status??500}); }
  }
}
export default entry;
`;

test('actual Worker public claims survive disposal, exact finish retry and guarded legacy writes without membership or credit changes', async () => {
  const bundled = await build({ stdin: { contents: fixture, resolveDir: fileURLToPath(new URL('.', import.meta.url)), sourcefile: 'public-claim-local-fixture.mjs' },
    bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  const persistence = await mkdtemp(join(tmpdir(), 'public-claim-worker-persist-'));
  const origin='https://room.example.test';
  const config={ modules:true,script:bundled.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],
    durableObjects:{ROOM:{className:'PublicClaimTestRoom',useSQLite:true}},bindings:{ROOM_ORIGIN:origin},durableObjectsPersist:persistence };
  let worker=new Miniflare(config);
  const api=(path,body,secret,method)=>worker.dispatchFetch(origin+path,{method:method??(body?'POST':'GET'),
    headers:{Host:'room.example.test',...(body?{Origin:origin,'Content-Type':'application/json'}:{}),...(secret?{Authorization:'Bearer '+secret}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const call=(path,body)=>path==='action' ? api('/api/public-work/tasks/worker-public-task/'+body.action,body.body,body.secret)
    : api('/__fixture/'+path,body);
  const json=async(response,status=200)=>{assert.equal(response.status,status,await response.clone().text());return response.json();};
  const reopen=async()=>{await worker.dispose();worker=new Miniflare(config);};
  try {
    const {task,identity}=await json(await call('setup'));
    const before=await json(await call('state'));
    assert.equal(before.permit,0);assert.equal(before.validFence,true);assert.ok(!before.members.includes(identity.identityId));
    assert.deepEqual((await json(await api('/api/public-work/tasks'))).tasks,[task]);
    assert.deepEqual((await json(await api('/api/public-work/tasks?limit=1'))).tasks,[task]);
    const head=await api('/api/public-work/tasks/worker-public-task',undefined,undefined,'HEAD');
    assert.equal(head.status,200);assert.equal(await head.text(),'');
    assert.equal((await api('/api/public-work/tasks?unexpected=1')).status,422);
    const claim={requestId:'worker-claim',expectedTermsVersion:1,leaseHours:1};
    const claimed=await json(await call('action',{secret:identity.secret,action:'claim',body:claim}));
    await reopen();
    assert.deepEqual(await json(await call('action',{secret:identity.secret,action:'claim',body:claim})),claimed);
    const artifactText='Public synthetic artifact\nUnicode: ✓';
    const finish={requestId:'worker-finish',expectedTermsVersion:1,generation:claimed.task.claim.generation,artifactText,checksReported:['Synthetic check reported by contributor']};
    const completed=await json(await call('action',{secret:identity.secret,action:'finish',body:finish}));
    const finishedState=await json(await call('state'));
    await reopen();
    assert.deepEqual(await json(await call('state')),finishedState);
    assert.deepEqual(await json(await call('action',{secret:identity.secret,action:'finish',body:finish})),completed);
    const proof=await json(await call('receipt',{receiptId:completed.receipt.receiptId}));
    assert.deepEqual(await json(await api('/api/public-work/receipts/'+completed.receipt.receiptId)),completed.receipt);
    assert.equal(await (await api('/api/public-work/receipts/'+completed.receipt.receiptId+'/artifact')).text(),artifactText);
    assert.equal(proof.artifact.artifactText,artifactText);
    assert.equal(proof.artifact.sha256,createHash('sha256').update(artifactText).digest('hex'));
    assert.equal(proof.artifact.bytes,Buffer.byteLength(artifactText));
    assert.equal(proof.receipt.state,'submitted');
    const legacy=await json(await call('legacy-writer',{}),500);assert.match(legacy.error.message,/unsupported public claim writer/);
    const fault=await json(await call('fault',{}),500);assert.match(fault.error.message,/Injected failure/);
    const final=await json(await call('state'));assert.deepEqual(final,finishedState);
    assert.deepEqual(final.balances,before.balances);assert.deepEqual(final.members,before.members);assert.equal(task.claim.generation,0);
  } finally {await worker.dispose();await rm(persistence,{recursive:true,force:true});}
});
