import test from 'node:test';
import assert from 'node:assert/strict';
import { logRoomRequest } from '../cloudflare/request-timing.mjs';

test('request residual preserves legacy values without asserting queue or CPU attribution', t => {
  const rows = [];
  t.mock.method(console, 'info', line => rows.push(JSON.parse(line)));
  for (const appMs of [0, 30, 120, null]) logRoomRequest({method:'GET',path:'/api/version',status:200,totalMs:100,servedBy:'room',appMs});
  for (const row of rows) {
    assert.equal(row.clockSemantics, 'io-bound');
    assert.equal(row.cpuMeasured, false);
  }
  assert.deepEqual(rows.slice(0,3).map(row=>row.queueMs), [100,70,0]);
  for (const row of rows.slice(0,3)) {
    assert.equal(row.residualMs,row.queueMs);
    assert.equal(row.residualAttribution,'unattributed');
  }
  assert.equal(rows[0].appMs,0,'zero remains observable, never fabricated CPU time');
  assert.equal(Object.hasOwn(rows[3],'queueMs'),false);
  assert.equal(Object.hasOwn(rows[3],'residualMs'),false);
});
