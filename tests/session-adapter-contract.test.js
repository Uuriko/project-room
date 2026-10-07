/**
 * session-adapter-contract.test.js — the shared SessionAdapter contract suite.
 *
 * This suite defines the domain contract that EVERY SessionAdapter backend must
 * satisfy (per phase1/seam-design.md §2). Project Room codes against this
 * contract, never against a backend's wire details.
 *
 * Backend coverage: the suite is written backend-agnostic via `runContractSuite`.
 * In this lane (B2) the only backend is `InMemorySessionAdapter`. The future
 * HerdrBridgeAdapter (B4, HTTPS transport to bridge/herdr-bridge.mjs) must pass
 * the SAME suite — that is the seam.
 *
 * InMemory fidelity bar (documented skips — never silent):
 *  - `events_lost` recovery is exercised through the adapter's own recovery
 *    path via the documented test-only hook `_simulateEventsLost()`; real
 *    overrun timing is a HerdrBridgeAdapter concern (B11 smoke).
 *  - Occupant changes are exercised with a forged (stale) occupant token on a
 *    known handle; the in-memory backend never swaps occupants on its own.
 *  - `sendText` echo into the pane buffer emulates terminal echo; a real herdr
 *    pane shows CLI output. `waitForOutput` matches against that buffer.
 *
 * Worker-safety guard: the module under test must never import node:net,
 * node:child_process, or otherwise touch Unix sockets / subprocesses — the
 * production transport lives in B4's HerdrBridgeAdapter, not here.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  createSessionAdapter,
  SessionAdapterError,
  VersionMismatchError,
  OccupantChangedError,
  SubscriptionLostError,
  MethodUnsupportedError,
  TransportError,
  TimeoutError,
  ServerError,
  AGENT_STATES,
  CORE_METHODS,
  INMEMORY_PROTOCOL_VERSION,
  INMEMORY_HERDR_VERSION,
} from '../server/session-adapter.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_SRC = readFileSync(join(HERE, '..', 'server', 'session-adapter.mjs'), 'utf8');

function validOpts(extra = {}) {
  return { pinnedProtocolVersion: INMEMORY_PROTOCOL_VERSION, ...extra };
}

/**
 * runContractSuite — every assertion a backend must satisfy.
 * @param {string} backendName
 * @param {(opts: object) => Promise<object>} makeAdapter — fresh adapter per call
 */
