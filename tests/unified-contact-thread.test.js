import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHANNELS,
  CHANNEL_RANK,
  CHANNEL_CAPABILITIES,
  createUnifiedContactThread,
} from '../src/unified-contact-thread.mjs';

function makeThread(seed = 1_000_000) {
  const now = seed;
  return createUnifiedContactThread({
    clock: () => now,
    id: (() => {
      let n = 0;
      return () => `m${(n += 1)}`;
    })(),
    hash: (s) => `h:${s}`,
  });
}

function msg(overrides = {}) {
  return {
    channel: 'email',
    channelMessageId: 'e-1',
    ts: 1_000_000,
    direction: 'inbound',
    from: 'alice@example.com',
    subject: 'hello',
    body: 'hi there',
    ...overrides,
  };
}

describe('channels', () => {
  it('exposes the three channels with a stable rank', () => {
    assert.deepEqual([...CHANNELS], ['email', 'telegram', 'whatsapp']);
    assert.ok(CHANNEL_RANK.email < CHANNEL_RANK.telegram);
    assert.ok(CHANNEL_RANK.telegram < CHANNEL_RANK.whatsapp);
  });

  it('exposes per-channel capability flags', () => {
    assert.equal(CHANNEL_CAPABILITIES.whatsapp.subject, false);
    assert.equal(CHANNEL_CAPABILITIES.telegram.readReceipts, false);
    assert.equal(CHANNEL_CAPABILITIES.email.subject, true);
    assert.equal(CHANNEL_CAPABILITIES.email.readReceipts, true);
  });
});

describe('merge ordering across channels', () => {
  it('orders by timestamp across all three channels', () => {
    const t = makeThread();
    t.addMessage(msg({ channel: 'whatsapp', channelMessageId: 'w-3', ts: 3_000, body: 'third' }));
    t.addMessage(msg({ channel: 'email', channelMessageId: 'e-1', ts: 1_000, body: 'first' }));
    t.addMessage(msg({ channel: 'telegram', channelMessageId: 't-2', ts: 2_000, body: 'second' }));
    const bodies = t.all().map((m) => m.body);
    assert.deepEqual(bodies, ['first', 'second', 'third']);
  });

  it('breaks timestamp ties by channel rank, then insertion order', () => {
    const t = makeThread();
    t.addMessage(msg({ channel: 'whatsapp', channelMessageId: 'w-1', ts: 5_000, body: 'wa' }));
    t.addMessage(msg({ channel: 'telegram', channelMessageId: 't-1', ts: 5_000, body: 'tg' }));
    t.addMessage(msg({ channel: 'email', channelMessageId: 'e-1', ts: 5_000, body: 'em' }));
    const channels = t.all().map((m) => m.channel);
    assert.deepEqual(channels, ['email', 'telegram', 'whatsapp']);
  });
});

describe('cross-channel dedupe', () => {
  it('merges the same content arriving on two channels into one entry', () => {
    const t = makeThread();
    const first = t.addMessage(
      msg({ channel: 'email', channelMessageId: 'e-9', body: 'same content' }),
    );
    assert.equal(first.deduped, false);

    const second = t.addMessage(
      msg({ channel: 'telegram', channelMessageId: 't-9', body: 'same content' }),
    );
    assert.equal(second.deduped, true);
    assert.equal(t.size, 1);
    assert.equal(second.message.id, first.message.id);
    assert.deepEqual(second.message.aliases, [
      { channel: 'telegram', channelMessageId: 't-9' },
    ]);
  });

  it('treats different bodies as different messages', () => {
    const t = makeThread();
    t.addMessage(msg({ channel: 'email', channelMessageId: 'e-1', body: 'one' }));
    const res = t.addMessage(msg({ channel: 'email', channelMessageId: 'e-2', body: 'two' }));
    assert.equal(res.deduped, false);
    assert.equal(t.size, 2);
  });

  it('rejects the same per-channel message id twice (never silent)', () => {
    const t = makeThread();
    t.addMessage(msg({ channel: 'email', channelMessageId: 'e-dup' }));
    assert.throws(
      () => t.addMessage(msg({ channel: 'email', channelMessageId: 'e-dup' })),
      (err) => {
        assert.equal(err.code, 'THREAD_DUPLICATE_CHANNEL_ID');
        return true;
      },
    );
  });
});

