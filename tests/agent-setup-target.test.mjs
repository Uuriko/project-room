import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupTarget, connectRoom } from '../client/agent-setup.mjs';
const origin = 'https://independent.example', code = 'ABC-DEF-GHJ', token = 'a'.repeat(43);
const bad = [
 `/?code=${code}#room/commons`, `/?code=${code}#code=${code}`,
 `/?code=${code}&code=JKM-NPQ-RST`, `/x/${code}?code=JKM-NPQ-RST`,
 `/#code/${code}/unrecognized`, `/#code/${code}/work/task/extra`,
 `/#code/${code}/work/task/`, `/#join/${token}/work/task/extra/ignored`,
 `/x/${code}#room/commons`, `/#code/${code}?token=secret`,
 `/?code=${code}&token=secret`, `/x/${code}?token=secret`,
 `/a/RM-ABCDEFG?code=${code}`, `/join/RM-1234567#room/commons`,
 `/#room/commons//work/task`, `/#agent-invite/RM-ABC//extra`,
];
test('setup refuses ambiguous selectors and malformed short or long invitation suffixes before any side effect', async () => {
 const root=mkdtempSync(join(tmpdir(),'setup-target-'));
 try {
  for (const path of bad) {
   const target=origin+path, directory=join(root,'not-created'); let requests=0;
   assert.throws(()=>setupTarget(target), error=>!error.message.includes('secret')&&!error.message.includes(code),path);
   await assert.rejects(connectRoom({target,directory,accept:true,fetchImpl:async()=>{requests++;throw Error('unexpected request');}}),undefined,path);
   assert.equal(requests,0,path); assert.equal(existsSync(directory),false,path);
  }
 } finally { rmSync(root,{recursive:true,force:true}); }
});
test('setup preserves supported short-code forms, focused links and exact same origin',()=>{
 for(const target of [code,'abc def ghj',`${origin}/?code=${code}`,`${origin}/room?code=${code}&ref=source`,`${origin}/x/${code}`,`${origin}/x/${code}/`,`${origin}/#code/${code}`,`${origin}/?ref=source#code/${code}`,`${origin}/x/ABC%2DDEF%2DGHJ`,`${origin}/#code/${code}/work/task`,`${origin}/#code/${code}/message/message-1`,`${origin}/#join/${code}`])
  assert.deepEqual(setupTarget(target,origin),{origin,sharedToken:code},target);
 assert.deepEqual(setupTarget(`${origin}/#join/${token}/work/task`),{origin,sharedToken:token});
 assert.deepEqual(setupTarget(`${origin}/r/abcdefghi`),{origin,publicRoom:'abcdefghi'});
 assert.deepEqual(setupTarget(`${origin}/#room/commons`),{origin,roomId:'commons'});
 for (const path of ['/a/RM-ABCDEFG','/join/RM-ABCDEFG','/room/join/RM-ABCDEFG/','/a/RM-ABCDEFG?ref=source'])
  assert.deepEqual(setupTarget(origin+path),{origin,code:'RM-ABCDEFG'},path);
 assert.deepEqual(setupTarget(`${origin}/join/RM-1234567`),{origin,code:'RM-1234567'});
});
