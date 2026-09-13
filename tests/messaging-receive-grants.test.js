import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {rmSync} from 'node:fs';
import {join} from 'node:path';
import {createAcceptanceFixture} from '../scripts/acceptance-fixture.mjs';
import {MessagingReceiveGrants,MAX_RECEIVE_GRANT_MS} from '../server/messaging-receive-grants.mjs';
import {RoomStore} from '../server/store.mjs';

function fixture(t){
  const f=createAcceptanceFixture(),path=join(f.directory,'receive.sqlite'),db=new DatabaseSync(path);
  const account=f.store.accountForMember('commons','owner'),slot=f.store.createAccountSessionSlot();
  const auth=f.store.loginAccountSession(slot.token,f.store.issueAccountAccessKey(account.id),0);
  const session={token:slot.token,binding:auth.sessionBinding};
  const grants=new MessagingReceiveGrants({db,store:f.store});
  t.after(()=>{grants.close();db.close();f.store.close();rmSync(f.directory,{recursive:true,force:true});});
  const request={connectionId:'telegram-one',provider:'telegram',connectionRevision:1,expectedRevision:0,expiresAt:f.store.now()+60000};
  const binding=r=>({accountId:r.accountId,connectionId:r.connectionId,revision:r.revision,provider:r.provider,connectionRevision:r.connectionRevision});
  return {...f,db,path,account,session,sessionRevision:auth.sessionRevision,grants,request,binding};
}

test('receive grant is bounded, account-authorized, persistent and not a login credential',t=>{
  const f=fixture(t),before=f.store.room('commons').sequence;
  const grant=f.grants.issue(f.session,f.request);
  assert.equal(grant.state,'active');assert.equal(Object.isFrozen(grant),true);
  assert.equal(f.grants.withGrant(f.binding(grant),g=>g.provider),'telegram');
  assert.throws(()=>f.store.authenticateAccountSession(grant));
  const db=new DatabaseSync(f.path),reopened=new MessagingReceiveGrants({db,store:f.store});
  try{
    assert.equal(reopened.withGrant(f.binding(grant),g=>g.revision),1);
    const revoked=reopened.revoke(f.session,{connectionId:grant.connectionId,expectedRevision:1});
    assert.equal(revoked.state,'revoked');
    assert.throws(()=>f.grants.withGrant(f.binding(grant),()=>true),/unconfirmed/);
    assert.equal(f.db.prepare('SELECT count(*) n FROM messaging_receive_grants_v1').get().n,2);
    assert.equal(f.store.room('commons').sequence,before);
  }finally{reopened.close();db.close();}
});

test('grant rejects extra authority, wrong connection/provider/revision, expiry and account epoch changes',t=>{
  const f=fixture(t);
  for(const change of [{send:true},{expiresAt:f.store.now()-1},{expiresAt:f.store.now()+MAX_RECEIVE_GRANT_MS+10000},
    {provider:'signal'},{expectedRevision:1},{connectionRevision:0}])
    assert.throws(()=>f.grants.issue(f.session,{...f.request,...change}),/unconfirmed/);
  assert.throws(()=>f.grants.issue({...f.session,binding:'a'.repeat(64)},f.request),/unconfirmed/);
  const grant=f.grants.issue(f.session,f.request),binding=f.binding(grant);
  for(const change of [{provider:'sms'},{connectionRevision:2},{revision:2},{accountId:'foreign'},{send:true}])
    assert.throws(()=>f.grants.withGrant({...binding,...change},()=>true),/unconfirmed/);
  const realNow=f.store.now;f.store.now=()=>grant.expiresAt;
  assert.throws(()=>f.grants.withGrant(binding,()=>true),/unconfirmed/);f.store.now=realNow;
  f.store.db.prepare('UPDATE accounts SET auth_epoch=auth_epoch+1 WHERE id=?').run(f.account.id);
  assert.throws(()=>f.grants.withGrant(binding,()=>true),/unconfirmed/);
});

test('locked grant prevents concurrent revoke and rolls back receive work when authority expires mid-import',t=>{
  const f=fixture(t),grant=f.grants.issue(f.session,f.request),binding=f.binding(grant);
  const otherDb=new DatabaseSync(f.path),otherStore=new RoomStore(join(f.directory,'room.sqlite'));
  const other=new MessagingReceiveGrants({db:otherDb,store:otherStore});
  try{
    f.grants.withGrant(binding,()=>{
      assert.throws(()=>other.revoke(f.session,{connectionId:grant.connectionId,expectedRevision:1}),/unconfirmed/);
    });
    const before=f.store.account(f.account.id).revision,realNow=f.store.now;
    assert.throws(()=>f.grants.withGrant(binding,()=>{
      f.store.db.prepare('UPDATE accounts SET revision=revision+1 WHERE id=?').run(f.account.id);
      f.store.now=()=>grant.expiresAt;
    }),/unconfirmed/);
    f.store.now=realNow;
    assert.equal(f.store.account(f.account.id).revision,before);
    assert.throws(()=>f.grants.withGrant(binding,()=>Promise.resolve()),/unconfirmed/);
    assert.equal(f.grants.withGrant(binding,()=>true),true);
  }finally{other.close();otherDb.close();otherStore.close();}
});

test('renewal fences old grants; sign-out is distinct from account revocation and cannot renew authority',t=>{
  const f=fixture(t),first=f.grants.issue(f.session,f.request);
  const next=f.grants.issue(f.session,{...f.request,expectedRevision:1,connectionRevision:2});
  assert.throws(()=>f.grants.withGrant(f.binding(first),()=>true),/unconfirmed/);
  assert.equal(f.grants.withGrant(f.binding(next),()=>true),true);
  f.store.logoutAccountSession(f.session.token,f.sessionRevision);
  assert.throws(()=>f.grants.issue(f.session,{...f.request,expectedRevision:2}),/unconfirmed/);
  // Explicit background authorization survives sign-out, not deactivation.
  assert.equal(f.grants.withGrant(f.binding(next),()=>true),true);
  const account=f.store.account(f.account.id);
  f.store.changeAccountAccess(account.id,{expectedRevision:account.revision,active:false,reason:'fixture revoke'});
  assert.throws(()=>f.grants.withGrant(f.binding(next),()=>true),/unconfirmed/);
});
