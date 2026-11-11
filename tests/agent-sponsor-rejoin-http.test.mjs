import test from 'node:test';
import {request} from 'node:http';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {linkWithProof} from './helpers/link-with-proof.mjs';
import {AccessRequests} from '../server/access-requests.mjs';
import {listMcpOAuthAgents,validateMcpOAuthBinding} from '../server/mcp-oauth.mjs';
import {createRoomServer} from '../server/http.mjs';
for (const representation of ['legacy', 'normalized-current-v1']) test(`adoption cannot follow a departed human into a new membership (${representation})`, async () => {
const s=new RoomStore(':memory:');s.initialize(initialRoom('commons'), representation === 'legacy' ? {} : {representation});
try{
 const owner=s.issueAccessKey('commons','owner');
 s.command(owner,'commons',{id:'john',type:'member.added',data:{memberId:'john',displayName:'John',kind:'human',permissions:[]}});
 const account=s.bindHumanAccount('commons','john'),slot=s.createAccountSessionSlot(),auth=s.loginAccountSession(slot.token,s.issueAccountAccessKey(account.id),0);
 const identity=s.identities.create('Existing Claude');linkWithProof(s,owner,'commons',identity,{permissions:['accept_work']});
 const access=new AccessRequests(s);access.sponsorTransfers.request(slot.token,'commons',{memberId:identity.identityId,requestId:'review-adoption'},auth.sessionBinding);access.decide(owner,'commons','review-adoption',{decision:'approve'});
 const resource='https://room.example/mcp',preference={preferredRoomId:'commons',preferredMemberId:identity.identityId};
 const original=listMcpOAuthAgents(s,account.id,resource,preference)[0].binding;
 assert.ok(validateMcpOAuthBinding(s,account.id,original));
 s.command(slot.token,'commons',{id:'leave',type:'member.access_changed',data:{memberId:'john',expectedMemberRevision:0,active:false,permissions:[]}},auth.sessionBinding);
 assert.equal(validateMcpOAuthBinding(s,account.id,original),null);
 const ownerAccount=s.authenticate(owner).account.id,ownerSlot=s.createAccountSessionSlot(),ownerAuth=s.loginAccountSession(ownerSlot.token,s.issueAccountAccessKey(ownerAccount),0),inviteToken=randomBytes(32).toString('base64url');
 s.issueInvitation(ownerSlot.token,'commons',{requestId:'review-rejoin',token:inviteToken,intendedAccountId:account.id,intendedMemberId:'john-rejoined',displayName:'John rejoined',role:'member',expiresAt:s.now()+3600000,expectedIssuerMemberRevision:0,expectedSessionBinding:ownerAuth.sessionBinding});
 s.acceptInvitation(slot.token,inviteToken,{redemptionId:randomUUID(),expectedRevision:0,expectedSessionBinding:auth.sessionBinding});
 const crafted={...original,humanMemberId:'john-rejoined'};
 const eligible=listMcpOAuthAgents(s,account.id,resource,preference);
 assert.equal(validateMcpOAuthBinding(s,account.id,original),null);
 assert.equal(eligible.length,0);
 const rejectedBinding=validateMcpOAuthBinding(s,account.id,crafted);
 const callback='https://client.example/callback',clientId='review-mcp';
 const server=createRoomServer({store:s,origin:'https://room.example',mcpOAuthClients:[{clientId,name:'Review MCP',redirectUris:[callback],...preference}]});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const current=s.authenticateAccountSession(slot.token),q={client_id:clientId,redirect_uri:callback,scope:'chat:read',code_challenge:createHash('sha256').update('v'.repeat(43)).digest('base64url'),code_challenge_method:'S256',resource,csrf_token:current.csrf,decision:'allow',agent_binding:JSON.stringify(crafted)};
  const send=(url,options)=>new Promise((resolve,reject)=>{const req=request(url,{method:options.method,headers:options.headers},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:res.headers})));});req.on('error',reject);req.end(options.body);});
  const codesBefore=s.db.prepare('SELECT count(*) n FROM oauth_provider_codes').get().n;
  const response=await send('http://127.0.0.1:'+server.address().port+'/oauth/authorize',{method:'POST',redirect:'manual',headers:{Host:'room.example',Origin:'https://room.example',Cookie:'__Host-account_session='+slot.token,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(q).toString()});
  const location=response.headers.get('location');
  assert.equal(response.status,302);
  assert.equal(new URL(location).searchParams.get('error'),'access_denied');
  assert.equal(s.db.prepare('SELECT count(*) n FROM oauth_provider_codes').get().n,codesBefore,'denial writes no authorization code');
  assert.equal(location ? new URL(location,'https://room.example').searchParams.has('code') : false,false,'a former adoption must not issue a code for a new member');
  assert.equal(rejectedBinding,null,'the provider binding validator independently rejects the substituted recipient');
  assert.equal(s.roomAuthority('commons',{memberId:identity.identityId}).members[identity.identityId].accountableHumanId,'john');
 }finally{server.closeStreams();server.closeAllConnections();await new Promise(r=>server.close(r));}
}finally{s.close();}

});
