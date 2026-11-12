import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {verifyLocal,executeUnits} from '../scripts/verify-local.mjs';

import {localVerificationFixture as fixture} from './helpers/local-verification-fixture.mjs';

const plan=()=>['tests/tiny.test.mjs'];
function fakeExecution(status=0, mutate=()=>{}) {
  return async ({checkout,env})=>{
    const files=plan(),attempt=env.GITHUB_RUN_ATTEMPT,dir=join(checkout,'test-results');mkdirSync(dir,{recursive:true});
    const unit={files,planHash:createHash('sha256').update(files.join('\n')).digest('hex'),status,signal:null,revision:env.GITHUB_SHA,runId:env.GITHUB_RUN_ID,runAttempt:attempt};
    writeFileSync(join(dir,`unit-affected-attempt-${attempt}.json`),JSON.stringify(unit));
    for(const suffix of ['','.spec.log','.progress.ndjson'])writeFileSync(join(dir,`unit-junit-affected-attempt-${attempt}.xml${suffix}`),'fixture');
    mutate(checkout,unit);return {status,signal:null,timedOut:false};
  };
}

test('refuses wrong source, dirty tracked/untracked files and unsupported arguments before execution',async t=>{
  const f=fixture(t);let calls=0;const deps={plan,execute:()=>{calls++;}};
  await assert.rejects(()=>verifyLocal({...f.options,expectedHead:'0'.repeat(40)},deps),/head_changed/);
  for(const bad of [{recipe:'shell'},{expectedHead:'HEAD'},{baseSha:'--help'},{timeoutMs:1800001},{command:'echo hi'}])await assert.rejects(()=>verifyLocal({...f.options,...bad},deps),/invalid_local/);
  writeFileSync(join(f.checkout,'unexpected'),'dirty');await assert.rejects(()=>verifyLocal(f.options,deps),/not_clean/);rmSync(join(f.checkout,'unexpected'));
  writeFileSync(join(f.checkout,'package-lock.json'),'changed');await assert.rejects(()=>verifyLocal(f.options,deps),/not_clean/);
  assert.equal(calls,0);
});
test('passed receipt pins source, environment, plan and locally copied evidence without CI assertion',async t=>{
  const f=fixture(t);const {receipt,path}=await verifyLocal(f.options,{plan,execute:fakeExecution()});
  assert.equal(receipt.status,'passed');assert.equal(receipt.hostedCI,false);assert.equal(receipt.provenance,'local');
  assert.equal(receipt.source.head,f.options.expectedHead);assert.equal(receipt.environment.node,process.version);
  assert.equal(receipt.artifacts.length,4);assert.ok(receipt.artifacts.every(a=>/^[a-f0-9]{64}$/.test(a.sha256)));
  assert.deepEqual(JSON.parse(readFileSync(path)),receipt);assert.equal(existsSync(join(f.checkout,'.git/local-verification.lock')),false);
  assert.equal(f.git('status','--porcelain'), '');
});
test('nonzero exit is failed, never a successful local proof',async t=>{
  const f=fixture(t);const {receipt}=await verifyLocal(f.options,{plan,execute:fakeExecution(1)});
  assert.equal(receipt.status,'failed');assert.equal(receipt.exitCode,1);
});
test('source mutation invalidates otherwise successful evidence',async t=>{
  const f=fixture(t);const {receipt}=await verifyLocal(f.options,{plan,execute:fakeExecution(0,cwd=>writeFileSync(join(cwd,'package-lock.json'),'changed'))});
  assert.equal(receipt.status,'invalid');assert.equal(receipt.reason,'source_changed');
});
test('missing evidence, timeout and thrown execution never pass',async t=>{
  for(const execute of [async()=>({status:0,signal:null}),async()=>({status:null,signal:'SIGKILL',timedOut:true}),async()=>{throw Error('private command detail');}]) {
    const f=fixture(t);const {receipt}=await verifyLocal(f.options,{plan,execute});
    assert.equal(receipt.status,'invalid');assert.doesNotMatch(JSON.stringify(receipt),/private command detail/);
  }
});
test('existing reservation blocks a second invocation without clearing unknown ownership',async t=>{
  const f=fixture(t),lock=join(f.checkout,'.git/local-verification.lock');writeFileSync(lock,'unknown');
  await assert.rejects(()=>verifyLocal(f.options,{plan,execute:fakeExecution()}),{code:'EEXIST'});
  assert.equal(readFileSync(lock,'utf8'),'unknown');
});
test('symlinked output roots are refused before execution', {skip:process.platform==='win32'},async t=>{
  for(const name of ['.git/local-verification','test-results','.tmp']) {
    const f=fixture(t),outside=mkdtempSync(join(tmpdir(),'proof-outside-'));t.after(()=>rmSync(outside,{recursive:true,force:true}));
    writeFileSync(join(f.checkout,'.git/info/exclude'),'test-results\n.tmp\n');
    symlinkSync(outside,join(f.checkout,name));
    await assert.rejects(()=>verifyLocal(f.options,{plan,execute:()=>{throw Error('must not execute');}}),/unsafe_output_directory/);
  }
});
test('different test plan cannot be accepted as exact planned evidence',async t=>{
  const f=fixture(t);const {receipt}=await verifyLocal(f.options,{plan:()=>['tests/other.test.mjs'],execute:fakeExecution()});
  assert.equal(receipt.status,'invalid');assert.equal(receipt.reason,'missing_or_mismatched_evidence');
});
test('real child pipeline reuses existing unit runner and retains measured result', {skip:process.platform==='win32'},async t=>{
  const f=fixture(t);const {receipt}=await verifyLocal({...f.options,timeoutMs:10000});
  assert.equal(receipt.status,'passed');assert.equal(receipt.exitCode,0);assert.equal(receipt.artifacts.length,4);
});
test('actual bounded process timeout is invalid and releases the completed attempt reservation', {skip:process.platform==='win32'},async t=>{
  const f=fixture(t);writeFileSync(join(f.checkout,'scripts/unit-ci.mjs'),'setInterval(()=>{},1000);\n');
  f.git('add','scripts/unit-ci.mjs');f.git('commit','-qm','hanging fixture');
  const head=f.git('rev-parse','HEAD');
  const {receipt}=await verifyLocal({...f.options,expectedHead:head,timeoutMs:100},{plan});
  assert.equal(receipt.status,'invalid');assert.equal(receipt.reason,'timeout');assert.equal(receipt.signal,'SIGKILL');
  assert.equal(existsSync(join(f.checkout,'.git/local-verification.lock')),false);
});

