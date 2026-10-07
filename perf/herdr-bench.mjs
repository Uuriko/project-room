#!/usr/bin/env node
/**
 * perf/herdr-bench.mjs — herdr session-substrate benchmark harness (lane P1).
 *
 * Measures the herdr session substrate against a local throwaway herdr install
 * (pinned upstream binary v0.9.3, protocol 22, read-only benchmark use).
 * No production code is touched; this file is harness-only.
 *
 * Suites:
 *   a) spawn      — tab.create (pane/PTY spawn, the spawnAgent analog) latency, p50/p95 over N spawns
 *   b) reattach   — server.stop -> respawn -> connect -> ping -> session.snapshot latency
 *   c) read       — pane.read latency vs payload size (1KB..1MB)
 *   d) bridge     — adapter overhead vs raw socket: reference HTTP bridge hop decomposition
 *                   (Worker->bridge HTTP leg vs bridge->socket leg vs raw socket)
 *   e) events     — state change (pane.report_agent) -> subscriber receipt latency
 *
 * Usage:
 *   HERDR_BIN=/path/to/herdr node perf/herdr-bench.mjs [--suite=a,b,c,d,e] [--spawns=50]
 *       [--out=results.json] [--bin=/path/to/herdr] [--no-budget]
 *
 * Env:
 *   HERDR_BIN        path to the herdr binary under test (required unless --bin)
 *   TMPDIR           run dirs are created under $TMPDIR (task: TMPDIR=~/workspace/pr-herdr-p1/.tmp)
 *   BENCH_SUITES     default suite list
 *   BENCH_SPAWNS     default spawn count for suite (a)
 *   BENCH_NO_BUDGET  set to 1 to report without failing on budget misses
 *
 * Budgets (failing-until-met; exit 1 on miss unless --no-budget):
 *   spawn p95 < 2000ms · reattach(stop->snapshot) p95 < 10000ms · event p95 < 500ms
 *   pane.read 1MB p95 < 5000ms · bridge overhead p95 < 100ms
 *   (pane.read is server-capped at 1000 lines; the 1MB case is a capped read over 1MB scrollback)
 *
 * Protocol notes (upstream herdr 0.9.3, JSON socket protocol 22):
 * - newline-delimited JSON over a Unix socket; ONE request per connection —
 *   the server responds then closes normal connections. events.subscribe is the
 *   exception: after the subscribe response the connection stays open and the
 *   server pushes {"event": kind, "data": {...}} envelopes, one per line.
 * - Every connection starts with a ping gate: pong.protocol must equal 22,
 *   else fail closed (same pattern as the bundled Rust CLI).
 * - HERDR_SOCKET_PATH + XDG_CONFIG_HOME isolate each run hermetically.
 */

import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------- config

const EXPECTED_PROTOCOL = 22;
const EXPECTED_VERSION = '0.9.3';

const BUDGETS = {
  spawnP95Ms: 2000,        // suite (a) tab.create p95
  reattachP95Ms: 10000,    // suite (b) server.stop -> session.snapshot p95
  eventP95Ms: 500,         // suite (e) report_agent -> subscriber receipt p95
  read1MbP95Ms: 5000,      // suite (c) pane.read of a 1MB payload p95
  bridgeOverheadP95Ms: 100 // suite (d) reference-bridge hop overhead vs raw socket p95
};

const args = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith('--')).map(a => {
    const [k, ...rest] = a.slice(2).split('=');
    return [k, rest.length ? rest.join('=') : true];
  })
);
if (args.help) {
  console.log('usage: HERDR_BIN=/path/to/herdr node perf/herdr-bench.mjs [--suite=a,b,c,d,e] [--spawns=50] [--out=results.json] [--bin=path] [--no-budget]');
  process.exit(0);
}

const HERDR_BIN = args.bin || process.env.HERDR_BIN;
if (!HERDR_BIN || !fs.existsSync(HERDR_BIN)) {
  console.error('FATAL: HERDR_BIN not set or not found. Pass --bin=/path/to/herdr or set HERDR_BIN.');
  console.error('  Pinned upstream binary: herdr 0.9.3 linux-x86_64, sha256');
  console.error('  18a8dc65f1c2fa485884344356dea1cfd911c6f06cf46fa78e193f4087f4dba7');
  process.exit(2);
}
const SUITES = (args.suite || process.env.BENCH_SUITES || 'a,b,c,d,e').split(',').map(s => s.trim());
const SPAWNS = parseInt(args.spawns || process.env.BENCH_SPAWNS || '50', 10);
const NO_BUDGET = !!(args['no-budget'] || process.env.BENCH_NO_BUDGET);
const RUN_DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'herdr-bench-'));
const OUT_PATH = args.out || path.join(RUN_DIR, 'results.json');