describe('unread counts and mark-read', () => {
  it('summarizes per-channel counts, unread counts, and activity bounds', () => {
    const t = makeThread();
    t.addMessage(msg({ channel: 'email', channelMessageId: 'e-1', ts: 1_000 }));
    t.addMessage(msg({ channel: 'telegram', channelMessageId: 't-1', ts: 2_000, body: 'tg body' }), { read: true });
    t.addMessage(msg({ channel: 'whatsapp', channelMessageId: 'w-1', ts: 3_000, body: 'wa' }));
    const s = t.summary();
    assert.deepEqual(s.perChannel, { email: 1, telegram: 1, whatsapp: 1 });
    assert.deepEqual(s.unreadPerChannel, { email: 1, telegram: 0, whatsapp: 1 });
    assert.equal(s.unreadTotal, 2);
    assert.equal(s.total, 3);
    assert.equal(s.firstActivityTs, 1_000);
    assert.equal(s.lastActivityTs, 3_000);
  });

  it('marks read per channel only', () => {
    const t = makeThread();
    t.addMessage(msg({ channel: 'email', channelMessageId: 'e-1' }));
    t.addMessage(msg({ channel: 'telegram', channelMessageId: 't-1', body: 'tg body' }));
    const marked = t.markRead({ channel: 'email' });
    assert.equal(marked, 1);
    const s = t.summary();
    assert.deepEqual(s.unreadPerChannel, { email: 0, telegram: 1, whatsapp: 0 });
  });

  it('marks all read with no channel', () => {
    const t = makeThread();
    t.addMessage(msg({ channel: 'email', channelMessageId: 'e-1' }));
    t.addMessage(msg({ channel: 'telegram', channelMessageId: 't-1', body: 'tg body' }));
    assert.equal(t.markRead(), 2);
    assert.equal(t.summary().unreadTotal, 0);
    assert.equal(t.markRead(), 0); // nothing left to mark
  });

  it('rejects markRead on an unknown channel', () => {
    const t = makeThread();
    assert.throws(() => t.markRead({ channel: 'sms' }), (err) => {
      assert.equal(err.code, 'THREAD_INVALID_CHANNEL');
      return true;
    });
  });
});

describe('query', () => {
  it('filters by channel', () => {
    const t = makeThread();
    t.addMessage(msg({ channel: 'email', channelMessageId: 'e-1' }));
    t.addMessage(msg({ channel: 'telegram', channelMessageId: 't-1', body: 'tg body' }));
    const res = t.query({ channel: 'telegram' });
    assert.equal(res.length, 1);
    assert.equal(res[0].channel, 'telegram');
  });

  it('filters by inclusive time range', () => {
    const t = makeThread();
    t.addMessage(msg({ channel: 'email', channelMessageId: 'e-1', ts: 1_000, body: 'a' }));
    t.addMessage(msg({ channel: 'telegram', channelMessageId: 't-1', ts: 2_000, body: 'b' }));
    t.addMessage(msg({ channel: 'whatsapp', channelMessageId: 'w-1', ts: 3_000, body: 'c' }));
    const res = t.query({ sinceMs: 2_000, untilMs: 3_000 });
    assert.deepEqual(
      res.map((m) => m.body),
      ['b', 'c'],
    );
  });

  it('supports unread-first ordering with chronological groups', () => {
    const t = makeThread();
    t.addMessage(msg({ channel: 'email', channelMessageId: 'e-1', ts: 1_000 }), { read: true });
    t.addMessage(msg({ channel: 'telegram', channelMessageId: 't-1', ts: 2_000, body: 'unread-new' }));
    t.addMessage(msg({ channel: 'whatsapp', channelMessageId: 'w-1', ts: 500, body: 'unread-old' }));
    const res = t.query({ unreadFirst: true });
    assert.deepEqual(
      res.map((m) => m.body),
      ['unread-old', 'unread-new', 'hi there'],
    );
  });

  it('supports a limit', () => {
    const t = makeThread();
    for (let i = 0; i < 5; i += 1) {
      t.addMessage(
        msg({ channel: 'email', channelMessageId: `e-${i}`, ts: i, body: `b${i}` }),
      );
    }
    assert.equal(t.query({ limit: 2 }).length, 2);
  });

  it('rejects malformed query options with a coded error', () => {
    const t = makeThread();
    assert.throws(() => t.query({ limit: -1 }), (err) => {
      assert.equal(err.code, 'THREAD_INVALID_QUERY');
      return true;
    });
    assert.throws(() => t.query({ channel: 'sms' }), (err) => {
      assert.equal(err.code, 'THREAD_INVALID_CHANNEL');
      return true;
    });
  });
});

