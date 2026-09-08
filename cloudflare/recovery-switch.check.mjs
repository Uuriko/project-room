import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { Miniflare, Response } from 'miniflare';
import { createRuntimePackage, verifyRuntimePackage } from '../scripts/runtime-package.mjs';
import { frozenRecoveryFixture, v8ConnectionBaseline, v12HelpBaseline } from '../scripts/frozen-runtime-fixture.mjs';
import { currentAttention } from '../client/attention-inbox.mjs';

const baseline = '7075c1ddfe5ced3ae970f817dbfd0fc3e88a13b6';
const repository = fileURLToPath(new URL('../', import.meta.url));
const observerState = directory => {
  const db = new DatabaseSync(join(directory, 'watch.sqlite'), { readOnly: true });
  try { return { checkpoint: db.prepare('SELECT * FROM checkpoint').all(),
    notices: db.prepare('SELECT * FROM attention ORDER BY work_id').all() }; }
  finally { db.close(); }
};

// Preserve historical switch proofs. Neither schema12 package is a schema13 fallback.
for (const version of [8, 12]) test(`historical schema${version} packages switch candidate → pause → fallback → candidate on the same populated Workers object`, { timeout: 90000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), `room-v${version}-switch-`));
  let fixture, mf;
  try {
    const retained = version === 12 && (process.env.ROOM_RECOVERY_CANDIDATE_PACKAGE !== undefined
      || process.env.ROOM_RECOVERY_FALLBACK_PACKAGE !== undefined);
    const fallback = version === 12 ? '4d22189ccdebc56db23397e6cc75b07eff0e3c2c' : baseline;
    let packages;
    if (retained) {
      // Explicit paired paths opt into actual retained artifacts. Never rewrite,
      // repair, delete or replace them with a passing synthetic candidate.
      packages = new Map([['candidate', process.env.ROOM_RECOVERY_CANDIDATE_PACKAGE],
        ['baseline', process.env.ROOM_RECOVERY_FALLBACK_PACKAGE]].map(([label, path]) => {
        assert.ok(typeof path === 'string' && isAbsolute(path), 'Both retained package paths must be absolute');
        const receipt = verifyRuntimePackage(path);
        assert.equal(receipt.schemaVersion, 12);
        if (label === 'baseline') assert.equal(receipt.sourceCommit, fallback);
        return [label, { path, receipt }];
      }));
    } else {
      const candidate = version === 12 ? { repository, commit: v12HelpBaseline }
        : { repository, commit: v8ConnectionBaseline };
      packages = new Map([['candidate', candidate], ['baseline', { repository, commit: fallback }]].map(([label, source]) => {
        const path = join(directory, label);
        return [label, { path, receipt: createRuntimePackage({ ...source, destination: path }) }];
      }));
    }
    assert.notEqual(packages.get('candidate').receipt.sourceCommit, packages.get('baseline').receipt.sourceCommit);
    const differingRuntime = version === 12 ? 'server/store.mjs' : 'cloudflare/room.mjs';
    assert.notDeepEqual(readFileSync(join(packages.get('candidate').path, differingRuntime)),
      readFileSync(join(packages.get('baseline').path, differingRuntime)), 'The actual application runtimes must differ');
    const candidatePath = packages.get('candidate').path;
    const createRecoveryFixture = await frozenRecoveryFixture(repository, candidatePath, packages.get('candidate').receipt.sourceCommit);
    const { auditRecovery } = await import(pathToFileURL(join(candidatePath, 'server/recovery.mjs')));
    const { applicationTables } = await import(pathToFileURL(join(candidatePath, 'server/writer-fence.mjs')));
    fixture = createRecoveryFixture(join(directory, 'seed.sqlite'));
    const requestRetries = [];
    if (version === 12) {
      for (const status of ['open', 'answered', 'declined', 'cancelled']) {
        const opening = { id: `open-${status}`, type: 'message.posted', data: { messageId: `request-${status}`,
          body: `Synthetic ${status} request 🪷`, toMemberId: 'agent', requestKind: 'reply' } };
        const opened = fixture.store.command(fixture.keys.owner, 'commons', opening);
        requestRetries.push({ actor: 'owner', command: opening, receipt: opened });
        if (status === 'open') continue;
        const actor = status === 'cancelled' ? 'owner' : 'agent';
        const command = status === 'cancelled'
          ? { id: 'cancel-request', type: 'reply_request.cancelled', data: { requestMessageId: opening.data.messageId, expectedRequestRevision: 0, reason: 'Synthetic cancellation' } }
          : { id: `respond-${status}`, type: 'message.posted', data: { messageId: `response-${status}`, body: `Synthetic ${status} response`,
            replyToId: opening.data.messageId, responseToRequestId: opening.data.messageId, expectedRequestRevision: 0,
            responseOutcome: status, toMemberId: 'owner', workItemId: null, contextEventId: opened.event.id, contextSequence: opened.sequence } };
        requestRetries.push({ actor, command, receipt: fixture.store.command(fixture.keys[actor], 'commons', command) });
      }
    }
    const expected = auditRecovery(fixture.store);
    const proof = { keys: fixture.keys, owner: fixture.owner, target: fixture.target, validSession: fixture.validSession,
      revokedSession: fixture.revokedSession, loggedOut: fixture.loggedOut, sharedSession: fixture.sharedSession,
      pending: fixture.pending, guestSlot: fixture.guestSlot, guest: fixture.guest, linkToken: fixture.linkToken,
      joinRequest: fixture.joinRequest, reminders: fixture.reminders, redemptionId: randomUUID(), requestRetries,
      nativeBody: fixture.nativeBody, nativeCommand: fixture.nativeCommand, nativeCompletion: fixture.nativeCompletion,
      charterCommand: fixture.charterCommand, charterSaved: fixture.charterSaved,
      requests: version === 12 ? fixture.store.room('commons').state.replyRequests : null };
    const rows = applicationTables.flatMap(table => fixture.store.db.prepare(`SELECT * FROM ${table}`).all()
      .map(row => ({ table, columns: Object.keys(row), values: Object.values(row) })));
    const persistence = join(directory, 'persistence'); mkdirSync(persistence);
    const origin = 'https://room.example.test';
    const scripts = new Map();
    for (const [label, pkg] of packages) {
      const publicAssets = JSON.parse(readFileSync(join(pkg.path, 'runtime-manifest.json'))).publicAssets;
      // Test-only wrapper around each preserved production entrypoint. Synthetic
      // rows seed equivalent data; this is NOT a product storage-conversion API.
      const source = `
        import assert from 'node:assert/strict';
        import entry, { ProjectRoom as RuntimeRoom } from ${JSON.stringify(join(pkg.path, 'cloudflare/room.mjs'))};
        import { auditRecovery } from ${JSON.stringify(join(candidatePath, 'server/recovery.mjs'))};
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
              if (f.requests) {
                assert.deepEqual(store.room('commons').state.replyRequests, f.requests);
                for (const retry of f.requestRetries) {
                  const receipt = store.command(f.keys[retry.actor], 'commons', retry.command);
                  assert.equal(receipt.duplicate, true); assert.equal(receipt.event.id, retry.receipt.event.id);
                }
                assert.equal(store.command(f.keys.owner, 'commons', f.nativeCommand).event.id, f.nativeCompletion.event.id);
                assert.equal(store.workResult(f.keys.owner, 'commons', 'native-evidence').result.text.body, f.nativeBody);
                assert.equal(store.command(f.keys.owner, 'commons', f.charterCommand).event.id, f.charterSaved.event.id);
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
      assert.equal(result.version, version); assert.equal(result.permit, 0); assert.equal(result.audit.platform, 'durable-object');
      return result.audit;
    };
    await start('candidate'); await json('/__recovery-seed');
    assert.equal((await audit()).dataSha256, expected.dataSha256, 'Every application row matches the independently built fixture');
    const candidateCommand = { id: 'candidate-write', type: 'message.posted', data: { body: 'Synthetic candidate contribution' } };
    const candidateReminder = { requestId: 'candidate-reminder', workItemId: 'active', expectedRevision: 1, action: 'schedule', dueAt: Date.now() + 3600000 };
    assert.equal((await json('/api/rooms/commons/commands', candidateCommand)).duplicate, false);
    assert.equal((await json('/api/rooms/commons/reminders', candidateReminder)).duplicate, false);
    const candidateData = await audit();
    const attentionConfig = { directory: join(directory, 'observer-v3'), version: 3, origin, roomId: 'commons', client: {
      snapshot: () => json('/api/rooms/commons', undefined, fixture.keys.agent),
      changes: (after, limit) => json(`/api/rooms/commons/events?after=${after}&limit=${limit}`, undefined, fixture.keys.agent)
    } };
    const notices = version === 12 ? await currentAttention(attentionConfig) : null;
    if (notices) assert.equal(notices.items.some(n => n.request?.id === 'request-open'), true);
    const savedObserver = notices ? observerState(attentionConfig.directory) : null;
    await start('candidate', true);
    for (const path of ['/', '/api/rooms/commons', '/__recovery-audit']) {
      const response = await call(path); assert.equal(response.status, 503); assert.equal(response.headers.get('set-cookie'), null);
    }
    assert.equal((await call('/api/rooms/commons/commands', { ...candidateCommand, id: 'paused-write' })).status, 503);
    assert.equal((await call('/api/rooms/commons/reminders', { ...candidateReminder, requestId: 'paused-reminder' })).status, 503);
    await start('baseline'); assert.deepEqual(await audit(), candidateData);
    if (notices) {
      await assert.rejects(currentAttention(attentionConfig), error => error.code === 'request_context_unavailable');
      // A new observer run legitimately changes its control run ID, but must
      // leave the history checkpoint and every notice/acknowledgement untouched.
      assert.deepEqual(observerState(attentionConfig.directory), savedObserver,
        'Unsupported fallback cannot modify observer history or notices');
    }
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
    const fallbackRequests = [];
    if (version === 12) {
      const command = { id: 'fallback-question', type: 'message.posted', data: { messageId: 'fallback-question',
        body: 'Can requests still be answered on fallback?', toMemberId: 'agent', requestKind: 'reply' } };
      const opened = await json('/api/rooms/commons/commands', command);
      const answer = { id: 'fallback-answer', type: 'message.posted', data: { messageId: 'fallback-answer', body: 'Yes, synthetic answer.',
        replyToId: 'fallback-question', responseToRequestId: 'fallback-question', expectedRequestRevision: 0,
        responseOutcome: 'answered', toMemberId: 'owner', workItemId: null, contextEventId: opened.event.id, contextSequence: opened.sequence } };
      const answered = await json('/api/rooms/commons/commands', answer, fixture.keys.agent);
      assert.equal(opened.duplicate, false); assert.equal(answered.duplicate, false);
      fallbackRequests.push({ command, token: fixture.keys.owner, eventId: opened.event.id },
        { command: answer, token: fixture.keys.agent, eventId: answered.event.id });
    }
    assert.deepEqual(await json('/__recovery-accept'), { accepted: true, duplicate: false });
    const baselineData = await audit();
    await start('candidate'); assert.deepEqual(await audit(), baselineData);
    if (notices) assert.deepEqual((await currentAttention(attentionConfig)).items, notices.items,
      'Unsupported fallback does not erase retained observer v3 notices');
    for (const retry of fallbackRequests) {
      const result = await json('/api/rooms/commons/commands', retry.command, retry.token);
      assert.equal(result.duplicate, true); assert.equal(result.event.id, retry.eventId);
    }
    assert.deepEqual(await json('/__recovery-accept'), { accepted: true, duplicate: true });
    assert.equal((await json('/api/rooms/commons/commands', baselineWork)).duplicate, true);
    assert.equal((await json('/api/rooms/commons/reminders', baselineReminder)).duplicate, true);
    assert.deepEqual(await audit(), baselineData, 'Returning to candidate and retrying does not change any data');
    for (const [label, pkg] of packages) assert.deepEqual(verifyRuntimePackage(pkg.path), pkg.receipt, label);
    t.diagnostic(JSON.stringify({ candidate: packages.get('candidate').receipt, baseline: packages.get('baseline').receipt,
      schemaVersion: version, syntheticCandidate: false, retainedPackages: Boolean(retained), idlePermit: 0, rooms: expected.rooms, tables: expected.tables.length,
      seed: expected.dataSha256, afterCandidate: candidateData.dataSha256, afterBaseline: baselineData.dataSha256,
      boundaries: 'Local workerd app-switch only. No provider PITR, live namespace, deployment or current-authority certification.' }));
  } finally {
    if (mf) await mf.dispose(); fixture?.store.close(); rmSync(directory, { recursive: true, force: true });
  }
});
