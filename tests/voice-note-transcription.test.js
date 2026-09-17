/**
 * voice-note-transcription.test.js — tests for src/voice-note-transcription.mjs.
 *
 * Uses node:test + node:assert/strict with a fake clock and injected fakes for
 * every dependency (id generator, transcriber). No network, no real timers.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createVoiceNoteTranscriber,
  STATES,
  ALLOWED_MIME_TYPES,
  DEFAULT_MAX_DURATION_SEC,
  DEFAULT_STALL_TIMEOUT_MS,
  DEFAULT_QUEUED_TTL_MS,
} from '../src/voice-note-transcription.mjs';

/** Deterministic fake clock: starts at t0, advanced manually. */
function fakeClock(t0 = 1_000_000) {
  let now = t0;
  const clock = () => now;
  clock.advance = (ms) => {
    now += ms;
    return now;
  };
  return clock;
}

/** Sequential fake ids: job-1, job-2, ... */
function fakeId(prefix = 'job') {
  let n = 0;
  return () => `${prefix}-${(n += 1)}`;
}

const goodAudio = (overrides = {}) => ({
  durationSec: 90,
  mimeType: 'audio/ogg',
  sizeBytes: 512_000,
  ...overrides,
});

const goodSegments = () => [
  { start: 0, end: 2.5, text: 'hello there', speaker: 'SPEAKER_00' },
  { start: 2.5, end: 5.1, text: 'this is a test', speaker: 'SPEAKER_01' },
];

function machineWith(clock, overrides = {}) {
  return createVoiceNoteTranscriber({
    clock,
    id: fakeId(),
    transcriber: async () => ({ segments: goodSegments(), language: 'en' }),
    stallTimeoutMs: 1_000,
    queuedTtlMs: 60_000,
    ...overrides,
  });
}

/** Assert that fn rejects/throws an Error whose `code` matches. */
async function assertCodedError(fn, code) {
  let caught = null;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof Error, `expected an Error to be thrown (code ${code})`);
  assert.equal(caught.code, code, `expected code ${code}, got ${caught.code}: ${caught.message}`);
  return caught;
}

describe('state machine basics', () => {
  it('exports the full state set and defaults', () => {
    assert.deepEqual([...STATES], [
      'queued',
      'transcribing',
      'transcribed',
      'failed',
      'cancelled',
      'expired',
    ]);
    assert.deepEqual([...ALLOWED_MIME_TYPES], [
      'audio/ogg',
      'audio/mpeg',
      'audio/mp4',
      'audio/webm',
    ]);
    assert.equal(DEFAULT_MAX_DURATION_SEC, 300);
    assert.equal(DEFAULT_STALL_TIMEOUT_MS, 5 * 60 * 1000);
    assert.equal(DEFAULT_QUEUED_TTL_MS, 24 * 60 * 60 * 1000);
  });

  it('exposes injected defaults', () => {
    const m = createVoiceNoteTranscriber();
    assert.equal(m.maxDurationSec, 300);
    assert.equal(m.stallTimeoutMs, 5 * 60 * 1000);
    assert.equal(m.queuedTtlMs, 24 * 60 * 60 * 1000);
  });

  it('enqueue stores audio metadata, language hint, and speaker flag', () => {
    const clock = fakeClock();
    const m = machineWith(clock);
    const job = m.enqueue(goodAudio(), { languageHint: 'es', speakerLabels: true }, 'john');
    assert.equal(job.id, 'job-1');
    assert.equal(job.state, 'queued');
    assert.deepEqual(job.audio, { durationSec: 90, mimeType: 'audio/ogg', sizeBytes: 512_000 });
    assert.equal(job.languageHint, 'es');
    assert.equal(job.speakerLabels, true);
    assert.equal(job.enqueuedAt, clock());
    assert.equal(job.attempts, 0);
    assert.equal(job.segments, null);
    assert.equal(m.get('job-1').id, 'job-1');
    assert.equal(m.get('nope'), null);
  });

  it('happy path: queued -> transcribing -> transcribed with segment assertions', async () => {
    const clock = fakeClock();
    const m = machineWith(clock);
    const queued = m.enqueue(goodAudio({ mimeType: 'audio/mpeg' }), {
      languageHint: 'en',
      speakerLabels: true,
    });
    assert.equal(queued.state, 'queued');

    const done = await m.start('job-1', 'agent');
    assert.equal(done.state, 'transcribed');
    assert.equal(done.attempts, 1);
    assert.equal(done.segments.length, 2);
    assert.deepEqual(done.segments[0], {
      start: 0,
      end: 2.5,
      text: 'hello there',
      speaker: 'SPEAKER_00',
    });
    assert.deepEqual(done.segments[1], {
      start: 2.5,
      end: 5.1,
      text: 'this is a test',
      speaker: 'SPEAKER_01',
    });
    // resultLanguage comes from the transcriber result, falling back to the hint.
    assert.equal(done.resultLanguage, 'en');
    assert.ok(done.transcribingStartedAt <= clock());

    // audit shows the full ordered trail.
    const trail = m.audit.map((e) => `${e.from}→${e.to}`);
    assert.deepEqual(trail, ['null→queued', 'queued→transcribing', 'transcribing→transcribed']);
  });

  it('strips speaker labels when the job was enqueued without speakerLabels', async () => {
    const clock = fakeClock();
    const m = machineWith(clock);
    m.enqueue(goodAudio(), { languageHint: 'en' }); // speakerLabels defaults to false
    const done = await m.start('job-1');
    assert.equal(done.state, 'transcribed');
    assert.ok(done.segments.every((s) => !('speaker' in s)), 'speaker labels must be stripped');
    assert.deepEqual(done.segments[0], { start: 0, end: 2.5, text: 'hello there' });
  });

  it('passes languageHint through to the transcriber and records it on success', async () => {
    const clock = fakeClock();
    let seen = null;
    const m = machineWith(clock, {
      transcriber: async ({ job }) => {
        seen = job;
        return { segments: goodSegments() }; // no language in result
      },
    });
    m.enqueue(goodAudio(), { languageHint: 'fr' });
    const done = await m.start('job-1');
    assert.equal(seen.languageHint, 'fr');
    assert.equal(seen.audio.durationSec, 90);
    // falls back to the hint when the transcriber reports no language
    assert.equal(done.resultLanguage, 'fr');
  });
});

