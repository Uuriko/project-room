import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTelegramOutbound,
  defaultChunker,
  TELEGRAM_MAX_MESSAGE_CHARS,
  PARSE_MODES,
  STATES,
} from '../src/telegram-outbound.mjs';

/** Deterministic fake clock; advance with .tick(ms). */
function makeClock(start = 1_000_000) {
  let now = start;
  const clock = () => now;
  clock.tick = (ms) => {
    now += ms;
  };
  return clock;
}

function makeIds(prefix = 'm') {
  let n = 0;
  return () => `${prefix}-${(n += 1)}`;
}

/** Sender stub that always succeeds; records every payload it receives. */
function makeSender() {
  const calls = [];
  const sender = async (payload) => {
    calls.push(payload);
    return { ok: true };
  };
  return { sender, calls };
}

/** Compose → validate → enqueue in one go; returns the snapshot. */
function prepare(planner, input, actor = 'agent') {
  const composed = planner.compose(input, actor);
  planner.validate(composed.id, actor);
  return planner.enqueue(composed.id, actor);
}

describe('telegram-outbound: constants and exports', () => {
  it('exposes the 4096-char Telegram limit, parse-mode allowlist, and states', () => {
    assert.equal(TELEGRAM_MAX_MESSAGE_CHARS, 4096);
    assert.deepEqual([...PARSE_MODES], ['none', 'MarkdownV2', 'HTML']);
    assert.deepEqual([...STATES], ['compose', 'validated', 'queued', 'sending', 'sent', 'failed', 'cancelled']);
  });
});

describe('telegram-outbound: happy path', () => {
  it('compose → validate → enqueue → flush ends in sent with the chunk delivered', async () => {
    const { sender, calls } = makeSender();
    const planner = createTelegramOutbound({ sender });
    const composed = planner.compose({ chatId: '@dasha', text: 'hello world' });
    assert.equal(composed.state, 'compose');

    const validated = planner.validate(composed.id);
    assert.equal(validated.state, 'validated');
    assert.deepEqual(validated.chunks, ['hello world']);

    const queued = planner.enqueue(composed.id);
    assert.equal(queued.state, 'queued');

    const result = await planner.flush();
    assert.deepEqual(result.sent, [composed.id]);
    assert.deepEqual(result.skipped, []);

    const final = planner.get(composed.id);
    assert.equal(final.state, 'sent');
    assert.equal(final.sentChunks, 1);
    assert.ok(final.sentAt != null);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      chatId: '@dasha',
      text: 'hello world',
      parseMode: 'none',
      chunkIndex: 0,
      chunkCount: 1,
    });
    assert.ok(planner.isTerminal(composed.id));
  });

  it('supports MarkdownV2 and HTML parse modes end to end', async () => {
    const { sender, calls } = makeSender();
    const planner = createTelegramOutbound({ sender });
    prepare(planner, { chatId: 'c1', text: '<b>bold</b>', parseMode: 'HTML' });
    prepare(planner, { chatId: 'c1', text: '*bold*', parseMode: 'MarkdownV2' });
    await planner.flush();
    assert.equal(calls[0].parseMode, 'HTML');
    assert.equal(calls[1].parseMode, 'MarkdownV2');
    assert.ok(planner.list().every((m) => m.state === 'sent'));
  });
});

