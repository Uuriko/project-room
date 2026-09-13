import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {chmodSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {createAcceptanceFixture} from '../scripts/acceptance-fixture.mjs';
import {TelegramConnectionRegistry} from '../server/telegram-connection-registry.mjs';
import {TelegramReceiveQueue} from '../server/telegram-receive-queue.mjs';
import {MessagingReceiveGrants} from '../server/messaging-receive-grants.mjs';
import {RoomStore} from '../server/store.mjs';

test('entrypoint opts in after bind and drains a fixture poll on SIGTERM; default and bind failure never poll',async t=>{
  const f=createAcceptanceFixture(),dir=realpathSync(f.directory),key=Buffer.alloc(32,7);
  const account=f.store.accountForMember('commons','owner'),binding={accountId:account.id,connectionId:'one',authEpoch:0};
  const env={ROOM_TELEGRAM_ACCOUNT_ID:account.id,ROOM_TELEGRAM_CONNECTION_ID:'one',ROOM_TELEGRAM_REGISTRY_FILE:join(dir,'registry.sqlite'),
    ROOM_TELEGRAM_QUEUE_FILE:join(dir,'queue.sqlite'),ROOM_TELEGRAM_KEY_FILE:join(dir,'key'),ROOM_TELEGRAM_RECEIVE_GRANTS_FILE:join(dir,'grants.sqlite')};
  writeFileSync(env.ROOM_TELEGRAM_KEY_FILE,key,{mode:0o600});
  const rd=new DatabaseSync(env.ROOM_TELEGRAM_REGISTRY_FILE),registry=new TelegramConnectionRegistry({db:rd,key});
  registry.configure({...binding,expectedRevision:0,botId:'123456',token:'123456:abcdefghijklmnopqrstuvwxyz',chatIds:[44]});registry.close();rd.close();
  const qd=new DatabaseSync(env.ROOM_TELEGRAM_QUEUE_FILE);new TelegramReceiveQueue({db:qd,key,...binding});qd.close();
  const gd=new DatabaseSync(env.ROOM_TELEGRAM_RECEIVE_GRANTS_FILE),grants=new MessagingReceiveGrants({db:gd,store:f.store});
  const slot=f.store.createAccountSessionSlot(),auth=f.store.loginAccountSession(slot.token,f.store.issueAccountAccessKey(account.id),0);
  grants.issue({token:slot.token,binding:auth.sessionBinding},{connectionId:'one',provider:'telegram',connectionRevision:1,expectedRevision:0,expiresAt:f.store.now()+86400000});grants.close();gd.close();
  for(const name of ['ROOM_TELEGRAM_REGISTRY_FILE','ROOM_TELEGRAM_QUEUE_FILE','ROOM_TELEGRAM_RECEIVE_GRANTS_FILE'])chmodSync(env[name],0o600);
  f.store.close();t.after(()=>rmSync(f.directory,{recursive:true,force:true}));
  const script=`globalThis.fetch=async()=>{console.log('fixture-poll');await new Promise(r=>setTimeout(r,250));console.log('fixture-complete');return Response.json({ok:true,result:[{update_id:9,message:{message_id:9,chat:{id:44},from:{id:44},date:1700000000,text:'Lifecycle fixture'}}]});};await import('./server.mjs');`;
  for(const mode of ['default','enabled','collision']){
    const holder=createServer();await new Promise(r=>holder.listen(0,'127.0.0.1',r));const port=holder.address().port;
    if(mode!=='collision')await new Promise(r=>holder.close(r));
    const child=spawn(process.execPath,['--input-type=module','-e',script],{cwd:fileURLToPath(new URL('../',import.meta.url)),env:{
      NODE_ENV:'development',HOST:'127.0.0.1',PORT:String(port),ROOM_DB:join(dir,'room.sqlite'),...env,
      ...(mode==='default'?{}:{ROOM_TELEGRAM_POLL_INTERVAL_MS:'1000'})},stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
    const exit=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal}))),timer=setTimeout(()=>child.kill('SIGKILL'),10000);
    const waitFor=needle=>new Promise((resolve,reject)=>{
      const check=()=>{if(output.includes(needle)){clearInterval(poll);resolve();}};
      const poll=setInterval(check,10);child.once('exit',()=>{clearInterval(poll);reject(new Error(output));});check();
    });
    try{
      if(mode!=='collision'){
        await waitFor('Project Room local pilot:');
        if(mode==='enabled'){await waitFor('fixture-poll');assert.ok(!output.includes('fixture-complete'));}
        else await new Promise(r=>setTimeout(r,1100));
        child.kill('SIGTERM');
      }
      const ended=await exit;assert.equal(ended.code,mode==='collision'?1:0,output);
      if(mode==='enabled'){
        assert.ok(output.indexOf('Project Room local pilot:')<output.indexOf('fixture-poll'));
        assert.ok(output.includes('fixture-complete'));assert.equal(output.split('fixture-poll').length-1,1);
        assert.ok(!output.includes('database is not open'));
        const reopened=new RoomStore(join(dir,'room.sqlite'));try{assert.equal(reopened.inbox.verify().versions,1);}finally{reopened.close();}
      }else assert.ok(!output.includes('fixture-poll'));
      if(mode==='collision')assert.ok(!output.includes('Project Room local pilot:'));
    }finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exit;}if(holder.listening)await new Promise(r=>holder.close(r));}
  }
});
