import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRuntimePackage, verifyRuntimePackage } from '../scripts/runtime-package.mjs';
const repository=fileURLToPath(new URL('../',import.meta.url));
test('explicit instance build stamps its selected commit without changing default exact-source packages',()=>{
 const directory=mkdtempSync(join(tmpdir(),'room-instance-build-'));
 try{
  const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:repository,encoding:'utf8'}).trim();
  const destination=join(directory,'stamped'),buildId='synthetic-instance-build';
  assert.equal(createRuntimePackage({repository,commit,destination,buildId}).verified,true);
  const path=join(destination,'runtime-manifest.json'),manifest=JSON.parse(readFileSync(path,'utf8'));
  assert.deepEqual(manifest.build,{sourceRevision:commit,buildId});
  const version=readFileSync(join(destination,'server/version.mjs'),'utf8');
  assert.ok(version.includes(`SOURCE_REVISION = "${commit}"`));
  assert.ok(version.includes(`BUILD_ID = "${buildId}"`));
  manifest.build.sourceRevision='0'.repeat(40);writeFileSync(path,JSON.stringify(manifest));
  assert.throws(()=>verifyRuntimePackage(destination),/build/);
  const plain=join(directory,'plain');createRuntimePackage({repository,commit,destination:plain});
  assert.deepEqual(readFileSync(join(plain,'server/version.mjs')),execFileSync('git',['show',commit+':server/version.mjs'],{cwd:repository}));
  assert.equal(JSON.parse(readFileSync(join(plain,'runtime-manifest.json'),'utf8')).build,undefined);
  for(const buildId of ['unstamped','dev','bad"value',''])assert.throws(()=>createRuntimePackage({repository,commit,destination:join(directory,'invalid'),buildId}));
 }finally{rmSync(directory,{recursive:true,force:true});}
});
