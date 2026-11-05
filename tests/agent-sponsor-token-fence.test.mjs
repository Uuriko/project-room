import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {AccessRequests} from '../server/access-requests.mjs';
import {linkWithProof} from './helpers/link-with-proof.mjs';
import {createOAuthProvider} from '../server/oauth-provider.mjs';
import {createMcpInviteOAuth,inviteOAuthDatabase} from '../server/mcp-invite-oauth.mjs';
import {listMcpOAuthAgents,validateMcpOAuthBinding,validateMcpInviteOAuthBinding,mcpInviteOAuthIdentityEpoch,
  resolveMcpOAuthPrincipal,mcpOAuthPrincipalDescriptor,authorizeMcpOAuthDescriptor} from '../server/mcp-oauth.mjs';
const resource='https://room.example/mcp',callback='https://client.example/callback';
const client={clientId:'fence-test',name:'Fence test',redirectUris:[callback]},verifier='v'.repeat(43);
const challenge=createHash('sha256').update(verifier).digest('base64url');
const tables=['oauth_provider_codes','oauth_provider_access_tokens','oauth_provider_refresh_tokens','oauth_invite_codes','oauth_invite_access_tokens','oauth_invite_refresh_tokens','oauth_invite_grants'];
const snapshots=s=>tables.map(table=>({table,rows:s.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)?s.db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all():null}));
function setup(t){
 const directory=mkdtempSync(join(tmpdir(),'sponsor-fence-')),filename=join(directory,'room.sqlite');
 let store=new RoomStore(filename);store.initialize(initialRoom('commons'));
 t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 const owner=store.issueAccessKey('commons','owner');
 store.command(owner,'commons',{id:'john',type:'member.added',data:{memberId:'john',displayName:'John',kind:'human',permissions:[]}});
 const recipient=store.bindHumanAccount('commons','john'),sponsor=store.bindHumanAccount('commons','owner');
 const slot=store.createAccountSessionSlot(),auth=store.loginAccountSession(slot.token,store.issueAccountAccessKey(recipient.id),0);
 const identity=store.identities.create('Existing agent');linkWithProof(store,owner,'commons',identity,{permissions:['accept_work']});
 const accountProvider=()=>createOAuthProvider({db:store.db,clock:()=>store.now(),isAccountActive:id=>store.db.prepare('SELECT active FROM accounts WHERE id=?').get(id)?.active===1,isBindingActive:(id,binding)=>!!validateMcpOAuthBinding(store,id,binding)});
 const invitedProvider=()=>createOAuthProvider({db:inviteOAuthDatabase(store.db),tokenKind:'invite',clock:()=>store.now(),isBindingActive:(id,binding)=>!!validateMcpInviteOAuthBinding(store,id,binding)});
 const choices=identityId=>listMcpOAuthAgents(store,sponsor.id,resource,{preferredRoomId:'commons',preferredMemberId:identityId}).find(value=>value.binding.memberId===identityId).binding;
 const ask=memberId=>{const access=new AccessRequests(store);access.sponsorTransfers.request(slot.token,'commons',{memberId,requestId:'adopt-fence'},auth.sessionBinding);return()=>access.decide(owner,'commons','adopt-fence',{decision:'approve'});};
 return{get store(){return store;},owner,identity,recipient,sponsor,accountProvider,invitedProvider,choices,ask,
  reopen(){store.close();store=new RoomStore(filename);}};
}
function mint(provider,userId,binding){
 provider.registerClient(client);
 const issue=()=>provider.issueCode({clientId:client.clientId,userId,redirectUri:callback,scopes:['chat:read'],codeChallenge:challenge,binding}).code;
 const exchange=code=>provider.exchangeCode({code,clientId:client.clientId,redirectUri:callback,codeVerifier:verifier,resource});
 const tokens=exchange(issue());return{tokens,unused:issue(),exchange};
}
function descriptor(store,provider,tokens){
 const principal=resolveMcpOAuthPrincipal({store,provider,token:tokens.accessToken,resource,roomId:'commons'});assert.ok(principal);return mcpOAuthPrincipalDescriptor(principal);
}
function deny(provider,issued){
 assert.equal(provider.verifyAccessToken(issued.tokens.accessToken,{resource}),null);
 assert.throws(()=>provider.refresh({refreshToken:issued.tokens.refreshToken,clientId:client.clientId,resource}),/connection is no longer active/);
 assert.throws(()=>provider.exchangeCode({code:issued.unused,clientId:client.clientId,redirectUri:callback,codeVerifier:verifier,resource}),/connection is no longer active/);
}
test('approval fences real account code/access/refresh/descriptor after cold reopen without token-table walks',t=>{
 const f=setup(t),provider=f.accountProvider();
 const selected=mint(provider,f.sponsor.id,f.choices(f.identity.identityId));
 const other=f.store.identities.create('Unrelated agent');linkWithProof(f.store,f.owner,'commons',other,{permissions:['accept_work']});
 const unrelated=mint(provider,f.sponsor.id,f.choices(other.identityId));
 const beforeDescriptor=descriptor(f.store,provider,selected.tokens);
 createMcpInviteOAuth({store:f.store,clients:[client],resource});
 const decide=f.ask(f.identity.identityId),before=snapshots(f.store),prepare=f.store.db.prepare.bind(f.store.db),queries=[];
 f.store.db.prepare=sql=>{if(/oauth_(?:provider|invite)_(?:codes|access_tokens|refresh_tokens|grants)/.test(sql))queries.push(sql);return prepare(sql);};
 try{decide();}finally{f.store.db.prepare=prepare;}
 assert.deepEqual(queries,[],'approval must not select or rewrite unrelated token history');
 assert.deepEqual(snapshots(f.store),before,'all existing token/grant bytes remain unchanged; the protected consent marker is the invalidation authority');
 deny(provider,selected);assert.ok(provider.verifyAccessToken(unrelated.tokens.accessToken,{resource}));
 assert.equal(authorizeMcpOAuthDescriptor({store:f.store,accountProvider:provider,resource,descriptor:beforeDescriptor}),null);
 f.reopen();const cold=f.accountProvider();deny(cold,selected);
 assert.equal(authorizeMcpOAuthDescriptor({store:f.store,accountProvider:cold,resource,descriptor:beforeDescriptor}),null);
 assert.ok(cold.verifyAccessToken(unrelated.tokens.accessToken,{resource}));
});
test('invitation epochs fence prior grants after cold adoption while a current consent-bound grant remains valid',t=>{
 const f=setup(t),service=createMcpInviteOAuth({store:f.store,clients:[client],resource});
 const invitation=f.store.invites.create(f.owner,'commons',{profile:'contribute'});
 const {nonce}=service.begin(new URLSearchParams({client_id:client.clientId,redirect_uri:callback,scope:'chat:read',code_challenge:challenge,code_challenge_method:'S256',resource}));
 const url=new URL(service.approve(nonce,invitation.code,'Invited agent'));
 const tokens=service.provider.exchangeCode({code:url.searchParams.get('code'),clientId:client.clientId,redirectUri:callback,codeVerifier:verifier,resource});
 const grant=f.store.db.prepare('SELECT * FROM oauth_invite_grants').get();
 const binding={principalType:'invited-agent',invitationGrantId:grant.id,resource,roomId:'commons',identityId:grant.identity_id,memberId:grant.member_id,identityEpoch:grant.identity_epoch};
 const unused=service.provider.issueCode({clientId:client.clientId,userId:grant.id,redirectUri:callback,scopes:['chat:read'],codeChallenge:challenge,binding}).code;
 const prior=descriptor(f.store,service.provider,tokens),before=snapshots(f.store);
 f.ask(grant.member_id)();assert.deepEqual(snapshots(f.store),before);
 const issued={tokens,unused};deny(service.provider,issued);
 assert.equal(authorizeMcpOAuthDescriptor({store:f.store,inviteProvider:service.provider,resource,descriptor:prior}),null);
 f.reopen();const cold=f.invitedProvider();deny(cold,issued);
 assert.equal(authorizeMcpOAuthDescriptor({store:f.store,inviteProvider:cold,resource,descriptor:prior}),null);
 const epoch=mcpInviteOAuthIdentityEpoch(f.store,grant.identity_id,'commons');assert.notEqual(epoch,grant.identity_epoch);
 // A synthetic, explicitly authorized new issuer grant uses the SAME epoch
 // producer as approve(). This does not add an existing-seat invitation UI.
 const fresh={...grant,id:'fresh-current-grant',identity_epoch:epoch};
 f.store.db.prepare('INSERT INTO oauth_invite_grants(id,room_id,identity_id,member_id,identity_epoch,invite_hash,sponsor_member_id,created_at,expires_at,revoked_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(...Object.values(fresh));
 const nextBinding={...binding,invitationGrantId:fresh.id,identityEpoch:epoch};
 const next=mint(cold,fresh.id,nextBinding);assert.ok(cold.verifyAccessToken(next.tokens.accessToken,{resource}));
 assert.ok(cold.refresh({refreshToken:next.tokens.refreshToken,clientId:client.clientId,resource}));
 assert.equal(cold.verifyAccessToken(tokens.accessToken,{resource}),null,'fresh issuance never revives old consent');
});
