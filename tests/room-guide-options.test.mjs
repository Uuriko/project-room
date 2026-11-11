import test from 'node:test';import assert from 'node:assert/strict';
import {installGuideCommandHook} from '../server/room-guide.mjs';
import {RoomStore} from '../server/store.mjs';
import {seedNormalizationAuth,normalizationAuthFacts} from './helpers/operator-normalization-auth-source.mjs';
test('guide wrapper preserves every command argument, option identity, return and thrown error',()=>{
 class Probe{command(...args){this.received=args;if(this.failure)throw this.failure;return this.result;}}
 const probe=new Probe(),options={agentConnectionSponsor:true,listenerToken:{opaque:'existing-listener-fence'}},extra={futureInternalContext:true},args=['credential',null,{id:'command'},null,options,extra];probe.result={committed:true};installGuideCommandHook(probe);
 assert.equal(probe.command(...args),probe.result);assert.deepEqual(probe.received,args);assert.equal(probe.received[4],options);assert.equal(probe.received[5],extra);
 const failure=Error('original refusal');probe.failure=failure;assert.throws(()=>probe.command(...args),error=>error===failure);assert.deepEqual(probe.received,args);
});
test('installed production guide hook preserves existing nonowner account-sponsored agent authority',t=>{
 const s=new RoomStore(':memory:');t.after(()=>s.close());installGuideCommandHook(s);const f=seedNormalizationAuth(s),facts=normalizationAuthFacts(s,f);
 assert.equal(facts.active['active-friend'],'active-friend');assert.equal(facts.active['revoked-friend'],null);assert.equal(s.roomAuthority('commons').members.human.permissions.includes('invite_member'),false);
 assert.equal(s.agentConnections.friendSponsored(s.agentConnections.row('commons','active-friend')),true);
});
