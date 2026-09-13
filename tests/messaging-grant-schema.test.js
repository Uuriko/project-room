import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {MessagingReceiveGrants} from '../server/messaging-receive-grants.mjs';

test('receive grant database rejects malformed same-name tables and foreign schema without mutation',()=>{
  for(const sql of [
    'CREATE TABLE messaging_receive_grants_v1 (junk TEXT)',
    'CREATE TABLE unrelated (id TEXT)',
    'CREATE TABLE sqlitex_hidden (id TEXT)',
    `CREATE TABLE messaging_receive_grants_v1 (
      account_id TEXT, connection_id TEXT, revision INTEGER, auth_epoch INTEGER,
      provider TEXT, connection_revision INTEGER, state TEXT, expires_at INTEGER,
      at INTEGER, actor_session_revision INTEGER)`
  ]){
    const db=new DatabaseSync(':memory:');
    try{
      db.exec(sql);
      const before=db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all();
      assert.throws(()=>new MessagingReceiveGrants({db,store:{}}),/receive_grant_unconfirmed/);
      assert.deepEqual(db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all(),before);
    }finally{db.close();}
  }
});

test('canonical grant schema reopens but unexpected triggers are rejected',()=>{
  const db=new DatabaseSync(':memory:');
  try{
    new MessagingReceiveGrants({db,store:{}}).close();
    new MessagingReceiveGrants({db,store:{}}).close();
    db.exec('CREATE TRIGGER unexpected AFTER INSERT ON messaging_receive_grants_v1 BEGIN SELECT 1; END');
    assert.throws(()=>new MessagingReceiveGrants({db,store:{}}),/receive_grant_unconfirmed/);
  }finally{db.close();}
});