describe('telegram-outbound: 4096 chunking', () => {
  it('splits a long multi-paragraph message into ordered chunks, each ≤ 4096', async () => {
    const { sender, calls } = makeSender();
    const planner = createTelegramOutbound({ sender });
    const para = 'x'.repeat(3000);
    const text = [para, para, para].join('\n\n'); // 3 paragraphs, ~9000 chars
    const composed = planner.compose({ chatId: 'c1', text });
    const validated = planner.validate(composed.id);
    assert.equal(validated.chunks.length, 3);
    for (const chunk of validated.chunks) {
      assert.ok(chunk.length <= 4096, `chunk length ${chunk.length} exceeds 4096`);
    }
    // Order preserved: every chunk is a full paragraph, joined back to the original.
    assert.deepEqual(validated.chunks, [para, para, para]);

    planner.enqueue(composed.id);
    await planner.flush();
    assert.equal(calls.length, 3);
    calls.forEach((call, i) => {
      assert.equal(call.chunkIndex, i);
      assert.equal(call.chunkCount, 3);
    });
    const final = planner.get(composed.id);
    assert.equal(final.state, 'sent');
    assert.equal(final.sentChunks, 3);
  });

  it('preserves paragraph boundaries where possible (greedy packing, never mid-paragraph splits)', () => {
    const p1 = 'alpha';
    const p2 = 'beta';
    const filler = 'f'.repeat(4000);
    // All four paragraphs pack greedily into one chunk (4020 ≤ 4096): no split at all.
    const packed = defaultChunker(`${p1}\n\n${p2}\n\n${filler}\n\n${p1}`);
    assert.equal(packed.length, 1);
    assert.equal(packed[0], `${p1}\n\n${p2}\n\n${filler}\n\n${p1}`);
    // Force an overflow: paragraphs that cannot share a chunk still stay whole.
    const big = 'g'.repeat(3000);
    const chunks = defaultChunker(`${p1}\n\n${big}\n\n${big}\n\n${p2}`);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0], `${p1}\n\n${big}`);
    assert.equal(chunks[1], `${big}\n\n${p2}`);
    for (const c of chunks) assert.ok(c.length <= 4096);
  });

  it('splits over-long lines on whitespace and throws TG_MSG_TOO_LONG_UNCHUNKABLE on unbroken tokens', () => {
    const longLine = `${'word '.repeat(900)}end`.slice(0, 5000);
    const chunks = defaultChunker(longLine);
    assert.ok(chunks.length > 1);
    for (const c of chunks) assert.ok(c.length <= 4096);
    assert.equal(chunks.join(' ').replace(/\s+/g, ' ').trim(), longLine.replace(/\s+/g, ' ').trim());

    const unchunkable = 'z'.repeat(4097);
    assert.throws(() => defaultChunker(unchunkable), (err) => {
      assert.ok(err instanceof Error);
      assert.equal(err.code, 'TG_MSG_TOO_LONG_UNCHUNKABLE');
      return true;
    });

    const planner = createTelegramOutbound();
    const composed = planner.compose({ chatId: 'c1', text: unchunkable });
    assert.throws(() => planner.validate(composed.id), (err) => {
      assert.equal(err.code, 'TG_MSG_TOO_LONG_UNCHUNKABLE');
      assert.equal(planner.get(composed.id).state, 'compose'); // stays unvalidated
      return true;
    });
  });
});

describe('telegram-outbound: validation errors', () => {
  it('rejects invalid parse modes with a coded error', () => {
    const planner = createTelegramOutbound();
    assert.throws(
      () => planner.compose({ chatId: 'c1', text: 'hi', parseMode: 'Markdown' }),
      (err) => {
        assert.equal(err.code, 'TG_INVALID_PARSE_MODE');
        return true;
      },
    );
    assert.throws(() => planner.compose({ chatId: 'c1', text: 'hi', parseMode: 'markdown' }), (err) => {
      assert.equal(err.code, 'TG_INVALID_PARSE_MODE');
      return true;
    });
  });

  it('rejects missing/invalid chat ids and empty text with coded errors', () => {
    const planner = createTelegramOutbound();
    assert.throws(() => planner.compose({ text: 'hi' }), (err) => err.code === 'TG_INVALID_CHAT');
    assert.throws(() => planner.compose({ chatId: '   ', text: 'hi' }), (err) => err.code === 'TG_INVALID_CHAT');
    assert.throws(() => planner.compose({ chatId: 'c1', text: '   ' }), (err) => err.code === 'TG_EMPTY_TEXT');
    assert.throws(() => planner.compose({ chatId: 'c1' }), (err) => err.code === 'TG_EMPTY_TEXT');
  });

  it('throws TG_NOT_FOUND for unknown ids on every op', async () => {
    const planner = createTelegramOutbound();
    for (const op of [
      () => planner.validate('nope'),
      () => planner.enqueue('nope'),
      () => planner.cancel('nope'),
    ]) {
      assert.throws(op, (err) => err.code === 'TG_NOT_FOUND');
    }
    assert.equal(planner.get('nope'), null); // get is the non-throwing read
    assert.throws(() => planner.isTerminal('nope'), (err) => err.code === 'TG_NOT_FOUND');
    await assert.rejects(planner.sendOne('nope'), (err) => err.code === 'TG_NOT_FOUND');
  });

  it('enforces transition order: cannot skip compose → validate → enqueue', async () => {
    const planner = createTelegramOutbound();
    const composed = planner.compose({ chatId: 'c1', text: 'hi' });
    assert.throws(() => planner.enqueue(composed.id), (err) => err.code === 'TG_INVALID_TRANSITION');
    await assert.rejects(planner.sendOne(composed.id), (err) => err.code === 'TG_INVALID_TRANSITION');
    planner.validate(composed.id);
    await assert.rejects(planner.sendOne(composed.id), (err) => err.code === 'TG_INVALID_TRANSITION');
  });
});