function runContractSuite(backendName, makeAdapter) {
  describe(`SessionAdapter contract [${backendName}]`, () => {
    let adapter;
    beforeEach(async () => {
      adapter = await makeAdapter(validOpts());
      await adapter.connect();
    });

    it('factory requires a numeric pinnedProtocolVersion', async () => {
      await assert.rejects(() => createSessionAdapter({}), /pinnedProtocolVersion/);
      await assert.rejects(() => createSessionAdapter({ pinnedProtocolVersion: '22' }), /pinnedProtocolVersion/);
    });

    it('connect/ping/disconnect lifecycle; disconnect is idempotent', async () => {
      const pong = await adapter.ping();
      assert.equal(pong.ok, true);
      assert.equal(pong.protocolVersion, INMEMORY_PROTOCOL_VERSION);
      assert.equal(typeof pong.herdrVersion, 'string');
      assert.ok(pong.herdrVersion.length > 0);
      await adapter.disconnect();
      await adapter.disconnect(); // idempotent, must not throw
      assert.equal(adapter.connected, false);
    });

    it('methods before connect() throw TransportError (not-connected)', async () => {
      const fresh = await makeAdapter(validOpts());
      await assert.rejects(() => fresh.ping(), (e) => {
        assert.ok(e instanceof TransportError);
        assert.equal(e.code, 'not_connected');
        return true;
      });
      await assert.rejects(() => fresh.snapshot(), TransportError);
    });

    it('protocol version mismatch fails closed with VersionMismatchError', async () => {
      const bad = await makeAdapter(validOpts({ pinnedProtocolVersion: 999 }));
      let err = null;
      await bad.connect().catch((e) => { err = e; });
      assert.ok(err instanceof VersionMismatchError);
      assert.equal(err.pinnedProtocolVersion, 999);
      assert.equal(err.observedProtocolVersion, INMEMORY_PROTOCOL_VERSION);
      assert.equal(err.adapter, 'session-adapter');
      assert.equal(err.backend, backendName);
    });

    it('binary version mismatch fails closed with VersionMismatchError', async () => {
      const bad = await makeAdapter(validOpts({ pinnedHerdrVersion: '0.0.0-nope' }));
      await assert.rejects(() => bad.connect(), (e) => {
        assert.ok(e instanceof VersionMismatchError);
        assert.equal(e.pinnedHerdrVersion, '0.0.0-nope');
        assert.equal(e.observedHerdrVersion, INMEMORY_HERDR_VERSION);
        return true;
      });
    });

    it('onVersionMismatch observer fires before the throw', async () => {
      let seen = null;
      const bad = await makeAdapter(validOpts({
        pinnedProtocolVersion: 999,
        onVersionMismatch: (info) => { seen = info; },
      }));
      await assert.rejects(() => bad.connect(), VersionMismatchError);
      assert.ok(seen && seen.pinnedProtocolVersion === 999);
    });

    it('factory rejects unimplemented backends with MethodUnsupportedError', async () => {
      await assert.rejects(
        () => createSessionAdapter(validOpts({ backend: 'herdr' })),
        (e) => {
          assert.ok(e instanceof MethodUnsupportedError);
          assert.equal(e.method, 'createSessionAdapter');
          return true;
        },
      );
    });

    it('spawnAgent returns a pinned handle; snapshot reflects workspace→tab→pane→agent', async () => {
      const h = await adapter.spawnAgent({
        kind: 'claude', command: 'claude', args: ['--dangerously-skip-permissions'],
        workspace: 'ws1', tab: 'tab-a', title: 'lane worker',
      });
      assert.ok(h.id && h.paneId && h.occupantId, 'handle carries id, paneId, occupantId');
      const snap = await adapter.snapshot();
      const ws = snap.workspaces.find((w) => w.name === 'ws1');
      assert.ok(ws, 'workspace present');
      const tab = ws.tabs.find((t) => t.name === 'tab-a');
      assert.ok(tab, 'tab present');
      const pane = tab.panes.find((p) => p.id === h.paneId);
      assert.ok(pane, 'pane present');
      assert.equal(pane.agentId, h.id);
      assert.equal(pane.occupantId, h.occupantId);
    });

    it('spawnAgent with native resume refs stores them (no transcript replay)', async () => {
      const h = await adapter.spawnAgent({
        command: 'claude',
        resumeSessionRef: 'sess-abc-123',
        resumeCommand: ['claude', '--resume', 'sess-abc-123'],
      });
      const info = await adapter.getAgent(h.id);
      assert.equal(info.sessionRef, 'sess-abc-123');
      assert.deepEqual(info.resumeCommand, ['claude', '--resume', 'sess-abc-123']);
    });

    it('resumeCommand is capped at 64 args', async () => {
      const tooMany = Array.from({ length: 65 }, (_, i) => `arg${i}`);
      await assert.rejects(
        () => adapter.spawnAgent({ command: 'claude', resumeCommand: tooMany }),
        /64/,
      );
    });

    it('listAgents/getAgent inventory; unknown agent → ServerError not_found', async () => {
      const h1 = await adapter.spawnAgent({ command: 'claude', title: 'one' });
      const h2 = await adapter.spawnAgent({ command: 'codex', title: 'two' });
      const list = await adapter.listAgents();
      assert.ok(list.some((a) => a.id === h1.id));
      assert.ok(list.some((a) => a.id === h2.id));
      const one = await adapter.getAgent(h1.id);
      assert.equal(one.id, h1.id);
      assert.equal(one.command, 'claude');
      await assert.rejects(() => adapter.getAgent('no-such-agent'), (e) => {
        assert.ok(e instanceof ServerError);
        assert.equal(e.code, 'not_found');
        return true;
      });
    });

    it('closePane removes the pane; later sends → ServerError not_found', async () => {
      const h = await adapter.spawnAgent({ command: 'claude' });
      await adapter.closePane(h.paneId);
      const snap = await adapter.snapshot();
      const panes = snap.workspaces.flatMap((w) => w.tabs.flatMap((t) => t.panes));
      assert.ok(!panes.some((p) => p.id === h.paneId));
      await assert.rejects(() => adapter.sendText(h, 'hello'), (e) => {
        assert.ok(e instanceof ServerError);
        assert.equal(e.code, 'not_found');
        return true;
      });
      await adapter.closePane(h.paneId); // idempotent
    });

    it('readPane returns the sent text (echo) for recent/visible sources', async () => {
      const h = await adapter.spawnAgent({ command: 'claude' });
      await adapter.sendText(h, 'hello pane');
      for (const source of ['visible', 'recent', 'recent-unwrapped', 'detection']) {
        const pt = await adapter.readPane(h.paneId, source, { lines: 50 });
        assert.equal(pt.paneId, h.paneId);
        assert.equal(pt.source, source);
        assert.ok(pt.text.includes('hello pane'), `source ${source} shows echo`);
      }
    });

    it('readPane on unknown pane → ServerError not_found', async () => {
      await assert.rejects(() => adapter.readPane('no-such-pane', 'recent'), ServerError);
    });

    it('sendText with a fresh handle succeeds; forged occupant → OccupantChangedError', async () => {
      const h = await adapter.spawnAgent({ command: 'claude' });
      const res = await adapter.sendText(h, 'do the thing');
      assert.equal(res.ok, true);
      assert.equal(res.agentId, h.id);
      assert.ok(res.bytes > 0);

      const forged = { id: h.id, paneId: h.paneId, occupantId: 'stale-occupant-token' };
      await assert.rejects(() => adapter.sendText(forged, 'hijack'), (e) => {
        assert.ok(e instanceof OccupantChangedError);
        assert.equal(e.agentId, h.id);
        assert.equal(e.observedOccupant, h.occupantId);
        assert.equal(e.expectedOccupant, 'stale-occupant-token');
        return true;
      });
      // string ids are the unpinned form (caller re-resolved) — still allowed
      const res2 = await adapter.sendText(h.id, 'plain id ok');
      assert.equal(res2.ok, true);
    });

    it('sendKeys with a fresh handle succeeds; forged occupant → OccupantChangedError', async () => {
      const h = await adapter.spawnAgent({ command: 'claude' });
      await adapter.sendKeys(h, ['ctrl+c']);
      const forged = { id: h.id, paneId: h.paneId, occupantId: 'stale' };
      await assert.rejects(() => adapter.sendKeys(forged, ['enter']), OccupantChangedError);
    });

    it('waitForState resolves event-driven when the agent reports the target state', async () => {
      const h = await adapter.spawnAgent({ command: 'claude' });
      setTimeout(() => { adapter.reportState(h.paneId, 'blocked', 'waiting on approval').catch(() => {}); }, 20);
      const state = await adapter.waitForState(h, ['blocked', 'done'], { timeoutMs: 2000 });
      assert.equal(state, 'blocked');
    });

    it('waitForState resolves immediately if already in a target state', async () => {
      const h = await adapter.spawnAgent({ command: 'claude' });
      await adapter.reportState(h.paneId, 'idle');
      const state = await adapter.waitForState(h, ['idle'], { timeoutMs: 500 });
      assert.equal(state, 'idle');
    });

    it('waitForState times out with TimeoutError; aborts via AbortSignal', async () => {
      const h = await adapter.spawnAgent({ command: 'claude' });
      await assert.rejects(
        () => adapter.waitForState(h, ['done'], { timeoutMs: 60 }),
        (e) => {
          assert.ok(e instanceof TimeoutError);
          assert.equal(e.timeoutMs, 60);
          return true;
        },
      );
      const ctl = new AbortController();
      const p = adapter.waitForState(h, ['done'], { timeoutMs: 5000, signal: ctl.signal });
      ctl.abort();
      await assert.rejects(p, TimeoutError);
    });

    it('waitForOutput matches a regex against pane output; timeout → TimeoutError', async () => {
      const h = await adapter.spawnAgent({ command: 'claude' });
      await adapter.sendText(h, 'needle-42 here');
      const m = await adapter.waitForOutput(h.paneId, 'needle-\\d+', { timeoutMs: 1000 });
      assert.equal(m.paneId, h.paneId);
      assert.ok(/needle-42/.test(m.matched));
      await assert.rejects(
        () => adapter.waitForOutput(h.paneId, 'zzz-no-such-output-zzz', { timeoutMs: 60 }),
        TimeoutError,
      );
    });

    it('reportState is the authoritative lane state (working/blocked/idle/done/unknown)', async () => {
      assert.deepEqual([...AGENT_STATES].sort(), ['blocked', 'done', 'idle', 'unknown', 'working']);
      const h = await adapter.spawnAgent({ command: 'claude' });
      for (const s of ['working', 'blocked', 'idle', 'done']) {
        await adapter.reportState(h.paneId, s);
        const info = await adapter.getAgent(h.id);
        assert.equal(info.state, s);
      }
      await assert.rejects(() => adapter.reportState(h.paneId, 'napping'), /unknown state|invalid/i);
    });

    it('reportResume stores the native session ref (≤64 args, 8 KiB cap)', async () => {
      const h = await adapter.spawnAgent({ command: 'claude' });
      await adapter.reportResume(h.paneId, {
        sessionRef: 'sess-xyz',
        resumeCommand: ['claude', '--resume', 'sess-xyz'],
      });
      const info = await adapter.getAgent(h.id);
      assert.equal(info.sessionRef, 'sess-xyz');
      await assert.rejects(
        () => adapter.reportResume(h.paneId, { sessionRef: 'x', resumeCommand: Array.from({ length: 65 }, (_, i) => `a${i}`) }),
        /64/,
      );
    });

    it('reportMetadata stores labels; ttlMs expires them', async () => {
      const h = await adapter.spawnAgent({ command: 'claude' });
      await adapter.reportMetadata(h.paneId, { lane: 'b2', task: 'adapter' });
      let info = await adapter.getAgent(h.id);
      assert.equal(info.metadata.lane, 'b2');
      await adapter.reportMetadata(h.paneId, { temp: 'gone-soon' }, { ttlMs: 30 });
      info = await adapter.getAgent(h.id);
      assert.equal(info.metadata.temp, 'gone-soon');
      await new Promise((r) => setTimeout(r, 60));
      info = await adapter.getAgent(h.id);
      assert.ok(!('temp' in info.metadata), 'expired key is gone');
      assert.equal(info.metadata.lane, 'b2', 'unexpired key survives');
    });

    it('subscribe delivers pane.agent_status_changed; close() stops delivery', async () => {
      const h = await adapter.spawnAgent({ command: 'claude' });
      const seen = [];
      const sub = await adapter.subscribe(['pane.agent_status_changed'], (ev) => { seen.push(ev); });
      assert.equal(sub.active, true);
      await adapter.reportState(h.paneId, 'blocked', 'need input');
      assert.equal(seen.length, 1);
      assert.equal(seen[0].type, 'pane.agent_status_changed');
      assert.equal(seen[0].agentId, h.id);
      assert.equal(seen[0].state, 'blocked');
      await sub.close();
      assert.equal(sub.active, false);
      await sub.close(); // idempotent
      await adapter.reportState(h.paneId, 'working');
      assert.equal(seen.length, 1, 'no events after close');
    });

    it('events_lost triggers adapter-owned recovery: re-snapshot + onReconcile, flow resumes', async () => {
      const h = await adapter.spawnAgent({ command: 'claude', workspace: 'ws-r' });
      const seen = [];
      let reconciled = null;
      const sub = await adapter.subscribe(['pane.agent_status_changed'], (ev) => { seen.push(ev); }, {
        onReconcile: (snapshot, lostCount) => { reconciled = { snapshot, lostCount }; },
      });
      // Test-only hook: drives the adapter's real recovery path (re-snapshot →
      // onReconcile → resubscribe). Real overrun timing is a bridge concern.
      assert.equal(typeof adapter._simulateEventsLost, 'function');
      await adapter._simulateEventsLost(7);
      assert.ok(reconciled, 'onReconcile was called');
      assert.equal(reconciled.lostCount, 7);
      assert.ok(Array.isArray(reconciled.snapshot.workspaces));
      assert.ok(reconciled.snapshot.workspaces.some((w) => w.name === 'ws-r'));
      assert.equal(sub.active, true, 'subscription survives recovery');
      await adapter.reportState(h.paneId, 'done');
      assert.ok(seen.some((ev) => ev.type === 'pane.agent_status_changed' && ev.state === 'done'),
        'event flow resumes after recovery');
      await sub.close();
    });

    it('supports(): core tier true, optional tier false', async () => {
      for (const m of CORE_METHODS) assert.equal(adapter.supports(m), true, `core ${m}`);
      assert.equal(adapter.supports('worktree.create'), false);
      assert.equal(adapter.supports('layout.apply'), false);
      assert.equal(adapter.supports('nope.not-a-method'), false);
    });

    it('every error carries adapter/backend identity', async () => {
      const h = await adapter.spawnAgent({ command: 'claude' });
      const forged = { id: h.id, paneId: h.paneId, occupantId: 'stale' };
      const errs = [];
      await adapter.sendText(forged, 'x').catch((e) => errs.push(e));
      await adapter.getAgent('missing').catch((e) => errs.push(e));
      await adapter.waitForState(h, ['done'], { timeoutMs: 5 }).catch((e) => errs.push(e));
      assert.ok(errs.length === 3);
      for (const e of errs) {
        assert.ok(e instanceof SessionAdapterError);
        assert.equal(e.adapter, 'session-adapter');
        assert.equal(e.backend, backendName);
      }
    });

    it('protocolVersion getter returns the asserted version', async () => {
      assert.equal(adapter.protocolVersion, INMEMORY_PROTOCOL_VERSION);
    });
  });
}