// ---------------------------------------------------------------- helpers

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const q = p => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return { n: s.length, min: r1(s[0]), p50: r1(q(0.5)), p95: r1(q(0.95)), max: r1(s[s.length - 1]), mean: r1(mean) };
}
const r1 = x => Math.round(x * 10) / 10;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** One-shot JSON-RPC over the herdr Unix socket. Server answers then closes. */
function rpc(sockPath, method, params = {}, timeoutMs = 30000) {
  const t0 = performance.now();
  return new Promise((resolve, reject) => {
    const s = net.createConnection(sockPath);
    let buf = '';
    let done = false;
    const finish = (err, msg) => {
      if (done) return; done = true;
      clearTimeout(to); s.destroy();
      err ? reject(err) : resolve({ ms: performance.now() - t0, msg });
    };
    const to = setTimeout(() => finish(new Error(`rpc timeout: ${method}`)), timeoutMs);
    s.setEncoding('utf8');
    s.on('error', e => finish(e));
    s.on('data', d => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i >= 0) {
        try { finish(null, JSON.parse(buf.slice(0, i))); }
        catch (e) { finish(new Error(`bad JSON from ${method}: ${e.message}`)); }
      }
    });
    s.on('connect', () => s.write(JSON.stringify({ id: `b${Math.random().toString(36).slice(2)}`, method, params }) + '\n'));
  });
}

/** Ping gate: fail closed unless the server speaks the pinned protocol. */
async function pingGate(sockPath) {
  const { msg } = await rpc(sockPath, 'ping', {});
  const pong = msg.result;
  if (!pong || pong.protocol !== EXPECTED_PROTOCOL)
    throw new Error(`protocol gate failed: server protocol=${pong && pong.protocol}, expected=${EXPECTED_PROTOCOL}`);
  return pong;
}