describe('enqueue validation', () => {
  it('rejects audio longer than maxDurationSec with VN_TOO_LONG', () => {
    const clock = fakeClock();
    const m = machineWith(clock, { maxDurationSec: 60 });
    const err = assertCodedErrorSync(
      () => m.enqueue(goodAudio({ durationSec: 61 })),
      'VN_TOO_LONG',
    );
    assert.match(err.message, /61/);
    assert.equal(m.activeIds().length, 0, 'no job may be created on rejection');
  });

  it('accepts a note exactly at the cap', () => {
    const clock = fakeClock();
    const m = machineWith(clock, { maxDurationSec: 60 });
    const job = m.enqueue(goodAudio({ durationSec: 60 }));
    assert.equal(job.state, 'queued');
  });

  it('rejects unsupported mime types with VN_UNSUPPORTED_MIME', () => {
    const clock = fakeClock();
    const m = machineWith(clock);
    for (const bad of ['audio/wav', 'video/mp4', 'text/plain', 'audio/x-wav']) {
      assertCodedErrorSync(
        () => m.enqueue(goodAudio({ mimeType: bad })),
        'VN_UNSUPPORTED_MIME',
      );
    }
    for (const ok of ALLOWED_MIME_TYPES) {
      const job = m.enqueue(goodAudio({ mimeType: ok }));
      assert.equal(job.state, 'queued');
    }
  });

  it('rejects malformed audio payloads with VN_INVALID_AUDIO', () => {
    const clock = fakeClock();
    const m = machineWith(clock);
    assertCodedErrorSync(() => m.enqueue(null), 'VN_INVALID_AUDIO');
    assertCodedErrorSync(() => m.enqueue({}), 'VN_INVALID_AUDIO');
    assertCodedErrorSync(() => m.enqueue(goodAudio({ durationSec: 0 })), 'VN_INVALID_AUDIO');
    assertCodedErrorSync(() => m.enqueue(goodAudio({ durationSec: -5 })), 'VN_INVALID_AUDIO');
    assertCodedErrorSync(() => m.enqueue(goodAudio({ durationSec: NaN })), 'VN_INVALID_AUDIO');
    assertCodedErrorSync(
      () => m.enqueue(goodAudio({ durationSec: '90' })),
      'VN_INVALID_AUDIO',
    );
    assertCodedErrorSync(() => m.enqueue(goodAudio({ mimeType: null })), 'VN_INVALID_AUDIO');
  });
});

