import test from 'node:test';
import assert from 'node:assert/strict';
import { DurableDatabase, durableStorage } from '../cloudflare/storage.mjs';
import { SqlCostScopes } from '../cloudflare/sql-cost-scope.mjs';

function fixture() {
  const logs = [], scopes = new SqlCostScopes({ emit: row => logs.push(row) });
  const storage = { transactionSync: fn => fn(), sql: { exec(sql) {
    if (sql === 'fail-before-cursor') throw new Error('SECRET sql failed');
    if (sql === 'SELECT changes() AS n') return { one: () => ({ n: 2 }) };
    const cursor = { rowsRead: 0, rowsWritten: 0,
      toArray() { this.rowsRead = 7; this.rowsWritten = 2; if (sql === 'fail-consume') throw new Error('SECRET consume'); return [{ n: 1 }, { n: 2 }]; },
      *[Symbol.iterator]() { this.rowsRead++; yield { n: 1 }; if (sql === 'fail-iterate') throw new Error('SQL iteration failure'); this.rowsRead++; yield { n: 2 }; }
    }; return cursor;
  } } };
  const db = new DurableDatabase(storage, { observeStatement: scopes.observeStatement });
  // Focus on adapter accounting; real transaction behavior is covered separately.
  db.isTransaction = true;
  return { logs, scopes, db };
}

test('all/get/run/exec count exactly once, exclude raw changes and preserve return semantics', () => {
  const {logs, scopes, db} = fixture();
  scopes.run('request', 'work-claims', () => {
    assert.equal(db.prepare('SECRET').all('private-token').length, 2);
    assert.equal(db.prepare('x').get().n, 1);
    assert.deepEqual(db.prepare('x').run(), {changes: 2});
    assert.equal(db.exec('x').length, 2);
  });
  assert.equal(db.rowsRead, 28);
  assert.deepEqual(logs[0], {event:'room.sql_cost',coverage:'adapter-observed',scopeKind:'request',operation:'work-claims',statements:4,rowsRead:28,rowsWritten:8,sqlErrors:0,unknownRowCosts:0,pendingStatements:0,complete:true,outcome:'completed'});
  assert.doesNotMatch(JSON.stringify(logs), /SECRET|private-token/);
});

test('cursor failures, pre-cursor failures and rollback retain observed costs', () => {
  const {logs, scopes, db} = fixture();
  assert.throws(() => scopes.run('job', 'patrol', () => durableStorage.transaction(db, () => {
    assert.throws(() => db.prepare('fail-consume').all());
    db.prepare('fail-before-cursor').get();
  }, false, {isolated:true})), /SECRET/);
  assert.equal(logs[0].rowsRead, 7); assert.equal(logs[0].statements, 2);
  assert.equal(logs[0].sqlErrors, 2); assert.equal(logs[0].unknownRowCosts, 1);
  assert.equal(logs[0].complete, false); assert.equal(logs[0].outcome, 'failed');
});

test('iteration captures first-next scope, counts early break/throw once and never observes unstarted cursor', () => {
  const {logs, scopes, db} = fixture(); const prepared=db.prepare('private SQL');
  const iterable = prepared.iterate(); prepared.iterate();
  scopes.run('job','patrol', () => { for (const row of iterable) { assert.equal(row.n,1); break; } });
  scopes.run('job','patrol', () => { const it=prepared.iterate(); it.next(); assert.throws(() => it.throw(new Error('stop'))); });
  assert.deepEqual(logs.map(x=>[x.statements,x.rowsRead,x.sqlErrors]), [[1,1,0],[1,1,0]]);
});

test('interleaved requests, nested jobs and explicit background scopes never double count', async () => {
  const {logs, scopes, db} = fixture(); let resume; const gate=new Promise(resolve=>resume=resolve);
  const a=scopes.run('request','mcp',async()=>{ db.prepare('a').get(); await gate;
    await scopes.run('job','patrol',async()=>{ db.prepare('c').get(); }); db.prepare('a').get(); });
  await scopes.run('request','work-context',async()=>{db.prepare('b').get();await Promise.resolve(); db.prepare('b').get();});
  await scopes.run('background','webhooks',async()=>db.prepare('d').get()); resume(); await a;
  assert.deepEqual(logs.map(x=>[x.operation,x.statements]), [['work-context',2],['webhooks',1],['patrol',1],['mcp',2]]);
});

