import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
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
test('artifact and pin FIFOs refuse without waiting for a writer',{skip:process.platform==='win32'},()=>{
 const directory=mkdtempSync(join(tmpdir(),'room-public-signing-fifo-'));
 try{
  const artifact=join(directory,'artifact.json'),pin=join(directory,'pin.json'),fifo=join(directory,'input.fifo');
  writeFileSync(artifact,'{}');writeFileSync(pin,'{}');
  execFileSync('mkfifo',[fifo]);
  for(const [label,artifactPath,pinPath] of [['artifact',fifo,pin],['pin',artifact,fifo]]){
   // A child deadline bounds a regression in synchronous openSync: a blocked
   // FIFO open cannot be interrupted by an in-process timer in the test.
   const child=spawnSync(process.execPath,['--input-type=module','-e',`
    const {readInstanceCardFiles}=await import(process.argv[1]);
    try{
     readInstanceCardFiles({ROOM_INSTANCE_CARD_PATH:process.argv[2],ROOM_INSTANCE_CARD_PIN_PATH:process.argv[3]});
     process.exitCode=2;
    }catch(error){
     if(!error.message.includes('bounded regular public artifact'))throw error;
     console.log('refused non-regular signing input');
    }
   `,new URL('../server/instance-card-files.mjs',import.meta.url).href,artifactPath,pinPath],
   {encoding:'utf8',timeout:5000,killSignal:'SIGKILL'});
   assert.equal(child.error,undefined,label+' must refuse before the child deadline');
   assert.equal(child.signal,null,label+' must exit normally');
   assert.equal(child.status,0,child.stderr);
   assert.equal(child.stdout.trim(),'refused non-regular signing input',label);
  }
 }finally{rmSync(directory,{recursive:true,force:true});}
});
test('unstamped checkout cannot satisfy signed production setup with a valid offline signature',()=>{
 const input={origin:'https://alpha.example',keyId:'synthetic-alpha',agentId:'synthetic-instance',...generateKeyPair()};
 const {privateKey,...trustedPin}=input;
 const artifactJson=JSON.stringify(signInstanceCardArtifact(input));
 assert.equal(artifactJson.includes(privateKey),false);
 assert.throws(()=>loadInstanceCardRuntime({origin:input.origin,instanceCard:{artifactJson,trustedPin}}),/Refusing instance card/);
});