describe('remove', () => {
  it('removes a message and returns its snapshot', () => {
    const t = makeThread();
    const { message } = t.addMessage(msg({ channelMessageId: 'e-gone' }));
    const removed = t.removeMessage(message.id);
    assert.equal(removed.id, message.id);
    assert.equal(t.size, 0);
    assert.equal(t.get(message.id), null);
  });

  it('also drops the dedupe index so the content can be re-added', () => {
    const t = makeThread();
    const { message } = t.addMessage(msg({ channelMessageId: 'e-1', body: 'again' }));
    t.removeMessage(message.id);
    const res = t.addMessage(msg({ channelMessageId: 'e-2', body: 'again' }));
    assert.equal(res.deduped, false);
  });

  it('throws a coded error for unknown ids', () => {
    const t = makeThread();
    assert.throws(() => t.removeMessage('nope'), (err) => {
      assert.equal(err.code, 'THREAD_MESSAGE_NOT_FOUND');
      return true;
    });
  });
});

describe('validation and coded-error contract', () => {
  it('rejects an invalid channel', () => {
    const t = makeThread();
    assert.throws(() => t.addMessage(msg({ channel: 'sms' })), (err) => {
      assert.equal(err.code, 'THREAD_INVALID_CHANNEL');
      return true;
    });
  });

  it('rejects invalid messages', () => {
    const t = makeThread();
    assert.throws(() => t.addMessage(msg({ ts: NaN })), (err) => {
      assert.equal(err.code, 'THREAD_INVALID_MESSAGE');
      return true;
    });
    assert.throws(() => t.addMessage(msg({ direction: 'sideways' })), (err) => {
      assert.equal(err.code, 'THREAD_INVALID_MESSAGE');
      return true;
    });
    assert.throws(() => t.addMessage({}), (err) => {
      assert.equal(err.code, 'THREAD_INVALID_CHANNEL');
      return true;
    });
  });

  it('every thrown failure carries a string code', () => {
    const t = makeThread();
    const cases = [
      () => t.addMessage(msg({ channel: 'fax' })),
      () => t.addMessage(msg({ body: 42 })),
      () => t.removeMessage('missing'),
      () => t.markRead({ channel: 'fax' }),
      () => t.query({ sinceMs: 'soon' }),
    ];
    for (const fn of cases) {
      assert.throws(fn, (err) => {
        assert.ok(err instanceof Error);
        assert.equal(typeof err.code, 'string');
        assert.ok(err.code.startsWith('THREAD_'));
        return true;
      });
    }
  });

  it('returns frozen snapshots that cannot be mutated', () => {
    const t = makeThread();
    const { message } = t.addMessage(msg());
    assert.ok(Object.isFrozen(message));
    assert.throws(() => {
      message.body = 'tampered';
    }, TypeError);
    const summary = t.summary();
    assert.ok(Object.isFrozen(summary));
    assert.ok(Object.isFrozen(summary.perChannel));
  });
});