test('late inherited callbacks and cross-scope cursor close stay out of emitted parents', async () => {
  const {logs, scopes, db} = fixture(); let it, runLate;
  scopes.run('request','mcp',()=>{it=db.prepare('x').iterate();it.next();runLate=new Promise(resolve=>setImmediate(()=>{db.prepare('late').get();resolve();}));});
  assert.equal(logs[0].pendingStatements,1); assert.equal(logs[0].complete,false);
  scopes.run('request','work-context',()=>it.return()); await runLate;
  db.prepare('unscoped').get(); scopes.flushUnattributed(); scopes.flushUnattributed();
  assert.equal(logs[1].statements,0);
  assert.deepEqual(logs.slice(2).map(x=>[x.scopeKind,x.statements,x.rowsRead]),[['unscoped',1,7],['late',2,8]]);
  assert.equal(logs[0].statements,0, 'emitted summary is immutable');
});

test('unknown labels collapse, streaming header scope is explicit partial, observer failures cannot change SQL', () => {
  const {logs, scopes, db} = fixture();
  scopes.run('SECRET-kind','/room/private-token',()=>db.prepare('SECRET').all(),{partial:true});
  assert.equal(logs[0].scopeKind,'other'); assert.equal(logs[0].operation,'other');assert.equal(logs[0].complete,false);
  assert.doesNotMatch(JSON.stringify(logs), /SECRET|private-token/);
  db.observeStatement=()=>{throw new Error('observer')};assert.equal(db.prepare('ok').get().n,1);
  db.observeStatement=()=>()=>{throw new Error('sink')};assert.equal(db.prepare('ok').get().n,1);
});

test('route buckets discard identifiers, queries and malformed input', async () => {
  const {sqlCostOperation}=await import('../cloudflare/sql-cost-scope.mjs');
  for (const [path, expected] of [['/mcp','mcp'], ['/room/api/rooms/SECRET/work-claims/SECRET','work-claims'], ['/api/rooms/SECRET/work-context?token=SECRET','work-context'], ['/api/rooms/SECRET?view=work','room-view'], ['/api/operator/export','operator'], ['/SECRET','other']]) assert.equal(sqlCostOperation('https://example.test'+path),expected);
  assert.equal(sqlCostOperation('SECRET'), 'other');
});

test('cursor-originated next failure counts SQL error, and counter getter failure stays diagnostic only', () => {
  const {logs, scopes, db}=fixture();
  scopes.run('job','patrol',()=>{const it=db.prepare('fail-iterate').iterate();it.next();assert.throws(()=>it.next(),/SQL iteration failure/);});
  assert.equal(logs[0].sqlErrors,1);assert.equal(logs[0].rowsRead,1);
  db.storage.sql.exec=()=>({get rowsRead(){throw new Error('counter unavailable')},get rowsWritten(){throw new Error('counter unavailable')},toArray:()=>[{ok:true}]});
  scopes.run('request','other',()=>assert.equal(db.prepare('ok').get().ok,true));
  assert.equal(logs[1].unknownRowCosts,1);assert.equal(logs[1].complete,false);
  db.observeStatement=undefined;assert.equal(db.prepare('ok').get().ok,true);
});

test('disabled observer fast path preserves rowsRead without accessing rowsWritten', () => {
  const {db}=fixture();db.observeStatement=undefined;let writeCounterReads=0;
  db.storage.sql.exec=()=>({rowsRead:3,get rowsWritten(){writeCounterReads++;throw new Error('must not access writes when disabled')},toArray:()=>[1],*[Symbol.iterator](){yield 1;}});
  assert.equal(db.prepare('x').get(),1);assert.deepEqual([...db.prepare('x').iterate()],[1]);assert.equal(db.rowsRead,6);assert.equal(writeCounterReads,0);
});

test('SQL diagnostic configuration is explicit and reversible only on the production Durable Object', async () => {
  const {readFile}=await import('node:fs/promises');
  const config=JSON.parse(await readFile(new URL('../cloudflare/wrangler.jsonc',import.meta.url),'utf8'));
  assert.ok(['0','1'].includes(config.env.production.vars.ROOM_SQL_COST_LOG));
  assert.notEqual(config.vars.ROOM_SQL_COST_LOG,'1');
  assert.notEqual(config.env.staging.vars.ROOM_SQL_COST_LOG,'1');
});
