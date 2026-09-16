import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMonitor } from '../src/uptime-monitor.mjs';

function makeHarness(responses, configOverrides = {}) {
  const events = [];
  let clock = 1_700_000_000_000;
  let calls = 0;
  const fetchFn = async (url) => {
    const r = responses[Math.min(calls, responses.length - 1)];
    calls += 1;
    if (r === 'throw') throw new Error('boom');
    return r;
  };
  const monitor = createMonitor(
    {
      endpoints: [{ name: 'api', url: 'https://api.example.test/health' }],
      checkIntervalMs: 10,
      timeoutMs: 50,
      failureThreshold: 3,
      ...configOverrides,
    },
    {
      fetchFn,
      notifier: (e) => events.push(e),
      now: () => {
        clock += 1000;
        return clock;
      },
    },
  );
  return { monitor, events, getCalls: () => calls };
}

describe('uptime-monitor', () => {
  it('healthy endpoint stays up and never alerts', async () => {
    const { monitor, events } = makeHarness([{ ok: true, status: 200 }]);
    for (let i = 0; i < 5; i += 1) {
      await monitor.checkOnce();
    }
    assert.equal(events.length, 0);
    assert.deepEqual(monitor.getStatus('api'), {
      name: 'api',
      consecutiveFailures: 0,
      lastStatus: 'up',
      lastCheckedAt: 1_700_000_005_000,
      isDown: false,
    });
  });

  it('fires exactly one down alert after N consecutive failures', async () => {
    const { monitor, events } = makeHarness([{ ok: false, status: 500 }]);
    for (let i = 0; i < 6; i += 1) {
      await monitor.checkOnce();
    }
    const downs = events.filter((e) => e.type === 'down');
    assert.equal(downs.length, 1);
    assert.equal(downs[0].consecutiveFailures, 3);
    assert.equal(downs[0].endpoint.name, 'api');
    assert.equal(monitor.getStatus('api').isDown, true);
  });

  it('intermittent failure below threshold does not alert', async () => {
    const { monitor, events } = makeHarness([
      { ok: false, status: 500 },
      { ok: false, status: 500 },
      { ok: true, status: 200 },
    ]);
    for (let i = 0; i < 3; i += 1) {
      await monitor.checkOnce();
    }
    assert.equal(events.length, 0);
    const s = monitor.getStatus('api');
    assert.equal(s.consecutiveFailures, 0);
    assert.equal(s.isDown, false);
  });

  it('success after down fires recovered and resets the counter', async () => {
    const { monitor, events } = makeHarness(
      [
        { ok: false, status: 500 },
        { ok: false, status: 500 },
        { ok: true, status: 200 },
      ],
      { failureThreshold: 2 },
    );
    await monitor.checkOnce(); // 1 failure
    await monitor.checkOnce(); // 2 failures -> down alert
    await monitor.checkOnce(); // success -> recovered
    const types = events.map((e) => e.type);
    assert.deepEqual(types, ['down', 'recovered']);
    assert.equal(events[1].endpoint.name, 'api');
    const s = monitor.getStatus('api');
    assert.equal(s.isDown, false);
    assert.equal(s.consecutiveFailures, 0);
    assert.equal(s.lastStatus, 'up');
  });

  it('timeout (rejection) counts as failure', async () => {
    const { monitor, events } = makeHarness(['throw'], { failureThreshold: 2 });
    await monitor.checkOnce();
    await monitor.checkOnce();
    assert.equal(events.filter((e) => e.type === 'down').length, 1);
    assert.equal(monitor.getStatus('api').consecutiveFailures, 2);
  });

  it('getSnapshot reflects current state across endpoints', async () => {
    const events = [];
    const monitor = createMonitor(
      {
        endpoints: [
          { name: 'a', url: 'https://a.test' },
          { name: 'b', url: 'https://b.test' },
        ],
        failureThreshold: 1,
      },
      {
        fetchFn: async (url) =>
          url === 'https://a.test' ? { ok: true, status: 200 } : { ok: false, status: 503 },
        notifier: (e) => events.push(e),
      },
    );
    await monitor.checkOnce();
    const snap = monitor.getSnapshot();
    assert.equal(snap.length, 2);
    assert.deepEqual(
      snap.map((s) => [s.name, s.lastStatus, s.isDown]),
      [
        ['a', 'up', false],
        ['b', 'down', true],
      ],
    );
    assert.equal(events.length, 1);
    assert.equal(monitor.getStatus('missing'), null);
  });

  it('start/stop schedules checks on an interval', async () => {
    const { monitor, events, getCalls } = makeHarness([{ ok: false, status: 500 }], {
      checkIntervalMs: 10,
      failureThreshold: 2,
    });
    monitor.start();
    await new Promise((resolve) => setTimeout(resolve, 120));
    monitor.stop();
    const callsAfterStop = getCalls();
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(getCalls(), callsAfterStop, 'no checks after stop()');
    assert.ok(callsAfterStop >= 2, `expected >= 2 checks, got ${callsAfterStop}`);
    assert.equal(events.filter((e) => e.type === 'down').length, 1);
  });

  it('start() is idempotent — a second start does not double-schedule', async () => {
    const { monitor, getCalls } = makeHarness([{ ok: true, status: 200 }], {
      checkIntervalMs: 15,
    });
    monitor.start();
    monitor.start();
    await new Promise((resolve) => setTimeout(resolve, 70));
    monitor.stop();
    const calls = getCalls();
    assert.ok(calls >= 2 && calls <= 6, `expected 2..6 checks with one timer, got ${calls}`);
  });

  describe('config validation', () => {
    it('requires an injected fetchFn', () => {
      assert.throws(
        () => createMonitor({ endpoints: [{ name: 'x', url: 'https://x.test' }] }, {}),
        /fetchFn/,
      );
    });

    it('rejects endpoints without name or url', () => {
      assert.throws(
        () => createMonitor({ endpoints: [{ url: 'https://x.test' }] }, { fetchFn: async () => ({ ok: true }) }),
        /name/,
      );
      assert.throws(
        () => createMonitor({ endpoints: [{ name: 'x' }] }, { fetchFn: async () => ({ ok: true }) }),
        /url/,
      );
    });
  });
});
