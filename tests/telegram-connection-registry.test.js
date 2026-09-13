import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelegramConnectionRegistry } from '../server/telegram-connection-registry.mjs';
const key=Buffer.alloc(32,8),binding={accountId:'a',connectionId:'tg-one',authEpoch:0};
const config={...binding,expectedRevision:0,botId:'123456',token:'123456:abcdefghijklmnopqrstuvwxyz',chatIds:[44]};

test('encrypted configuration survives restart; disconnect tombstone fences stale reconnect',t=>{
  const dir=mkdtempSync(join(tmpdir(),'tg-registry-')),path=join(dir,'private.sqlite');t.after(()=>rmSync(dir,{recursive:true,force:true}));
  let db=new DatabaseSync(path),registry=new TelegramConnectionRegistry({db,key});
  assert.deepEqual(registry.configure(config),{state:'active',revision:1});db.close();
  assert.equal(readFileSync(path).includes(Buffer.from(config.token)),false);
  db=new DatabaseSync(path);t.after(()=>db.close());registry=new TelegramConnectionRegistry({db,key});
  assert.equal(registry.grant(binding).token,config.token);
  assert.deepEqual(registry.status({...binding,authEpoch:1}),{state:'reauthorize',revision:1});
  assert.throws(()=>registry.grant({...binding,authEpoch:1}));
  registry.disconnect({...binding,expectedRevision:1});assert.throws(()=>registry.grant(binding));
  assert.equal(db.prepare('SELECT ciphertext FROM telegram_connections_v1').get().ciphertext,null);
  assert.throws(()=>registry.configure({...config,expectedRevision:1}));
  assert.equal(registry.configure({...config,expectedRevision:2}).revision,3);
});

test('bot ownership, account epoch, key integrity and grant locking',t=>{
  const dir=mkdtempSync(join(tmpdir(),'tg-registry-')),path=join(dir,'private.sqlite');
  const db=new DatabaseSync(path),other=new DatabaseSync(path);t.after(()=>{db.close();other.close();rmSync(dir,{recursive:true,force:true});});
  const registry=new TelegramConnectionRegistry({db,key}),second=new TelegramConnectionRegistry({db:other,key});registry.configure(config);
  assert.throws(()=>second.configure({...config,accountId:'b'}));
  assert.throws(()=>registry.grant({...binding,accountId:'b'}));
  assert.throws(()=>new TelegramConnectionRegistry({db:other,key:Buffer.alloc(32,9)}).grant(binding));
  registry.withGrant(binding,grant=>{assert.equal(grant.active,true);assert.throws(()=>second.disconnect({...binding,expectedRevision:1}));});
  assert.equal(registry.status(binding).state,'active');second.disconnect({...binding,expectedRevision:1});
  assert.throws(()=>registry.withGrant(binding,()=>true));
});
