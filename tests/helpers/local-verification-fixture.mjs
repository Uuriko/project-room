import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';

export function localVerificationFixture(t) {
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
  const runner=new URL('../../scripts/unit-ci.mjs',import.meta.url).href;
  writeFileSync(join(checkout,'scripts/unit-ci.mjs'),`import {runTestFiles} from ${JSON.stringify(runner)};
import {mkdirSync,writeFileSync} from 'node:fs';import {createHash} from 'node:crypto';
const files=['tests/tiny.test.mjs'],attempt=process.env.GITHUB_RUN_ATTEMPT;
mkdirSync('test-results',{recursive:true});const result=runTestFiles(files,{junitPath:'test-results/unit-junit-affected-attempt-'+attempt+'.xml'});
writeFileSync('test-results/unit-affected-attempt-'+attempt+'.json',JSON.stringify({...result,files,planHash:createHash('sha256').update(files.join('\\n')).digest('hex'),revision:process.env.GITHUB_SHA,runId:process.env.GITHUB_RUN_ID,runAttempt:attempt}));process.exitCode=result.status;\n`);
  git('add','.');git('commit','-qm','fixture');const head=git('rev-parse','HEAD');
  const options={checkout,expectedHead:head,baseSha:head,recipe:'affected-unit'};
  return {checkout,git,options};
}
