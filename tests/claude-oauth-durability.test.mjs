import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {bindingFixture,resource} from './helpers/oauth-binding-context-fixture.mjs';
import {resolveMcpOAuthPrincipal,mcpOAuthPrincipalDescriptor,authorizeMcpOAuthDescriptor} from '../server/mcp-oauth.mjs';

test('owned-agent grant descriptors retain exact principal type and fresh authority',t=>{
 const f=bindingFixture(t,0,{canonical:false}),binding={...f.binding,principalType:'account-owned-agent',accountEpoch:String(f.store.db.prepare('SELECT auth_epoch FROM accounts WHERE id=?').get(f.accountId).auth_epoch)};
 const verifier='v'.repeat(43),clientId='binding-context-test',redirectUri='https://client.example/callback';
 const {code}=f.provider.issueCode({clientId,userId:f.accountId,redirectUri,scopes:['rooms:read','chat:read'],codeChallenge:createHash('sha256').update(verifier).digest('base64url'),binding});
 const tokens=f.provider.exchangeCode({code,clientId,redirectUri,codeVerifier:verifier,resource});
 const principal=resolveMcpOAuthPrincipal({store:f.store,provider:f.provider,token:tokens.accessToken,resource,roomId:'commons'});
 assert.equal(principal.principalType,'account-owned-agent');const descriptor=mcpOAuthPrincipalDescriptor(principal);
 const authorize=descriptor=>authorizeMcpOAuthDescriptor({store:f.store,accountProvider:f.provider,resource,descriptor});
 assert.equal(authorize(descriptor).memberId,binding.memberId);
 assert.equal(authorize({...descriptor,principalType:'account-agent'}),null,'a descriptor cannot relabel a grant');
 assert.equal(authorize({...f.descriptor,principalType:'account-owned-agent'}),null,'old grants do not acquire new principal semantics');
 f.provider.revoke(tokens.refreshToken);assert.equal(authorize(descriptor),null);
});
