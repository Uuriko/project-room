import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPair, signCardJws} from '../server/agent-card-signing.mjs';
import {signInstanceCardArtifact,verifyInstanceCardArtifact} from '../server/instance-card-artifact.mjs';
import {discoveryDoc,ROOM_ORIGIN} from '../server/agent-discovery.mjs';
const clone = value => JSON.parse(JSON.stringify(value));
const fixtures = ['alpha','beta'].map(name=>({origin:`https://${name}.example.test`, keyId:`${name}-ed25519-v1`,agentId:`${name}-instance`,...generateKeyPair()}));

test('two independent offline keys produce pinned origin-specific public artifacts',()=>{
 const hosted=discoveryDoc('/.well-known/agent.json').body;
 for(const input of fixtures){
  const artifact=signInstanceCardArtifact(input);
  const {privateKey,...pin}=input;
  assert.equal(verifyInstanceCardArtifact(artifact,pin),true);
  assert.equal(JSON.stringify(artifact).includes(privateKey),false);
  assert.equal(JSON.stringify(artifact).includes('privateKey'),false);
  assert.equal(artifact.card.publicKey,input.publicKey);
  assert.equal(artifact.jwks.keys[0].kid,input.keyId);
  assert.equal(verifyInstanceCardArtifact(artifact,fixtures.find(x=>x!==input)),false);
  for(const field of ['origin','keyId','agentId','publicKey']) assert.equal(verifyInstanceCardArtifact(artifact,{...pin,[field]:fixtures.find(x=>x!==input)[field]}),false,field);
 }
 assert.equal(discoveryDoc('/.well-known/agent.json').body,hosted);
 assert.throws(()=>signInstanceCardArtifact({...fixtures[0],origin:ROOM_ORIGIN}),/Hosted card/);
 assert.throws(()=>signInstanceCardArtifact({...fixtures[0],privateKey:fixtures[1].privateKey}),/does not match/);
});
test('mutations, foreign key discovery and wrong-origin re-signing are rejected offline',()=>{
 const input=fixtures[0], original=signInstanceCardArtifact(input);
 for(const mutate of [
  a=>a.card.endpoints.mcp='https://attacker.example/mcp',
  a=>a.card.description+=' changed', a=>a.card.skills[0].name+=' changed',
  a=>a.card.signedRevision='different', a=>a.card.signatureAgentId='different',
  a=>a.card.cardSignature=fixtures[1].publicKey,
  a=>a.jwks.keys[0].x=fixtures[1].publicKey,
  a=>a.card.signatures[0].signature='AA', a=>a.extra='unexpected',
  a=>a.card.signatures[0]=signCardJws({card:a.card,privateKey:input.privateKey,keyId:input.keyId,jku:'https://attacker.example/keys'}),
  a=>{a.card.endpoints.mcp='https://attacker.example/mcp';a.card.signatures=[signCardJws({card:a.card,privateKey:input.privateKey,keyId:input.keyId,jku:input.origin+'/.well-known/jwks.json'})];}
 ]){const altered=clone(original);mutate(altered);assert.equal(verifyInstanceCardArtifact(altered,input),false);}
 assert.equal(verifyInstanceCardArtifact(null,input),false);
});

test('strict schema rejects canonicalization omissions and unsigned signature-entry extras',()=>{
 const input=fixtures[0], original=signInstanceCardArtifact(input);
 for(const path of [[],['card'],['card','capabilities'],['card','skills',0],['card','signatures',0],['jwks'],['jwks','keys',0]]) {
  for(const key of ['__proto__','constructor','prototype','unexpected']) {
   const changed=clone(original);let target=changed;
   for(const segment of path) target=target[segment];
   // Use JSON-parsed own property, not object-literal prototype syntax.
   Object.defineProperty(target,key,{value:{injected:'must be rejected'},enumerable:true,writable:true,configurable:true});
   assert.equal(verifyInstanceCardArtifact(clone(changed),input),false,`${path.join('.')}.${key}`);
  }
 }
 for(const value of [{privateKey:'secret-like extra'}, {header:{foo:'bar'}}, {signature:original.card.signatures[0].signature+'='}]) {
  const changed=clone(original);Object.assign(changed.card.signatures[0],value);
  assert.equal(verifyInstanceCardArtifact(changed,input),false);
 }
 const changed=clone(original);changed.card.cardSignature+='\n';
 assert.equal(verifyInstanceCardArtifact(changed,input),false,'legacy envelope mutation remains covered by JWS');
});