describe('telegram-outbound: rate-budget overflow queues', () => {
  it('holds messages over budget in queued until the window slides', async () => {
    const clock = makeClock();
    const { sender, calls } = makeSender();
    const planner = createTelegramOutbound({ clock, sender, maxPerWindow: 2, windowMs: 60_000 });

    const ids = [];
    for (let i = 0; i < 3; i += 1) {
      ids.push(prepare(planner, { chatId: 'chat-a', text: `msg ${i}` }).id);
    }

    const first = await planner.flush();
    assert.deepEqual(first.sent, [ids[0], ids[1]]);
    assert.deepEqual(first.skipped, [ids[2]]);
    assert.equal(calls.length, 2);
    assert.equal(planner.get(ids[2]).state, 'queued');
    assert.deepEqual(planner.budgetStatus('chat-a'), {
      chatId: 'chat-a',
      used: 2,
      maxPerWindow: 2,
      windowMs: 60_000,
    });

    // Budgets are per chat: another chat is unaffected.
    const other = prepare(planner, { chatId: 'chat-b', text: 'other' }).id;
    const second = await planner.flush();
    assert.deepEqual(second.sent, [other]);
    assert.deepEqual(second.skipped, [ids[2]]);

    // Window slides: the held message drains.
    clock.tick(60_001);
    const third = await planner.flush();
    assert.deepEqual(third.sent, [ids[2]]);
    assert.deepEqual(third.skipped, []);
    assert.equal(planner.get(ids[2]).state, 'sent');
    assert.equal(calls.length, 4);
  });

  it('a direct sendOne over budget stays queued instead of failing silently', async () => {
    const clock = makeClock();
    const { sender } = makeSender();
    const planner = createTelegramOutbound({ clock, sender, maxPerWindow: 1, windowMs: 60_000 });
    prepare(planner, { chatId: 'c1', text: 'first' });
    const second = prepare(planner, { chatId: 'c1', text: 'second' });
    await planner.flush();
    const held = await planner.sendOne(second.id);
    assert.equal(held.state, 'queued'); // not sent, not failed
    const overBudgetNote = planner.audit.find(
      (e) => e.detail?.messageId === second.id && e.detail?.reason === 'rate budget exhausted',
    );
    assert.ok(overBudgetNote, 'budget exhaustion is recorded in the audit log');
  });
});

describe('telegram-outbound: cancel', () => {
  it('cancels from compose/validated/queued and flush skips cancelled messages', async () => {
    const { sender, calls } = makeSender();
    const planner = createTelegramOutbound({ sender });
    const a = planner.compose({ chatId: 'c1', text: 'a' });
    planner.validate(a.id);
    const b = planner.compose({ chatId: 'c1', text: 'b' });

    const cancelledA = planner.cancel(a.id);
    assert.equal(cancelledA.state, 'cancelled');
    assert.ok(cancelledA.cancelledAt != null);
    const cancelledB = planner.cancel(b.id);
    assert.equal(cancelledB.state, 'cancelled');

    const c = prepare(planner, { chatId: 'c1', text: 'c' });
    const result = await planner.flush();
    assert.deepEqual(result.sent, [c.id]);
    assert.equal(calls.length, 1);
    assert.ok(planner.isTerminal(a.id));
  });

  it('rejects cancel from terminal/sending states with TG_INVALID_TRANSITION', async () => {
    const { sender } = makeSender();
    const planner = createTelegramOutbound({ sender });
    const m = prepare(planner, { chatId: 'c1', text: 'hi' });
    await planner.flush();
    assert.equal(planner.get(m.id).state, 'sent');
    assert.throws(() => planner.cancel(m.id), (err) => err.code === 'TG_INVALID_TRANSITION');
    assert.throws(() => planner.cancel(m.id), (err) => err.code === 'TG_INVALID_TRANSITION');
  });
});

