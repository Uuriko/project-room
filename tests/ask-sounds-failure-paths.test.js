// Independent failure-path probes for the ask-sounds first slice (WAVE-500 g3).
// The module's contract: every failure (no Web Audio, refused autoplay, blocked
// storage) is silent AND the player stays usable. Two spots break that contract
// when a promise-returning collaborator throws synchronously instead of
// rejecting: the player wedges (unlocking stuck, stale pending) and the ledger
// throws out of a promise-returning API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoomSounds, createCueLedger } from '../src/ask-sounds.js';

const flush = async () => { for (let i = 0; i < 5; i += 1) await new Promise(resolve => setImmediate(resolve)); };
const visibleDoc = () => ({ visibilityState: 'visible' });

// An AudioContext whose resume() throws synchronously (hardened/shimmed
// environments do this instead of returning a rejected promise).
function syncThrowAudio() {
  const started = [];
  class Ctx {
    constructor() { this.state = 'suspended'; this.currentTime = 0; this.destination = {}; }
    resume() { throw new Error('resume unavailable'); }
    createGain() { return { gain: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, setTargetAtTime() {} }, connect() {} }; }
    createOscillator() { return { frequency: { value: 0 }, connect() {}, start() { started.push(this.frequency.value); }, stop() {} }; }
  }
  return { Ctx, started };
}

// Same, but resume() starts throwing only after the first successful unlock.
function flakyAudio() {
  const good = syncThrowAudio();
  let calls = 0; const instances = [];
  class Ctx extends good.Ctx {
    constructor() { super(); instances.push(this); }
    resume() { calls += 1; if (calls === 1) { this.state = 'running'; return Promise.resolve(); } return super.resume(); }
  }
  return { Ctx, started: good.started, calls: () => calls, instances };
}

test('a synchronously-throwing resume() stays silent and does not wedge the player', async () => {
  const audio = syncThrowAudio();
  const sounds = createRoomSounds({ enabled: () => true, AudioContext: audio.Ctx, doc: visibleDoc() });
  assert.equal(sounds.play('result-ready'), false, 'the failed cue reports false, not true');
  await flush();
  assert.equal(audio.started.length, 0, 'nothing sounded');
  // The player must still be usable: a later working unlock plays again.
  const flaky = flakyAudio();
  let t = 0;
  const sounds2 = createRoomSounds({ enabled: () => true, AudioContext: flaky.Ctx, doc: visibleDoc(), now: () => t });
  // First unlock succeeds and plays…
  assert.equal(sounds2.play('picked-up'), true);
  await flush();
  assert.ok(flaky.started.length > 0, 'first cue played after unlock');
  // …then resume() starts throwing synchronously: silent, and the NEXT
  // attempt must still try (no stuck `unlocking` flag).
  flaky.instances[0].state = 'suspended'; // the browser suspended it again
  t += 2000; // past the rate-limit gap so the unlock is actually attempted
  assert.equal(sounds2.play('needs-you'), false, 'failed cue is honest');
  await flush();
  assert.equal(flaky.calls(), 2, 'the unlock was attempted');
  // One more attempt: without the fix this returns true while never calling
  // resume() again (wedged); with the fix it retries and reports honestly.
  t += 2000;
  assert.equal(sounds2.play('result-ready'), false, 'still honest, never claims a cue it cannot play');
  assert.equal(flaky.calls(), 3, 'a later play() retries the unlock instead of staying wedged');
});

test('a synchronously-throwing locks.request() resolves false instead of throwing', async () => {
  const throwingLocks = { request() { throw new Error('locks unavailable'); } };
  const ledger = createCueLedger({ locks: throwingLocks });
  await assert.doesNotReject(ledger.claim('result:x'), 'claim() keeps its promise contract');
  assert.equal(await ledger.claim('result:x'), false);
  assert.equal(await ledger.mark('result:y'), false);
});
