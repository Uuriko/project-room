// Synthetic account/identity credentials remain inside the local qualification fixture.
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {initialRoom} from '../../server/bootstrap.mjs';
import {createOAuthProvider} from '../../server/oauth-provider.mjs';
import {createMcpInviteOAuth} from '../../server/mcp-invite-oauth.mjs';
import {validateMcpOAuthBinding,mcpOAuthIdentityEpoch,resolveMcpOAuthPrincipal} from '../../server/mcp-oauth.mjs';
export const authResource='https://room.example/mcp';
const client={clientId:'preserved-fixture',name:'Preserved fixture',redirectUris:['https://client.example/callback']},verifier='v'.repeat(43);
const hash=x=>createHash('sha256').update(x).digest('hex');
const accountSession=(s,id)=>{const slot=s.createAccountSessionSlot(),auth=s.loginAccountSession(slot.token,s.issueAccountAccessKey(id),0);return{token:slot.token,binding:auth.sessionBinding};};
export function seedNormalizationAuth(s){
 s.initialize(initialRoom('commons'));const owner=s.issueAccessKey('commons','owner'),roomSession=s.createSession(owner),ownerAccount=s.db.prepare("SELECT account_id FROM member_accounts WHERE room_id='commons' AND member_id='owner'").get().account_id,ownerAccountSession=accountSession(s,ownerAccount);
 s.createAccount('preserved-human');const human=accountSession(s,'preserved-human'),inviteToken=randomBytes(32).toString('base64url');
 s.issueInvitation(ownerAccountSession.token,'commons',{requestId:'preserved-invitation',token:inviteToken,intendedAccountId:'preserved-human',intendedMemberId:'human',displayName:'Invited Human',role:'member',expiresAt:s.now()+3600000,expectedIssuerMemberRevision:0,expectedSessionBinding:ownerAccountSession.binding});
 s.acceptInvitation(human.token,inviteToken,{redemptionId:randomUUID(),expectedRevision:0,expectedSessionBinding:human.binding});
 const identities={};
 for(const [id,name] of [['active-owner','Vega'],['active-friend','Lyra'],['revoked-friend','Aster'],['expired-friend','Altair'],['disconnected-friend','Orion']]){
  const identity=s.identities.create(name),proof=s.identities.mintLinkCode(identity.identityId,identity.secret,{roomId:'commons'}),session=id==='active-owner'?{token:roomSession.token,binding:roomSession.session.sessionBinding}:human;
  identities[id]=identity;
  s.agentConnections.apply(session.token,'commons',{action:'create',requestId:'create-'+id,memberId:id,displayName:name,access:'contribute',expectedOwnerRevision:0,keyHash:hash(id+'-synthetic-scoped'),expiresAt:s.now()+(id==='expired-friend'?1000:3600000),identityId:identity.identityId,identityLinkCode:proof.linkCode},session.binding);
 }
 s.agentConnections.revokeMember('commons','revoked-friend');
 s.agentConnections.apply(human.token,'commons',{action:'disconnect',requestId:'disconnect-orion',memberId:'disconnected-friend',expectedOwnerRevision:0,expectedGeneration:1,expectedMemberRevision:0},human.binding);
 const binding={resource:authResource,roomId:'commons',identityId:identities['active-owner'].identityId,memberId:'active-owner',humanMemberId:'owner',identityEpoch:mcpOAuthIdentityEpoch(s,identities['active-owner'].identityId)};
 const provider=createOAuthProvider({db:s.db,clock:()=>s.now(),isBindingActive:(id,value)=>!!validateMcpOAuthBinding(s,id,value)});provider.registerClient(client);
 const request={clientId:client.clientId,redirectUri:client.redirectUris[0],scopes:['chat:read'],codeChallenge:createHash('sha256').update(verifier).digest('base64url')};
 const code=provider.issueCode({...request,userId:ownerAccount,binding}).code,accountGrant=provider.exchangeCode({code,clientId:client.clientId,redirectUri:client.redirectUris[0],codeVerifier:verifier,resource:authResource});
 const native=createMcpInviteOAuth({store:s,clients:[client],resource:authResource}),invitation=s.invites.create(owner,'commons',{profile:'member'});
 const pending=native.begin(new URLSearchParams({client_id:client.clientId,redirect_uri:client.redirectUris[0],resource:authResource,scope:'chat:read',code_challenge:request.codeChallenge,code_challenge_method:'S256'}));
 const invitedCode=new URL(native.approve(pending.nonce,invitation.code,'Existing Dot')).searchParams.get('code'),inviteGrant=native.provider.exchangeCode({code:invitedCode,clientId:client.clientId,redirectUri:client.redirectUris[0],codeVerifier:verifier,resource:authResource});
 const baseNow=s.now();s.now=()=>baseNow+2000;
 return{owner,ownerAccount,human,identities,accountGrant,inviteGrant,baseNow};
}
export function normalizationAuthSnapshot(s){
 const tables=['credentials','accounts','account_credentials','account_session_slots','account_login_methods','member_accounts','agent_identities','identity_links','agent_key_registry','agent_api_keys','agent_connections','agent_connection_operations','membership_invitations','membership_invitation_events','membership_invitation_journal','oauth_provider_codes','oauth_provider_access_tokens','oauth_provider_refresh_tokens','oauth_invite_grants','oauth_invite_codes','oauth_invite_access_tokens','oauth_invite_refresh_tokens','events','commands'];
 return hash(JSON.stringify(tables.map(table=>[table,s.db.prepare(`SELECT * FROM ${table}`).all().map(row=>JSON.stringify(row)).sort()])));
}
export function normalizationAuthFacts(s,f,{refresh=false}={}){
 const attempt=fn=>{try{return fn();}catch{return null;}};
 const active=Object.fromEntries(Object.entries(f.identities).map(([id,value])=>[id,attempt(()=>s.authenticate(value.secret,'commons').member.id)]));
 const provider=createOAuthProvider({db:s.db,clock:()=>s.now(),isBindingActive:(id,value)=>!!validateMcpOAuthBinding(s,id,value)}),native=createMcpInviteOAuth({store:s,clients:[client],resource:authResource});
 const account=resolveMcpOAuthPrincipal({store:s,provider,token:f.accountGrant.accessToken,resource:authResource,roomId:'commons'}),invited=resolveMcpOAuthPrincipal({store:s,provider:native.provider,token:f.inviteGrant.accessToken,resource:authResource,roomId:'commons'});
 const grants=refresh?{account:!!provider.refresh({refreshToken:f.accountGrant.refreshToken,clientId:client.clientId,resource:authResource}).accessToken,invited:!!native.provider.refresh({refreshToken:f.inviteGrant.refreshToken,clientId:client.clientId,resource:authResource}).accessToken}:null;
 return{active,human:s.authenticateAccountSession(f.human.token,'commons',f.human.binding).member.id,accountMember:account?.memberId,invitedMember:invited?.memberId,grants,ownerId:s.roomAuthority('commons').ownerId};
}
