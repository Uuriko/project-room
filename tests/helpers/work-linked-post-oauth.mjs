import {createHash} from 'node:crypto';
import {initialRoom} from '../../server/bootstrap.mjs';
import {event} from '../../src/events.js';
import {AccessRequests} from '../../server/access-requests.mjs';
import {linkWithProof} from './link-with-proof.mjs';
import {createOAuthProvider} from '../../server/oauth-provider.mjs';
import {listMcpOAuthAgents,validateMcpOAuthBinding,runMcpOAuthRequest} from '../../server/mcp-oauth.mjs';
export const resource='https://room.example/mcp';
export const client={clientId:'bounded-post-test',name:'Bounded post test',redirectUris:['https://client.example/callback']};
export function providerFor(store){return createOAuthProvider({db:store.db,clock:()=>store.now(),isBindingActive:(id,binding)=>!!validateMcpOAuthBinding(store,id,binding)});}
export function seedPostOAuth(store,{permissions=['accept_work'],scopes=['chat:write'],memberPermissions={}}={}){
 const identity=store.identities.create('Existing Claude'),events=initialRoom();
 for(const id of ['john','verifier','observer'])events.push(event({roomId:'commons',actorId:'owner',type:'member.added',data:{memberId:id,displayName:id,kind:id==='john'?'human':'agent',permissions:memberPermissions[id]??[]}}));
 store.initialize(events,{representation:'normalized-current-v1'});
 const owner=store.issueAccessKey('commons','owner');
 linkWithProof(store,owner,'commons',identity,{permissions});
 const account=store.bindHumanAccount('commons','john'),slot=store.createAccountSessionSlot();
 const auth=store.loginAccountSession(slot.token,store.issueAccountAccessKey(account.id),0),requests=new AccessRequests(store);
 requests.sponsorTransfers.request(slot.token,'commons',{memberId:identity.identityId,requestId:'adopt'},auth.sessionBinding);
 requests.decide(owner,'commons','adopt',{decision:'approve'});
 const binding=listMcpOAuthAgents(store,account.id,resource).find(c=>c.binding.memberId===identity.identityId).binding;
 const provider=providerFor(store);provider.registerClient(client);
 const verifier='v'.repeat(43),code=provider.issueCode({clientId:client.clientId,userId:account.id,redirectUri:client.redirectUris[0],scopes,codeChallenge:createHash('sha256').update(verifier).digest('base64url'),binding}).code;
 const tokens=provider.exchangeCode({code,clientId:client.clientId,redirectUri:client.redirectUris[0],codeVerifier:verifier,resource});
 store.command(owner,'commons',{id:'task',type:'work.proposed',data:{workItemId:'task',title:'Useful selected task',definitionOfDone:'Saved result',accountableMemberId:identity.identityId,verifierMemberId:'verifier',humanDecisionMakerId:'john'}});
 return {owner,identityId:identity.identityId,identitySecret:identity.secret,token:tokens.accessToken};
}
export function postWithOAuth(store,saved,data){return runMcpOAuthRequest({store,provider:providerFor(store),token:saved.token,resource,roomId:'commons'},()=>store.command(saved.token,'commons',{id:data.messageId,type:'message.posted',data}));}
