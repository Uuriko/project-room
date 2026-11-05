import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { operatorAttachmentIndex, ATTACHMENT_INDEX_LIMITS } from '../server/operator-attachment-index.mjs';
import { attachmentLiveIndexSql, attachmentLiveIndexState, ensureAttachmentSchema } from '../server/attachment-schema.mjs';
import { createRoomServer } from '../server/http.mjs';

const TOKEN = 'synthetic-attachment-index-operator-0123456789';
async function fixture(t) {
  const prior = process.env.ROOM_OPERATOR_TOKEN_SHA256;
  process.env.ROOM_OPERATOR_TOKEN_SHA256 = createHash('sha256').update(TOKEN).digest('hex');
  const store = new RoomStore(':memory:'); store.initialize(initialRoom());
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close();
    if (prior === undefined) delete process.env.ROOM_OPERATOR_TOKEN_SHA256; else process.env.ROOM_OPERATOR_TOKEN_SHA256 = prior;
  });
  const call = async (phase, input = {}, token = TOKEN) => {
    const response = await fetch(origin + '/api/operator/attachments/live-index/' + phase, { method: 'POST',
      headers: { origin, 'content-type': 'application/json', ...(token ? { authorization: 'Operator ' + token } : {}) },
      body: JSON.stringify({ reason: 'Synthetic bounded attachment qualification', ...input }) });
    return { status: response.status, body: await response.json() };
  };
  return { store, call, origin };
}
test('attachment index is an explicit operator action, absent on ordinary startup', async t => {
  const f = await fixture(t);
  const installed = () => Boolean(f.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='room_attachments_live'").get());
  assert.equal(installed(), false);
  assert.equal((await f.call('plan', {}, null)).status, 404);
  const plan = await f.call('plan'); assert.equal(plan.status, 200, JSON.stringify(plan.body));
  assert.equal(plan.body.scope, 'database'); assert.equal(installed(), false);
  const done = await f.call('execute', { requestId: 'install-once', planHash: plan.body.planHash });
  assert.equal(done.status, 200, JSON.stringify(done.body)); assert.equal(installed(), true);
});
test('quota and expiry explicitly constrain live rows without changing attachment quantities', t => {
  const store = new RoomStore(':memory:'); t.after(() => store.close()); store.initialize(initialRoom());
  const key = store.issueAccessKey('commons', 'owner'), queries = [], prepare = store.db.prepare.bind(store.db);
  store.roomAttachments.stage(key, 'commons', { id: 'expires', filename: 'x.txt', mediaType: 'text/plain', data: 'eA==' });
  store.db.prepare("UPDATE room_attachments SET expires_at=0 WHERE id='expires'").run();
  seed(store, { id: 'retained', state: 'committed', bytes: Buffer.from('ok') });
  store.db.prepare = sql => { queries.push(sql); return prepare(sql); };
  store.roomAttachments.stage(key, 'commons', { id: 'first', filename: 'x.txt', mediaType: 'text/plain', data: 'eA==' });
  const quota = queries.find(sql => sql.includes('AS roomBytes'));
  assert.match(quota, /WHERE room_id=\? AND state IN \('staged','committed'\)/);
  const preflight = queries.find(sql => sql.startsWith('SELECT 1 FROM room_attachments WHERE room_id=?'));
  assert.match(preflight, /state IN \('staged','committed'\)/);
  const expiry = queries.find(sql => sql.includes("SET state='expired'"));
  assert.match(expiry, /state IN \('staged','committed'\)/);
  const rows = store.db.prepare('SELECT id,state,byte_length,bytes FROM room_attachments ORDER BY id').all();
  assert.deepEqual(rows.map(row => [row.id, row.state, row.byte_length, row.bytes?.length ?? null]),
    [['expires', 'expired', 1, null], ['first', 'staged', 1, 1], ['retained', 'committed', 2, 2]],
    'only expired staging bytes are released; committed quantities and the new upload survive');
  queries.length = 0;
  store.roomAttachments.expire('commons', store.now());
  assert.equal(queries.some(sql => sql.includes("SET state='expired'")), false,
    'a second sweep with no expired staging rows does not open a write');
});

function local(t) {
  const store = new RoomStore(':memory:'); store.initialize(initialRoom());
  t.after(() => store.close());
  const input = { reason: 'Synthetic index qualification' };
  const plan = (reverse = false) => operatorAttachmentIndex(store, { ...input, reverse });
  const execute = (value, requestId = 'install', reverse = false) => operatorAttachmentIndex(store, { ...input, reverse, requestId, planHash: value.planHash }, true);
  return { store, plan, execute, input };
}
function seed(store, { id = 'terminal', state = 'discarded', filename = 'x', bytes = null } = {}) {
  store.db.prepare(`INSERT INTO room_attachments(room_id,id,uploader_id,filename,media_type,byte_length,sha256,bytes,state,created_at,expires_at,message_id)
    VALUES('commons',?,'owner',?,'text/plain',?, ?, ?, ?,0,100,NULL)`)
    .run(id, filename, bytes?.length ?? 0, 'a'.repeat(64), bytes, state);
}
test('global scalar admission rejects oversized keys before transferring key text or DDL', t => {
  const f = local(t); seed(f.store, { id: 'x'.repeat(ATTACHMENT_INDEX_LIMITS.keyBytes + 1) });
  const prepare = f.store.db.prepare.bind(f.store.db), exec = f.store.db.exec.bind(f.store.db); let keyReads = 0, builds = 0;
  f.store.db.prepare = sql => { if (sql.startsWith('SELECT hex(CAST(room_id AS BLOB))')) keyReads++; return prepare(sql); };
  f.store.db.exec = sql => { if (sql === attachmentLiveIndexSql) builds++; return exec(sql); };
  assert.throws(() => f.plan(), error => error.code === 'attachment_index_budget_exceeded');
  assert.equal(keyReads, 0); assert.equal(builds, 0); assert.equal(attachmentLiveIndexState(f.store.db), 'absent');
});
test('planning only reads bounded scalar lengths then admitted keys, never attachment payloads', t => {
  const f = local(t); seed(f.store, { id: 'live', state: 'committed', bytes: Buffer.from('private') });
  const prepare = f.store.db.prepare.bind(f.store.db), queries = [];
  f.store.db.prepare = sql => { queries.push(sql); assert.doesNotMatch(sql, /SELECT\s+(?:\*|bytes\s+FROM)\s*.*room_attachments/i); return prepare(sql); };
  f.store.room = () => { throw Error('No projection hydration'); };
  const plan = f.plan(); assert.equal(plan.admitted.rows, 1);
  assert.ok(queries.findIndex(sql => sql.includes('AS storedBytes')) < queries.findIndex(sql => sql.startsWith('SELECT hex(CAST(room_id AS BLOB))')));
  assert.ok(queries.find(sql => sql.includes('AS storedBytes')).includes('length(CAST(bytes AS BLOB))'));
  assert.equal(attachmentLiveIndexState(f.store.db), 'absent');
});
test('stale key/state/row plans refuse and terminal tombstones survive install and reversal', t => {
  const f = local(t); seed(f.store);
  const stale = f.plan(); f.store.db.prepare("UPDATE room_attachments SET state='expired' WHERE id='terminal'").run();
  assert.throws(() => f.execute(stale), error => error.code === 'plan_changed');
  const before = f.store.db.prepare('SELECT * FROM room_attachments').all();
  const installed = f.execute(f.plan()); assert.equal(installed.result.changed, true);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM room_attachments').all(), before);
  const reversed = f.execute(f.plan(true), 'reverse', true); assert.equal(reversed.result.installed, false);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM room_attachments').all(), before);
  assert.ok(f.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='room_attachments_owner'").get());
});
test('exact receipt retries precede current inspection; changed input conflicts', t => {
  const f = local(t); const plan = f.plan(), first = f.execute(plan);
  seed(f.store); f.execute(f.plan(true), 'reverse', true);
  const prepare = f.store.db.prepare.bind(f.store.db);
  f.store.db.prepare = sql => { if (sql.includes('AS storedBytes')) throw Error('retry must be a point read'); return prepare(sql); };
  const retry = f.execute(plan); assert.equal(retry.duplicate, true); assert.deepEqual(retry.result, first.result);
  assert.throws(() => operatorAttachmentIndex(f.store, { ...f.input, reason: 'Changed reason', requestId: 'install', planHash: plan.planHash }, true), error => error.code === 'idempotency_conflict');
});
test('receipt fault atomically rolls back create and reverse without data writes', t => {
  const f = local(t); seed(f.store); const plan = f.plan();
  const trigger = "CREATE TRIGGER reject_attachment_index_receipt BEFORE INSERT ON operator_actions WHEN NEW.action='attachment_index_execute' BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END";
  f.store.db.exec(trigger); assert.throws(() => f.execute(plan)); assert.equal(attachmentLiveIndexState(f.store.db), 'absent');
  f.store.db.exec('DROP TRIGGER reject_attachment_index_receipt'); f.execute(plan);
  const reverse = f.plan(true); f.store.db.exec(trigger); assert.throws(() => f.execute(reverse, 'reverse', true));
  assert.equal(attachmentLiveIndexState(f.store.db), 'installed');
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM operator_actions WHERE action='attachment_index_execute'").get().n, 1);
});
test('index/table definition conflicts are refused, not silently replaced or certified', t => {
  const f = local(t); f.store.db.exec('CREATE INDEX room_attachments_live ON room_attachments(filename)');
  assert.throws(() => f.plan(), error => error.code === 'attachment_index_conflict');
  assert.equal(attachmentLiveIndexState(f.store.db), 'conflict');
  assert.equal(ensureAttachmentSchema(f.store.db), 'current', 'startup ensure does not build or replace the optional index');
});
test('payload-only equal-size changes remain outside index content certification and are preserved', t => {
  const f = local(t); seed(f.store, { state: 'committed', bytes: Buffer.from('abc') }); const plan = f.plan();
  f.store.db.prepare("UPDATE room_attachments SET bytes=? WHERE id='terminal'").run(Buffer.from('xyz'));
  const done = f.execute(plan); assert.equal(done.result.installed, true);
  assert.equal(Buffer.from(f.store.db.prepare("SELECT bytes FROM room_attachments WHERE id='terminal'").get().bytes).toString(), 'xyz');
});

test('critical SQLite faults before/after DDL and receipt insertion roll back and preserve exact retry', t => {
  for (const fault of ['before-ddl', 'after-ddl', 'receipt']) {
    const f = local(t), plan = f.plan(), exec = f.store.db.exec.bind(f.store.db), prepare = f.store.db.prepare.bind(f.store.db);
    const broken = () => { throw Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' }); };
    f.store.db.exec = sql => {
      if (sql === attachmentLiveIndexSql && fault === 'before-ddl') broken();
      const value = exec(sql);
      if (sql === attachmentLiveIndexSql && fault === 'after-ddl') broken();
      return value;
    };
    f.store.db.prepare = sql => {
      const statement = prepare(sql);
      if (fault === 'receipt' && /INSERT INTO operator_actions/.test(sql)) statement.run = broken;
      return statement;
    };
    assert.throws(() => f.execute(plan), error => error.code === 'storage_unavailable');
    f.store.db.exec = exec; f.store.db.prepare = prepare;
    assert.equal(attachmentLiveIndexState(f.store.db), 'absent');
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM operator_actions WHERE action='attachment_index_execute'").get().n, 0);
    assert.equal(f.execute(plan).result.installed, true);
  }
});
test('new route adapters retain credential-first method and unknown-field refusal', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('plan', { roomId: 'commons' })).status, 422);
  const plan = await f.call('plan'); assert.equal(plan.status, 200);
  assert.equal((await f.call('execute', { planHash: plan.body.planHash })).body.error.code, 'request_id_required');
  assert.equal((await f.call('plan/extra')).status, 404);
});

