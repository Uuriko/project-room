import { createHash } from 'node:crypto';
import { CurrentEventsRoom } from './current-events-worker.test-fixture.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createMcpInviteOAuth } from '../server/mcp-invite-oauth.mjs';
const resource='https://room.example/mcp', clients=[{clientId:'native-test',name:'Native test',redirectUris:['https://client.example/callback']}];
export class ExistingSeatRoom extends CurrentEventsRoom {
 async fetch(request){
  try {
   const s=this.store, oauth=createMcpInviteOAuth({store:s,clients,resource}), path=new URL(request.url).pathname;
   if(path==='/seed'){
    s.initialize(initialRoom());const owner=s.issueAccessKey('commons','owner'),identity=s.identities.create('Agent');
    const invite=s.invites.create(owner,'commons',{profile:'member'}),joined=s.invites.redeem(invite.code,{identitySecret:identity.secret,displayName:'Agent'});
    const nonce=oauth.begin(new URLSearchParams({client_id:'native-test',redirect_uri:clients[0].redirectUris[0],scope:'rooms:read',code_challenge:createHash('sha256').update('v'.repeat(43)).digest('base64url'),code_challenge_method:'S256',resource})).nonce;
    const proof=oauth.existingSeatProof(),reference=proof.createHandoff(nonce),view=proof.inspect(reference,identity.secret,'commons');
    proof.approve(reference,identity.secret,'commons',view.requestHash);
    const code=new URL(oauth.approveExisting(nonce)).searchParams.get('code');
    const token=oauth.provider.exchangeCode({code,clientId:'native-test',redirectUri:clients[0].redirectUris[0],codeVerifier:'v'.repeat(43),resource});
    await this.ctx.storage.put('fixture',{token:token.accessToken,memberId:joined.memberId,identityId:identity.identityId});
    return Response.json({ok:true});
   }
   const saved=await this.ctx.storage.get('fixture');
   if(path==='/revoke')s.db.prepare('UPDATE agent_identities SET revoked_at=? WHERE identity_id=?').run(Date.now(),saved.identityId);
   const valid=oauth.provider.verifyAccessToken(saved.token,{resource});
   return Response.json({valid:Boolean(valid),sameMember:valid?.binding?.memberId===saved.memberId});
  }catch(error){return Response.json({error:error.message},{status:500});}
 }
}
export default {fetch(request,env){return env.ROOM.getByName('existing-seat').fetch(request);}};
