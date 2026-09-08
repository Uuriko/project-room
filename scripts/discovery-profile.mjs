// Local synthetic transfer measurement, not a latency or production benchmark.
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { RoomAgentClient } from '../client/room-agent.mjs';
import { auditRecovery } from '../server/recovery.mjs';

export async function profileDiscovery({ workCount, messageCount, samples = 3 }) {
  for (const [value, min, max] of [[workCount, 1, 400], [messageCount, 2, 1200], [samples, 1, 5]]) {
    if (!Number.isInteger(value) || value < min || value > max) throw new Error('Choose bounded synthetic fixture sizes');
  }
  const f = createAcceptanceFixture(); let server;
  try {
    const send = (type, data) => f.store.command(f.keys.owner, 'commons', { id: crypto.randomUUID(), type, data });
    for (let i = 1; i < workCount; i++) send('work.proposed', { workItemId: `profile-work-${i}`,
      title: `Observation preparation ${i}`, definitionOfDone: 'Synthetic task criteria. '.repeat(20),
      accountableMemberId: 'owner', independentVerificationRequired: false, ownerDecisionRequired: false });
    for (let i = 2; i < messageCount; i++) send('message.posted', { messageId: `profile-message-${i}`,
      body: `Synthetic unrelated discussion ${i}: ` + 'Observation notes for the local fixture. '.repeat(12) });
    const state = f.store.room('commons').state;
    assert.equal(Object.keys(state.workItems).length, workCount); assert.equal(state.messages.length, messageCount);
    server = createRoomServer({ store: f.store });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const requests = [], client = new RoomAgentClient({ origin: `http://127.0.0.1:${server.address().port}`,
      roomId: 'commons', memberId: 'producer', token: f.keys.producer,
      fetchImpl: async (url, options) => {
        assert.equal(options.method, 'GET');
        const response = await fetch(url, options);
        assert.equal(response.status, 200);
        requests.push({ route: new URL(url).pathname.split('/').at(-1),
          decodedBodyBytes: (await response.clone().arrayBuffer()).byteLength });
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
          decodedBodyBytes: requests.reduce((sum, request) => sum + request.decodedBodyBytes, 0),
          resultJsonBytes: Buffer.byteLength(JSON.stringify(result)) });
      }
    }
    assert.equal(auditRecovery(f.store).dataSha256, before);
    const metrics = Object.fromEntries(Object.entries(measured).map(([name, rows]) => [name, {
      samples: rows.length, requestsPerRead: 2, identityChecksPerRead: 1,
      decodedBodyBytes: { min: Math.min(...rows.map(row => row.decodedBodyBytes)), max: Math.max(...rows.map(row => row.decodedBodyBytes)) },
      resultJsonBytes: { min: Math.min(...rows.map(row => row.resultJsonBytes)), max: Math.max(...rows.map(row => row.resultJsonBytes)) }
    }]));
    return { workCount, messageCount, projectionJsonBytes: Buffer.byteLength(JSON.stringify(state)),
      metrics, roomAuditUnchanged: true, nativeModels: false };
  } finally {
    if (server) { server.closeStreams(); server.closeAllConnections();
      if (server.listening) await new Promise(resolve => server.close(resolve)); }
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) throw new Error('No arguments: this profiler creates disposable local fixtures only');
  const scenarios = [];
  for (const [workCount, messageCount] of [[10, 20], [100, 250], [400, 1200]]) {
    const result = await profileDiscovery({ workCount, messageCount }); scenarios.push(result);
    console.log(JSON.stringify(result));
  }
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/discovery-profile.json', JSON.stringify({ version: 1, scenarios,
    boundary: 'Synthetic local Node HTTP; decoded response bodies excluding headers/TLS/compression, not latency, tokens, memory, concurrency, Workers cost or measured user workloads. All reads retain identity preflight; no Room writes during measurement.' }, null, 2));
}
