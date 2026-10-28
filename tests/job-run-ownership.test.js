import test from 'node:test';
import assert from 'node:assert/strict';
import { createJobRunCoordinator } from '../cloudflare/job-heartbeat.mjs';
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };

test('same job shares ownership through commit while independent jobs progress', async () => {
  const coordinate = createJobRunCoordinator(), body = deferred(), commit = deferred();
  let runs = 0, committed = false;
  const run = async () => { runs++; await body.promise; await commit.promise; committed=true; return 'recorded'; };
  const leader = coordinate('first', run);
  await Promise.resolve();
  assert.equal(runs,1);
  assert.equal(await coordinate('independent', () => 'progress'), 'progress');
  body.resolve(); await Promise.resolve();
  const followers=Array.from({length:7},()=>coordinate('first',run));
  assert.ok(followers.every(p=>p===leader));
  assert.equal(committed,false);
  commit.resolve();
  assert.deepEqual(await Promise.all([leader,...followers]),Array(8).fill('recorded'));
  assert.equal(runs,1);
  await coordinate('first',run);
  assert.equal(runs,2,'settled results are not cached as permission to skip a new run');
});

test('failed work or outcome recording rejects every waiter and allows retry', async () => {
  for (const phase of ['body','commit']) {
    const coordinate=createJobRunCoordinator(), gate=deferred(); let calls=0;
    const run=async()=>{ calls++; await gate.promise; throw new Error(phase); };
    const requests=Array.from({length:8},()=>coordinate('job',run));
    const settled=Promise.allSettled(requests); gate.resolve();
    assert.ok((await settled).every(r=>r.status==='rejected' && r.reason.message===phase));
    assert.equal(calls,1);
    assert.equal(await coordinate('job',()=> 'retried'),'retried');
  }
});

test('synchronous failure releases ownership without swallowing the error', async () => {
  const coordinate=createJobRunCoordinator();
  await assert.rejects(coordinate('job',()=>{throw new Error('sync');}),/sync/);
  assert.equal(await coordinate('job',()=>42),42);
});
