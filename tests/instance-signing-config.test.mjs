import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readInstanceCardFiles } from '../server/instance-card-files.mjs';
import { loadInstanceCardRuntime } from '../server/instance-card-runtime.mjs';
import { signInstanceCardArtifact } from '../server/instance-card-artifact.mjs';
import { generateKeyPair } from '../server/agent-card-signing.mjs';
test('instance file configuration is explicit, bounded and public-only; incomplete paths fail closed',()=>{
 const directory=mkdtempSync(join(tmpdir(),'room-public-signing-input-'));
 try{
  assert.equal(readInstanceCardFiles({}),undefined);
  const artifact=join(directory,'artifact.json'),pin=join(directory,'pin.json');
  writeFileSync(artifact,'{}');writeFileSync(pin,JSON.stringify({origin:'https://alpha.example'}));
  const env={ROOM_INSTANCE_CARD_PATH:artifact,ROOM_INSTANCE_CARD_PIN_PATH:pin};
  assert.deepEqual(readInstanceCardFiles(env),{artifactJson:'{}',trustedPin:{origin:'https://alpha.example'}});
  for(const invalid of [{ROOM_INSTANCE_CARD_PATH:artifact},{ROOM_INSTANCE_CARD_PIN_PATH:pin},{...env,ROOM_INSTANCE_CARD_PATH:'relative.json'},{...env,ROOM_INSTANCE_CARD_PATH:directory}])assert.throws(()=>readInstanceCardFiles(invalid));
  const link=join(directory,'link');symlinkSync(artifact,link);assert.throws(()=>readInstanceCardFiles({...env,ROOM_INSTANCE_CARD_PATH:link}));
  writeFileSync(artifact,'x'.repeat(262145));assert.throws(()=>readInstanceCardFiles(env));
  writeFileSync(artifact,'{}');writeFileSync(pin,'x'.repeat(8193));assert.throws(()=>readInstanceCardFiles(env));
 }finally{rmSync(directory,{recursive:true,force:true});}
});
test('unstamped checkout cannot satisfy signed production setup with a valid offline signature',()=>{
 const input={origin:'https://alpha.example',keyId:'synthetic-alpha',agentId:'synthetic-instance',...generateKeyPair()};
 const {privateKey,...trustedPin}=input;
 const artifactJson=JSON.stringify(signInstanceCardArtifact(input));
 assert.equal(artifactJson.includes(privateKey),false);
 assert.throws(()=>loadInstanceCardRuntime({origin:input.origin,instanceCard:{artifactJson,trustedPin}}),/Refusing instance card/);
});