test('already cancelled job never executes or creates a reservation',async t=>{
  const f=fixture(t),controller=new AbortController();controller.abort();let called=false;
  await assert.rejects(verifyLocal({...f.options,signal:controller.signal},{plan,execute:()=>{called=true;}}),{name:'AbortError'});
  assert.equal(called,false);assert.equal(existsSync(join(f.checkout,'.git/local-verification.lock')),false);
});
test('cancellation during a real child run kills it and retains an invalid receipt', {skip:process.platform==='win32'},async t=>{
  const f=fixture(t);writeFileSync(join(f.checkout,'scripts/unit-ci.mjs'),'setInterval(()=>{},1000);\n');
  f.git('add','.');f.git('commit','-qm','cancellation fixture');
  const controller=new AbortController();let timer;
  t.after(()=>clearTimeout(timer));
  const {receipt}=await verifyLocal({...f.options,expectedHead:f.git('rev-parse','HEAD'),signal:controller.signal,timeoutMs:10000},
    {plan,execute:args=>{timer=setTimeout(()=>controller.abort(),100);return executeUnits(args);}});
  assert.equal(receipt.status,'invalid');assert.equal(receipt.reason,'cancelled');assert.equal(receipt.signal,'SIGKILL');
  assert.equal(existsSync(join(f.checkout,'.git/local-verification.lock')),false);
});
