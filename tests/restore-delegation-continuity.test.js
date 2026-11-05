import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {exportNdjsonText,replayNdjson} from '../server/room-export.mjs';
import {replayNdjsonInto,createBackupReplaySession} from '../server/restore-ndjson.mjs';
import {linkWithProof} from './helpers/link-with-proof.mjs';

for(const method of ['file','buffered','stream']) for(const invalidPending of [false,true]) {
  test(`${method} restore preserves delegation journal across cold open${invalidPending ? ' and retains invalid pending evidence' : ''}`, t=>{
    const directory=mkdtempSync(join(tmpdir(),'restore-delegation-'));
    const handles=[];
    t.after(()=>{for(const store of handles)try{store.close();}catch{}rmSync(directory,{recursive:true,force:true});});
    const source=new RoomStore(join(directory,'source.sqlite'));handles.push(source);
    source.initialize(initialRoom());
    const owner=source.issueAccessKey('commons','owner');
    const identity=source.identities.create('Synthetic delegate');
    linkWithProof(source,owner,'commons',identity,{displayName:'Synthetic delegate',permissions:['accept_work']});
    source.delegation.grant(owner,'commons',{identityId:identity.identityId});
    assert.equal(source.delegationJournal.verify().entries,1);
    if(invalidPending) {
      source.db.prepare('UPDATE membership_delegation_grants SET revoked_at=? WHERE room_id=? AND identity_id=?').run(Date.now(),'commons',identity.identityId);
      // Independent corruption: preserve this evidence, never erase it while restoring.
      source.db.exec('UPDATE membership_delegation_pending SET next_active=prior_active');
    }
    const expectedPending=source.db.prepare('SELECT * FROM membership_delegation_pending ORDER BY sequence').all();
    const ndjson=exportNdjsonText(source.db), filename=join(directory,'restored.sqlite');
    let restored;
    if(method==='file') {
      replayNdjson(ndjson,filename,{audit:'report'});
      if(!invalidPending){restored=new RoomStore(filename);handles.push(restored);}
    } else {
      restored=new RoomStore(filename);handles.push(restored);
      if(method==='buffered')replayNdjsonInto(ndjson,restored,{audit:'report'});
      else {const session=createBackupReplaySession(restored,{audit:'report'});session.writeText(ndjson);session.finish();}
    }
    if(invalidPending) {
      // Inspect with a raw read-only handle: RoomStore must refuse corrupt evidence.
      const db=new DatabaseSync(filename,{readOnly:true});
      try{assert.deepEqual(db.prepare('SELECT * FROM membership_delegation_pending ORDER BY sequence').all(),expectedPending);}finally{db.close();}
      restored?.close();
      assert.throws(()=>new RoomStore(filename),/Membership delegation journal requires operator reconciliation/);
      return;
    }
    assert.deepEqual(restored.db.prepare('SELECT * FROM membership_delegation_pending ORDER BY sequence').all(),expectedPending);
    restored.close();restored=new RoomStore(filename);handles.push(restored);
    assert.equal(restored.delegationJournal.verify().entries,1);
    assert.equal(restored.delegation.hasGrant('commons',identity.identityId),true);
    restored.delegation.revoke(owner,'commons',{identityId:identity.identityId});
    assert.equal(restored.delegationJournal.verify().entries,2,'ordinary delegation triggers and journal stay active after restore');
    assert.equal(restored.delegation.hasGrant('commons',identity.identityId),false);
  });
}
