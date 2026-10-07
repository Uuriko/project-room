/**
 * adapter-seam-integration.test.js — fail-first integration tests ACROSS the
 * herdr adapter seam (lane T1, herdr redesign; pure test lane, no production code).
 *
 * Chain under test:
 *   test → createSessionAdapter({ transport:'bridge', ... })   [B2 interface / B4 worker wiring]
 *        → HTTP bridge API (D3 route table)                    [B3; fixture: ./fixtures/fake-herdr-bridge.mjs]
 *        → Unix-socket NDJSON herdr wire                       [fixture: ./fixtures/fake-herdr-socket.mjs]
 *
 * The two fixture servers are real (loopback HTTP + real Unix socket); the
 * only fakes are the herdr server's scripted behaviors and the bridge's
 * translation. The contract these tests pin is documented in
 * tests/herdr-bridge-adapter-contract.md — B2/B3/B4 must satisfy it.
 *
 * Structure:
 *   1. "seam fixtures" — fixture-only sanity; passes NOW (no adapter needed).
 *   2. "adapter seam contract" — fail-first: the `before()` hook throws a
 *      clear FAIL-FIRST error until server/session-adapter.mjs implements
 *      createSessionAdapter. Happy paths: spawn/read/send/keys/wait/state/
 *      output/report/subscribe/waitForEvent/supports/closePane.
 *   3. "chaos" — the load-bearing cases:
 *      - broker unreachable at connect + fallback → degrade to legacy (assert
 *        degradation, NOT a throw); without fallback → TransportError
 *      - bridge death mid-session → TransportError (never silent downgrade)
 *      - events_lost → re-snapshot + onReconcile + resubscribe (no silent gap)
 *      - occupant change mid-wait → OccupantChangedError
 *      - stale occupant on sendText → OccupantChangedError
 *      - protocol/herdr-version drift, missing core method → VersionMismatchError
 *      - malformed socket frames → TransportError, settled within budget (never hangs)
 *      - waitForState with no transition → TimeoutError
 *      - unknown agent → ServerError with upstream code preserved
 */

import { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {
  createFakeHerdrSocket,
  FAKE_PROTOCOL_VERSION,
  FAKE_HERDR_VERSION,
  CORE_METHODS,
} from './fixtures/fake-herdr-socket.mjs';
import { createFakeHerdrBridge } from './fixtures/fake-herdr-bridge.mjs';
import { createFakeLegacyAdapter } from './fixtures/fake-legacy-adapter.mjs';

const TEST_BEARER = 'test-bearer-token';

/** Start a fresh socket+bridge chain; returns { socket, bridge, url, token }. */
async function startChain(socketOpts = {}) {
  const socket = createFakeHerdrSocket(socketOpts);
  await socket.start();
  const bridge = createFakeHerdrBridge({ socketPath: socket.path, token: TEST_BEARER });
  await bridge.start();
  return { socket, bridge, url: bridge.url, token: TEST_BEARER };
}

async function stopChain(chain) {
  if (!chain) return;
  await chain.bridge.close().catch(() => {});
  await chain.socket.close().catch(() => {});
}

/** Poll until fn() is truthy or the budget elapses. */
async function waitFor(fn, { timeoutMs = 3000, label = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

async function authedFetch(url, { token = TEST_BEARER, method = 'GET', body } = {}) {
  return fetch(url, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

/* ------------------------------------------------------------------ */
/* 1. Fixture-only sanity (passes now — no adapter implementation needed) */
/* ------------------------------------------------------------------ */

describe('seam fixtures (no adapter required)', () => {
  let chain;
  beforeEach(async () => {
    chain = await startChain();
  });
  afterEach(async () => {
    await stopChain(chain);
  });

  it('fake socket: hello banner advertises the pinned protocol version', async () => {
    const hello = await new Promise((resolve, reject) => {
      const sock = net.createConnection(chain.socket.path);
      let buf = '';
      sock.setEncoding('utf8');
      sock.on('data', (c) => {
        buf += c;
        const idx = buf.indexOf('\n');
        if (idx !== -1) {
          sock.destroy();
          try {
            resolve(JSON.parse(buf.slice(0, idx)));
          } catch (e) {
            reject(e);
          }
        }
      });
      sock.on('error', reject);
    });
    assert.equal(hello.type, 'hello');
    assert.equal(hello.protocolVersion, FAKE_PROTOCOL_VERSION);
    assert.equal(hello.herdrVersion, FAKE_HERDR_VERSION);
    for (const m of CORE_METHODS) assert.ok(hello.methods.includes(m), `banner missing core method ${m}`);
  });

  it('fake socket: request/response round-trips with id echo', async () => {
    const result = await new Promise((resolve, reject) => {
      const sock = net.createConnection(chain.socket.path);
      let buf = '';
      sock.setEncoding('utf8');
      sock.on('data', (c) => {
        buf += c;
        const idx = buf.indexOf('\n');
        if (idx === -1) return;
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        let frame;
        try {
          frame = JSON.parse(line);
        } catch (e) {
          reject(e);
          return;
        }
        if (frame.type === 'hello') {
          sock.write(JSON.stringify({ id: 41, method: 'ping', params: {} }) + '\n');
          return;
        }
        if (frame.id === 41) {
          sock.destroy();
          resolve(frame);
        }
      });
      sock.on('error', reject);
    });
    assert.equal(result.ok, true);
    assert.equal(result.result.protocolVersion, FAKE_PROTOCOL_VERSION);
  });

  it('fake bridge: /healthz is unauthenticated; /v1/* requires the bearer', async () => {
    const hz = await fetch(`${chain.url}/healthz`);
    assert.equal(hz.status, 200);
    assert.equal((await hz.json()).ok, true);

    const denied = await authedFetch(`${chain.url}/v1/ping`, { token: null, method: 'POST' });
    assert.equal(denied.status, 401);
    assert.equal((await denied.json()).code, 'auth_denied');

    const wrong = await authedFetch(`${chain.url}/v1/ping`, { token: 'wrong', method: 'POST' });
    assert.equal(wrong.status, 401);
  });

  it('fake bridge: spawn → send → read translates through the socket', async () => {
    const spawn = await authedFetch(`${chain.url}/v1/spawn`, {
      method: 'POST',
      body: { kind: 'claude', command: 'claude', workspace: 'w', tab: 't' },
    });
    assert.equal(spawn.status, 200);
    const s = await spawn.json();
    assert.ok(s.agentId);
    assert.ok(s.paneId);
    assert.ok(s.occupantToken);

    const send = await authedFetch(`${chain.url}/v1/send`, {
      method: 'POST',
      body: { agentId: s.agentId, text: 'fixture probe', occupantToken: s.occupantToken },
    });
    assert.equal(send.status, 200);
    assert.equal((await send.json()).sent, true);

    const read = await authedFetch(`${chain.url}/v1/read`, {
      method: 'POST',
      body: { paneId: s.paneId, source: 'visible' },
    });
    assert.equal(read.status, 200);
    assert.match((await read.json()).text, /fixture probe/);
  });

  it('fake bridge: stale occupant token is rejected 409 occupant_changed', async () => {
    const spawn = await (
      await authedFetch(`${chain.url}/v1/spawn`, { method: 'POST', body: { command: 'x' } })
    ).json();
    chain.socket.changeOccupant(spawn.agentId);
    const send = await authedFetch(`${chain.url}/v1/send`, {
      method: 'POST',
      body: { agentId: spawn.agentId, text: 'stale', occupantToken: spawn.occupantToken },
    });
    assert.equal(send.status, 409);
    assert.equal((await send.json()).code, 'occupant_changed');
  });
});

/* ------------------------------------------------------------------ */
/* 2. Adapter seam contract — FAIL-FIRST until B2/B4 implement it        */
/* ------------------------------------------------------------------ */

describe('adapter seam contract (fail-first: needs server/session-adapter.mjs)', () => {
  let mod;
  let chain;

  before(async () => {
    try {
      mod = await import('../server/session-adapter.mjs');
    } catch (e) {
      throw new Error(
        `FAIL-FIRST: server/session-adapter.mjs does not implement createSessionAdapter yet (lanes B2/B4): ${e.message}`,
      );
    }
    if (typeof mod.createSessionAdapter !== 'function') {
      throw new Error('FAIL-FIRST: server/session-adapter.mjs must export createSessionAdapter');
    }
  });

  beforeEach(async () => {
    chain = await startChain();
  });
  afterEach(async () => {
    await stopChain(chain);
  });

  function makeAdapter(over = {}) {
    return mod.createSessionAdapter({
      transport: 'bridge',
      bridgeUrl: chain.url,
      bridgeToken: TEST_BEARER,
      tenantId: 'lane-t1',
      pinnedProtocolVersion: FAKE_PROTOCOL_VERSION,
      pinnedHerdrVersion: FAKE_HERDR_VERSION,
      connectTimeoutMs: 5000,
      requestTimeoutMs: 2000,
      ...over,
    });
  }

  async function connectedAdapter(over = {}) {
    const adapter = await makeAdapter(over);
    await adapter.connect();
    return adapter;
  }

  it('connect asserts versions; ping returns the pinned pair', async () => {
    const adapter = await connectedAdapter();
    const p = await adapter.ping();
    assert.equal(p.ok, true);
    assert.equal(p.protocolVersion, FAKE_PROTOCOL_VERSION);
    assert.equal(p.herdrVersion, FAKE_HERDR_VERSION);
    assert.equal(adapter.protocolVersion, FAKE_PROTOCOL_VERSION);
    await adapter.disconnect();
    await adapter.disconnect(); // idempotent
  });

  it('spawnAgent → listAgents/getAgent inventory round-trip', async () => {
    const adapter = await connectedAdapter();
    const h = await adapter.spawnAgent({ kind: 'claude', command: 'claude', args: ['--resume', 'abc'], title: 't1' });
    assert.ok(h.agentId, 'handle carries agentId');
    assert.ok(h.paneId, 'handle carries paneId');
    assert.ok(h.occupantToken, 'handle pins the occupant');

    const list = await adapter.listAgents();
    assert.ok(list.agents.some((a) => a.id === h.agentId), 'spawned agent visible in listAgents');

    const one = await adapter.getAgent(h.agentId);
    assert.equal(one.id, h.agentId);
    assert.equal(one.paneId, h.paneId);
    await adapter.disconnect();
  });

  it('sendText → readPane round-trip; sendKeys resolves', async () => {
    const adapter = await connectedAdapter();
    const h = await adapter.spawnAgent({ kind: 'claude', command: 'claude' });
    const res = await adapter.sendText(h.agentId, 'hello from t1');
    assert.equal(res.sent, true);

    await adapter.sendKeys(h.agentId, ['ctrl-c']);

    const pane = await adapter.readPane(h.paneId, 'visible');
    assert.match(pane.text, /hello from t1/);
    await adapter.disconnect();
  });

  it('waitForState resolves on a fixture-driven transition (event-driven, no polling)', async () => {
    const adapter = await connectedAdapter();
    const h = await adapter.spawnAgent({ kind: 'claude', command: 'claude' });
    const waiting = adapter.waitForState(h.agentId, ['blocked'], { timeoutMs: 5000 });
    await tick();
    chain.socket.setAgentState(h.agentId, 'blocked');
    const state = await waiting;
    assert.equal(state, 'blocked');
    await adapter.disconnect();
  });

  it('waitForOutput resolves on a regex match', async () => {
    const adapter = await connectedAdapter();
    const h = await adapter.spawnAgent({ kind: 'claude', command: 'claude' });
    const waiting = adapter.waitForOutput(h.paneId, 'DONE-\\d+', { timeoutMs: 5000 });
    await tick();
    chain.socket.appendOutput(h.paneId, 'result DONE-42\n');
    const m = await waiting;
    assert.equal(m.match, 'DONE-42');
    await adapter.disconnect();
  });

  it('reportState/reportResume/reportMetadata are recorded socket-side', async () => {
    const adapter = await connectedAdapter();
    const h = await adapter.spawnAgent({ kind: 'claude', command: 'claude' });
    await adapter.reportState(h.paneId, 'blocked', 'waiting on review');
    await adapter.reportResume(h.paneId, { sessionRef: 'sess-1', resumeCommand: ['claude', '--resume', 'sess-1'] });
    await adapter.reportMetadata(h.paneId, { title: 'lane t1' });
    const pane = chain.socket.getPane(h.paneId);
    assert.equal(pane.state, 'blocked');
    assert.equal(pane.sessionRef, 'sess-1');
    assert.deepEqual(pane.resumeCommand, ['claude', '--resume', 'sess-1']);
    assert.equal(pane.metadata.title, 'lane t1');
    await adapter.disconnect();
  });

  it('subscribe receives the mapped agent.state_changed event; close() ends it', async () => {
    const adapter = await connectedAdapter();
    const h = await adapter.spawnAgent({ kind: 'claude', command: 'claude' });
    const seen = [];
    const sub = await adapter.subscribe(['agent.state_changed'], (ev) => seen.push(ev));
    assert.equal(sub.active, true);
    chain.socket.setAgentState(h.agentId, 'blocked');
    await waitFor(() => seen.length >= 1, { label: 'state_changed event' });
    assert.equal(seen[0].name, 'agent.state_changed');
    assert.equal(seen[0].agentId, h.agentId);
    assert.equal(seen[0].state, 'blocked');
    await sub.close();
    assert.equal(sub.active, false);
    await adapter.disconnect();
  });

  it('waitForEvent is a one-shot wait on the event feed', async () => {
    const adapter = await connectedAdapter();
    const h = await adapter.spawnAgent({ kind: 'claude', command: 'claude' });
    const waiting = adapter.waitForEvent({ name: 'agent.state_changed', agentId: h.agentId }, { timeoutMs: 5000 });
    await tick();
    chain.socket.setAgentState(h.agentId, 'done');
    const ev = await waiting;
    assert.equal(ev.state, 'done');
    await adapter.disconnect();
  });

  it('supports() gates the optional tier; core methods are advertised', async () => {
    const mini = await startChain({ methods: [...CORE_METHODS] });
    try {
      const adapter = await mod.createSessionAdapter({
        transport: 'bridge',
        bridgeUrl: mini.url,
        bridgeToken: TEST_BEARER,
        tenantId: 'lane-t1',
        pinnedProtocolVersion: FAKE_PROTOCOL_VERSION,
        pinnedHerdrVersion: FAKE_HERDR_VERSION,
        connectTimeoutMs: 5000,
        requestTimeoutMs: 2000,
      });
      await adapter.connect();
      assert.equal(adapter.supports('agent.start'), true);
      assert.equal(adapter.supports('worktree.create'), false);
      await adapter.disconnect();
    } finally {
      await stopChain(mini);
    }
  });

  it('closePane tears the agent down', async () => {
    const adapter = await connectedAdapter();
    const h = await adapter.spawnAgent({ kind: 'claude', command: 'claude' });
    await adapter.closePane(h.paneId);
    const list = await adapter.listAgents();
    assert.ok(!list.agents.some((a) => a.id === h.agentId), 'closed agent gone from listAgents');
    await adapter.disconnect();
  });
});

/* ------------------------------------------------------------------ */
/* 3. Chaos — the load-bearing cases                                    */
/* ------------------------------------------------------------------ */

describe('adapter seam chaos (fail-first: needs server/session-adapter.mjs)', () => {
  let mod;
  let chain;

  before(async () => {
    try {
      mod = await import('../server/session-adapter.mjs');
    } catch (e) {
      throw new Error(
        `FAIL-FIRST: server/session-adapter.mjs does not implement createSessionAdapter yet (lanes B2/B4): ${e.message}`,
      );
    }
  });

  beforeEach(async () => {
    chain = await startChain();
  });
  afterEach(async () => {
    await stopChain(chain);
  });

  function baseOpts(over = {}) {
    return {
      transport: 'bridge',
      bridgeUrl: chain.url,
      bridgeToken: TEST_BEARER,
      tenantId: 'lane-t1',
      pinnedProtocolVersion: FAKE_PROTOCOL_VERSION,
      pinnedHerdrVersion: FAKE_HERDR_VERSION,
      connectTimeoutMs: 5000,
      requestTimeoutMs: 2000,
      ...over,
    };
  }

  it('broker unreachable at connect + fallback → degrade to legacy, NOT a throw', async () => {
    const legacy = createFakeLegacyAdapter();
    const degraded = [];
    const adapter = await mod.createSessionAdapter(
      baseOpts({
        bridgeUrl: 'http://127.0.0.1:1', // nothing listens; fast refused
        fallback: legacy,
        onDegraded: (info) => degraded.push(info),
      }),
    );
    await adapter.connect(); // must not throw

    const h = await adapter.spawnAgent({ kind: 'claude', command: 'claude' });
    assert.equal(h.backend, 'legacy', 'spawn served by the legacy backend');

    const pane = await adapter.readPane(h.paneId, 'visible');
    assert.equal(pane.backend, 'legacy', 'reads served by the legacy backend');

    assert.ok(degraded.length >= 1, 'degradation was reported');
    assert.equal(degraded[0].phase, 'connect');
    assert.match(String(degraded[0].reason), /unreachable|refused|transport/i);
    await adapter.disconnect();
  });

  it('broker unreachable at connect WITHOUT fallback → TransportError', async () => {
    const adapter = await mod.createSessionAdapter(baseOpts({ bridgeUrl: 'http://127.0.0.1:1' }));
    await assert.rejects(() => adapter.connect(), (e) => {
      assert.equal(e.name, 'TransportError');
      return true;
    });
  });

  it('bridge death mid-session → TransportError, never a silent legacy downgrade', async () => {
    const legacy = createFakeLegacyAdapter();
    const degraded = [];
    const adapter = await mod.createSessionAdapter(
      baseOpts({ fallback: legacy, onDegraded: (i) => degraded.push(i) }),
    );
    await adapter.connect();
    const h = await adapter.spawnAgent({ kind: 'claude', command: 'claude' });
    assert.ok(h.agentId);

    await chain.bridge.close(); // the bridge dies mid-session

    // D3 §2.3: backend selection is all-or-nothing per session. A mid-session
    // outage must ERROR, never silently downgrade — even with a fallback set.
    await assert.rejects(() => adapter.ping(), (e) => {
      assert.equal(e.name, 'TransportError');
      return true;
    });
    await adapter.disconnect().catch(() => {});
  });

  it('events_lost → re-snapshot + onReconcile + resubscribe, no silent gap', async () => {
    const adapter = await mod.createSessionAdapter(baseOpts());
    await adapter.connect();
    const h = await adapter.spawnAgent({ kind: 'claude', command: 'claude' });

    const seen = [];
    const reconciles = [];
    const streamsBefore = chain.bridge.eventStreamCount;
    const sub = await adapter.subscribe(['agent.state_changed'], (ev) => seen.push(ev), {
      onReconcile: (snapshot, lostCount) => {
        reconciles.push({ snapshot, lostCount });
      },
    });

    chain.socket.setAgentState(h.agentId, 'blocked');
    await waitFor(() => seen.length >= 1, { label: 'pre-loss event' });
    assert.equal(seen[0].state, 'blocked');

    chain.socket.emitEventsLost(2);

    await waitFor(() => reconciles.length >= 1, { label: 'onReconcile' });
    assert.equal(reconciles[0].lostCount, 2, 'lost count surfaced to the reconciler');
    assert.ok(Array.isArray(reconciles[0].snapshot.workspaces), 're-snapshot is a full WorkspaceSnapshot');
    const panes = reconciles[0].snapshot.workspaces.flatMap((w) => w.tabs.flatMap((t) => t.panes));
    assert.ok(panes.some((p) => p.id === h.paneId), 're-snapshot contains the live pane');

    assert.ok(
      chain.bridge.eventStreamCount > streamsBefore,
      'adapter resubscribed on a fresh event stream after events_lost',
    );

    // The feed continues after recovery — no silent gap, no swallowed event.
    chain.socket.setAgentState(h.agentId, 'done');
    await waitFor(() => seen.length >= 2, { label: 'post-recovery event' });
    assert.equal(seen[1].state, 'done');
    assert.equal(seen.length, 2, 'exactly the two real transitions observed; nothing duplicated or lost');

    await sub.close();
    await adapter.disconnect();
  });

  it('occupant change mid-wait → OccupantChangedError', async () => {
    const adapter = await mod.createSessionAdapter(baseOpts());
    await adapter.connect();
    const h = await adapter.spawnAgent({ kind: 'claude', command: 'claude' });

    const waiting = adapter.waitForState(h.agentId, ['done'], { timeoutMs: 5000 });
    await tick();
    chain.socket.changeOccupant(h.agentId); // another process takes the pane

    await assert.rejects(() => waiting, (e) => {
      assert.equal(e.name, 'OccupantChangedError');
      return true;
    });
    await adapter.disconnect();
  });

  it('stale occupant on sendText → OccupantChangedError', async () => {
    const adapter = await mod.createSessionAdapter(baseOpts());
    await adapter.connect();
    const h = await adapter.spawnAgent({ kind: 'claude', command: 'claude' });
    chain.socket.changeOccupant(h.agentId);
    await assert.rejects(() => adapter.sendText(h.agentId, 'should not send'), (e) => {
      assert.equal(e.name, 'OccupantChangedError');
      return true;
    });
    await adapter.disconnect();
  });

  it('protocol version drift → VersionMismatchError at connect (fail closed)', async () => {
    const drifted = await startChain({ protocolVersion: FAKE_PROTOCOL_VERSION - 1 });
    try {
      const adapter = await mod.createSessionAdapter(baseOpts({ bridgeUrl: drifted.url }));
      await assert.rejects(() => adapter.connect(), (e) => {
        assert.equal(e.name, 'VersionMismatchError');
        return true;
      });
    } finally {
      await stopChain(drifted);
    }
  });

  it('herdr binary version drift → VersionMismatchError at connect', async () => {
    const drifted = await startChain({ herdrVersion: '0.99.0' });
    try {
      const adapter = await mod.createSessionAdapter(baseOpts({ bridgeUrl: drifted.url }));
      await assert.rejects(() => adapter.connect(), (e) => {
        assert.equal(e.name, 'VersionMismatchError');
        return true;
      });
    } finally {
      await stopChain(drifted);
    }
  });

  it('missing core method in the advertised list → VersionMismatchError at connect', async () => {
    const stripped = await startChain({ methods: CORE_METHODS.filter((m) => m !== 'agent.start') });
    try {
      const adapter = await mod.createSessionAdapter(baseOpts({ bridgeUrl: stripped.url }));
      await assert.rejects(() => adapter.connect(), (e) => {
        assert.equal(e.name, 'VersionMismatchError');
        return true;
      });
    } finally {
      await stopChain(stripped);
    }
  });

  it('malformed socket frames → TransportError, never a hang', async () => {
    const garbage = await startChain({ mode: 'garbage' });
    const requestTimeoutMs = 1500;
    try {
      const adapter = await mod.createSessionAdapter(baseOpts({ bridgeUrl: garbage.url, requestTimeoutMs }));
      await adapter.connect(); // banner is still valid; only request frames are garbage
      const start = Date.now();
      await assert.rejects(() => adapter.ping(), (e) => {
        assert.equal(e.name, 'TransportError');
        return true;
      });
      const elapsed = Date.now() - start;
      assert.ok(
        elapsed < requestTimeoutMs + 3000,
        `malformed frame settled in ${elapsed}ms — bounded, no hang (budget ${requestTimeoutMs}ms + slack)`,
      );
      await adapter.disconnect().catch(() => {});
    } finally {
      await stopChain(garbage);
    }
  });

  it('waitForState with no transition → TimeoutError', async () => {
    const adapter = await mod.createSessionAdapter(baseOpts());
    await adapter.connect();
    const h = await adapter.spawnAgent({ kind: 'claude', command: 'claude' });
    const start = Date.now();
    await assert.rejects(() => adapter.waitForState(h.agentId, ['done'], { timeoutMs: 400 }), (e) => {
      assert.equal(e.name, 'TimeoutError');
      return true;
    });
    assert.ok(Date.now() - start < 5000, 'timeout settled promptly');
    await adapter.disconnect();
  });

  it('sendText to an unknown agent → ServerError with the upstream code preserved', async () => {
    const adapter = await mod.createSessionAdapter(baseOpts());
    await adapter.connect();
    await assert.rejects(() => adapter.sendText('agent-nope', 'hello?'), (e) => {
      assert.equal(e.name, 'ServerError');
      assert.ok(e.code === 'not_found' || e.upstream?.code === 'not_found', 'upstream code preserved');
      return true;
    });
    await adapter.disconnect();
  });
});