// ---- backend under test in this lane ---------------------------------------
runContractSuite('inmemory', (opts) => createSessionAdapter({ backend: 'inmemory', ...opts }));

// ---- module-level guards (apply to the shipped file, any backend) -----------
describe('session-adapter module guards', () => {
  it('never touches node:net, child_process, or Unix sockets (Worker-safe)', () => {
    for (const banned of ['node:net', 'node:child_process', 'child_process', 'net.createConnection', 'spawnSync', 'execSync']) {
      assert.ok(!MODULE_SRC.includes(banned), `module must not contain ${banned}`);
    }
    assert.ok(!/from\s+['"]node:net['"]/.test(MODULE_SRC), 'no node:net import');
    assert.ok(!/require\(\s*['"]net['"]\s*\)/.test(MODULE_SRC), 'no net require');
  });

  it('exports the full error taxonomy and domain constants', () => {
    for (const cls of [SessionAdapterError, VersionMismatchError, OccupantChangedError,
      SubscriptionLostError, MethodUnsupportedError, TransportError, TimeoutError, ServerError]) {
      assert.equal(typeof cls, 'function', `${cls.name} exported`);
    }
    assert.ok(Array.isArray(AGENT_STATES) && AGENT_STATES.includes('working'));
    assert.ok(Array.isArray(CORE_METHODS) && CORE_METHODS.includes('spawnAgent'));
  });
});
