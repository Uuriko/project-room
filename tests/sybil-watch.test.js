// FIX-77: sybil-resistant claim caps — advisory mint-cluster detection.
//
// Per-member claim caps (docs/WORK-CLAIMS.md "Caps": 20 open claims per
// member) are identity-based, but anonymous identities are self-minted at
// POST /api/agent-identities (server/agent-identities.mjs), so one operator
// can mint N identities and hold N x 20 claims. This module adds an ADVISORY
// signal: N distinct anonymous-mint identities sharing one mint fingerprint
// (mint_network) holding claims in the same room within a window. Advisory
// only — it never refuses a claim. Invite/in-process mints carry no mint
// fingerprint (mint_address IS NULL in agent_identities) and are excluded
// by construction, so a provisioned fleet (e.g. John's own hundreds of
// agents, provisioned rather than anonymously self-minted) cannot trip it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SYBIL_CLUSTER_THRESHOLD,
  SYBIL_CLUSTER_WINDOW_MS,
  detectSybilClusters,
  sybilAdvisoryText,
  validateSybilAdvisory,
} from '../server/sybil-watch.mjs';
import { RoomAgentClient } from '../client/room-agent.mjs';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';

const fp = network => ({ address: `addr-for-${network}`, network });
const holder = (memberId, identityId, claimedAt = 1000) => ({ memberId, identityId, claimedAt });

test('detectSybilClusters flags N distinct anonymous-mint identities on one mint network', () => {
  const holders = ['a', 'b', 'c', 'd', 'e'].map(m => holder(`m-${m}`, `ai-${m}`));
  const fingerprints = new Map(holders.map(h => [h.identityId, fp('net-sybil')]));
  const clusters = detectSybilClusters({ holders, fingerprints, now: 2000 });
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].network, 'net-sybil');
  assert.equal(clusters[0].size, 5);
  assert.deepEqual([...clusters[0].memberIds].sort(), ['m-a', 'm-b', 'm-c', 'm-d', 'm-e']);
});

test('detectSybilClusters stays silent below the threshold', () => {
  const holders = ['a', 'b', 'c', 'd'].map(m => holder(`m-${m}`, `ai-${m}`));
  const fingerprints = new Map(holders.map(h => [h.identityId, fp('net-sybil')]));
  assert.deepEqual(detectSybilClusters({ holders, fingerprints, now: 2000 }), []);
});

test('detectSybilClusters never flags invite/in-process mints (no fingerprint)', () => {
  // John's provisioned fleet: mint_address IS NULL, so fingerprints has no
  // entry. Even a dozen provisioned identities sharing a room is not a
  // cluster — the heuristic cannot distinguish them from a sybil, so it
  // excludes them by construction instead of trying.
  const holders = Array.from({ length: 12 }, (_, i) => holder(`fleet-${i}`, `ai-fleet-${i}`));
  const fingerprints = new Map(); // invite/in-process mints: no mint fingerprint
  assert.deepEqual(detectSybilClusters({ holders, fingerprints, now: 2000 }), []);
});

test('detectSybilClusters counts distinct identities, not claims', () => {
  const holders = [
    holder('m-a', 'ai-a'), holder('m-a', 'ai-a'), // one identity, two claims
    holder('m-b', 'ai-b'), holder('m-c', 'ai-c'), holder('m-d', 'ai-d'),
  ];
  const fingerprints = new Map(['ai-a', 'ai-b', 'ai-c', 'ai-d'].map(id => [id, fp('net-x')]));
  assert.deepEqual(detectSybilClusters({ holders, fingerprints, now: 2000 }), [],
    '4 distinct identities must not trip a threshold of 5');
});

test('detectSybilClusters ignores claims outside the window', () => {
  const holders = ['a', 'b', 'c', 'd', 'e'].map(m => holder(`m-${m}`, `ai-${m}`, 1000));
  holders[4] = holder('m-e', 'ai-e', 1000 - SYBIL_CLUSTER_WINDOW_MS - 1); // stale
  const fingerprints = new Map(holders.map(h => [h.identityId, fp('net-old')]));
  assert.deepEqual(detectSybilClusters({ holders, fingerprints, now: 1000 }), []);
});

