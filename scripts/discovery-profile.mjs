// Local synthetic transfer/read-volume measurement, not a latency or production benchmark.
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { RoomAgentClient } from '../client/room-agent.mjs';
import { auditRecovery } from '../server/recovery.mjs';

function compareAuthorityReads(store) {
  const methods = {
    full: () => {
      const { sequence, state } = store.room('commons');
      return { sequence, ownerId: state.room.ownerId, members: state.members };
    },
    narrow: () => {
      const row = store.db.prepare("SELECT sequence,json_extract(projection,'$.room.ownerId','$.members') AS authority FROM rooms WHERE id=?").get('commons');
      const [ownerId, members] = JSON.parse(row.authority);
      return { sequence: row.sequence, ownerId, members };
    }
  };
  const expected = methods.full(), measurements = { full: [], narrow: [] };
  for (const method of Object.values(methods)) for (let i = 0; i < 10; i++) assert.deepEqual(method(), expected);
  for (let sample = 0; sample < 5; sample++) {
    for (const name of sample % 2 ? ['narrow', 'full'] : ['full', 'narrow']) {
      let result; const start = performance.now();
      for (let iteration = 0; iteration < 50; iteration++) result = methods[name]();
      measurements[name].push((performance.now() - start) / 50);
      assert.deepEqual(result, expected);
    }
  }
  const authorityJson = store.db.prepare("SELECT json_extract(projection,'$.room.ownerId','$.members') AS authority FROM rooms WHERE id=?").get('commons').authority;
  return { equivalent: true, samples: 5, iterationsPerSample: 50, warmupsPerMethod: 10,
    narrowJsonBytes: Buffer.byteLength(authorityJson), millisecondsPerRead: Object.fromEntries(Object.entries(measurements).map(([name, values]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return [name, { min: sorted[0], median: sorted[2], max: sorted[4] }];
    })), boundary: 'Warm sequential local Node microbenchmark including statement preparation, SQL selection and JavaScript decoding; not HTTP latency, CPU time, disk I/O, concurrency or Workers performance. No timing assertion in tests.' };
}