describe('telegram-outbound: retry-once policy', () => {
  it('retries a transient sender failure once and then sends', async () => {
    const calls = [];
    let attempts = 0;
    const sender = async (payload) => {
      calls.push(payload);
      attempts += 1;
      if (attempts === 1) return { ok: false, transient: true, error: 'timeout' };
      return { ok: true };
    };
    const planner = createTelegramOutbound({ sender });
    const m = prepare(planner, { chatId: 'c1', text: 'hi' });
    const after = await planner.sendOne(m.id);
    assert.equal(after.state, 'sent');
    assert.equal(calls.length, 2);
    assert.equal(after.attempts, 2);
  });

  it('retries a thrown coded transient error once, then succeeds', async () => {
    let attempts = 0;
    const sender = async () => {
      attempts += 1;
      if (attempts === 1) {
        const err = new Error('connection reset');
        err.code = 'TG_SEND_TRANSIENT';
        throw err;
      }
      return { ok: true };
    };
    const planner = createTelegramOutbound({ sender });
    const m = prepare(planner, { chatId: 'c1', text: 'hi' });
    const after = await planner.sendOne(m.id);
    assert.equal(after.state, 'sent');
    assert.equal(after.attempts, 2);
    assert.ok(planner.audit.some((e) => e.detail?.retried === true), 'retry is audit-logged');
  });

  it('a second transient failure moves the message to failed with a coded error', async () => {
    const sender = async () => ({ ok: false, transient: true, error: 'still down' });
    const planner = createTelegramOutbound({ sender });
    const m = prepare(planner, { chatId: 'c1', text: 'hi' });
    const after = await planner.sendOne(m.id);
    assert.equal(after.state, 'failed');
    assert.equal(after.attempts, 2);
    assert.equal(after.lastError.code, 'TG_SEND_TRANSIENT');
    assert.ok(after.failedAt != null);
    assert.ok(planner.isTerminal(m.id));
  });

  it('a non-transient failure fails immediately without retry', async () => {
    let calls = 0;
    const sender = async () => {
      calls += 1;
      return { ok: false, error: 'chat not found', transient: false };
    };
    const planner = createTelegramOutbound({ sender });
    const m = prepare(planner, { chatId: 'c1', text: 'hi' });
    const after = await planner.sendOne(m.id);
    assert.equal(after.state, 'failed');
    assert.equal(calls, 1, 'no retry for non-transient failures');
    assert.equal(after.lastError.code, 'TG_SEND_FAILED');
  });

  it('a thrown non-transient coded error fails with the sender code preserved', async () => {
    const sender = async () => {
      const err = new Error('bot blocked by user');
      err.code = 'TG_BOT_BLOCKED';
      throw err;
    };
    const planner = createTelegramOutbound({ sender });
    const m = prepare(planner, { chatId: 'c1', text: 'hi' });
    const after = await planner.sendOne(m.id);
    assert.equal(after.state, 'failed');
    assert.equal(after.lastError.code, 'TG_BOT_BLOCKED');
  });

  it('retry applies per chunk: chunk 1 can succeed after chunk 0 retried', async () => {
    const calls = [];
    const sender = async (payload) => {
      calls.push(payload.chunkIndex);
      if (payload.chunkIndex === 1 && !sender.retried) {
        sender.retried = true;
        return { ok: false, transient: true, error: 'blip' };
      }
      return { ok: true };
    };
    sender.retried = false;
    const planner = createTelegramOutbound({ sender });
    const text = ['p'.repeat(3000), 'q'.repeat(3000)].join('\n\n');
    const m = prepare(planner, { chatId: 'c1', text });
    const after = await planner.sendOne(m.id);
    assert.equal(after.state, 'sent');
    assert.equal(after.sentChunks, 2);
    assert.deepEqual(calls, [0, 1, 1], 'chunks sent in order with chunk 1 retried');
  });
});

describe('telegram-outbound: coded-error contract', () => {
  it('every thrown error carries a string code and detail is never silent', () => {
    const planner = createTelegramOutbound();
    const seen = [];
    const capture = (fn) => {
      try {
        fn();
      } catch (err) {
        seen.push(err);
      }
    };
    capture(() => planner.compose({ chatId: '', text: 'x' }));
    capture(() => planner.compose({ chatId: 'c', text: 'x', parseMode: 'bad' }));
    capture(() => planner.validate('missing'));
    capture(() => planner.cancel('missing'));
    assert.ok(seen.length >= 4);
    for (const err of seen) {
      assert.ok(err instanceof Error);
      assert.equal(typeof err.code, 'string');
      assert.match(err.code, /^TG_/);
    }
  });

  it('audit log records the full lifecycle in order', async () => {
    const clock = makeClock();
    const { sender } = makeSender();
    const planner = createTelegramOutbound({ clock, sender, id: makeIds() });
    const m = planner.compose({ chatId: 'c1', text: 'hi' }, 'inbox');
    planner.validate(m.id, 'inbox');
    planner.enqueue(m.id, 'inbox');
    await planner.sendOne(m.id, 'worker');
    const transitions = planner.audit.filter((e) => e.detail?.messageId === m.id).map((e) => `${e.from}→${e.to}`);
    assert.deepEqual(transitions, [
      'null→compose',
      'compose→validated',
      'validated→queued',
      'queued→sending',
      'sending→sent',
    ]);
    assert.equal(planner.audit[0].actor, 'inbox');
  });

  it('default sender is a successful no-op so plans run without a real dep', async () => {
    const planner = createTelegramOutbound();
    const m = prepare(planner, { chatId: 'c1', text: 'hi' });
    const after = await planner.sendOne(m.id);
    assert.equal(after.state, 'sent');
  });
});
