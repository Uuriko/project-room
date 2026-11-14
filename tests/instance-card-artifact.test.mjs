import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPair, signCard, signCardJws, verifyCardSignature, verifyCardJws} from '../server/agent-card-signing.mjs';
import {signInstanceCardArtifact,verifyInstanceCardArtifact} from '../server/instance-card-artifact.mjs';
import {discoveryDoc,ROOM_ORIGIN} from '../server/agent-discovery.mjs';
import {instanceDiscoveryBody} from '../server/node-discovery-origin.mjs';
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
test('instance join guidance is origin-scoped before signing and cannot be replaced by a signed lobby assumption',()=>{
 const paths=['/.well-known/agent.json','/.well-known/agent-card.json'];
 const hosted=paths.map(path=>discoveryDoc(path).body);
 for(const input of fixtures){
  const artifact=signInstanceCardArtifact(input);
  const description=artifact.card.skills.find(skill=>skill.id==='join-existing-room').description;
  assert.equal(description.includes('project-room-lobby'),false);
  assert.ok(description.includes('ask the instance owner for the intended room'));
  assert.ok(description.includes('Pass the confirmed roomId explicitly'));
  assert.ok(description.includes(`this exact service origin (${input.origin})`));
  assert.ok(description.includes('never forward them to another host'));
  assert.ok(description.includes(input.origin+'/docs/agents'));
  assert.equal(description.includes(fixtures.find(other=>other!==input).origin),false);
  for(const path of paths){
   const unsigned=JSON.parse(instanceDiscoveryBody(discoveryDoc(path),input.origin));
   assert.equal(unsigned.skills.find(skill=>skill.id==='join-existing-room').description,description);
  }
  const changed=clone(artifact);
  changed.card.skills.find(skill=>skill.id==='join-existing-room').description='Join project-room-lobby without an invitation.';
  assert.equal(verifyInstanceCardArtifact(changed,input),false,'modified guidance invalidates the signatures');
  changed.card.cardSignature=signCard({agentId:input.agentId,card:changed.card,privateKey:input.privateKey});
  changed.card.signatures=[signCardJws({card:changed.card,privateKey:input.privateKey,keyId:input.keyId,jku:input.origin+'/.well-known/jwks.json'})];
  assert.equal(verifyCardSignature({agentId:input.agentId,card:changed.card,publicKey:input.publicKey,signature:changed.card.cardSignature}),true);
  assert.equal(verifyCardJws({card:changed.card,publicKey:input.publicKey,jws:changed.card.signatures[0]}),true);
  assert.equal(verifyInstanceCardArtifact(changed,input),false,'even re-signed guidance must match this build instance card');
 }
 paths.forEach((path,index)=>{
  assert.equal(discoveryDoc(path).body,hosted[index]);
  assert.equal(instanceDiscoveryBody(discoveryDoc(path),ROOM_ORIGIN),hosted[index]);
  assert.equal(instanceDiscoveryBody(discoveryDoc(path),undefined),hosted[index]);
 });
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