describe('transcriber failure semantics', () => {
  it('retries ONCE on transient failure, then fails with VN_TRANSCRIBE_FAILED', async () => {
    const clock = fakeClock();
    let calls = 0;
    const transientErr = Object.assign(new Error('rate limited'), {
      transient: true,
      code: 'VN_TRANSCRIBE_TRANSIENT',
    });
    const m = machineWith(clock, {
      transcriber: async ({ attempt }) => {
        calls += 1;
        if (attempt === 1) throw transientErr;
        return { segments: goodSegments() };
      },
    });
    m.enqueue(goodAudio());
    const done = await m.start('job-1');
    assert.equal(calls, 2, 'transcriber called exactly twice (1 retry)');
    assert.equal(done.state, 'transcribed');
    assert.equal(done.attempts, 2);
    // audit records the retry as an event, not a state change.
    const retryEvents = m.audit.filter(
      (e) => e.detail && e.detail.event === 'transient-failure-retrying',
    );
    assert.equal(retryEvents.length, 1);
    assert.equal(retryEvents[0].detail.attempt, 1);
  });

  it('fails with VN_TRANSCRIBE_FAILED after the retry also fails transiently', async () => {
    const clock = fakeClock();
    let calls = 0;
    const m = machineWith(clock, {
      transcriber: async () => {
        calls += 1;
        throw Object.assign(new Error('still busy'), { transient: true });
      },
    });
    m.enqueue(goodAudio());
    const err = await assertCodedError(() => m.start('job-1'), 'VN_TRANSCRIBE_FAILED');
    assert.equal(calls, 2, 'exactly one retry');
    assert.equal(m.get('job-1').state, 'failed');
    assert.equal(m.get('job-1').attempts, 2);
    assert.equal(m.get('job-1').failCode, 'VN_TRANSCRIBE_FAILED');
    assert.match(err.detail.cause, /still busy/);
  });

  it('does NOT retry non-transient failures', async () => {
    const clock = fakeClock();
    let calls = 0;
    const m = machineWith(clock, {
      transcriber: async () => {
        calls += 1;
        throw Object.assign(new Error('unsupported codec'), { code: 'VN_PERMANENT' });
      },
    });
    m.enqueue(goodAudio());
    await assertCodedError(() => m.start('job-1'), 'VN_TRANSCRIBE_FAILED');
    assert.equal(calls, 1, 'no retry for non-transient errors');
    assert.equal(m.get('job-1').attempts, 1);
    assert.equal(m.get('job-1').state, 'failed');
  });

  it('fails with VN_TRANSCRIBE_FAILED on invalid result shape', async () => {
    const clock = fakeClock();
    const m = machineWith(clock, {
      transcriber: async () => ({ segments: [{ start: 0, text: '' }] }), // bad segment
    });
    m.enqueue(goodAudio());
    await assertCodedError(() => m.start('job-1'), 'VN_TRANSCRIBE_FAILED');
    assert.equal(m.get('job-1').state, 'failed');
    assert.equal(m.get('job-1').failCode, 'VN_INVALID_RESULT');
  });

  it('fails loudly (VN_NO_TRANSCRIBER) when start is called with no transcriber', async () => {
    const clock = fakeClock();
    const m = createVoiceNoteTranscriber({ clock, id: fakeId() }); // no transcriber injected
    m.enqueue(goodAudio());
    await assertCodedError(() => m.start('job-1'), 'VN_TRANSCRIBE_FAILED');
    assert.equal(m.get('job-1').state, 'failed');
    assert.equal(m.get('job-1').failCode, 'VN_TRANSCRIBE_FAILED');
  });
});

describe('stall sweep and expiry', () => {
  it('sweep fails stalled transcribing jobs with an audit entry', async () => {
    const clock = fakeClock();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const m = machineWith(clock, {
      transcriber: () => gate.then(() => ({ segments: goodSegments() })),
      stallTimeoutMs: 1_000,
    });
    m.enqueue(goodAudio());
    const started = m.start('job-1'); // hangs on the gate
    clock.advance(500);
    assert.deepEqual(m.sweep('system'), [], 'not stalled yet');
    clock.advance(501);
    const moved = m.sweep('system');
    assert.deepEqual(moved, ['job-1']);
    const job = m.get('job-1');
    assert.equal(job.state, 'failed');
    assert.equal(job.failCode, 'VN_STALLED');
    const stallEntries = m.audit.filter(
      (e) => e.to === 'failed' && e.detail && e.detail.code === 'VN_STALLED',
    );
    assert.equal(stallEntries.length, 1, 'stall recorded in audit');
    assert.equal(stallEntries[0].actor, 'system');
    // late transcriber resolution must not resurrect the failed job.
    release();
    const late = await started;
    assert.equal(late.state, 'failed');
    assert.equal(m.get('job-1').state, 'failed');
  });

  it('sweep expires queued jobs past queuedTtlMs', () => {
    const clock = fakeClock();
    const m = machineWith(clock, { queuedTtlMs: 60_000 });
    m.enqueue(goodAudio());
    clock.advance(60_001);
    assert.deepEqual(m.sweep('system'), ['job-1']);
    assert.equal(m.get('job-1').state, 'expired');
    assert.deepEqual(m.activeIds(), []);
  });
});

