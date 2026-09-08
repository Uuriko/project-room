import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, Response } from 'miniflare';
import { createRuntimePackage, verifyRuntimePackage, publicAssets } from '../scripts/runtime-package.mjs';
import { createRecoveryFixture } from '../scripts/recovery-fixture.mjs';
import { applicationTables } from '../server/writer-fence.mjs';
import { auditRecovery } from '../server/recovery.mjs';

const baseline = '7075c1ddfe5ced3ae970f817dbfd0fc3e88a13b6';
const repository = fileURLToPath(new URL('../', import.meta.url));

test('distinct exact-commit v8 packages switch candidate → pause → baseline → candidate on the same populated Workers object', { timeout: 90000 }, async t => {
  const candidate = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
  assert.notEqual(candidate, baseline, 'Commit the distinct candidate before certifying its immutable package');
  const directory = mkdtempSync(join(tmpdir(), 'room-v8-switch-'));
  let fixture, mf;
  try {
    const packages = new Map([['candidate', candidate], ['baseline', baseline]].map(([label, commit]) => {
      const path = join(directory, label);
      return [label, { path, receipt: createRuntimePackage({ repository, commit, destination: path }) }];
    }));
    assert.notDeepEqual(readFileSync(join(packages.get('candidate').path, 'cloudflare/room.mjs')),
      readFileSync(join(packages.get('baseline').path, 'cloudflare/room.mjs')), 'The actual application entrypoints must differ');
    fixture = createRecoveryFixture(join(directory, 'seed.sqlite'));
    const expected = auditRecovery(fixture.store);
    const proof = { keys: fixture.keys, owner: fixture.owner, target: fixture.target, validSession: fixture.validSession,
      revokedSession: fixture.revokedSession, loggedOut: fixture.loggedOut, sharedSession: fixture.sharedSession,
      pending: fixture.pending, guestSlot: fixture.guestSlot, guest: fixture.guest, linkToken: fixture.linkToken,
      joinRequest: fixture.joinRequest, reminders: fixture.reminders, redemptionId: randomUUID() };
    const rows = applicationTables.flatMap(table => fixture.store.db.prepare(`SELECT * FROM ${table}`).all()
      .map(row => ({ table, columns: Object.keys(row), values: Object.values(row) })));
    const persistence = join(directory, 'persistence'); mkdirSync(persistence);
    const origin = 'https://room.example.test';
    const scripts = new Map();
    for (const [label, pkg] of packages) {
      // Test-only wrapper around each preserved production entrypoint. Synthetic
      // rows seed equivalent data; this is NOT a product storage-conversion API.
      const source = `
        import assert from 'node:assert/strict';
        import entry, { ProjectRoom as RuntimeRoom } from ${JSON.stringify(join(pkg.path, 'cloudflare/room.mjs'))};
        import { auditRecovery } from ${JSON.stringify(join(repository, 'server/recovery.mjs'))};
        export class ProjectRoom extends RuntimeRoom {
          fetch(request) {
            const path = new URL(request.url).pathname;
            if (path === '/__recovery-seed') {
              if (this.store.db.prepare('SELECT count(*) n FROM rooms').get().n) throw new Error('Seed requires empty disposable data');
              this.store.transaction(() => {
                for (const row of JSON.parse(this.env.SEED_ROWS)) {
                  const sql = 'INSERT INTO ' + row.table + '(' + row.columns.join(',') + ') VALUES(' + row.columns.map(() => '?').join(',') + ')';
                  this.store.db.prepare(sql).run(...row.values);
                }
              });
              return Response.json({ seeded: true });
            }
            if (path === '/__recovery-audit') return Response.json({ audit: auditRecovery(this.store),
              version: this.store.db.prepare('SELECT version FROM room_runtime_version WHERE singleton=1').get().version,
              permit: this.store.db.prepare('SELECT version FROM room_writer_permit WHERE singleton=1').get().version });
            if (path === '/__recovery-identities') {
              const f = JSON.parse(this.env.IDENTITY_PROOF), store = this.store;
              assert.equal(store.authenticate(f.validSession.token).member.id, 'owner');
              assert.equal(store.authenticateAccountSession(f.owner.token, 'commons', f.owner.session.sessionBinding).account.id, f.owner.session.account.id);
              assert.equal(store.authenticateAccountSession(f.guestSlot.token, 'commons', f.guest.session.sessionBinding).member.id, f.guest.session.member.id);
              for (const token of [f.revokedSession.token, f.keys.oldAgent, f.keys.commonsShared, f.keys.secondShared, f.loggedOut.token, f.sharedSession.token]) assert.throws(() => store.authenticate(token));
              assert.throws(() => store.snapshot(f.target.token, 'commons', f.target.session.sessionBinding), /no membership/);
              assert.equal(store.issueInvitation(f.owner.token, 'commons', f.pending).duplicate, true);
              const slot = store.accountSessionSlot(f.guestSlot.token);
              const joined = store.shareLinks.join(f.guestSlot.token, f.linkToken, { ...f.joinRequest, expectedSessionRevision: slot.sessionRevision, expectedSessionBinding: slot.sessionBinding });
              assert.equal(joined.duplicate, true); assert.equal(joined.session.member.id, f.guest.session.member.id);
              for (const reminder of f.reminders.filter(row => ![f.keys.commonsShared, f.keys.secondShared].includes(row.token))) {
                const retry = store.reminders.mutate(reminder.token, reminder.room, reminder.request);
                assert.equal(retry.duplicate, true); assert.deepEqual(retry.receipt, reminder.receipt);
              }
              return Response.json({ preservedIdentitiesAndRetries: true });
            }
            if (path === '/__recovery-accept') {
              const f = JSON.parse(this.env.IDENTITY_PROOF);
              const result = this.store.acceptInvitation(f.target.token, f.pending.token, { redemptionId: f.redemptionId,
                expectedRevision: 0, expectedSessionBinding: f.target.session.sessionBinding });
              assert.equal(result.session.member.id, 'pending-human');
              return Response.json({ accepted: true, duplicate: result.duplicate });
            }
            return super.fetch(request);
          }
        }
        export default entry;`;
      const bundle = await build({ stdin: { contents: source, resolveDir: repository, sourcefile: 'local-recovery-fixture.mjs' },
        bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
      scripts.set(label, bundle.outputFiles[0].text);
    }
    const start = async (label, paused = false) => {
      if (mf) await mf.dispose();
      const pkg = packages.get(label), config = JSON.parse(readFileSync(join(pkg.path, 'cloudflare/wrangler.jsonc')));
      mf = new Miniflare({ modules: true, script: scripts.get(label), compatibilityDate: config.compatibility_date,
        compatibilityFlags: config.compatibility_flags, durableObjects: { ROOM: { className: 'ProjectRoom', useSQLite: true } },
        durableObjectsPersist: persistence, bindings: { ROOM_ORIGIN: origin, ROOM_MAINTENANCE: paused ? '1' : '0', SEED_ROWS: JSON.stringify(rows), IDENTITY_PROOF: JSON.stringify(proof) },
        serviceBindings: { ASSETS: async request => {
          const path = new URL(request.url).pathname.slice(1);
          return publicAssets.includes(path) ? new Response(readFileSync(join(pkg.path, path))) : new Response(null, { status: 404 });
        } } });
    };
    const call = (path, data, token = fixture.keys.owner) => mf.dispatchFetch(origin + path, {
      method: data ? 'POST' : 'GET', headers: { 'CF-Connecting-IP': '192.0.2.1', Authorization: `Bearer ${token}`,
        ...(data ? { Origin: origin, 'Content-Type': 'application/json' } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) });
    const json = async (path, data, token) => {
      const response = await call(path, data, token);
      assert.ok([200, 201].includes(response.status), `${response.status} ${await response.clone().text()}`); return response.json();
    };
    const audit = async () => {
      const result = await json('/__recovery-audit');
      assert.equal(result.version, 8); assert.equal(result.permit, 0); assert.equal(result.audit.platform, 'durable-object');
      return result.audit;
    };
    await start('candidate'); await json('/__recovery-seed');
    assert.equal((await audit()).dataSha256, expected.dataSha256, 'Every application row matches the independently built fixture');
    const candidateCommand = { id: 'candidate-write', type: 'message.posted', data: { body: 'Synthetic candidate contribution' } };
    const candidateReminder = { requestId: 'candidate-reminder', workItemId: 'active', expectedRevision: 1, action: 'schedule', dueAt: Date.now() + 3600000 };
    assert.equal((await json('/api/rooms/commons/commands', candidateCommand)).duplicate, false);
    assert.equal((await json('/api/rooms/commons/reminders', candidateReminder)).duplicate, false);
    const candidateData = await audit();
    await start('candidate', true);
    for (const path of ['/', '/api/rooms/commons', '/__recovery-audit']) {
      const response = await call(path); assert.equal(response.status, 503); assert.equal(response.headers.get('set-cookie'), null);
    }
    await start('baseline'); assert.deepEqual(await audit(), candidateData);
    assert.deepEqual(await json('/__recovery-identities'), { preservedIdentitiesAndRetries: true });
    assert.deepEqual(await audit(), candidateData, 'Historical retries do not change any captured row');
    assert.equal((await json('/api/rooms/commons/commands', candidateCommand)).duplicate, true);
    assert.equal((await json('/api/rooms/commons/reminders', candidateReminder)).duplicate, true);
    assert.equal((await call('/api/rooms/commons', undefined, fixture.keys.oldAgent)).status, 401);
    assert.equal((await json('/api/rooms/commons')).cursor, fixture.cursor);
    assert.equal((await call('/')).status, 200);
    const baselineWork = { id: 'baseline-new-work', type: 'work.proposed', data: { workItemId: 'baseline-work', title: 'Continue while on fallback',
      definitionOfDone: 'Synthetic fallback remains usable', accountableMemberId: 'owner', independentVerificationRequired: false, ownerDecisionRequired: false } };
    const baselineReminder = { requestId: 'baseline-reminder', workItemId: 'baseline-work', expectedRevision: 0, action: 'schedule', dueAt: Date.now() + 3600000 };
    assert.equal((await json('/api/rooms/commons/commands', baselineWork)).duplicate, false);
    assert.equal((await json('/api/rooms/commons/reminders', baselineReminder)).duplicate, false);
    assert.deepEqual(await json('/__recovery-accept'), { accepted: true, duplicate: false });
    const baselineData = await audit();
    await start('candidate'); assert.deepEqual(await audit(), baselineData);
    assert.deepEqual(await json('/__recovery-accept'), { accepted: true, duplicate: true });
    assert.equal((await json('/api/rooms/commons/commands', baselineWork)).duplicate, true);
    assert.equal((await json('/api/rooms/commons/reminders', baselineReminder)).duplicate, true);
    for (const [label, pkg] of packages) assert.deepEqual(verifyRuntimePackage(pkg.path), pkg.receipt, label);
    t.diagnostic(JSON.stringify({ candidate: packages.get('candidate').receipt, baseline: packages.get('baseline').receipt,
      schemaVersion: 8, idlePermit: 0, rooms: expected.rooms, tables: expected.tables.length,
      seed: expected.dataSha256, afterCandidate: candidateData.dataSha256, afterBaseline: baselineData.dataSha256,
      boundaries: 'Local workerd app-switch only. No provider PITR, live namespace, deployment or current-authority certification.' }));
  } finally {
    if (mf) await mf.dispose(); fixture?.store.close(); rmSync(directory, { recursive: true, force: true });
  }
});
