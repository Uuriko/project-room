import test from 'node:test';
import assert from 'node:assert/strict';
import { Bridge } from '../room-acp/src/bridge.mjs';
import { ThreadQueue } from '../room-acp/src/queue.mjs';

function fixture() {
  const state = { room: { ownerId: 'owner' }, members: { owner: { id: 'owner', active: true }, next: { id: 'next', active: true }, agent: { id: 'agent', active: true, accountableHumanId: 'owner' } } };
  const counts = { prompts: 0, posts: 0, acks: 0 };
  const bridge = new Bridge({ connection: { apiBase: 'http://localhost', roomId: 'r', memberId: 'agent', hostId: 'h' }, persistSessions: false, host: {
    session: async () => ({ sessionId: 's', created: true }),
    prompt: async () => { counts.prompts++; return { recorder: { text: 'done', tools: new Map() }, stopReason: 'end_turn' }; },
    stop() {},
  } });
  bridge.fencingToken = "test-listener";
    bridge.room.checkListener = async () => ({ listener: { valid: true } });
    bridge.room.room = async () => ({ state });
  bridge.room.thread = async id => ({ thread: { id, authorId: 'owner', body: 'work', replies: [] } });
  bridge.room.post = async () => { counts.posts++; };
  bridge.room.ack = async () => { counts.acks++; };
  return { bridge, state, counts };
}
const wake = { signalId: 'wake', messageId: 'message', author: 'owner', body: 'work' };

test('refresh changes permission approver and cancels old pending authority', async () => {
  const { bridge, state } = fixture();
  await bridge.refreshRoom();
  let requestSignal;
  bridge.permissions.request = async (_request, signal) => { requestSignal = signal; return {}; };
  await bridge.onPermission({});
  state.members.agent.accountableHumanId = 'next';
  await bridge.refreshRoom();
  assert.equal(bridge.permissions.approverId, 'next');
  assert.equal(requestSignal.aborted, true);
});

test('saved result cannot post after requester removal', async () => {
  const { bridge, state, counts } = fixture();
  await bridge.refreshRoom();
  bridge.room.post = async () => { throw Error('lost connection'); };
  await bridge.turn('message', [wake]);
  assert.equal(counts.prompts, 1);
  state.members.owner.active = false;
  bridge.room.post = async () => { counts.posts++; };
  await bridge.turn('message', [wake]);
  assert.equal(counts.posts, 0);
  assert.equal(counts.prompts, 1);
});

test('queued work rechecks requester before execution', async () => {
  const { bridge, state, counts } = fixture();
  await bridge.refreshRoom();
  state.members.owner.active = false;
  await bridge.turn('message', [wake]);
  assert.equal(counts.prompts, 0);
});

test('queue retains distinct claim wakes without message IDs', async () => {
  let release;
  const calls = [];
  const queue = new ThreadQueue({ concurrency: 1, run: async (_key, batch) => { calls.push(batch.map(x => x.signalId)); if (calls.length === 1) await new Promise(resolve => { release = resolve; }); } });
  queue.push('claim', { signalId: 'one' });
  await Promise.resolve();
  queue.push('claim', { signalId: 'two' });
  queue.push('claim', { signalId: 'three' });
  release();
  await queue.idle();
  assert.deepEqual(calls, [['one'], ['two', 'three']]);
});

test('stop aborts held poll and closes active host before awaiting queue', async () => {
  const { bridge } = fixture();
  let polling;
  const started = new Promise(resolve => { polling = resolve; });
  bridge.host.start = async () => {};
  let hostStopped = false;
  bridge.host.stop = () => { hostStopped = true; };
  bridge.room.heartbeat = async () => ({ listener: { acquired: true, fencingToken: 'token', leaseExpiresAt: Date.now() + 60000 } });
  bridge.room.poll = async ({ signal }) => { polling(); await new Promise(resolve => signal?.addEventListener('abort', resolve, { once: true })); return {}; };
  bridge.room.disconnect = async () => ({});
  const running = bridge.run();
  await started;
  bridge.stop();
  assert.equal(hostStopped, true);
  await Promise.race([running, new Promise((_, reject) => setTimeout(() => reject(Error('stop left held poll alive')), 200))]);
});

test('revocation during a turn suppresses its output', async () => {
  const { bridge, state, counts } = fixture();
  bridge.host.prompt = async () => {
    counts.prompts++;
    state.members.owner.active = false;
    return { recorder: { text: 'sensitive result', tools: new Map() }, stopReason: 'end_turn' };
  };
  await bridge.turn('message', [wake]);
  assert.equal(counts.prompts, 1);
  assert.equal(counts.posts, 0);
  assert.equal(counts.acks, 1);
  assert.equal(bridge.chatReceipts.begin(wake.signalId).receipt.phase, 'discarded');
});

test('stopped queued work never creates an ambiguous execution receipt', async () => {
  const { bridge, counts } = fixture();
  bridge.stop();
  await bridge.turn('message', [wake]);
  assert.equal(counts.prompts, 0);
  assert.equal(bridge.chatReceipts.memory.size, 0);
});

test('claim replay rechecks current claim owner before posting', async () => {
  const { bridge, counts } = fixture();
  let owner = 'agent';
  bridge.room.claim = async () => ({ id: 'work', owner, history: [{ action: 'created', agentId: 'owner' }] });
  bridge.room.claimNote = async () => { throw Error('lost connection'); };
  const item = { signalId: 'claim-wake', claim: await bridge.room.claim(), author: 'owner' };
  await bridge.claimSignalTurn('work-claim:work', item);
  assert.equal(counts.prompts, 1);
  owner = 'other-agent';
  bridge.room.claimNote = async () => { counts.posts++; };
  await bridge.claimSignalTurn('work-claim:work', item);
  assert.equal(counts.posts, 0);
  assert.equal(counts.prompts, 1);
});