test('sybilAdvisoryText is advisory, names the signal, never an accusation', () => {
  const text = sybilAdvisoryText({ network: 'net-sybil', size: 5, memberIds: ['m-a'] });
  assert.match(text, /advisory/i);
  assert.match(text, /5/);
  assert.ok(!/sybil attack confirmed|has been banned|will be punished/i.test(text),
    'advisory must not accuse or promise enforcement');
  assert.match(text, /nothing was blocked/i, 'advisory states explicitly that nothing was blocked');
});

test('validateSybilAdvisory accepts the module output and rejects junk', () => {
  const good = { network: 'net-sybil', size: 5, memberIds: ['m-a', 'm-b'], windowMs: SYBIL_CLUSTER_WINDOW_MS, threshold: SYBIL_CLUSTER_THRESHOLD, text: 'advisory' };
  assert.equal(validateSybilAdvisory(good), true);
  assert.equal(validateSybilAdvisory(null), false);
  assert.equal(validateSybilAdvisory({ ...good, size: 2 }), false, 'below threshold is not a cluster');
  assert.equal(validateSybilAdvisory({ ...good, memberIds: 'm-a' }), false);
});

// --- HTTP wiring: the advisory rides the work_claim.updated room event ---

async function fixture(t, memberCount) {
  const store = new RoomStore(':memory:');
  store.initialize(initialRoom('commons'));
  const ownerKey = store.issueAccessKey('commons', 'owner');
  const clients = [];
  for (let i = 0; i < memberCount; i++) {
    const memberId = `m-${i}`;
    store.command(store.issueAccessKey('commons', 'owner'), 'commons', { id: `add-${memberId}`, type: 'member.added',
      data: { memberId, displayName: `Member ${i}`, kind: 'agent', permissions: ['accept_work', 'complete_work'] } });
    const identityId = `ai-${i}`;
    store.db.prepare('INSERT INTO agent_identities(identity_id,secret_hash,display_name,created_at,mint_address,mint_network) VALUES(?,?,?,?,?,?)')
      .run(identityId, `hash-${i}`, `Member ${i}`, Date.now(), `addr-hash-${i}`, 'net-sybil');
    store.db.prepare('INSERT INTO identity_links(room_id,identity_id,member_id,linked_at) VALUES(?,?,?,?)')
      .run('commons', identityId, memberId, Date.now());
    clients.push({ token: store.issueAccessKey('commons', memberId) });
  }
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const agents = clients.map(c => new RoomAgentClient({ origin, roomId: 'commons', token: c.token }));
  return { store, clients: agents };
}

const claimEvents = async client => (await client.changes(0, 100)).events
  .filter(row => row.event.type === 'work_claim.updated')
  .map(row => row.event.data);

test('HTTP: the 5th same-network anonymous claim carries a sybilAdvisory on its room event', async t => {
  const { clients } = await fixture(t, 5);
  for (let i = 0; i < 5; i++) await clients[i].workClaim(`lane-${i}`, { title: `Lane ${i}` });
  const events = await claimEvents(clients[0]);
  const claimed = events.filter(e => e.action === 'claimed');
  assert.equal(claimed.length, 5);
  for (const e of claimed.slice(0, 4)) assert.equal(e.sybilAdvisory, undefined, 'no advisory below threshold');
  const advisory = claimed[4].sybilAdvisory;
  assert.ok(advisory, '5th same-network claim flags the advisory');
  assert.equal(validateSybilAdvisory(advisory), true);
  assert.equal(advisory.network, 'net-sybil');
  assert.equal(advisory.size, 5);
});

test('HTTP: four same-network claims stay silent', async t => {
  const { clients } = await fixture(t, 4);
  for (let i = 0; i < 4; i++) await clients[i].workClaim(`lane-${i}`, { title: `Lane ${i}` });
  const events = await claimEvents(clients[0]);
  assert.ok(events.filter(e => e.action === 'claimed').every(e => e.sybilAdvisory === undefined));
});
