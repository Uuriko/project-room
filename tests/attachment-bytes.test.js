import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createAttachmentBytes,
  DEFAULT_MAX_BYTES,
  DEFAULT_STALL_TIMEOUT_MS,
  DEFAULT_MIME_BLOCKLIST,
} from '../src/attachment-bytes.mjs';

function makeClock(start = 1_000_000) {
  let now = start;
  return {
    clock: () => now,
    advance: (ms) => {
      now += ms;
    },
  };
}

function bytesOf(n, fill = 0x41) {
  const b = new Uint8Array(n);
  b.fill(fill);
  return b;
}

/** Deterministic FNV-1a over raw bytes (mirrors the module default). */
function fnv1a(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

const SPEC = () => ({
  messageId: 'msg-1',
  attachmentId: 'att-1',
  filename: 'report.pdf',
  mimeType: 'application/pdf',
  declaredSize: 128,
});

async function assertThrowsCode(fn, code) {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof Error, 'must throw an Error');
    assert.equal(err.code, code, `expected code ${code}, got ${err.code}`);
    return;
  }
  assert.fail(`expected throw with code ${code}, but nothing was thrown`);
}

test('happy path: queued → fetching → fetched with byte count and handle', async () => {
  const { clock } = makeClock();
  const progress = [];
  const payload = bytesOf(128);
  const pipe = createAttachmentBytes({
    clock,
    fetcher: async () => ({ bytes: payload }),
    onProgress: (jobId, n) => progress.push([jobId, n]),
  });

  const q = pipe.enqueue(SPEC());
  assert.equal(q.state, 'queued');

  const done = await pipe.fetch(q.id);
  assert.equal(done.state, 'fetched');
  assert.equal(done.byteLength, 128);
  assert.equal(done.bytesSoFar, 128);
  assert.equal(done.handle, fnv1a(payload));
  assert.equal(done.attempts, 1);
  assert.ok(/^[0-9a-f]{8}$/.test(done.handle));
});

test('too-large declaredSize rejected at enqueue', async () => {
  const { clock } = makeClock();
  const pipe = createAttachmentBytes({ clock, fetcher: async () => ({ bytes: bytesOf(1) }) });
  await assertThrowsCode(
    () => pipe.enqueue({ ...SPEC(), declaredSize: DEFAULT_MAX_BYTES + 1 }),
    'AB_TOO_LARGE',
  );
  // nothing was recorded or stored on a rejected enqueue
  assert.equal(pipe.audit.length, 0);
});

test('too-large actual bytes rejected at completion', async () => {
  const { clock } = makeClock();
  const pipe = createAttachmentBytes({
    clock,
    maxBytes: 100,
    fetcher: async () => ({ bytes: bytesOf(101) }),
  });
  const q = pipe.enqueue({ ...SPEC(), declaredSize: 10 });
  const done = await pipe.fetch(q.id);
  assert.equal(done.state, 'failed');
  assert.equal(done.failCode, 'AB_TOO_LARGE');
  assert.match(done.failReason, /exceeds maxBytes/);
  assert.equal(done.handle, null);
  assert.equal(done.byteLength, null);
});

test('blocked mime rejected at enqueue', async () => {
  const { clock } = makeClock();
  const pipe = createAttachmentBytes({ clock, fetcher: async () => ({ bytes: bytesOf(1) }) });
  assert.ok(DEFAULT_MIME_BLOCKLIST.includes('application/x-msdownload'));
  await assertThrowsCode(
    () => pipe.enqueue({ ...SPEC(), mimeType: 'application/x-msdownload' }),
    'AB_MIME_REJECTED',
  );
  await assertThrowsCode(
    () => pipe.enqueue({ ...SPEC(), mimeType: 'application/x-sh' }),
    'AB_MIME_REJECTED',
  );
});