export async function profileDiscovery({ workCount, messageCount, samples = 3, managedProducer = false }) {
  for (const [value, min, max] of [[workCount, 1, 400], [messageCount, 2, 1200], [samples, 1, 5]]) {
    if (!Number.isInteger(value) || value < min || value > max) throw new Error('Choose bounded synthetic fixture sizes');
  }
  if (typeof managedProducer !== 'boolean') throw new Error('Choose a boolean managed-producer fixture mode');
  const f = createAcceptanceFixture({ managedProducer }); let server;
  try {
    const send = (type, data) => f.store.command(f.keys.owner, 'commons', { id: crypto.randomUUID(), type, data });
    for (let i = 1; i < workCount; i++) send('work.proposed', { workItemId: `profile-work-${i}`,
      title: `Observation preparation ${i}`, definitionOfDone: 'Synthetic task criteria. '.repeat(20),
      accountableMemberId: 'owner', independentVerificationRequired: false, ownerDecisionRequired: false });
    for (let i = 2; i < messageCount; i++) send('message.posted', { messageId: `profile-message-${i}`,
      body: `Synthetic unrelated discussion ${i}: ` + 'Observation notes for the local fixture. '.repeat(12) });
    const { state, sequence } = f.store.room('commons');
    assert.equal(Object.keys(state.workItems).length, workCount); assert.equal(state.messages.length, messageCount);
    const projectionJsonBytes = Buffer.byteLength(f.store.db.prepare('SELECT projection FROM rooms WHERE id=?').get('commons').projection);
    assert.equal(Boolean(f.store.agentConnections.row('commons', 'producer')), managedProducer);
    const authorityComparison = compareAuthorityReads(f.store);
    // Instance-only instrumentation. room() currently selects and JSON-decodes one
    // complete projection per successful call. The fixture is immutable while read;
    // do not mistake this input volume for physical disk I/O, CPU or retained memory.
    const room = f.store.room;
    let fullRoomReads = 0, authorityReads = 0;
    f.store.room = function(roomId) {
      assert.equal(roomId, 'commons');
      const result = room.call(this, roomId);
      assert.equal(result.sequence, sequence);
      fullRoomReads++;
      return result;
    };
    const authority = f.store.roomAuthority;
    if (authority) f.store.roomAuthority = function(roomId) {
      assert.equal(roomId, 'commons');
      const result = authority.call(this, roomId);
      assert.equal(result.sequence, sequence);
      authorityReads++;
      return result;
    };
    server = createRoomServer({ store: f.store });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const requests = [], client = new RoomAgentClient({ origin: `http://127.0.0.1:${server.address().port}`,
      roomId: 'commons', memberId: 'producer', token: f.keys.producer,
      fetchImpl: async (url, options) => {
        assert.equal(options.method, 'GET');
        const readsBefore = fullRoomReads;
        const authorityBefore = authorityReads;
        const response = await fetch(url, options);
        assert.equal(response.status, 200);
        requests.push({ route: new URL(url).pathname.split('/').at(-1),
          decodedBodyBytes: (await response.clone().arrayBuffer()).byteLength,
          fullRoomReads: fullRoomReads - readsBefore, authorityReads: authorityReads - authorityBefore });
        return response;
      } });
    const methods = {
      full: () => client.orient(),
      focused: () => client.orient({ focus: 'needs_me' }),
      search: () => client.orient({ focus: 'needs_me', query: 'agenda' }),
      selected: () => client.workContext('test-handoff')
    };
    const measured = Object.fromEntries(Object.keys(methods).map(key => [key, []]));
    const before = auditRecovery(f.store).dataSha256;
    for (let sample = 0; sample < samples; sample++) {
      // Rotate order; bytes, not elapsed times, are the reported comparison.
      const names = Object.keys(methods), order = [...names.slice(sample % names.length), ...names.slice(0, sample % names.length)];
      for (const name of order) {
        requests.length = 0; const result = await methods[name]();
        assert.equal(requests.length, 2); assert.equal(requests[0].route, 'session');
        assert.equal(requests[1].route, name === 'selected' ? 'work-context' : 'commons');
        if (name === 'selected') assert.equal(result.work.id, 'test-handoff');
        else { assert.equal(result.work.length, name === 'full' ? workCount : 1);
          assert.ok(result.work.some(work => work.id === 'test-handoff')); }
        measured[name].push({ requests: requests.length, identityChecks: 1,
          fullRoomReads: requests.reduce((sum, request) => sum + request.fullRoomReads, 0),
          authorityReads: requests.reduce((sum, request) => sum + request.authorityReads, 0),
          identityAuthorityReads: requests[0].authorityReads, operationAuthorityReads: requests[1].authorityReads,
          identityFullRoomReads: requests[0].fullRoomReads, operationFullRoomReads: requests[1].fullRoomReads,
          decodedBodyBytes: requests.reduce((sum, request) => sum + request.decodedBodyBytes, 0),
          resultJsonBytes: Buffer.byteLength(JSON.stringify(result)) });
      }
    }
    assert.equal(auditRecovery(f.store).dataSha256, before);
    const metrics = Object.fromEntries(Object.entries(measured).map(([name, rows]) => [name, {
      samples: rows.length, requestsPerRead: 2, identityChecksPerRead: 1,
      ...Object.fromEntries(['fullRoomReads', 'identityFullRoomReads', 'operationFullRoomReads', 'authorityReads', 'identityAuthorityReads', 'operationAuthorityReads'].map(field => [field,
        { min: Math.min(...rows.map(row => row[field])), max: Math.max(...rows.map(row => row[field])) }])),
      fullProjectionInputBytes: { min: Math.min(...rows.map(row => row.fullRoomReads)) * projectionJsonBytes,
        max: Math.max(...rows.map(row => row.fullRoomReads)) * projectionJsonBytes },
      javascriptProjectionInputBytes: {
        min: Math.min(...rows.map(row => row.fullRoomReads * projectionJsonBytes + row.authorityReads * authorityComparison.narrowJsonBytes)),
        max: Math.max(...rows.map(row => row.fullRoomReads * projectionJsonBytes + row.authorityReads * authorityComparison.narrowJsonBytes)) },
      projectionSelections: { min: Math.min(...rows.map(row => row.fullRoomReads + row.authorityReads)),
        max: Math.max(...rows.map(row => row.fullRoomReads + row.authorityReads)) },
      decodedBodyBytes: { min: Math.min(...rows.map(row => row.decodedBodyBytes)), max: Math.max(...rows.map(row => row.decodedBodyBytes)) },
      resultJsonBytes: { min: Math.min(...rows.map(row => row.resultJsonBytes)), max: Math.max(...rows.map(row => row.resultJsonBytes)) }
    }]));
    return { workCount, messageCount, credentialMode: managedProducer ? 'owner-connected' : 'legacy-key', projectionJsonBytes,
      metrics, authorityComparison, roomAuditUnchanged: true, nativeModels: false };
  } finally {
    if (server) { server.closeStreams(); server.closeAllConnections();
      if (server.listening) await new Promise(resolve => server.close(resolve)); }
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) throw new Error('No arguments: this profiler creates disposable local fixtures only');
  const scenarios = [];
  for (const managedProducer of [false, true]) for (const [workCount, messageCount] of [[10, 20], [100, 250], [400, 1200]]) {
    const result = await profileDiscovery({ workCount, messageCount, managedProducer }); scenarios.push(result);
    console.log(JSON.stringify(result));
  }
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/discovery-profile.json', JSON.stringify({ version: 3, scenarios,
    boundary: 'Synthetic local Node HTTP; decoded response bodies excluding headers/TLS/compression. Full/authority reads count successful instance room()/roomAuthority() calls. JavaScript projection input counts full stored text plus extracted authority text; projectionSelections includes both and SQL still processes the stored projection. These counts are not disk I/O, CPU, latency, tokens, retained memory, concurrency, Workers cost or measured user workloads. All reads retain identity preflight; no Room writes during measurement.' }, null, 2));
}
