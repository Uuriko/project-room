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

test('stamped package renders two independently pinned signed instances without starting a service',()=>{
 const directory=mkdtempSync(join(tmpdir(),'room-signed-runtime-render-'));
 try{
  const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:repository,encoding:'utf8'}).trim();
  const destination=join(directory,'stamped'),buildId='synthetic-signed-runtime-render';
  assert.equal(createRuntimePackage({repository,commit,destination,buildId}).verified,true);
  // Import the packaged modules in a fresh process: its version stamp and
  // module graph must come from the selected package, not this test checkout.
  const output=execFileSync(process.execPath,['--input-type=module','-e',`
   import assert from 'node:assert/strict';
   import {createHash} from 'node:crypto';
   import {generateKeyPair} from './server/agent-card-signing.mjs';
   import {signInstanceCardArtifact,verifyInstanceCardArtifact} from './server/instance-card-artifact.mjs';
   import {loadInstanceCardRuntime} from './server/instance-card-runtime.mjs';
   import {discoveryDoc,deployedInfo,ROOM_ORIGIN} from './server/agent-discovery.mjs';
   assert.equal(deployedInfo().revision,${JSON.stringify(commit)});
   assert.equal(deployedInfo().buildId,${JSON.stringify(buildId)});
   const hosted=discoveryDoc('/.well-known/agent.json').body;
   const instances=['alpha','beta'].map(name=>{
    const input={origin:'https://'+name+'.example.test',keyId:name+'-synthetic-ed25519',agentId:name+'-synthetic-instance',...generateKeyPair()};
    const {privateKey,...trustedPin}=input;
    const artifact=signInstanceCardArtifact(input);
    const runtime=loadInstanceCardRuntime({origin:input.origin,instanceCard:{artifactJson:JSON.stringify(artifact),trustedPin}});
    return {input,trustedPin,artifact,runtime};
   });
   for(const instance of instances){
    const {input,trustedPin,artifact,runtime}=instance;
    const other=instances.find(value=>value!==instance);
    assert.deepEqual(runtime.signatureState,{signed:true,signedRevision:${JSON.stringify(commit)},unsignedReason:null});
    const cardBody=runtime.body(discoveryDoc('/.well-known/agent.json'));
    assert.equal(runtime.body(discoveryDoc('/.well-known/agent-card.json')),cardBody);
    assert.deepEqual(JSON.parse(cardBody),artifact.card);
    assert.deepEqual(JSON.parse(runtime.body(discoveryDoc('/.well-known/jwks.json'))),artifact.jwks);
    assert.equal(verifyInstanceCardArtifact({schema:artifact.schema,card:JSON.parse(cardBody),jwks:artifact.jwks},trustedPin),true);
    assert.equal(cardBody.includes(input.privateKey),false);
    assert.equal(cardBody.includes(other.input.origin),false);
    const join=artifact.card.skills.find(skill=>skill.id==='join-existing-room').description;
    assert.ok(join.includes(input.origin+'/docs/agents'));
    assert.ok(join.includes('this exact service origin ('+input.origin+')'));
    assert.equal(join.includes('project-room-lobby'),false);
    for(const path of ['/llms.txt','/llms-full.txt','/SKILL.md','/join.txt']){
     const body=runtime.body(discoveryDoc(path));
     assert.ok(body.includes(input.origin),path);
     if(path!=='/join.txt'){
      assert.ok(body.includes(input.origin+'/mcp'),path);
      assert.ok(body.includes(input.origin+'/docs/agents'),path);
     }
     assert.equal(body.includes('project-room-lobby'),false,path);
     assert.equal(body.includes(other.input.origin),false,path);
    }
    const catalogBody=runtime.body(discoveryDoc('/.well-known/ard.json'));
    assert.equal(runtime.body(discoveryDoc('/.well-known/ai-catalog.json')),catalogBody);
    const catalog=JSON.parse(catalogBody);
    assert.equal(catalog.host.identifier,input.origin);
    const entry=catalog.entries.find(value=>value.type==='application/a2a-agent-card+json');
    assert.equal(entry.url,input.origin+'/.well-known/agent-card.json');
    assert.equal(entry.metadata.signed,true);
    assert.equal(entry.metadata.signatureKeyId,input.keyId);
    assert.equal(entry.metadata.unsignedReason,undefined);
    const index=JSON.parse(runtime.body(discoveryDoc('/.well-known/agent-skills/index.json')));
    assert.equal(index.skills[0].digest,'sha256:'+createHash('sha256').update(runtime.body(discoveryDoc('/SKILL.md'))).digest('hex'));
    assert.throws(()=>loadInstanceCardRuntime({origin:input.origin,instanceCard:{artifactJson:JSON.stringify(artifact),trustedPin:other.trustedPin}}),/Refusing instance card/);
    const changed=structuredClone(artifact);
    changed.card.skills.find(skill=>skill.id==='join-existing-room').description='Join project-room-lobby';
    assert.throws(()=>loadInstanceCardRuntime({origin:input.origin,instanceCard:{artifactJson:JSON.stringify(changed),trustedPin}}),/Refusing instance card/);
   }
   assert.equal(discoveryDoc('/.well-known/agent.json').body,hosted);
   assert.equal(JSON.parse(hosted).base_url,ROOM_ORIGIN);
   console.log(JSON.stringify({signedInstances:instances.length,sourceRevision:deployedInfo().revision,buildId:deployedInfo().buildId}));
  `],{cwd:destination,encoding:'utf8',maxBuffer:1024*1024});
  assert.deepEqual(JSON.parse(output.trim()),{signedInstances:2,sourceRevision:commit,buildId});
 }finally{rmSync(directory,{recursive:true,force:true});}
});