class HerdrServer {
  constructor(runDir, tag) {
    this.dir = path.join(runDir, tag);
    fs.mkdirSync(path.join(this.dir, 'cfg'), { recursive: true });
    this.sock = path.join(this.dir, 'herdr.sock');
    this.env = { ...process.env, XDG_CONFIG_HOME: path.join(this.dir, 'cfg'), HERDR_SOCKET_PATH: this.sock };
  }
  async start() {
    // `herdr server` daemonizes: the child exits after printing "herdr server
    // running" while the real server keeps the socket. So: spawn, wait for the
    // socket file, then ping-gate. Kill via server.stop RPC (graceful).
    const child = spawn(HERDR_BIN, ['server'], { env: this.env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.resume(); child.stderr.resume();
    child.on('error', () => {});
    const t0 = performance.now();
    for (let i = 0; i < 150; i++) {
      if (fs.existsSync(this.sock)) break;
      await sleep(100);
    }
    if (!fs.existsSync(this.sock)) throw new Error('server socket never appeared: ' + this.sock);
    // wait until it answers (daemon may still be binding)
    let last;
    for (let i = 0; i < 100; i++) {
      try { await pingGate(this.sock); return { ms: performance.now() - t0 }; }
      catch (e) { last = e; await sleep(100); }
    }
    throw new Error('server never answered ping: ' + (last && last.message));
  }
  async stop() {
    try { await rpc(this.sock, 'server.stop', {}, 10000); } catch { /* already gone */ }
    for (let i = 0; i < 50; i++) {
      try { await rpc(this.sock, 'ping', {}, 500); await sleep(100); }
      catch { return; } // gone
    }
  }
}

function checkBudget(name, actualMs, budgetMs, failures) {
  const ok = actualMs < budgetMs;
  console.log(`  BUDGET ${name}: ${r1(actualMs)}ms < ${budgetMs}ms -> ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) failures.push({ name, actualMs: r1(actualMs), budgetMs });
}

// ---------------------------------------------------------------- suite (a): spawn latency

async function suiteSpawn() {
  console.log('\n== suite (a): session spawn latency (tab.create x' + SPAWNS + ') ==');
  const srv = new HerdrServer(RUN_DIR, 'a-spawn');
  await srv.start();
  const { msg: ws } = await rpc(srv.sock, 'workspace.create', { name: 'bench-a' });
  const wsId = ws.result.workspace.workspace_id;
  const samples = [];
  const tabIds = [];
  for (let i = 0; i < SPAWNS; i++) {
    const { ms, msg } = await rpc(srv.sock, 'tab.create', { workspace_id: wsId, label: `s${i}`, focus: false });
    if (msg.error) throw new Error('tab.create failed: ' + JSON.stringify(msg.error));
    samples.push(ms);
    tabIds.push(msg.result.tab.tab_id);
  }
  const st = stats(samples);
  console.log(`  tab.create: n=${st.n} min=${st.min} p50=${st.p50} p95=${st.p95} max=${st.max} mean=${st.mean} ms`);
  for (const id of tabIds) await rpc(srv.sock, 'tab.close', { tab_id: id }).catch(() => {});
  await srv.stop();
  return { op: 'tab.create', samples: samples.map(r1), stats: st, budget: { name: 'spawn p95', ms: st.p95, limit: BUDGETS.spawnP95Ms } };
}

// ---------------------------------------------------------------- suite (b): reattach after restart

async function suiteReattach(iters = 10) {
  console.log(`\n== suite (b): reattach latency after server restart (x${iters}) ==`);
  const toPong = [], toSnap = [];
  for (let i = 0; i < iters; i++) {
    const srv = new HerdrServer(RUN_DIR, `b-reattach-${i}`);
    await srv.start();
    const { msg: ws } = await rpc(srv.sock, 'workspace.create', { name: `bench-b${i}` });
    await rpc(srv.sock, 'tab.create', { workspace_id: ws.result.workspace.workspace_id, label: 't', focus: false });
    const t0 = performance.now();
    await srv.stop();
    // respawn = the "restart"; measure stop -> pong and stop -> snapshot
    await srv.start();
    const pongMs = performance.now() - t0;
    const { msg: snap } = await rpc(srv.sock, 'session.snapshot', {});
    const snapMs = performance.now() - t0;
    const tabs = snap.result.snapshot.tabs.length;
    if (tabs < 1) throw new Error('restart lost the tab (persistence broken)');
    toPong.push(pongMs); toSnap.push(snapMs);
    console.log(`  iter ${i}: stop->pong ${r1(pongMs)}ms, stop->snapshot ${r1(snapMs)}ms (tabs restored: ${tabs})`);
    await srv.stop();
  }
  const sPong = stats(toPong), sSnap = stats(toSnap);
  console.log(`  stop->pong:    p50=${sPong.p50} p95=${sPong.p95} max=${sPong.max} ms`);
  console.log(`  stop->snapshot: p50=${sSnap.p50} p95=${sSnap.p95} max=${sSnap.max} ms`);
  return {
    stopToPong: { samples: toPong.map(r1), stats: sPong },
    stopToSnapshot: { samples: toSnap.map(r1), stats: sSnap },
    budget: { name: 'reattach p95', ms: sSnap.p95, limit: BUDGETS.reattachP95Ms }
  };
}

// ---------------------------------------------------------------- suite (c): pane.read vs payload size
//
// Server-side hard cap (upstream src/app/api_helpers.rs:117):
//   `let line_limit = lines.map(|lines| lines.min(1000) as usize);`
// pane.read returns AT MOST the last 1000 rows, end-anchored, truncated=true
// beyond that. So "payload size" is benchmarked two ways:
//   1. single-read latency for payloads that fit the cap (16/256/1000 lines x ~64B)
//   2. capped-read latency under scrollback pressure (1000-line read over a 1MB scrollback)

async function suiteRead() {
  console.log('\n== suite (c): pane.read latency vs payload size ==');
  console.log('   note: server caps pane.read at 1000 lines (api_helpers.rs:117); larger payloads need paging');
  const srv = new HerdrServer(RUN_DIR, 'c-read');
  await srv.start();
  const { msg: ws } = await rpc(srv.sock, 'workspace.create', { name: 'bench-c' });
  const { msg: tab } = await rpc(srv.sock, 'tab.create', { workspace_id: ws.result.workspace.workspace_id, label: 't', focus: false });
  const paneId = tab.result.root_pane.pane_id;
  await sleep(1500); // let the shell settle
  const linePayload = i => `'L%05d'%${i}+'x'*57`; // ~64B per line; NB: expanded below per size

  async function emitAndRead(nLines, readLines) {
    // NOTE: the sentinel is split in the command string ('ZZ'+'DONE'+'ZZ') so the
    // shell-echoed command line does not itself match wait_for_output's substring.
    const stamp = Date.now();
    const sentinel = `ZZDONEZZ-${nLines}-${stamp}`;
    const cmd = `python3 -c "import sys;[sys.stdout.write('L%05d'%i+'x'*57+chr(10)) for i in range(${nLines})];sys.stdout.write('ZZ'+'DONE'+'ZZ-${nLines}-${stamp}'+chr(10))"`;
    await rpc(srv.sock, 'pane.send_text', { pane_id: paneId, text: cmd + '\n' });
    const w = await rpc(srv.sock, 'pane.wait_for_output', {
      pane_id: paneId, source: 'recent',
      match: { type: 'substring', value: sentinel }, timeout_ms: 30000
    }, 35000);
    if (w.msg.error) throw new Error('wait_for_output failed: ' + JSON.stringify(w.msg.error));
    const { ms, msg } = await rpc(srv.sock, 'pane.read', { pane_id: paneId, source: 'recent', lines: readLines });
    if (msg.error) throw new Error('pane.read failed: ' + JSON.stringify(msg.error));
    return { ms, text: msg.result.read.text || '', truncated: msg.result.read.truncated };
  }

  const tailOf = n => 'L' + String(n - 1).padStart(5, '0'); // last payload line, e.g. L00999
  const bySize = {};
  for (const nLines of [16, 256, 1000]) {
    const samples = [];
    const approxBytes = nLines * 64;
    for (let r = 0; r < 5; r++) {
      const { ms, text } = await emitAndRead(nLines, 1100);
      if (!text.includes(tailOf(nLines)))
        throw new Error(`payload tail ${tailOf(nLines)} missing from read (nLines=${nLines})`);
      samples.push(ms);
    }
    const st = stats(samples);
    bySize[`${approxBytes}B`] = { lines: nLines, samples: samples.map(r1), stats: st };
    console.log(`  ~${String(approxBytes).padStart(6)}B (${nLines} lines): p50=${st.p50} p95=${st.p95} max=${st.max} mean=${st.mean} ms`);
  }

  // scrollback pressure: 1MB in the pane, then time the max useful read (1000 lines)
  {
    const samples = [];
    for (let r = 0; r < 5; r++) {
      const { ms, text, truncated } = await emitAndRead(16384, 1000);
      if (!truncated) throw new Error('expected truncated=true over 1MB scrollback');
      if (text.length < 50000) throw new Error(`capped read too short: ${text.length}`);
      samples.push(ms);
    }
    const st = stats(samples);
    bySize['1MB-scrollback-capped-read'] = { lines: 1000, scrollbackLines: 16384, samples: samples.map(r1), stats: st };
    console.log(`  1MB scrollback, capped 1000-line read: p50=${st.p50} p95=${st.p95} max=${st.max} mean=${st.mean} ms`);
  }
  await srv.stop();
  return { bySize, readLineCap: 1000, budget: { name: 'pane.read 1MB-scrollback p95', ms: bySize['1MB-scrollback-capped-read'].stats.p95, limit: BUDGETS.read1MbP95Ms } };
}

// ---------------------------------------------------------------- suite (d): bridge-hop decomposition
//
// The REDESIGN splits the adapter in two: Worker --HTTPS--> bridge --Unix socket--> herdr.
// The real bridge (bridge/herdr-bridge.mjs) is built by lane B3; here we run a
// minimal REFERENCE bridge (harness-local, same-machine HTTP) to decompose the
// unavoidable extra-hop cost into: Worker->bridge HTTP leg vs bridge->socket leg,
// compared against the raw-socket baseline.

function startReferenceBridge(sockPath) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        if (req.url === '/noop') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (req.url === '/rpc' && req.method === 'POST') {
          const { id, method, params } = JSON.parse(body);
          const { msg } = await rpc(sockPath, method, params || {});
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id, result: msg.result, error: msg.error || null }));
          return;
        }
        res.writeHead(404); res.end();
      } catch (e) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(e.message || e) }));
      }
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function httpPost(port, urlPath, payload) {
  const t0 = performance.now();
  const data = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`bridge ${res.statusCode}: ${body.slice(0, 200)}`));
        resolve({ ms: performance.now() - t0, body: JSON.parse(body) });
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => reject(new Error('bridge http timeout')));
    req.end(data);
  });
}

async function suiteBridge(iters = 30) {
  console.log(`\n== suite (d): bridge-hop cost decomposition (x${iters} interleaved) ==`);
  console.log('   reference bridge = harness-local HTTP->Unix-socket forwarder (B3 builds the real one)');
  const srv = new HerdrServer(RUN_DIR, 'd-bridge');
  await srv.start();
  const bridge = await startReferenceBridge(srv.sock);
  const port = bridge.address().port;
  const raw = [], httpLeg = [], bridged = [];
  for (let i = 0; i < iters; i++) {
    raw.push((await rpc(srv.sock, 'ping', {})).ms);
    httpLeg.push((await httpPost(port, '/noop', {})).ms);
    const b = await httpPost(port, '/rpc', { id: `d${i}`, method: 'ping', params: {} });
    if (b.body.error) throw new Error('bridged ping failed: ' + JSON.stringify(b.body.error));
    bridged.push(b.ms);
  }
  await new Promise(r => bridge.close(r));
  await srv.stop();
  const sRaw = stats(raw), sHttp = stats(httpLeg), sBridged = stats(bridged);
  // per-iteration overhead: bridged ping minus raw ping (interleaved, so paired)
  const overhead = bridged.map((b, i) => b - raw[i]);
  const sOver = stats(overhead);
  console.log(`  raw socket ping:      p50=${sRaw.p50} p95=${sRaw.p95} max=${sRaw.max} ms`);
  console.log(`  Worker->bridge HTTP:  p50=${sHttp.p50} p95=${sHttp.p95} max=${sHttp.max} ms  (localhost TCP+HTTP, no herdr)`);
  console.log(`  bridged ping (total): p50=${sBridged.p50} p95=${sBridged.p95} max=${sBridged.max} ms`);
  console.log(`  hop overhead (paired bridged-raw): p50=${sOver.p50} p95=${sOver.p95} max=${sOver.max} ms`);
  return {
    rawSocketPing: { samples: raw.map(r1), stats: sRaw },
    workerToBridgeHttp: { samples: httpLeg.map(r1), stats: sHttp },
    bridgedPing: { samples: bridged.map(r1), stats: sBridged },
    hopOverhead: { samples: overhead.map(r1), stats: sOver },
    note: 'reference bridge is harness-local; real bridge/herdr-bridge.mjs adds auth+allowlist+audit on top',
    budget: { name: 'bridge overhead p95', ms: sOver.p95, limit: BUDGETS.bridgeOverheadP95Ms }
  };
}

// ---------------------------------------------------------------- suite (e): event propagation

async function suiteEvents(iters = 30) {
  console.log(`\n== suite (e): event propagation (report_agent -> subscriber receipt, x${iters}) ==`);
  const srv = new HerdrServer(RUN_DIR, 'e-events');
  await srv.start();
  const { msg: ws } = await rpc(srv.sock, 'workspace.create', { name: 'bench-e' });
  const { msg: tab } = await rpc(srv.sock, 'tab.create', { workspace_id: ws.result.workspace.workspace_id, label: 't', focus: false });
  const paneId = tab.result.root_pane.pane_id;

  // persistent subscriber (events.subscribe keeps this connection open)
  const sub = net.createConnection(srv.sock);
  let buf = '';
  const waiters = [];
  sub.setEncoding('utf8');
  sub.on('error', e => { for (const w of waiters.splice(0)) w.reject(e); });
  sub.on('data', d => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.event === 'pane.agent_status_changed' && m.data && m.data.pane_id === paneId) {
        const t = performance.now();
        for (let k = waiters.length - 1; k >= 0; k--) {
          if (waiters[k].want === m.data.agent_status) { waiters.splice(k, 1)[0].resolve(t); break; }
        }
      }
    }
  });
  await new Promise((res, rej) => { sub.on('connect', res); sub.on('error', rej); });
  const subAck = await new Promise((resolve, reject) => {
    const onData = d => {
      const i = d.toString().indexOf('\n');
      if (i >= 0) { try { resolve(JSON.parse(d.toString().slice(0, i))); } catch (e) { reject(e); } }
    };
    sub.once('data', onData);
    sub.write(JSON.stringify({ id: 'sub1', method: 'events.subscribe', params: { subscriptions: [{ type: 'pane.agent_status_changed', pane_id: paneId }] } }) + '\n');
    setTimeout(() => reject(new Error('subscribe ack timeout')), 10000);
  });
  if (subAck.error) throw new Error('events.subscribe failed: ' + JSON.stringify(subAck.error));

  const deltas = [];
  let state = 'working';
  for (let i = 0; i < iters; i++) {
    state = state === 'working' ? 'blocked' : 'working'; // alternate to force a change each time
    const t0 = performance.now();
    const waiter = {};
    const p = new Promise((resolve, reject) => {
      waiter.want = state;
      waiter.resolve = t => { clearTimeout(waiter.to); resolve(t); };
      waiter.reject = e => { clearTimeout(waiter.to); reject(e); };
      waiter.to = setTimeout(() => {
        const k = waiters.indexOf(waiter);
        if (k >= 0) waiters.splice(k, 1);
        reject(new Error('event timeout'));
      }, 10000);
      waiters.push(waiter);
    });
    const { msg } = await rpc(srv.sock, 'pane.report_agent', {
      pane_id: paneId, source: 'bench', agent: 'bench-agent', state, message: `iter ${i}`
    });
    if (msg.error) throw new Error('pane.report_agent failed: ' + JSON.stringify(msg.error));
    const tEvent = await p;
    deltas.push(tEvent - t0);
  }
  sub.destroy();
  await srv.stop();
  const st = stats(deltas);
  console.log(`  report_agent -> subscriber: n=${st.n} min=${st.min} p50=${st.p50} p95=${st.p95} max=${st.max} mean=${st.mean} ms`);
  console.log('  note: alternating working/blocked forces a real transition each iteration;');
  console.log('  the detection engine may emit a follow-up status event afterwards (self-report is trusted first).');
  return { op: 'pane.report_agent -> pane.agent_status_changed', samples: deltas.map(r1), stats: st, budget: { name: 'event propagation p95', ms: st.p95, limit: BUDGETS.eventP95Ms } };
}

// ---------------------------------------------------------------- main

async function main() {
  console.log('herdr-bench: session substrate benchmarks');
  console.log(`  binary: ${HERDR_BIN}`);
  console.log(`  run dir: ${RUN_DIR}`);
  console.log(`  suites: ${SUITES.join(',')}`);
  const { msg: probe } = await (async () => {
    // version probe against a scratch server to record the environment honestly
    const srv = new HerdrServer(RUN_DIR, 'probe');
    await srv.start();
    const pong = await pingGate(srv.sock);
    await srv.stop();
    return { msg: pong };
  })();
  console.log(`  server: herdr ${probe.version}, protocol ${probe.protocol}`);

  const results = {
    meta: {
      ts: new Date().toISOString(),
      herdrBin: HERDR_BIN,
      herdrVersion: probe.version,
      protocol: probe.protocol,
      node: process.version,
      platform: `${os.platform()} ${os.arch()}`,
      budgets: BUDGETS,
      suites: SUITES
    },
    suites: {}
  };
  const failures = [];

  if (SUITES.includes('a')) {
    const r = await suiteSpawn();
    results.suites.spawn = r;
    checkBudget(r.budget.name, r.budget.ms, r.budget.limit, failures);
  }
  if (SUITES.includes('b')) {
    const r = await suiteReattach();
    results.suites.reattach = r;
    checkBudget(r.budget.name, r.budget.ms, r.budget.limit, failures);
  }
  if (SUITES.includes('c')) {
    const r = await suiteRead();
    results.suites.read = r;
    checkBudget(r.budget.name, r.budget.ms, r.budget.limit, failures);
  }
  if (SUITES.includes('d')) {
    const r = await suiteBridge();
    results.suites.bridge = r;
    checkBudget(r.budget.name, r.budget.ms, r.budget.limit, failures);
  }
  if (SUITES.includes('e')) {
    const r = await suiteEvents();
    results.suites.events = r;
    checkBudget(r.budget.name, r.budget.ms, r.budget.limit, failures);
  }

  fs.writeFileSync(OUT_PATH, JSON.stringify(results, null, 1));
  console.log(`\nresults -> ${OUT_PATH}`);
  if (failures.length && !NO_BUDGET) {
    console.log(`\n${failures.length} BUDGET(S) MISSED — failing until met:`);
    for (const f of failures) console.log(`  FAIL ${f.name}: ${f.actualMs}ms >= ${f.budgetMs}ms`);
    process.exit(1);
  }
  console.log(NO_BUDGET ? '\nbudgets reported only (--no-budget)' : '\nall budgets PASS');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(2); });