test('mime not on allowlist rejected at enqueue', async () => {
  const { clock } = makeClock();
  const pipe = createAttachmentBytes({
    clock,
    mimeAllowlist: ['image/png'],
    fetcher: async () => ({ bytes: bytesOf(1) }),
  });
  await assertThrowsCode(
    () => pipe.enqueue({ ...SPEC(), mimeType: 'application/pdf' }),
    'AB_MIME_REJECTED',
  );
  const ok = pipe.enqueue({ ...SPEC(), mimeType: 'image/png' });
  assert.equal(ok.state, 'queued');
});

test('retry-once: transient fetcher failure retried exactly once', async () => {
  const { clock } = makeClock();
  let calls = 0;
  const payload = bytesOf(64);
  const pipe = createAttachmentBytes({
    clock,
    fetcher: async () => {
      calls += 1;
      if (calls === 1) {
        const err = new Error('gateway blip');
        err.transient = true;
        throw err;
      }
      return { bytes: payload };
    },
  });
  const q = pipe.enqueue(SPEC());
  const done = await pipe.fetch(q.id);
  assert.equal(done.state, 'fetched');
  assert.equal(done.attempts, 2);
  assert.equal(calls, 2);
});

test('non-transient fetcher failure fails without retry', async () => {
  const { clock } = makeClock();
  let calls = 0;
  const pipe = createAttachmentBytes({
    clock,
    fetcher: async () => {
      calls += 1;
      throw new Error('message gone');
    },
  });
  const q = pipe.enqueue(SPEC());
  const done = await pipe.fetch(q.id);
  assert.equal(done.state, 'failed');
  assert.equal(done.failCode, 'AB_FETCH_FAILED');
  assert.equal(done.attempts, 1);
  assert.equal(calls, 1);
});

test('double transient failure fails after the single retry', async () => {
  const { clock } = makeClock();
  let calls = 0;
  const pipe = createAttachmentBytes({
    clock,
    fetcher: async () => {
      calls += 1;
      const err = new Error('still down');
      err.transient = true;
      throw err;
    },
  });
  const q = pipe.enqueue(SPEC());
  const done = await pipe.fetch(q.id);
  assert.equal(done.state, 'failed');
  assert.equal(done.failCode, 'AB_FETCH_FAILED');
  assert.equal(calls, 2);
});

test('stall sweep expires fetching jobs with no progress', async () => {
  const t = makeClock();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const pipe = createAttachmentBytes({
    clock: t.clock,
    stallTimeoutMs: 60_000,
    fetcher: () => gate,
  });
  const q = pipe.enqueue(SPEC());
  const pending = pipe.fetch(q.id);
  assert.equal(pipe.get(q.id).state, 'fetching');

  t.advance(60_001);
  const swept = pipe.sweep();
  assert.deepEqual(swept, [q.id]);
  assert.equal(pipe.get(q.id).state, 'expired');

  // A late fetcher resolution must not resurrect the expired job.
  release({ bytes: bytesOf(10) });
  const late = await pending;
  assert.equal(late.state, 'expired');
  assert.equal(late.byteLength, null);
});

test('active fetching jobs are not swept', async () => {
  const t = makeClock();
  let report;
  const pipe = createAttachmentBytes({
    clock: t.clock,
    stallTimeoutMs: 60_000,
    fetcher: async (_job, hooks) => {
      report = hooks.reportProgress;
      return new Promise(() => {});
    },
  });
  const q = pipe.enqueue(SPEC());
  pipe.fetch(q.id).catch(() => {});
  t.advance(50_000);
  report(42); // progress resets the stall clock
  t.advance(50_000);
  const swept = pipe.sweep();
  assert.deepEqual(swept, []);
  assert.equal(pipe.get(q.id).state, 'fetching');
  pipe.cancel(q.id); // cleanup: stop the pending fetcher from holding state
});

