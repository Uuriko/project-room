import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {verifyLocal} from '../scripts/verify-local.mjs';

function fixture(t) {
  const checkout=mkdtempSync(join(tmpdir(),'local-proof-'));t.after(()=>rmSync(checkout,{recursive:true,force:true}));
  const git=(...args)=>execFileSync('git',args,{cwd:checkout,encoding:'utf8'}).trim();
  git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  mkdirSync(join(checkout,'scripts'));mkdirSync(join(checkout,'tests'));
  writeFileSync(join(checkout,'.gitignore'),'test-results/\n.tmp/\n');
  writeFileSync(join(checkout,'package.json'),'{"type":"module"}');
  writeFileSync(join(checkout,'package-lock.json'),'{}');
  writeFileSync(join(checkout,'tests/tiny.test.mjs'),"import test from 'node:test';import assert from 'node:assert/strict';test('real child',()=>assert.equal(2+2,4));\n");
  writeFileSync(join(checkout,'scripts/ci-affected.mjs'),"export const affectedUnitFiles=()=>({files:['tests/tiny.test.mjs']});\n");
  // Actual process + existing runTestFiles export; fixture avoids running the
  // product's large safety-net plan recursively inside its own unit suite.
  const runner=new URL('../scripts/unit-ci.mjs',import.meta.url).href;
  writeFileSync(join(checkout,'scripts/unit-ci.mjs'),`import {runTestFiles} from ${JSON.stringify(runner)};
import {mkdirSync,writeFileSync} from 'node:fs';import {createHash} from 'node:crypto';
const files=['tests/tiny.test.mjs'],attempt=process.env.GITHUB_RUN_ATTEMPT;
mkdirSync('test-results',{recursive:true});const result=runTestFiles(files,{junitPath:'test-results/unit-junit-affected-attempt-'+attempt+'.xml'});
writeFileSync('test-results/unit-affected-attempt-'+attempt+'.json',JSON.stringify({...result,files,planHash:createHash('sha256').update(files.join('\\n')).digest('hex'),revision:process.env.GITHUB_SHA,runId:process.env.GITHUB_RUN_ID,runAttempt:attempt}));process.exitCode=result.status;\n`);
  git('add','.');git('commit','-qm','fixture');const head=git('rev-parse','HEAD');
  const options={checkout,expectedHead:head,baseSha:head,recipe:'affected-unit'};
  return {checkout,git,options};
}
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
