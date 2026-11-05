import { HttpTestRoom } from './http-worker.test-fixture.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { event } from '../src/events.js';
import { createHash } from 'node:crypto';
import { createOAuthProvider } from '../server/oauth-provider.mjs';
import { validateMcpOAuthBinding, mcpOAuthIdentityEpoch, runMcpOAuthRequest } from '../server/mcp-oauth.mjs';

export class OAuthBindingContextTestRoom extends HttpTestRoom {
  async fetch() {
    const store=this.store, history=initialRoom();
    for(let i=0;i<32;i++) history.push(event({id:`history-${i}`,type:'message.posted',roomId:'commons',actorId:'owner',
      at:'2026-11-01T12:00:00.000Z',data:{messageId:`history-${i}`,body:'Retained binding history'}}));
    store.maintainMessageCertification=true; store.initialize(history);
    const owner=store.issueAccessKey('commons','owner'),session=store.createSession(owner);
    const accountId=store.db.prepare("SELECT account_id FROM member_accounts WHERE room_id='commons' AND member_id='owner'").get().account_id;
    const identity=store.identities.create('Binding Agent');
    const {linkCode}=store.identities.mintLinkCode(identity.identityId,identity.secret,{roomId:'commons'});
    store.agentConnections.apply(session.token,'commons',{action:'create',requestId:'worker-binding-connection',memberId:'binding-agent',
      displayName:'Binding Agent',access:'collaborate',expectedOwnerRevision:0,expiresAt:store.now()+3600000,
      keyHash:createHash('sha256').update('worker-binding-credential').digest('hex'),identityId:identity.identityId,identityLinkCode:linkCode},session.session.sessionBinding);
    while(!store.backfillMessages({limit:1000}).done){}
    store.checkMessagesParity();store.migrateMessageAuthority('commons');store.maintainMessageCertification=false;
    const resource='https://room.example/mcp',client={clientId:'worker-binding',name:'Worker binding',redirectUris:['https://client.example/callback']};
    const verifier='v'.repeat(43),binding={resource,roomId:'commons',memberId:'binding-agent',identityId:identity.identityId,
      humanMemberId:'owner',identityEpoch:mcpOAuthIdentityEpoch(store,identity.identityId)};
    const provider=createOAuthProvider({db:store.db,isBindingActive:(id,value)=>Boolean(validateMcpOAuthBinding(store,id,value)),
      isAccountActive:id=>store.db.prepare('SELECT active FROM accounts WHERE id=?').get(id)?.active===1});
    provider.registerClient(client);
    const code=provider.issueCode({clientId:client.clientId,userId:accountId,redirectUri:client.redirectUris[0],scopes:['rooms:read','chat:read'],
      codeChallenge:createHash('sha256').update(verifier).digest('base64url'),binding}).code;
    const tokens=provider.exchangeCode({code,clientId:client.clientId,redirectUri:client.redirectUris[0],codeVerifier:verifier,resource});
    const authenticate=(target=resource)=>runMcpOAuthRequest({store,provider,token:tokens.accessToken,resource:target,roomId:'commons',requiredScopes:['rooms:read']},
      ()=>store.readTransaction(()=>store.authenticate(tokens.accessToken,'commons')));
    const room=store.room;let fullRoomReads=0;
    store.room=function(...args){fullRoomReads++;return room.apply(this,args);};
    const refused=target=>{try{authenticate(target);return false;}catch{return true;}};
    try{
      const principal=authenticate();
      const wrongResourceRefused=refused('https://other.example/mcp');
      const original=store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection;
      store.db.prepare("UPDATE rooms SET projection=json_set(projection,'$.room.title','Unproved') WHERE id='commons'").run();
      const corruptMetadataRefused=refused();
      store.db.prepare("UPDATE rooms SET projection=? WHERE id='commons'").run(original);
      provider.revoke(tokens.refreshToken);
      return Response.json({memberCorrect:principal.member.id==='binding-agent',fullRoomReads,wrongResourceRefused,
        corruptMetadataRefused,revokedFamilyRefused:refused()});
    }finally{store.room=room;}
  }
}
export default {fetch(request,env){return env.ROOM.getByName('oauth-binding-context').fetch(request);}};
