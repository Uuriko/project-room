import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {replayCutoverSchema,captureReplayWitness,advanceReplayWitness,partitionReplayWitness,qualifyReplayHWork,qualifyReplayHMessages,advanceCurrentRoomConversion} from '../server/replay-cutover.mjs';
import {auditRecovery} from '../server/recovery.mjs';
import {createOAuthProvider} from '../server/oauth-provider.mjs';
import {validateMcpOAuthBinding,mcpOAuthIdentityEpoch} from '../server/mcp-oauth.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
test('retained owner and friend connection journals verify after normalized activation and cold reopen',t=>{
 const dir=mkdtempSync(join(tmpdir(),'normalized-connections-')),file=join(dir,'room.sqlite');let store=new RoomStore(file),now=Date.now();store.now=()=>now;
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const identities={};let accountId,grant,binding,invited;
 store.initialize(initialRoom('legacy-room'));const key=store.issueAccessKey('legacy-room','owner');
 ((s)=>{
  const owner=s.createSession(key);
  const ownerAccount=s.db.prepare("SELECT account_id FROM member_accounts WHERE room_id='legacy-room' AND member_id='owner'").get().account_id;
  const ownerSlot=s.createAccountSessionSlot(),ownerAuth=s.loginAccountSession(ownerSlot.token,s.issueAccountAccessKey(ownerAccount),0);
  s.createAccount('invited-account');const invitedSlot=s.createAccountSessionSlot(),invitedAuth=s.loginAccountSession(invitedSlot.token,s.issueAccountAccessKey('invited-account'),0),invitationToken=randomBytes(32).toString('base64url');
  s.issueInvitation(ownerSlot.token,'legacy-room',{requestId:'human-invitation',token:invitationToken,intendedAccountId:'invited-account',intendedMemberId:'invited-human',displayName:'Invited Human',role:'member',expiresAt:now+3600000,expectedIssuerMemberRevision:0,expectedSessionBinding:ownerAuth.sessionBinding});
  s.acceptInvitation(invitedSlot.token,invitationToken,{redemptionId:randomUUID(),expectedRevision:0,expectedSessionBinding:invitedAuth.sessionBinding});
  invited={token:invitedSlot.token,binding:invitedAuth.sessionBinding};
  s.command(key,'legacy-room',{id:'human-sponsor',type:'member.added',data:{memberId:'human-sponsor',displayName:'Human Sponsor',kind:'human',permissions:['steer','accept_work','complete_work','verify']}});
  const friend=s.createSession(s.issueAccessKey('legacy-room','human-sponsor'));
  for(const [id,session] of [['owner-agent',owner],['friend-agent',friend],['revoked-friend',friend],['expired-friend',friend]]){
   const displayName=({'owner-agent':'Vega','friend-agent':'Lyra','revoked-friend':'Aster','expired-friend':'Altair'})[id],identity=s.identities.create(displayName),proof=s.identities.mintLinkCode(identity.identityId,identity.secret,{roomId:'legacy-room'});identities[id]=identity;
   s.agentConnections.apply(session.token,'legacy-room',{action:'create',requestId:'create-'+id,memberId:id,displayName,access:'collaborate',expectedOwnerRevision:0,keyHash:hash(id+'-scoped-fixture'),expiresAt:now+(id==='expired-friend'?1000:3600000),identityId:identity.identityId,identityLinkCode:proof.linkCode},session.session.sessionBinding);
  }
  s.agentConnections.revokeMember('legacy-room','revoked-friend');
  assert.equal(s.identities.resolveIdentityLink(identities['revoked-friend'].identityId,'legacy-room'),null);
  accountId=s.db.prepare("SELECT account_id FROM member_accounts WHERE room_id='legacy-room' AND member_id='owner'").get().account_id;
  binding={resource:'https://room.example/mcp',roomId:'legacy-room',identityId:identities['owner-agent'].identityId,memberId:'owner-agent',humanMemberId:'owner',identityEpoch:mcpOAuthIdentityEpoch(s,identities['owner-agent'].identityId)};
  const provider=createOAuthProvider({db:s.db,clock:()=>now,isBindingActive:(id,value)=>!!validateMcpOAuthBinding(s,id,value)});provider.registerClient({clientId:'existing',name:'Existing fixture',redirectUris:['https://client.example/callback']});
  const code=provider.issueCode({clientId:'existing',userId:accountId,redirectUri:'https://client.example/callback',scopes:['chat:read'],codeChallenge:createHash('sha256').update('v'.repeat(43)).digest('base64url'),binding}).code;
  grant=provider.exchangeCode({code,clientId:'existing',redirectUri:'https://client.example/callback',codeVerifier:'v'.repeat(43),resource:binding.resource});
 })(store);
 const snapshot=()=>({connections:store.db.prepare('SELECT * FROM agent_connections ORDER BY member_id').all(),operations:store.db.prepare('SELECT * FROM agent_connection_operations ORDER BY member_id,generation').all(),accounts:store.db.prepare('SELECT * FROM member_accounts ORDER BY member_id').all(),links:store.db.prepare('SELECT * FROM identity_links ORDER BY member_id').all(),credentials:store.db.prepare('SELECT * FROM credentials ORDER BY hash').all(),invitations:store.db.prepare('SELECT * FROM membership_invitations ORDER BY id').all(),invitationJournal:store.db.prepare('SELECT * FROM membership_invitation_journal ORDER BY invitation_id,sequence').all()});
 const originalAuthority=snapshot();
 assert.doesNotThrow(()=>auditRecovery(store));
 store.db.exec(replayCutoverSchema({durable:false}));
 const captured=captureReplayWitness(store,{roomId:'legacy-room',requestId:'connection-current',expectedHead:store.headSequence('legacy-room'),reason:'Retained auth qualification'}),base={roomId:'legacy-room',generation:captured.generation};
 const phases=[
  [advanceReplayWitness,{bytes:0},r=>r.phase==='witness_verified',r=>({expectedBytes:r.bytes})],
  [partitionReplayWitness,{bytes:0},r=>r.phase==='codec_partitioned',r=>({expectedBytes:r.bytes})],
  [qualifyReplayHWork,{workCount:0},r=>r.workDefaultsQualified,r=>({expectedWorkCount:r.workCount})],
  [qualifyReplayHMessages,{hMessageSteps:0},r=>r.hMessagesQualified,r=>({expectedSteps:r.hMessageSteps})],
  [advanceCurrentRoomConversion,{currentSteps:0},r=>r.phase==='current_serving',r=>({expectedSteps:r.currentSteps})]];
 for(const [i,[advance,initial,complete,cursor]] of phases.entries()){let result=initial,n=0;do{assert.ok(n<200);result=advance(store,{...base,requestId:`connection-phase-${i}-${n++}`,...cursor(result)});}while(!complete(result));}
 const before=snapshot();assert.deepEqual(before,originalAuthority);
 const roomRead=store.room;store.room=()=>{throw Error('unexpected full-room hydration');};
 try{assert.doesNotThrow(()=>store.agentConnections.verifyHistory());}finally{store.room=roomRead;}
 assert.doesNotThrow(()=>auditRecovery(store));
 assert.ok(store.identities.resolveIdentityLink(identities['friend-agent'].identityId,'legacy-room'));assert.equal(store.identities.resolveIdentityLink(identities['revoked-friend'].identityId,'legacy-room'),null);
 now+=2000;assert.equal(store.identities.resolveIdentityLink(identities['expired-friend'].identityId,'legacy-room'),null);
 store.close();store=new RoomStore(file);store.now=()=>now;
 assert.doesNotThrow(()=>store.agentConnections.verifyHistory());assert.doesNotThrow(()=>auditRecovery(store));assert.deepEqual(snapshot(),before);
 assert.equal(store.authenticateAccountSession(invited.token,'legacy-room',invited.binding).member.id,'invited-human');assert.doesNotThrow(()=>store.verifyInvitationAudit());
 const prepare=store.db.prepare.bind(store.db);
 for(const prefix of [false,true]){
  store.db.prepare=sql=>{
   const statement=prepare(sql),match=prefix?sql.includes('SELECT body FROM events WHERE room_id=? AND sequence<=?'):sql.includes('SELECT * FROM events WHERE room_id=? AND id=?');
   if(!match)return statement;
   return new Proxy(statement,{get(target,key){const fn=Reflect.get(target,key,target);
    if(key===(prefix?'all':'get'))return(...args)=>{
     const result=fn.apply(target,args),damage=row=>{if(!row)return row;const e=JSON.parse(row.body);
      if(prefix&&e.type==='member.added'&&e.data.memberId==='human-sponsor')return {...row,body:JSON.stringify({...e,data:{...e.data,permissions:[]}})};
      if(!prefix&&e.type==='member.added'&&e.data.memberId==='owner-agent')return {...row,body:JSON.stringify({...e,data:{...e.data,accountableHumanId:'unrelated'}})};
      return row;};return prefix?result.map(damage):damage(result);
    };return typeof fn==='function'?fn.bind(target):fn;}});
  };
  try{assert.throws(()=>store.agentConnections.verifyHistory(),e=>e.code==='connection_integrity_error');}finally{store.db.prepare=prepare;}
 }
 assert.ok(validateMcpOAuthBinding(store,accountId,binding));const provider=createOAuthProvider({db:store.db,clock:()=>now,isBindingActive:(id,value)=>!!validateMcpOAuthBinding(store,id,value)});
 const next=provider.refresh({refreshToken:grant.refreshToken,clientId:'existing',resource:binding.resource});assert.equal(provider.verifyAccessToken(next.accessToken,{resource:binding.resource}).binding.memberId,'owner-agent');
 assert.equal(store.identities.resolveIdentityLink(identities['revoked-friend'].identityId,'legacy-room'),null);assert.equal(store.identities.resolveIdentityLink(identities['expired-friend'].identityId,'legacy-room'),null);
});