test('cancel from queued and from fetching', async () => {
  const { clock } = makeClock();
  const pipe = createAttachmentBytes({
    clock,
    fetcher: () => new Promise(() => {}),
  });
  const q1 = pipe.enqueue(SPEC());
  const c1 = pipe.cancel(q1.id);
  assert.equal(c1.state, 'cancelled');

  const q2 = pipe.enqueue({ ...SPEC(), attachmentId: 'att-2' });
  const p2 = pipe.fetch(q2.id);
  p2.catch(() => {});
  const c2 = pipe.cancel(q2.id);
  assert.equal(c2.state, 'cancelled');
  assert.equal(pipe.get(q2.id).state, 'cancelled');
});

test('progress callbacks stream bytesSoFar to onProgress', async () => {
  const { clock } = makeClock();
  const seen = [];
  const pipe = createAttachmentBytes({
    clock,
    fetcher: async (_job, { reportProgress }) => {
      reportProgress(50);
      reportProgress(100);
      return { bytes: bytesOf(100) };
    },
    onProgress: (jobId, n) => seen.push([jobId, n]),
  });
  const q = pipe.enqueue(SPEC());
  await pipe.fetch(q.id);
  assert.deepEqual(seen, [
    [q.id, 50],
    [q.id, 100],
  ]);
  assert.equal(pipe.get(q.id).bytesSoFar, 100);
});

test('default stall timeout matches export', () => {
  assert.equal(DEFAULT_STALL_TIMEOUT_MS, 5 * 60 * 1000);
});

test('coded-error contract: every failure carries an AB_ code', async () => {
  const { clock } = makeClock();
  const pipe = createAttachmentBytes({ clock, fetcher: async () => ({ bytes: bytesOf(1) }) });

  const cases = [
    [() => pipe.enqueue({ messageId: 'm' }), 'AB_INVALID_JOB'],
    [() => pipe.enqueue({ ...SPEC(), mimeType: 'application/x-msdownload' }), 'AB_MIME_REJECTED'],
    [() => pipe.enqueue({ ...SPEC(), declaredSize: DEFAULT_MAX_BYTES + 1 }), 'AB_TOO_LARGE'],
    [() => pipe.fetch('nope'), 'AB_NOT_FOUND'],
    [() => pipe.cancel('nope'), 'AB_NOT_FOUND'],
  ];
  for (const [fn, code] of cases) {
    await assertThrowsCode(fn, code);
  }

  const q = pipe.enqueue(SPEC());
  const done = await pipe.fetch(q.id);
  assert.equal(done.state, 'fetched');
  await assertThrowsCode(() => pipe.fetch(q.id), 'AB_INVALID_TRANSITION');
  await assertThrowsCode(() => pipe.cancel(q.id), 'AB_INVALID_TRANSITION');
});

test('enqueue requires an injected fetcher before work can start', async () => {
  const { clock } = makeClock();
  const pipe = createAttachmentBytes({ clock });
  await assertThrowsCode(() => pipe.enqueue(SPEC()), 'AB_FETCH_FAILED');
});

test('audit trail records every transition', async () => {
  const { clock } = makeClock();
  const pipe = createAttachmentBytes({ clock, fetcher: async () => ({ bytes: bytesOf(8) }) });
  const q = pipe.enqueue(SPEC());
  await pipe.fetch(q.id);
  const states = pipe.audit.map((e) => e.to);
  assert.deepEqual(states, ['queued', 'fetching', 'fetched']);
  for (const entry of pipe.audit) {
    assert.ok(typeof entry.at === 'number');
    assert.equal(entry.detail.jobId, q.id);
  }
});

test('injected hasher produces the content-addressed handle', async () => {
  const { clock } = makeClock();
  const pipe = createAttachmentBytes({
    clock,
    hasher: () => 'test-handle-123',
    fetcher: async () => ({ bytes: bytesOf(16) }),
  });
  const done = await pipe.fetch(pipe.enqueue(SPEC()).id);
  assert.equal(done.handle, 'test-handle-123');
});