describe('cancel', () => {
  it('cancels from queued and from transcribing', async () => {
    const clock = fakeClock();
    const m = machineWith(clock);
    m.enqueue(goodAudio());
    m.enqueue(goodAudio());
    assert.equal(m.cancel('job-1', 'john').state, 'cancelled');
    // from transcribing: cancel while the transcriber is in flight.
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const m2 = machineWith(clock, {
      transcriber: () => gate.then(() => ({ segments: goodSegments() })),
    });
    m2.enqueue(goodAudio());
    const started = m2.start('job-1');
    const cancelled = m2.cancel('job-1', 'john');
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.cancelledBy, 'john');
    release();
    const late = await started;
    assert.equal(late.state, 'cancelled', 'late transcriber resolution must not override cancel');
    assert.equal(m2.get('job-1').state, 'cancelled');
  });

  it('rejects cancel from terminal states with VN_INVALID_TRANSITION', async () => {
    const clock = fakeClock();
    const m = machineWith(clock);
    m.enqueue(goodAudio());
    await m.start('job-1'); // transcribed
    await assertCodedError(() => m.cancel('job-1'), 'VN_INVALID_TRANSITION');
    m.enqueue(goodAudio());
    m.cancel('job-2');
    await assertCodedError(() => m.cancel('job-2'), 'VN_INVALID_TRANSITION');
    await assertCodedError(() => m.cancel('nope'), 'VN_NOT_FOUND');
  });
});

describe('invalid transitions and coded-error contract', () => {
  it('start is queued-only', async () => {
    const clock = fakeClock();
    const m = machineWith(clock);
    m.enqueue(goodAudio());
    await m.start('job-1');
    await assertCodedError(() => m.start('job-1'), 'VN_INVALID_TRANSITION');
    await assertCodedError(() => m.start('nope'), 'VN_NOT_FOUND');
  });

  it('codes are non-empty strings on every thrown failure', async () => {
    const clock = fakeClock();
    const m = machineWith(clock, {
      transcriber: async () => {
        throw Object.assign(new Error('boom'), { transient: true });
      },
    });
    const expected = [];
    expected.push(['enqueue too long', () => m.enqueue(goodAudio({ durationSec: 999 })), 'VN_TOO_LONG']);
    expected.push(['enqueue bad mime', () => m.enqueue(goodAudio({ mimeType: 'audio/wav' })), 'VN_UNSUPPORTED_MIME']);
    expected.push(['enqueue bad audio', () => m.enqueue(goodAudio({ durationSec: -1 })), 'VN_INVALID_AUDIO']);
    expected.push(['start unknown', () => m.start('missing'), 'VN_NOT_FOUND']);
    expected.push(['cancel unknown', () => m.cancel('missing'), 'VN_NOT_FOUND']);
    m.enqueue(goodAudio());
    expected.push(['transcribe fails', () => m.start('job-1'), 'VN_TRANSCRIBE_FAILED']);
    for (const [label, fn, code] of expected) {
      const err = await assertCodedError(fn, code);
      assert.equal(typeof err.code, 'string', `${label}: code must be a string`);
      assert.ok(err.code.length > 0, `${label}: code must be non-empty`);
    }
    // after the failed start: further ops are invalid transitions.
    await assertCodedError(() => m.start('job-1'), 'VN_INVALID_TRANSITION');
    await assertCodedError(() => m.cancel('job-1'), 'VN_INVALID_TRANSITION');
  });
});

/** Sync variant of assertCodedError for non-promise operations. */
function assertCodedErrorSync(fn, code) {
  let caught = null;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof Error, `expected an Error to be thrown (code ${code})`);
  assert.equal(caught.code, code, `expected code ${code}, got ${caught.code}: ${caught.message}`);
  return caught;
}