test('SQLite key-byte changes cannot collide through lossy UTF-8 decoding', t => {
  const f = local(t); seed(f.store);
  f.store.db.prepare("UPDATE room_attachments SET id=CAST(x'80' AS TEXT)").run();
  const plan = f.plan();
  f.store.db.prepare("UPDATE room_attachments SET id=CAST(x'81' AS TEXT)").run();
  assert.throws(() => f.execute(plan), error => error.code === 'plan_changed');
});
test('mounted management action rejects other credential forms and missing configuration', async t => {
  const f = await fixture(t), key = f.store.issueAccessKey('commons', 'owner');
  f.store.createAccount('synthetic-account', 'test');
  const { token: accountToken, session: slot } = f.store.createAccountSessionSlot();
  f.store.loginAccountSessionWithMethod(accountToken, 'synthetic-account', slot.sessionRevision, { method: { kind: 'password', ref: 'synthetic-method' } });
  assert.equal(f.store.authenticateAccountSession(accountToken).account.id, 'synthetic-account');
  const endpoint = f.origin + '/api/operator/attachments/live-index/plan';
  const request = headers => fetch(endpoint, { method: 'POST', headers: { origin: f.origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify({ reason: 'Synthetic auth refusal' }) });
  for (const headers of [{ authorization: 'Bearer ' + key }, { cookie: 'room_session=synthetic' }, { cookie: 'account_session=' + accountToken }, { authorization: 'Bearer ' + accountToken }]) {
    assert.equal((await request(headers)).status, 404);
  }
  const hash = process.env.ROOM_OPERATOR_TOKEN_SHA256; delete process.env.ROOM_OPERATOR_TOKEN_SHA256;
  assert.equal((await request({ authorization: 'Operator ' + TOKEN })).status, 404);
  process.env.ROOM_OPERATOR_TOKEN_SHA256 = hash;
  assert.equal((await request({ authorization: 'Operator ' + TOKEN })).status, 200);
});
test('mount keeps origin and credential-first method checks; no mutation on refusal', async t => {
  const f = await fixture(t), endpoint = f.origin + '/api/operator/attachments/live-index/execute';
  for (const origin of ['https://untrusted.invalid', 'null', 'not-an-origin']) {
    assert.equal((await fetch(endpoint, { method: 'POST', headers: { origin, authorization: 'Operator ' + TOKEN, 'content-type': 'application/json' }, body: '{}' })).status, 403);
  }
  for (const method of ['GET', 'PUT']) {
    assert.equal((await fetch(endpoint, { method, headers: { origin: f.origin } })).status, 404);
    assert.equal((await fetch(endpoint, { method, headers: { origin: f.origin, authorization: 'Operator ' + TOKEN } })).status, 405);
  }
  assert.equal(attachmentLiveIndexState(f.store.db), 'absent');
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM operator_actions WHERE action='attachment_index_execute'").get().n, 0);
});
test('mount shares existing management rate and body validation instead of adding a second authority', async t => {
  const f = await fixture(t), endpoint = f.origin + '/api/operator/attachments/live-index/plan';
  const invalid = await fetch(endpoint, { method: 'POST', headers: { origin: f.origin, authorization: 'Operator ' + TOKEN, 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(invalid.status, 415);
  for (let index = 0; index < 9; index++) {
    assert.equal((await fetch(f.origin + '/api/operator/actions', { headers: { origin: f.origin, authorization: 'Operator ' + TOKEN } })).status, 200);
  }
  assert.equal((await f.call('plan')).status, 429);
  assert.equal(attachmentLiveIndexState(f.store.db), 'absent');
});
test('a reserved index name occupied by another schema object is a conflict, not an absent index', t => {
  const f = local(t); f.store.db.exec('CREATE TABLE room_attachments_live(unrelated TEXT)');
  assert.throws(() => f.plan(), error => error.code === 'attachment_index_conflict');
});
