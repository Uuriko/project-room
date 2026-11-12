import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

test('connection status preserves read failures and manual recovery instead of inventing reconnect activity',()=>{
  const source=readFileSync(new URL('../src/app.js',import.meta.url),'utf8');
  const start=source.indexOf('function setConnectionStatus(text) {'),end=source.indexOf('function accountRoomCreateFailure(',start);
  assert.ok(start>=0&&end>start);
  const status={textContent:'',dataset:{}},explanation={textContent:''},bar={classList:{toggle(){}}};
  const ctx={state:null,$:selector=>({'#connection-status':status,'#connection-explanation':explanation,'.connection-bar':bar}[selector])};
  vm.createContext(ctx);vm.runInContext(source.slice(start,end),ctx);
  for(const text of ['Current view unavailable · displayed history may be stale. Refresh to retry.','Connection interrupted · refresh to recover; no peer activity inferred']) {
    ctx.setConnectionStatus(text);
    assert.equal(status.textContent,text);
    assert.equal(explanation.textContent,text);
    assert.equal(status.dataset.interrupted,'true');
    assert.doesNotMatch(status.textContent,/reconnecting/);
  }
  ctx.setConnectionStatus('Reconnecting · displayed history may be stale');
  assert.match(status.textContent,/reconnecting/,'actual transport reconnect remains visible');
  ctx.setConnectionStatus('Connected to room service · no peer read or processing receipt');
  assert.equal(status.textContent,'Connected');assert.equal(status.dataset.interrupted,'false');
});
